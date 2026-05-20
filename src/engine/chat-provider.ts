/**
 * chat-provider.ts - Single facade for ALL LLM functionality.
 *
 * Based on API_PROVIDER env var, re-exports from the active provider.
 * Both providers are statically imported — no top-level await needed.
 */

import { getApiProvider } from '../config.js';
import * as ollamaMod from './ollama.js';
import * as deepseekMod from './deepseek.js';

const active = getApiProvider() === 'deepseek' ? deepseekMod : ollamaMod;

// Chat (switchable — active provider)
export const MODEL = active.MODEL;
export const retryChat = active.retryChat;
export const retryMultipleChoice = active.retryMultipleChoice;

// Auxiliary (gated — may throw from deepseek)
export const webSearch = active.webSearch;
export const webFetch = active.webFetch;
export const imgDescribe = active.imgDescribe;
export const structuredChat = active.structuredChat;

// Health check (switchable — active provider)
export const healthCheck = active.healthCheck;

// Embedding (always Ollama)
export { getEmbedding } from './ollama-embedding.js';

// Re-export agnostic utilities
export {
  stopSpinner,
  isTransientError,
  classifyError,
  StreamAbortedError,
  StreamTimeoutError,
  DEFAULT_RETRY_CONFIG,
  calculateDelay,
  sleep,
  retryWithBackoff,
} from './chat-helpers.js';
export type { RetryConfig, ErrorType } from './chat-helpers.js';
