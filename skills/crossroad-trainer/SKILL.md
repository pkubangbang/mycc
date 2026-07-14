---
name: crossroad-trainer
keywords:
  - crossroad
  - training
  - ML
  - encoder
  - detector
  - onnx
  - label
  - evaluate
description: >
  Workflow for training and iterating the ML-based crossroad streaming encoder
  detector. Covers: collecting training data from crossroad triggers, LLM-based
  auto-labeling, running the Python trainer in ~/.mycc-store/crossroad-trainer/,
  evaluating model accuracy, and deploying the ONNX model. Use when the user
  wants to improve crossroad detection accuracy, retrain the encoder, label
  collected data, or debug the detector.
---

# Crossroad Trainer Workflow

This skill describes the iterative workflow for training and improving the ML-based crossroad streaming encoder detector.

## Overview

mycc's crossroad feature detects when an LLM changes direction mid-response. There are two detectors:

1. **ML encoder detector** (preferred) — a DistilBERT-based ONNX classifier that runs in streaming mode during LLM output. Loaded from `~/.mycc-store/crossroad-model/` at startup.
2. **Regex fallback** — the original regex-based `detectTurningWord()` in `src/loop/crossroad.ts`. Used when the ONNX model is unavailable or doesn't detect a turn.

## The Iterative Loop

### Step 1: Collect Data (Automatic)

mycc automatically collects crossroad triggers to `~/.mycc-store/crossroad-trainer/data/auto-collected.jsonl` during normal usage. Each entry:
```json
{"text": "...", "turnIndex": 35, "source": "encoder", "timestamp": "..."}
```

No action needed — just use mycc normally and crossroad triggers accumulate.

### Step 2: Label Data (LLM Auto-Labeling)

Use `label.py` to auto-label collected data with a local LLM:

```bash
cd ~/.mycc-store/crossroad-trainer
pip install -r requirements.txt
python label.py --model glm-5:cloud
```

This asks the LLM whether each collected sample contains a genuine turning point, then writes results to `positive.jsonl` / `negative.jsonl`. Offline, no latency limit — large models are fine.

### Step 3: Train the Model

```bash
cd ~/.mycc-store/crossroad-trainer
python train.py --epochs 3 --batch-size 16
```

Fine-tunes DistilBERT on seed + labeled data, exports a quantized ONNX model to `~/.mycc-store/crossroad-model/`.

If network issues occur, use the proxy:
```bash
export HTTP_PROXY=http://127.0.0.1:7777
export HTTPS_PROXY=http://127.0.0.1:7777
python train.py
```

### Step 4: Evaluate

```bash
python evaluate.py --verbose
```

Runs the ONNX model on all test cases in `tests/test_cases/`, reports accuracy/F1/precision/recall + confusion matrix.

### Step 5: Deploy (Automatic)

The trained model is deployed to `~/.mycc-store/crossroad-model/`. Restart mycc to load the new model. If the model file is missing, mycc automatically falls back to regex detection.

### Step 6: Iterate

Repeat the loop: more usage → more collected data → better labels → better model → fewer false triggers → improved UX.

## ONNX Model Interface Contract

The exported ONNX model must follow this interface (the TS side in `src/loop/crossroad-encoder.ts` depends on it):

- **Inputs**: `input_ids` (int64 [1, seq_len]), `attention_mask` (int64 [1, seq_len])
- **Output**: `logits` (float32 [1, 2]) — index 0 = P(no turn), index 1 = P(turn)

mycc applies softmax and uses `probabilities[1]` as P(turn). If P(turn) > threshold (from `config.json`, default 0.7), crossroad triggers.

## File Locations

| Path | Purpose |
|------|---------|
| `~/.mycc-store/crossroad-trainer/` | Python training project |
| `~/.mycc-store/crossroad-trainer/train.py` | Training script |
| `~/.mycc-store/crossroad-trainer/label.py` | LLM auto-labeling |
| `~/.mycc-store/crossroad-trainer/evaluate.py` | Evaluation |
| `~/.mycc-store/crossroad-trainer/data/seed-*.jsonl` | Preset training data |
| `~/.mycc-store/crossroad-trainer/data/auto-collected.jsonl` | Runtime-collected |
| `~/.mycc-store/crossroad-trainer/tests/test_cases/` | Test cases (en/zh/edge) |
| `~/.mycc-store/crossroad-model/` | Deployed ONNX model |
| `src/loop/crossroad-encoder.ts` | TS encoder loader (mycc side) |
| `src/loop/streaming-crossroad-detector.ts` | TS streaming detector |
| `src/loop/crossroad.ts` | Regex fallback + orchestrator |

## Testing

### Python tests
```bash
cd ~/.mycc-store/crossroad-trainer
python -m pytest tests/ -v
```

### TypeScript tests
```bash
cd <mycc-project-root>
npx vitest run src/tests/loop/streaming-crossroad-detector.test.ts src/tests/loop/crossroad-encoder.test.ts
```