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
import type { RetryConfig } from './chat-helpers.js';

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

// Embedding (RAG provider — model-aware, auto-inferred from OLLAMA_EMBEDDING_MODEL)
export { getEmbedding, EMBEDDING_DIM, NAMESPACE, type EmbedMode } from './rag-provider.js';

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
 * PROMPT-CACHE CONTRACT — the fork's whole value is reusing the prefix the
 * main agent loop already paid to compute. That cached prefix is the EXACT
 * token sequence of system + projectContext + conversation messages + the
 * FULL tools schema. To keep the cache hit:
 *   - `messages` MUST be the un-minified, untruncated array the main loop sends
 *     (minifying/truncating rewrites the sequence → cache miss → full recompute).
 *   - `tools` MUST be the complete tool list (omitting it drops cached tokens
 *     → cache miss). Pass the same `getToolsForScope(...)` result the loop uses.
 * The ONE safe knob is `toolChoice`: it is a sampling parameter that governs
 * whether the model may EMIT tool calls — it is NOT part of the cached prefix
 * token sequence, so `toolChoice:'none'` constrains output to text-only while
 * keeping the tools schema cached. Use it for text-only forks (recap, crossroad).
 *
 * Used by:
 * - handleRecap — summarize checkpoint span for context compression
 * - crossroad — generate/select continuation candidates (toolChoice:'none')
 *
 * @param messages - Full messages to fork from (caller's copy before mutation)
 * @param tools - All available tools (for prompt cache preservation)
 * @param prompt - The prompt to merge into the last user message
 * @param signal - Optional AbortSignal for ESC handling
 * @param toolChoice - Optional 'none'|'auto'|'required'; 'none' keeps the cached
 *   prefix intact while forbidding tool-call output (text-only forks)
 * @returns The LLM's text response, or empty string on failure
 */
export async function forkChat(
  messages: Message[],
  tools: Tool[],
  prompt: string,
  signal?: AbortSignal,
  toolChoice?: 'none' | 'auto' | 'required',
  retryConfig?: Partial<RetryConfig>,
): Promise<string> {
  const msgs = [...messages];
  const lastIdx = msgs.length - 1;
  if (lastIdx >= 0 && msgs[lastIdx] && msgs[lastIdx].role === 'user') {
    msgs[lastIdx] = { ...msgs[lastIdx], content: `${msgs[lastIdx].content}\n\n${prompt}` };
  } else {
    msgs.push({ role: 'user', content: prompt });
  }

  // Build request with full tools (preserves the cached prefix) plus optional
  // toolChoice. toolChoice is a sampling param — NOT part of the cached token
  // sequence — so 'none' constrains output to text-only without a cache miss.
  // DeepSeek reads toolChoice from the request object (deepseek.ts:359-362);
  // Ollama spreads the entire request and silently ignores unknown fields.
  const chatRequest: Record<string, unknown> = {
    model: MODEL,
    messages: msgs,
    tools,
  };
  if (toolChoice) {
    chatRequest.toolChoice = toolChoice;
  }

  const response = await retryChat(
    chatRequest as Parameters<typeof retryChat>[0],
    { signal, noSpinner: true, ...retryConfig },
  );

  return response.message.content || '';
}
