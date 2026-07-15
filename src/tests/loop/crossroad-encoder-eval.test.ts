/**
 * crossroad-encoder-eval.test.ts - Precision/Recall evaluation of the real ONNX model.
 *
 * DISABLED BY DEFAULT. This runs the actual ONNX model (loaded via
 * crossroad-encoder.ts) against the labeled test-case JSONL datasets and
 * computes precision, recall, F1, accuracy, and a confusion matrix.
 *
 * It is heavy (loads the ONNX model + tokenizer, runs inference on every
 * sample) and requires the trained model to exist at
 * ~/.mycc-store/crossroad-model/. So it is gated behind an env flag.
 *
 * To run:
 *   RUN_CROSSROAD_EVAL=1 npx vitest run src/tests/loop/crossroad-encoder-eval.test.ts
 * (PowerShell:  $env:RUN_CROSSROAD_EVAL=1; npx vitest run src/tests/loop/crossroad-encoder-eval.test.ts)
 *
 * Datasets: ~/.mycc-store/crossroad-trainer/tests/test_cases (recursive .jsonl)
 * Each line: { text: string, label: 0|1, optional turnIndex }. label 1 = turn.
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCrossroadEncoder, resetCrossroadEncoderCache } from '../../loop/crossroad-encoder.js';

const RUN_EVAL = process.env.RUN_CROSSROAD_EVAL === '1';
const TEST_CASES_DIR = path.join(os.homedir(), '.mycc-store', 'crossroad-trainer', 'tests', 'test_cases');
const HELD_OUT_DIR = path.join(os.homedir(), '.mycc-store', 'crossroad-trainer', 'tests', 'held_out');

/** Recursively collect all .jsonl files under a directory. */
function collectJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsonlFiles(full));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** Parse a JSONL file into {text, label, file} samples. */
function loadJsonl(file: string): { text: string; label: number; file: string }[] {
  const samples: { text: string; label: number; file: string }[] = [];
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.text === 'string' && (obj.label === 0 || obj.label === 1)) {
        samples.push({ text: obj.text, label: obj.label, file });
      }
    } catch {
      // skip malformed lines
    }
  }
  return samples;
}

interface Metrics {
  tp: number; fp: number; tn: number; fn: number;
  precision: number; recall: number; f1: number; accuracy: number;
}

/** Compute metrics from per-sample (pred, actual) pairs. label 1 = positive (turn). */
function computeMetrics(predictions: { pred: number; actual: number }[]): Metrics {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { pred, actual } of predictions) {
    if (pred === 1 && actual === 1) tp++;
    else if (pred === 1 && actual === 0) fp++;
    else if (pred === 0 && actual === 0) tn++;
    else fn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = predictions.length === 0 ? 0 : (tp + tn) / predictions.length;
  return { tp, fp, tn, fn, precision, recall, f1, accuracy };
}

// Disabled by default; only runs when RUN_CROSSROAD_EVAL=1.
describe.runIf(RUN_EVAL)('CrossroadEncoder ONNX precision/recall eval', () => {
  test('model loads and achieves reasonable precision & recall on labeled test cases', async () => {
    resetCrossroadEncoderCache();
    const encoder = await getCrossroadEncoder();
    expect(encoder, 'Encoder is null — is the ONNX model trained/installed at ~/.mycc-store/crossroad-model/?').to.not.be.null;
    const cfg = encoder!.getConfig();
    const threshold = cfg.threshold; // 0.7 by default

    const files = collectJsonlFiles(TEST_CASES_DIR);
    expect(files.length, 'no test_case .jsonl files found').to.be.greaterThan(0);
    const samples: { text: string; label: number; file: string }[] = [];
    for (const f of files) samples.push(...loadJsonl(f));
    expect(samples.length, 'no valid labeled samples found').to.be.greaterThan(0);

    const predictions: { pred: number; actual: number; text: string; file: string; prob: number }[] = [];
    for (const s of samples) {
      const prob = await encoder!.predict(s.text);
      predictions.push({ pred: prob >= threshold ? 1 : 0, actual: s.label, text: s.text, file: s.file, prob });
    }

    const m = computeMetrics(predictions);
    // eslint-disable-next-line no-console
    console.log(`\n=== Crossroad Encoder Eval (threshold=${threshold}, n=${samples.length}) ===`);
    // eslint-disable-next-line no-console
    console.log(`TP=${m.tp} FP=${m.fp} TN=${m.tn} FN=${m.fn}`);
    // eslint-disable-next-line no-console
    console.log(`precision=${m.precision.toFixed(4)} recall=${m.recall.toFixed(4)} f1=${m.f1.toFixed(4)} accuracy=${m.accuracy.toFixed(4)}`);

    // Sanity thresholds: the model was trained on this distribution, so it
    // should clear a modest bar. If these fail, the model needs retraining.
    expect(m.accuracy, `accuracy ${m.accuracy} below 0.70`).to.be.greaterThanOrEqual(0.70);
    expect(m.f1, `f1 ${m.f1} below 0.60`).to.be.greaterThanOrEqual(0.60);
    expect(m.recall, `recall ${m.recall} below 0.50`).to.be.greaterThanOrEqual(0.50);
    expect(m.precision, `precision ${m.precision} below 0.50`).to.be.greaterThanOrEqual(0.50);
  }, 120000); // generous timeout: loads ONNX + runs inference over all samples

  test('per-dataset breakdown does not regress catastrophically on any single dataset', async () => {
    resetCrossroadEncoderCache();
    const encoder = await getCrossroadEncoder();
    expect(encoder).to.not.be.null;
    const threshold = encoder!.getConfig().threshold;

    const files = collectJsonlFiles(TEST_CASES_DIR);
    for (const f of files) {
      const samples = loadJsonl(f);
      if (samples.length === 0) continue;
      const preds = [];
      for (const s of samples) {
        const prob = await encoder!.predict(s.text);
        preds.push({ pred: prob >= threshold ? 1 : 0, actual: s.label });
      }
      const m = computeMetrics(preds);
      const name = path.relative(TEST_CASES_DIR, f);
      // eslint-disable-next-line no-console
      console.log(`  ${name}: n=${samples.length} acc=${m.accuracy.toFixed(3)} P=${m.precision.toFixed(3)} R=${m.recall.toFixed(3)} F1=${m.f1.toFixed(3)}`);
      // No single dataset should be near-random (<=0.50 acc) unless it's all one class.
      const hasBothClasses = samples.some(s => s.label === 1) && samples.some(s => s.label === 0);
      if (hasBothClasses) {
        expect(m.accuracy, `${name} accuracy ${m.accuracy} catastrophically low`).to.be.greaterThanOrEqual(0.45);
      }
    }
  }, 120000);

  test('held-out generalization: precision & recall on unseen 500-case dataset', async () => {
    resetCrossroadEncoderCache();
    const encoder = await getCrossroadEncoder();
    expect(encoder, 'Encoder is null — is the ONNX model trained/installed at ~/.mycc-store/crossroad-model/?').to.not.be.null;
    const cfg = encoder!.getConfig();
    const threshold = cfg.threshold;

    const files = collectJsonlFiles(HELD_OUT_DIR);
    expect(files.length, 'no held_out .jsonl files found — run scripts/gen-held-out.cjs').to.be.greaterThan(0);
    const samples: { text: string; label: number; file: string }[] = [];
    for (const f of files) samples.push(...loadJsonl(f));
    expect(samples.length, 'no valid labeled held-out samples found').to.be.greaterThan(0);

    const predictions: { pred: number; actual: number; text: string; file: string; prob: number }[] = [];
    for (const s of samples) {
      const prob = await encoder!.predict(s.text);
      predictions.push({ pred: prob >= threshold ? 1 : 0, actual: s.label, text: s.text, file: s.file, prob });
    }

    const m = computeMetrics(predictions);
    // eslint-disable-next-line no-console
    console.log(`\n=== Crossroad Encoder HELD-OUT Eval (threshold=${threshold}, n=${samples.length}) ===`);
    // eslint-disable-next-line no-console
    console.log(`TP=${m.tp} FP=${m.fp} TN=${m.tn} FN=${m.fn}`);
    // eslint-disable-next-line no-console
    console.log(`precision=${m.precision.toFixed(4)} recall=${m.recall.toFixed(4)} f1=${m.f1.toFixed(4)} accuracy=${m.accuracy.toFixed(4)}`);

    // Per-file breakdown (reuse predictions from the first pass — no double inference)
    for (const f of files) {
      const filePreds = predictions.filter(p => p.file === f);
      if (filePreds.length === 0) continue;
      const fm = computeMetrics(filePreds.map(p => ({ pred: p.pred, actual: p.actual })));
      const name = path.relative(HELD_OUT_DIR, f);
      // eslint-disable-next-line no-console
      console.log(`  ${name}: n=${filePreds.length} acc=${fm.accuracy.toFixed(3)} P=${fm.precision.toFixed(3)} R=${fm.recall.toFixed(3)} F1=${fm.f1.toFixed(3)}`);
    }

    // Held-out is the true generalization test — bar slightly lower than training
    // set since these are unseen cases, but still must beat random meaningfully.
    expect(m.accuracy, `held-out accuracy ${m.accuracy} below 0.65`).to.be.greaterThanOrEqual(0.65);
    expect(m.f1, `held-out f1 ${m.f1} below 0.55`).to.be.greaterThanOrEqual(0.55);
  }, 300000); // 500 samples + ONNX inference
});

// A no-op describe that always runs, so the file shows up in normal test runs
// with a clear marker that the eval exists but is disabled.
describe('CrossroadEncoder ONNX precision/recall eval (disabled by default)', () => {
  test('eval is gated behind RUN_CROSSROAD_EVAL=1 and was skipped', () => {
    // When the flag is off, the gated suite above is skipped entirely.
    // This test just documents how to enable it.
    if (!RUN_EVAL) {
      expect(RUN_EVAL).to.be.false;
    } else {
      expect(RUN_EVAL).to.be.true;
    }
  });
});