"""evaluate.py — Evaluate the crossroad turn detection model on test cases.

Computes accuracy, F1, precision, recall on tests/test_cases/ test sets.
Outputs confusion matrix and error analysis report.

Usage:
    python evaluate.py [--model-dir DIR] [--test-dir DIR] [--threshold F]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_DIR = Path.home() / ".mycc-store" / "crossroad-model"
DEFAULT_TEST_DIR = BASE_DIR / "tests" / "test_cases"
DEFAULT_THRESHOLD = 0.7


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


def load_all_test_cases(test_dir: Path) -> dict[str, list[dict[str, Any]]]:
    """Load all test case files from the test directory tree.

    Returns a dict mapping file name (relative path) to list of entries.
    """
    test_cases: dict[str, list[dict[str, Any]]] = {}
    if not test_dir.exists():
        return test_cases

    for root, _dirs, files in os.walk(test_dir):
        for fname in sorted(files):
            if fname.endswith(".jsonl"):
                fpath = Path(root) / fname
                rel_path = str(fpath.relative_to(test_dir))
                entries = load_jsonl(fpath)
                if entries:
                    test_cases[rel_path] = entries

    return test_cases


# ---------------------------------------------------------------------------
# Model inference
# ---------------------------------------------------------------------------

def run_onnx_inference(
    model_dir: Path,
    texts: list[str],
    threshold: float = DEFAULT_THRESHOLD,
) -> list[dict[str, Any]]:
    """Run ONNX inference on a list of texts.

    Returns list of {"predicted": int, "probability": float, "logits": list[float]}.
    """
    import numpy as np
    import onnxruntime as ort
    from transformers import AutoTokenizer

    # Load tokenizer
    tokenizer_path = model_dir
    tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path))

    # Load ONNX session
    onnx_path = model_dir / "model.onnx"
    if not onnx_path.exists():
        raise FileNotFoundError(f"ONNX model not found: {onnx_path}")

    # Configure session for single-thread CPU inference
    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = 1
    sess_options.inter_op_num_threads = 1

    session = ort.InferenceSession(str(onnx_path), sess_options=sess_options, providers=["CPUExecutionProvider"])

    input_name_ids = session.get_inputs()[0].name
    input_name_mask = session.get_inputs()[1].name
    output_name = session.get_outputs()[0].name

    results: list[dict[str, Any]] = []

    for text in texts:
        if not text or not text.strip():
            results.append({"predicted": 0, "probability": 0.0, "logits": [1.0, 0.0]})
            continue

        # Tokenize
        encoding = tokenizer(
            text,
            truncation=True,
            padding=True,
            max_length=512,
            return_tensors="np",
        )

        input_ids = encoding["input_ids"].astype(np.int64)
        attention_mask = encoding["attention_mask"].astype(np.int64)

        # Run inference
        logits = session.run([output_name], {
            input_name_ids: input_ids,
            input_name_mask: attention_mask,
        })[0]

        # Apply softmax
        logits_flat = logits[0]
        exp_vals = np.exp(logits_flat - np.max(logits_flat))
        probs = exp_vals / np.sum(exp_vals)

        p_turn = float(probs[1])
        predicted = 1 if p_turn > threshold else 0

        results.append({
            "predicted": predicted,
            "probability": p_turn,
            "logits": [float(x) for x in logits_flat],
        })

    return results


# ---------------------------------------------------------------------------
# Metrics computation
# ---------------------------------------------------------------------------

def compute_metrics(predictions: list[int], labels: list[int]) -> dict[str, Any]:
    """Compute accuracy, F1, precision, recall, and confusion matrix."""
    tp = sum(1 for p, l in zip(predictions, labels) if p == 1 and l == 1)
    fp = sum(1 for p, l in zip(predictions, labels) if p == 1 and l == 0)
    tn = sum(1 for p, l in zip(predictions, labels) if p == 0 and l == 0)
    fn = sum(1 for p, l in zip(predictions, labels) if p == 0 and l == 1)

    accuracy = (tp + tn) / max(1, tp + fp + tn + fn)
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = 2 * precision * recall / max(1e-10, precision + recall)

    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "confusion_matrix": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
    }


def print_confusion_matrix(metrics: dict[str, Any]) -> None:
    """Print a formatted confusion matrix."""
    cm = metrics["confusion_matrix"]
    print()
    print("  Confusion Matrix:")
    print("  ┌──────────────┬──────────────┬──────────────┐")
    print("  │              │  Pred Turn   │  Pred NoTurn │")
    print("  ├──────────────┼──────────────┼──────────────┤")
    print(f"  │  Act Turn    │     {cm['tp']:>4}     │     {cm['fn']:>4}     │")
    print("  ├──────────────┼──────────────┼──────────────┤")
    print(f"  │  Act NoTurn  │     {cm['fp']:>4}     │     {cm['tn']:>4}     │")
    print("  └──────────────┴──────────────┴──────────────┘")


def evaluate_test_set(
    entries: list[dict[str, Any]],
    model_dir: Path,
    threshold: float,
) -> tuple[list[int], list[int], list[dict[str, Any]]]:
    """Evaluate a single test set.

    Returns (predictions, labels, error_cases).
    """
    texts = [e.get("text", "") for e in entries]
    labels = [int(e.get("label", 0)) for e in entries]

    if not texts:
        return [], [], []

    results = run_onnx_inference(model_dir, texts, threshold)
    predictions = [r["predicted"] for r in results]

    # Identify errors
    error_cases: list[dict[str, Any]] = []
    for i, (entry, pred, label) in enumerate(zip(entries, predictions, labels)):
        if pred != label:
            error_cases.append({
                "index": i,
                "text": entry.get("text", "")[:200],
                "expected": label,
                "predicted": pred,
                "probability": results[i]["probability"],
                "note": entry.get("note", ""),
            })

    return predictions, labels, error_cases


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate crossroad turn detection model")
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR), help=f"Model directory (default: {DEFAULT_MODEL_DIR})")
    parser.add_argument("--test-dir", default=str(DEFAULT_TEST_DIR), help=f"Test cases directory (default: {DEFAULT_TEST_DIR})")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD, help=f"Turn probability threshold (default: {DEFAULT_THRESHOLD})")
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    test_dir = Path(args.test_dir)

    print("=" * 60)
    print("Crossroad Turn Detection — Evaluation")
    print("=" * 60)
    print(f"  Model dir: {model_dir}")
    print(f"  Test dir:  {test_dir}")
    print(f"  Threshold: {args.threshold}")

    # Load config if available
    config_path = model_dir / "config.json"
    if config_path.exists():
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        print(f"  Base model: {config.get('baseModel', 'unknown')}")
        print(f"  Trained at: {config.get('trainedAt', 'unknown')}")
        print(f"  Training samples: {config.get('trainingSamples', 'unknown')}")
        # Use config threshold if not overridden
        if args.threshold == DEFAULT_THRESHOLD and "threshold" in config:
            args.threshold = config["threshold"]
            print(f"  Using config threshold: {args.threshold}")

    # Load test cases
    print("\n[1/2] Loading test cases...")
    test_cases = load_all_test_cases(test_dir)
    total_entries = sum(len(v) for v in test_cases.values())
    print(f"  Loaded {len(test_cases)} test files with {total_entries} total entries")

    if not test_cases:
        print("Error: No test cases found", file=sys.stderr)
        sys.exit(1)

    # Check model exists
    onnx_path = model_dir / "model.onnx"
    if not onnx_path.exists():
        print(f"Error: ONNX model not found at {onnx_path}", file=sys.stderr)
        print("Run 'python train.py' first to train and export the model.", file=sys.stderr)
        sys.exit(1)

    # Evaluate
    print("\n[2/2] Running evaluation...")

    all_predictions: list[int] = []
    all_labels: list[int] = []
    all_errors: list[dict[str, Any]] = []
    per_file_metrics: dict[str, dict[str, Any]] = {}

    for file_name, entries in sorted(test_cases.items()):
        predictions, labels, errors = evaluate_test_set(entries, model_dir, args.threshold)
        all_predictions.extend(predictions)
        all_labels.extend(labels)

        if predictions:
            metrics = compute_metrics(predictions, labels)
            per_file_metrics[file_name] = metrics
            print(f"\n  {file_name} ({len(entries)} samples):")
            print(f"    Accuracy: {metrics['accuracy']:.4f}  Precision: {metrics['precision']:.4f}  "
                  f"Recall: {metrics['recall']:.4f}  F1: {metrics['f1']:.4f}")

        for err in errors:
            err["file"] = file_name
            all_errors.append(err)

    # Overall metrics
    print("\n" + "=" * 60)
    print("Overall Metrics")
    print("=" * 60)

    if all_predictions:
        overall = compute_metrics(all_predictions, all_labels)
        print(f"  Total samples: {len(all_predictions)}")
        print(f"  Accuracy:  {overall['accuracy']:.4f}")
        print(f"  Precision: {overall['precision']:.4f}")
        print(f"  Recall:    {overall['recall']:.4f}")
        print(f"  F1 Score:  {overall['f1']:.4f}")
        print_confusion_matrix(overall)

    # Error analysis
    if all_errors:
        print(f"\n{'=' * 60}")
        print(f"Error Analysis ({len(all_errors)} errors)")
        print("=" * 60)

        # Group by error type
        false_positives = [e for e in all_errors if e["expected"] == 0 and e["predicted"] == 1]
        false_negatives = [e for e in all_errors if e["expected"] == 1 and e["predicted"] == 0]

        print(f"\n  False Positives (predicted turn, actually no turn): {len(false_positives)}")
        for fp in false_positives[:10]:
            print(f"    [{fp['file']}] P={fp['probability']:.3f}: {fp['text'][:80]}...")

        print(f"\n  False Negatives (predicted no turn, actually turn): {len(false_negatives)}")
        for fn in false_negatives[:10]:
            print(f"    [{fn['file']}] P={fn['probability']:.3f}: {fn['text'][:80]}...")

        if len(all_errors) > 20:
            print(f"\n  ... and {len(all_errors) - 20} more errors")
    else:
        print("\n  No errors! Perfect classification.")

    print("\n" + "=" * 60)
    print("Evaluation complete.")
    print("=" * 60)


if __name__ == "__main__":
    main()