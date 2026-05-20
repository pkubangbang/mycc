/**
 * chat-provider.ts - Single facade for ALL LLM functionality.
 *
 * Based on API_PROVIDER env var, dynamically imports only the active provider.
 * Chat is switchable. Auxiliary features (webSearch, webFetch, imgDescribe)
 * are gated — they work with Ollama, throw with DeepSeek.
 * Embedding is always Ollama (local model, independent of chat provider).
 */

import { getApiProvider } from '../config.js';

const provider = getApiProvider();

const activeModule = provider === 'deepseek'
  ? await import('./deepseek.js')
  : await import('./ollama.js');

// Chat (switchable — active provider)
export const MODEL = activeModule.MODEL;
export const retryChat = activeModule.retryChat;
export const retryMultipleChoice = activeModule.retryMultipleChoice;

// Auxiliary (gated — may throw from deepseek)
export const webSearch = activeModule.webSearch;
export const webFetch = activeModule.webFetch;
export const imgDescribe = activeModule.imgDescribe;
export const structuredChat = activeModule.structuredChat;

// Health check (switchable — active provider)
export const healthCheck = activeModule.healthCheck;

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
