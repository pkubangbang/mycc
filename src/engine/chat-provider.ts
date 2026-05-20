/**
 * chat-provider.ts - Barrel that re-exports from the active LLM provider.
 *
 * Based on API_PROVIDER env var, dynamically imports only the active provider.
 * The inactive provider's module is never loaded — no side effects (e.g. Ollama
 * client init) occur when using DeepSeek, and vice versa.
 */

import { getApiProvider } from '../config.js';

const provider = getApiProvider();

const activeModule = provider === 'deepseek'
  ? await import('./deepseek.js')
  : await import('./ollama.js');

export const MODEL = activeModule.MODEL;
export const retryChat = activeModule.retryChat;
export const retryMultipleChoice = activeModule.retryMultipleChoice;

// Re-export agnostic utilities for callers that previously imported from ollama.ts
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
