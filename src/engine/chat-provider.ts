/**
 * chat-provider.ts - Barrel that re-exports from the active LLM provider.
 *
 * Based on API_PROVIDER env var, re-exports retryChat, MODEL, retryMultipleChoice
 * from either ollama.ts or deepseek.ts.
 */

import { getApiProvider } from '../config.js';
import {
  retryChat as ollamaRetryChat,
  MODEL as OLLAMA_MODEL,
  retryMultipleChoice as ollamaRetryMultipleChoice,
} from './ollama.js';
import {
  retryChat as deepseekRetryChat,
  MODEL as DEEPSEEK_MODEL,
  retryMultipleChoice as deepseekRetryMultipleChoice,
} from './deepseek.js';

const provider = getApiProvider();

export const MODEL = provider === 'deepseek' ? DEEPSEEK_MODEL : OLLAMA_MODEL;
export const retryChat = provider === 'deepseek' ? deepseekRetryChat : ollamaRetryChat;
export const retryMultipleChoice = provider === 'deepseek' ? deepseekRetryMultipleChoice : ollamaRetryMultipleChoice;

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
