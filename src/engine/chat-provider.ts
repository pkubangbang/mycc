/**
 * chat-provider.ts - Single facade for ALL LLM functionality.
 *
 * Based on API_PROVIDER env var, re-exports from the active provider.
 * Both providers are statically imported — no top-level await needed.
 */

import { getApiProvider } from '../config.js';
import * as ollamaMod from './ollama.js';
import * as deepseekMod from './deepseek.js';
import type { Message, Tool } from '../types.js';

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

// ============================================================================
// forkChat — Side-chat forked from triologue with prompt cache
// ============================================================================

/**
 * Fork a single-turn chat from the current triologue state.
 * Copies messages, merges a prompt into the last user message, and calls
 * retryChat with all tools (to preserve prompt cache). Returns the LLM's
 * text content. Does NOT touch the triologue — callers own context management.
 *
 * Used by:
 * - SUGGEST phase (runSummarizing) — analyze conversation for skill probing
 * - handleRecap — summarize checkpoint span for context compression
 *
 * @param messages - Full messages to fork from (caller's copy before mutation)
 * @param tools - All available tools (for prompt cache preservation)
 * @param prompt - The prompt to merge into the last user message
 * @param signal - Optional AbortSignal for ESC handling
 * @returns The LLM's text response, or empty string on failure
 */
export async function forkChat(
  messages: Message[],
  tools: Tool[],
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const msgs = [...messages];
  const lastIdx = msgs.length - 1;
  if (lastIdx >= 0 && msgs[lastIdx].role === 'user') {
    msgs[lastIdx] = { ...msgs[lastIdx], content: `${msgs[lastIdx].content}\n\n${prompt}` };
  } else {
    msgs.push({ role: 'user', content: prompt });
  }

  const response = await retryChat(
    {
      model: MODEL,
      messages: msgs,
      tools,
    },
    { signal, noSpinner: true },
  );

  return response.message.content || '';
}
