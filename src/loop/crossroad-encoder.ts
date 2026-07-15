/**
 * crossroad-encoder.ts - ONNX encoder loader + inference wrapper
 *
 * Loads a DistilBERT-based ONNX model from ~/.mycc-store/crossroad-model/
 * and runs streaming inference to detect turning points in LLM output.
 *
 * Design:
 * - Lazy singleton: model is loaded on first create() call, cached thereafter.
 * - Dynamic import: onnxruntime-node and @huggingface/transformers are loaded
 *   via dynamic import() inside create() so users without these packages
 *   don't get import errors at startup.
 * - Graceful fallback: any failure returns null, causing the caller to fall
 *   back to the existing regex detector.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { agentIO } from './agent-io.js';

// ============================================================================
// Config Interface
// ============================================================================

export interface CrossroadModelConfig {
  version: number;
  baseModel: string;
  maxSequenceLength: number;
  threshold: number;
  checkInterval: number;
  trainedAt: string;
  trainingSamples: number;
}

// ============================================================================
// Types (minimal, to avoid importing heavy libs at module scope)
// ============================================================================

/** Subset of onnxruntime-node InferenceSession we use. */
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>;
}

/** Subset of @huggingface/transformers tokenizer we use.
 * NOTE: In @huggingface/transformers v4.x, AutoTokenizer.encode() returns a
 * plain number[] (the input_ids), NOT an object with a .data property. */
interface Tokenizer {
  encode(text: string, options?: { add_special_tokens?: boolean; max_length?: number; truncation?: boolean }): number[];
}

// ============================================================================
// Encoder
// ============================================================================

export class CrossroadEncoder {
  private session: OrtSession;
  private tokenizer: Tokenizer;
  private config: CrossroadModelConfig;
  private maxSequenceLength: number;
  /** Reference to the onnxruntime-node module (stored at create() time) so
   * predict() can construct ort.Tensor feed wrappers. */
  private ort: any;

  private constructor(
    session: OrtSession,
    tokenizer: Tokenizer,
    config: CrossroadModelConfig,
    ort: any,
  ) {
    this.session = session;
    this.tokenizer = tokenizer;
    this.config = config;
    this.maxSequenceLength = config.maxSequenceLength;
    this.ort = ort;
  }

  /** Singleton instance — cached after first successful create(). */
  private static instance: CrossroadEncoder | null | undefined = undefined;

  /**
   * Lazily load and create the encoder singleton.
   *
   * Loads:
   * - ONNX model from ~/.mycc-store/crossroad-model/model.onnx
   * - Tokenizer from ~/.mycc-store/crossroad-model/ (via @huggingface/transformers)
   * - Config from ~/.mycc-store/crossroad-model/config.json
   *
   * Any step fails → return null (regex fallback).
   * Uses dynamic import() so missing packages don't crash startup.
   */
  static async create(): Promise<CrossroadEncoder | null> {
    // Return cached instance if available
    if (CrossroadEncoder.instance !== undefined) {
      return CrossroadEncoder.instance;
    }

    try {
      const modelDir = path.join(os.homedir(), '.mycc-store', 'crossroad-model');
      const modelPath = path.join(modelDir, 'model.onnx');
      const configPath = path.join(modelDir, 'config.json');

      // Check model file exists
      if (!fs.existsSync(modelPath)) {
        agentIO.verbose('crossroad-encoder', `Model file not found at ${modelPath}`);
        CrossroadEncoder.instance = null;
        return null;
      }

      // Load config
      if (!fs.existsSync(configPath)) {
        agentIO.verbose('crossroad-encoder', `Config file not found at ${configPath}`);
        CrossroadEncoder.instance = null;
        return null;
      }
      const configRaw = await fs.promises.readFile(configPath, 'utf-8');
      const config = JSON.parse(configRaw) as CrossroadModelConfig;

      // Dynamic import of heavy ML dependencies — users without these
      // packages get null (regex fallback) instead of an import error.
      // Using string variables to prevent TS from resolving module types at
      // compile time (these packages are optional and may not be installed).
      let ort: any;
      let transformers: any;
      try {
        const ortModule = 'onnxruntime-node';
        ort = await import(/* @vite-ignore */ ortModule);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        agentIO.verbose('crossroad-encoder', `onnxruntime-node not available: ${msg}`);
        CrossroadEncoder.instance = null;
        return null;
      }
      try {
        const transformersModule = '@huggingface/transformers';
        transformers = await import(/* @vite-ignore */ transformersModule);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        agentIO.verbose('crossroad-encoder', `@huggingface/transformers not available: ${msg}`);
        CrossroadEncoder.instance = null;
        return null;
      }

      // Create ONNX session
      const numThreads = Math.max(1, Math.floor(os.cpus().length / 2));
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        intraOpNumThreads: numThreads,
        graphOptimizationLevel: 'all',
      }) as unknown as OrtSession;

      // Load tokenizer from model directory
      const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelDir) as unknown as Tokenizer;

      agentIO.verbose('crossroad-encoder',
        `Loaded model (baseModel=${config.baseModel}, threshold=${config.threshold}, maxSeq=${config.maxSequenceLength})`);

      const encoder = new CrossroadEncoder(session as OrtSession, tokenizer, config, ort);
      CrossroadEncoder.instance = encoder;
      return encoder;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agentIO.verbose('crossroad-encoder', `Failed to create encoder: ${msg}`);
      CrossroadEncoder.instance = null;
      return null;
    }
  }

  /**
   * Predict P(turn) for a given text.
   *
   * - Tokenizes text (truncates to maxSequenceLength)
   * - Runs ONNX session with input_ids (int64 [1, seq_len]) + attention_mask (int64 [1, seq_len])
   * - Applies softmax to logits output
   * - Returns probabilities[1] = P(turn)
   */
  async predict(text: string): Promise<number> {
    // Tokenize — encode() returns number[] directly (v4.x of @huggingface/transformers)
    const inputIds = this.tokenizer.encode(text, {
      add_special_tokens: true,
      max_length: this.maxSequenceLength,
      truncation: true,
    });

    // Build attention mask (all ones — no padding)
    const attentionMask = new Array(inputIds.length).fill(1);
    const seqLen = inputIds.length;

    // onnxruntime-node requires feeds to be ort.Tensor wrappers, not bare arrays.
    // input_ids / attention_mask are int64 [1, seq_len].
    const inputIdsTensor = new this.ort.Tensor(
      'int64',
      BigInt64Array.from(inputIds.map((v) => BigInt(v))),
      [1, seqLen],
    );
    const attentionMaskTensor = new this.ort.Tensor(
      'int64',
      BigInt64Array.from(attentionMask.map((v) => BigInt(v))),
      [1, seqLen],
    );

    // Run inference
    const feeds: Record<string, unknown> = {
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor,
    };

    const output = await this.session.run(feeds);

    // Get logits — float32 [1, 2]
    const logitsData = output['logits']?.data;
    if (!logitsData || logitsData.length < 2) {
      throw new Error('ONNX output logits missing or malformed');
    }

    // Extract logits[0] and logits[1]
    const logit0 = Number(logitsData[0]);
    const logit1 = Number(logitsData[1]);

    // Softmax: P(turn) = exp(logit1) / (exp(logit0) + exp(logit1))
    const maxLogit = Math.max(logit0, logit1);
    const exp0 = Math.exp(logit0 - maxLogit);
    const exp1 = Math.exp(logit1 - maxLogit);
    const probTurn = exp1 / (exp0 + exp1);

    return probTurn;
  }

  /** Get the model config (threshold, checkInterval, etc.) */
  getConfig(): CrossroadModelConfig {
    return this.config;
  }

  /** Reset the singleton (useful for testing). */
  static reset(): void {
    CrossroadEncoder.instance = undefined;
  }
}

// ============================================================================
// Lazy Singleton Accessor
// ============================================================================

/**
 * Lazy singleton accessor for the crossroad encoder.
 * Caches the result of CrossroadEncoder.create() so the model is only
 * loaded once per process. Returns null if the model is unavailable.
 */
let encoderCache: CrossroadEncoder | null | undefined;

export async function getCrossroadEncoder(): Promise<CrossroadEncoder | null> {
  if (encoderCache !== undefined) return encoderCache;
  encoderCache = await CrossroadEncoder.create();
  return encoderCache;
}

/** Reset the encoder cache (useful for testing).
 * Clears BOTH the module-level cache and the static instance so that the
 * next getCrossroadEncoder() call performs a fresh load. Failing to clear
 * both leaves a stale singleton — the two-cache split is a known footgun. */
export function resetCrossroadEncoderCache(): void {
  encoderCache = undefined;
  CrossroadEncoder.reset();
}