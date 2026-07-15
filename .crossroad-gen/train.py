"""train.py — Fine-tune DistilBERT for crossroad turn detection and export ONNX.

Pipeline:
1. Read seed-positive.jsonl + seed-negative.jsonl + positive.jsonl + negative.jsonl
2. Load distilbert-base-multilingual-cased + tokenizer
3. Construct training data: positives take text before turn point (label=1);
   also take windows from non-turn positions of positives as additional negatives (label=0)
4. Fine-tune 3-5 epochs (batch_size=16, lr=2e-5)
5. Export ONNX to ~/.mycc-store/crossroad-model/ (model.onnx + tokenizer.json + config.json)
   Unquantized by default (~541 MB); --quantize attempts quantization (known-broken)
6. Run evaluate.py and output metrics

Usage:
    python train.py [--epochs N] [--batch-size N] [--lr F] [--max-seq-len N]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
MODEL_OUTPUT_DIR = Path.home() / ".mycc-store" / "crossroad-model"

BASE_MODEL = "distilbert-base-multilingual-cased"
DEFAULT_EPOCHS = 4
DEFAULT_BATCH_SIZE = 16
DEFAULT_LR = 2e-5
DEFAULT_MAX_SEQ_LEN = 512
DEFAULT_THRESHOLD = 0.7
CHECK_INTERVAL = 50

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_jsonl(path: Path) -> list[dict[str, Any]]:
    """Load a JSONL file and return list of parsed dicts."""
    results: list[dict[str, Any]] = []
    if not path.exists():
        return results
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                results.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return results


def load_all_training_data(data_dir: Path) -> list[dict[str, Any]]:
    """Load all training data from seed and auto-labeled files."""
    files = [
        data_dir / "seed-positive.jsonl",
        data_dir / "seed-negative.jsonl",
        data_dir / "positive.jsonl",
        data_dir / "negative.jsonl",
    ]
    all_data: list[dict[str, Any]] = []
    for f in files:
        if f.exists():
            data = load_jsonl(f)
            print(f"  Loaded {len(data)} samples from {f.name}")
            all_data.extend(data)
    return all_data


# ---------------------------------------------------------------------------
# Training data construction
# ---------------------------------------------------------------------------

def construct_training_samples(data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Construct training samples from raw data.

    For positive samples (label=1): take text before the turn point as a
    positive example (the model should detect a turn is about to happen).
    Also take windows from non-turn positions as additional negatives.

    For negative samples (label=0): use the full text as-is.

    Returns list of {"text": str, "label": int}.
    """
    samples: list[dict[str, Any]] = []

    for entry in data:
        text = entry.get("text", "")
        label = entry.get("label", 0)
        turn_index = entry.get("turnIndex", -1)

        if not text or len(text.strip()) < 10:
            continue

        if label == 1 and turn_index is not None and turn_index >= 0:
            # Positive: text before turn point (includes the turn context)
            # Take a window ending at the turn point
            start = max(0, turn_index - DEFAULT_MAX_SEQ_LEN + 50)
            prefix_text = text[start:turn_index].strip()
            if len(prefix_text) >= 10:
                samples.append({"text": prefix_text, "label": 1})

            # Additional negative: take a window from the beginning (non-turn position)
            # This helps the model learn what non-turn text looks like
            if len(text) > 100:
                neg_window = text[:min(80, len(text) // 2)].strip()
                if len(neg_window) >= 10:
                    samples.append({"text": neg_window, "label": 0})

        elif label == 0:
            # Negative: use full text (truncated to max length)
            truncated = text[:DEFAULT_MAX_SEQ_LEN].strip()
            samples.append({"text": truncated, "label": 0})

    return samples


# ---------------------------------------------------------------------------
# Model training
# ---------------------------------------------------------------------------

def train_model(
    samples: list[dict[str, Any]],
    epochs: int = DEFAULT_EPOCHS,
    batch_size: int = DEFAULT_BATCH_SIZE,
    lr: float = DEFAULT_LR,
    max_seq_len: int = DEFAULT_MAX_SEQ_LEN,
) -> tuple[Any, Any]:
    """Fine-tune DistilBERT on the training samples.

    Returns (model, tokenizer).
    """
    import torch
    from torch.utils.data import Dataset, DataLoader
    from transformers import (
        AutoTokenizer,
        AutoModelForSequenceClassification,
        get_linear_schedule_with_warmup,
    )

    print(f"\nTraining with {len(samples)} samples")
    print(f"  Epochs: {epochs}, Batch size: {batch_size}, LR: {lr}")

    # Load tokenizer and model
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = AutoModelForSequenceClassification.from_pretrained(
        BASE_MODEL,
        num_labels=2,
        problem_type="single_label_classification",
    )

    # Custom dataset
    class CrossroadDataset(Dataset):
        def __init__(self, samples: list[dict[str, Any]], tokenizer: Any, max_len: int):
            self.samples = samples
            self.tokenizer = tokenizer
            self.max_len = max_len

        def __len__(self) -> int:
            return len(self.samples)

        def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
            item = self.samples[idx]
            encoding = self.tokenizer(
                item["text"],
                truncation=True,
                padding="max_length",
                max_length=self.max_len,
                return_tensors="pt",
            )
            return {
                "input_ids": encoding["input_ids"].squeeze(0),
                "attention_mask": encoding["attention_mask"].squeeze(0),
                "labels": torch.tensor(item["label"], dtype=torch.long),
            }

    # Shuffle and split
    random.seed(42)
    random.shuffle(samples)

    dataset = CrossroadDataset(samples, tokenizer, max_seq_len)
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    # Training setup
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr)
    total_steps = len(dataloader) * epochs
    scheduler = get_linear_schedule_with_warmup(
        optimizer, num_warmup_steps=int(total_steps * 0.1), num_training_steps=total_steps
    )

    # Training loop
    model.train()
    for epoch in range(epochs):
        total_loss = 0.0
        for batch_idx, batch in enumerate(dataloader):
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"].to(device)

            optimizer.zero_grad()
            outputs = model(input_ids=input_ids, attention_mask=attention_mask, labels=labels)
            loss = outputs.loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()

            total_loss += loss.item()
            if (batch_idx + 1) % 10 == 0:
                print(f"  Epoch {epoch+1}/{epochs} [{batch_idx+1}/{len(dataloader)}] loss={loss.item():.4f}")

        avg_loss = total_loss / len(dataloader)
        print(f"  Epoch {epoch+1}/{epochs} avg loss: {avg_loss:.4f}")

    return model, tokenizer


# ---------------------------------------------------------------------------
# ONNX export
# ---------------------------------------------------------------------------

def export_onnx(
    model: Any,
    tokenizer: Any,
    output_dir: Path,
    training_samples: int,
    quantize: bool = False,
) -> None:
    """Export model to ONNX format.

    Creates:
    - model.onnx (ONNX model — quantized if --quantize, else unquantized)
    - tokenizer.json + vocab files (HuggingFace tokenizer, for the TS runtime)
    - config.json (model configuration for mycc integration)

    Version contract: the exported model is consumed by the mycc TypeScript
    runtime (src/loop/crossroad-encoder.ts) using onnxruntime-node ^1.22.0 and
    @huggingface/transformers ^4.2.0. The ONNX opset and tokenizer.json format
    must stay compatible with those npm versions — see requirements.txt.

    NOTE on quantization: onnxruntime.quantization.quantize_dynamic crashes with
    ShapeInferenceError (expected 768, got 2) on DistilBERT even at opset 18.
    This is a known issue with no fix as of 2026-07. The unquantized model
    (~541 MB with external data) works correctly. The default (quantize=False)
    ships the working unquantized model.
    """
    import torch

    output_dir.mkdir(parents=True, exist_ok=True)

    # Save tokenizer (generates tokenizer.json + vocab files consumed by
    # @huggingface/transformers on the TS side)
    tokenizer.save_pretrained(output_dir)

    # Export to ONNX via torch.onnx.export.
    # (onnxmltools was previously tried as an alternative exporter but is not
    # in requirements.txt and offered no benefit — removed to avoid dead code.)
    dummy_text = "This is a sample input for ONNX export tracing."
    inputs = tokenizer(dummy_text, return_tensors="pt", padding="max_length", max_length=DEFAULT_MAX_SEQ_LEN, truncation=True)

    model.eval()
    model.cpu()

    onnx_path = output_dir / "model.onnx"
    OPSET_VERSION = 18  # opset 14 → 18; quantization still broken at either

    torch.onnx.export(
        model,
        (inputs["input_ids"], inputs["attention_mask"]),
        str(onnx_path),
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            "logits": {0: "batch"},
        },
        opset_version=OPSET_VERSION,
    )
    print(f"  Exported ONNX (opset {OPSET_VERSION}) to {onnx_path}")

    # Quantize the ONNX model (optional — known-broken, see docstring)
    if quantize:
        try:
            from onnxruntime.quantization import quantize_dynamic, QuantType
            quantized_path = output_dir / "model_quantized.onnx"
            quantize_dynamic(str(onnx_path), str(quantized_path), weight_type=QuantType.QUInt8)
            os.replace(str(quantized_path), str(onnx_path))
            print(f"  Quantized model saved to {onnx_path}")
        except ImportError:
            print("  Warning: onnxruntime quantization not available, keeping unquantized model")
        except Exception as e:
            print(f"  Warning: Quantization failed ({e}), keeping unquantized model")
            print("  (This is a known ShapeInferenceError on DistilBERT)")
    else:
        print("  Skipping quantization: shipping unquantized model (~541 MB)")

    # Write config.json (for mycc integration)
    config = {
        "version": 1,
        "baseModel": BASE_MODEL,
        "maxSequenceLength": DEFAULT_MAX_SEQ_LEN,
        "threshold": DEFAULT_THRESHOLD,
        "checkInterval": CHECK_INTERVAL,
        "trainedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "trainingSamples": training_samples,
    }
    config_path = output_dir / "config.json"
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    print(f"  Config saved to {config_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Train crossroad turn detection model")
    parser.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS, help=f"Number of epochs (default: {DEFAULT_EPOCHS})")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help=f"Batch size (default: {DEFAULT_BATCH_SIZE})")
    parser.add_argument("--lr", type=float, default=DEFAULT_LR, help=f"Learning rate (default: {DEFAULT_LR})")
    parser.add_argument("--max-seq-len", type=int, default=DEFAULT_MAX_SEQ_LEN, help=f"Max sequence length (default: {DEFAULT_MAX_SEQ_LEN})")
    parser.add_argument("--output-dir", default=str(MODEL_OUTPUT_DIR), help=f"Output directory (default: {MODEL_OUTPUT_DIR})")
    parser.add_argument("--skip-eval", action="store_true", help="Skip evaluation after training")
    parser.add_argument(
        "--quantize",
        action="store_true",
        default=False,
        help="Attempt dynamic quantization after export. OFF by default because "
        "quantize_dynamic crashes with ShapeInferenceError (768 vs 2) on "
        "DistilBERT. The unquantized model (~541 MB) works correctly.",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir)

    print("=" * 60)
    print("Crossroad Turn Detection — Training Pipeline")
    print("=" * 60)

    # Step 1: Load data
    print("\n[1/5] Loading training data...")
    raw_data = load_all_training_data(DATA_DIR)
    print(f"  Total raw samples: {len(raw_data)}")

    # Step 2: Construct training samples
    print("\n[2/5] Constructing training samples...")
    samples = construct_training_samples(raw_data)
    pos_count = sum(1 for s in samples if s["label"] == 1)
    neg_count = sum(1 for s in samples if s["label"] == 0)
    print(f"  Total training samples: {len(samples)} (positive: {pos_count}, negative: {neg_count})")

    if len(samples) < 10:
        print("Error: Not enough training data (need at least 10 samples)", file=sys.stderr)
        sys.exit(1)

    # Step 3: Train model
    print("\n[3/5] Training model...")
    model, tokenizer = train_model(
        samples,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        max_seq_len=args.max_seq_len,
    )

    # Step 4: Export ONNX
    # Quantize only if --quantize is explicitly set. Default is unquantized
    # because quantize_dynamic crashes on DistilBERT (ShapeInferenceError).
    quantize = args.quantize
    print(f"\n[4/5] Exporting ONNX to {output_dir} (quantize={quantize})...")
    export_onnx(model, tokenizer, output_dir, len(samples), quantize=quantize)

    # Step 5: Evaluate
    if not args.skip_eval:
        print("\n[5/5] Running evaluation...")
        eval_script = BASE_DIR / "evaluate.py"
        if eval_script.exists():
            try:
                subprocess.run(
                    [sys.executable, str(eval_script), "--model-dir", str(output_dir)],
                    check=False,
                )
            except Exception as e:
                print(f"  Evaluation failed: {e}", file=sys.stderr)
        else:
            print("  evaluate.py not found, skipping evaluation")
    else:
        print("\n  Skipping evaluation (--skip-eval)")

    print("\n" + "=" * 60)
    print("Training complete!")
    print(f"  Model: {output_dir / 'model.onnx'}")
    print(f"  Config: {output_dir / 'config.json'}")
    print(f"  Training samples: {len(samples)}")
    print("=" * 60)


if __name__ == "__main__":
    main()