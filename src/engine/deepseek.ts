/**
 * deepseek.ts - DeepSeek provider (STUB)
 *
 * Same export shape as ollama.ts. Currently throws "not implemented".
 * Provider-agnostic utilities are imported from ./chat-helpers.js.
 */

import type { ChatResponse } from 'ollama';
import type { RetryConfig } from './chat-helpers.js';

export const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

/** Not available when using DeepSeek — always undefined. */
export const ollama: undefined = undefined;

/** Not available when using DeepSeek — always empty. */
export const OLLAMA_HOST = '';

export async function retryChat(
  _request: { model: string; messages?: unknown[]; tools?: unknown[]; [key: string]: unknown },
  _config?: Partial<RetryConfig> & { signal?: AbortSignal; neglected?: boolean; noSpinner?: boolean },
): Promise<ChatResponse> {
  throw new Error('DeepSeek provider not yet implemented');
}

export async function retryMultipleChoice(
  _request: { model: string; messages?: unknown[]; [key: string]: unknown },
  _choices: string[],
  _config?: Partial<RetryConfig> & { signal?: AbortSignal },
): Promise<string | null> {
  throw new Error('DeepSeek provider not yet implemented');
}
