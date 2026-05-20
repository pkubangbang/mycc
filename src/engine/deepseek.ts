/**
 * deepseek.ts - DeepSeek provider
 *
 * Calls the DeepSeek API directly via raw fetch() with SSE streaming.
 * Same export shape as ollama.ts — uses identical parameter types.
 * Messages are normalized from Ollama format to DeepSeek format.
 */

import chalk from 'chalk';
import type { ChatRequest, ChatResponse, WebSearchResult, WebFetchResponse, Message as OllamaMessage, ToolCall as OllamaToolCall } from 'ollama';
import type { Message } from '../types.js';
import { agentIO } from '../loop/agent-io.js';
import type { HealthCheckResult } from './health-check.js';
import { probeModel } from './health-check.js';
import {
  collectStream,
  isTransientError,
  calculateDelay,
  sleep,
  startSpinner,
  stopSpinner,
  StreamAbortedError,
  StreamTimeoutError,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
  type RetryChatRequest,
  type RetryChatConfig,
} from './chat-helpers.js';

// ============================================================================
// Configuration
// ============================================================================

export const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

const NEGLECTED_SPINNER_TEXT = 'Hold on';

function getHost(): string {
  return process.env.DEEPSEEK_HOST || 'https://api.deepseek.com';
}

function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY || '';
}

// ============================================================================
// Message Normalization (Ollama format → DeepSeek format)
// ============================================================================

interface NormalizedMessage {
  role: string;
  content: string;
  reasoning_content?: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

function normalizeMessage(msg: OllamaMessage): NormalizedMessage {
  // The codebase uses the extended `Message` type which adds tool_call_id + reasoning_content
  const extended = msg as Message;

  const normalized: NormalizedMessage = {
    role: extended.role,
    content: extended.content,
  };

  // Copy DeepSeek-compatible fields from the extended message type
  if (extended.tool_call_id) {
    normalized.tool_call_id = extended.tool_call_id;
  }
  if (extended.reasoning_content) {
    normalized.reasoning_content = extended.reasoning_content;
  }

  // Convert Ollama `thinking` → DeepSeek `reasoning_content` (if no reasoning_content)
  if (!normalized.reasoning_content && extended.thinking) {
    normalized.reasoning_content = extended.thinking;
  }

  // Tool calls on assistant messages
  if (extended.tool_calls && extended.tool_calls.length > 0) {
    normalized.tool_calls = extended.tool_calls;
  }

  return normalized;
}

// ============================================================================
// DeepSeek-Specific Types
// ============================================================================

interface DeepSeekToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface DeepSeekChunk {
  choices?: Array<{
    index: number;
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

interface DeepSeekRequestBody {
  model: string;
  messages: NormalizedMessage[];
  stream: true;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'high' | 'max';
  max_tokens?: number;
  tools?: unknown[];
}

// ============================================================================
// SSE Streaming via fetch()
// ============================================================================

class FetchAsyncIterable implements AsyncIterable<DeepSeekChunk> {
  constructor(
    private reader: ReadableStreamDefaultReader<Uint8Array>,
    private abortFn: () => void,
  ) {}

  abort(): void {
    this.abortFn();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<DeepSeekChunk> {
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            yield JSON.parse(data);
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      this.reader.releaseLock();
    }
  }
}

async function deepseekChat(
  body: DeepSeekRequestBody,
  signal?: AbortSignal,
): Promise<FetchAsyncIterable> {
  const url = `${getHost()}/chat/completions`;
  const apiKey = getApiKey();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      // ignore
    }
    throw new Error(`DeepSeek API error ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('DeepSeek API returned empty response body');
  }

  return new FetchAsyncIterable(reader, () => reader.cancel());
}

// ============================================================================
// Chunk Reconstruction (DeepSeek-specific)
// ============================================================================

function reconstructResponse(chunks: DeepSeekChunk[], model: string): ChatResponse {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  let finishReason = '';
  const toolCallBuilders = new Map<number, {
    id: string;
    type: string;
    functionName: string;
    functionArgs: string;
  }>();

  for (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (delta?.content) {
      contentParts.push(delta.content);
    }
    if (delta?.reasoning_content) {
      reasoningParts.push(delta.reasoning_content);
    }
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let builder = toolCallBuilders.get(idx);
        if (!builder) {
          builder = { id: '', type: 'function', functionName: '', functionArgs: '' };
          toolCallBuilders.set(idx, builder);
        }
        if (tc.id) builder.id = tc.id;
        if (tc.type) builder.type = tc.type;
        if (tc.function?.name) builder.functionName = tc.function.name;
        if (tc.function?.arguments) builder.functionArgs += tc.function.arguments;
      }
    }
  }

  const sortedBuilders = [...toolCallBuilders.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => b);

  const toolCalls: ChatResponse['message']['tool_calls'] = sortedBuilders.length > 0
    ? sortedBuilders.map((b) => ({
        id: b.id,
        type: b.type as 'function',
        function: {
          name: b.functionName,
          arguments: b.functionArgs ? JSON.parse(b.functionArgs) : {},
        },
      }))
    : undefined;

  return {
    model,
    created_at: new Date(),
    message: {
      role: 'assistant' as const,
      content: contentParts.join(''),
      ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join('') } : {}),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
    done: true,
    done_reason: finishReason,
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: 0,
    prompt_eval_duration: 0,
    eval_count: 0,
    eval_duration: 0,
  };
}

// ============================================================================
// retryChat (same signature as ollama.ts)
// ============================================================================

export async function retryChat(
  request: RetryChatRequest,
  config?: RetryChatConfig,
): Promise<ChatResponse> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  const signal = config?.signal;
  const neglected = config?.neglected ?? false;
  const noSpinner = config?.noSpinner ?? false;
  let lastError: Error | null = null;

  if (!noSpinner) {
    startSpinner(neglected ? NEGLECTED_SPINNER_TEXT : 'Thinking');
  }

  try {
    for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
      if (signal?.aborted) throw new StreamAbortedError();

      if (attempt > 1) {
        agentIO.verbose('deepseek', `Retry attempt ${attempt}/${cfg.maxRetries + 1}`);
      }

      try {
        // Normalize messages from Ollama format to DeepSeek format
        const messages = (request.messages || []).map(normalizeMessage);

        // Build DeepSeek request body
        const body: DeepSeekRequestBody = {
          model: request.model,
          messages,
          stream: true,
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
        };

        // Convert Ollama `think` param to DeepSeek thinking toggle
        if (request.think !== undefined) {
          if (request.think === false) {
            body.thinking = { type: 'disabled' };
          }
          // `true` / `'high'` / `'medium'` / `'low'` all map to enabled
        }

        if (request.tools && request.tools.length > 0) {
          body.tools = request.tools as unknown[];
        }

        const stream = await deepseekChat(body, signal);

        const chunks = await collectStream<DeepSeekChunk>(
          stream,
          () => stream.abort(),
          {
            firstTokenTimeoutMs: cfg.firstTokenTimeoutMs,
            responseTimeoutMs: cfg.responseTimeoutMs,
            signal,
          },
        );

        const response = reconstructResponse(chunks, body.model);
        return response;
      } catch (err) {
        if (err instanceof StreamAbortedError) throw err;

        if (err instanceof StreamTimeoutError) {
          lastError = err;
        } else if (!isTransientError(err)) {
          throw err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }

        const isLastAttempt = attempt > cfg.maxRetries;
        if (!isLastAttempt) {
          const delay = calculateDelay(attempt, cfg);
          agentIO.verbose('deepseek', `Attempt ${attempt}/${cfg.maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`);
          await sleep(delay);
        }
      }
    }

    throw lastError || new Error('All retry attempts failed');
  } finally {
    stopSpinner();
  }
}

// ============================================================================
// retryMultipleChoice (same signature as ollama.ts)
// ============================================================================

export async function retryMultipleChoice(
  request: Omit<ChatRequest, 'stream'>,
  choices: string[],
  config?: Partial<RetryConfig> & { signal?: AbortSignal },
): Promise<string | null> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  const validChoices = choices.map(c => c.toUpperCase());

  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
    if (config?.signal?.aborted) {
      return null;
    }

    try {
      const response = await retryChat(request, { ...config, noSpinner: true });
      const content = (response.message?.content || '').trim().toUpperCase();

      for (const choice of validChoices) {
        if (content === choice || content.includes(choice)) {
          return choice;
        }
      }

      if (attempt <= cfg.maxRetries) {
        const delay = calculateDelay(attempt, cfg);
        if (request.messages && request.messages.length > 0) {
          const lastMessage = request.messages[request.messages.length - 1];
          if (lastMessage.role === 'user') {
            lastMessage.content += `\n\nYour previous response was invalid. You must respond with exactly one of: ${validChoices.join(', ')}. No other text.`;
          }
        }
        await sleep(delay);
      }
    } catch {
      if (attempt <= cfg.maxRetries) {
        const delay = calculateDelay(attempt, cfg);
        await sleep(delay);
      }
    }
  }

  return null;
}

// ─── Auxiliary (not supported by DeepSeek) ───────────────────────────────

export async function webSearch(_query: string): Promise<WebSearchResult[]> {
  throw new Error('webSearch not supported by DeepSeek provider');
}

export async function webFetch(_url: string): Promise<WebFetchResponse> {
  throw new Error('webFetch not supported by DeepSeek provider');
}

export async function imgDescribe(_image: string, _prompt?: string): Promise<string> {
  throw new Error('imgDescribe not supported by DeepSeek provider');
}

export async function structuredChat(
  messages: { role: string; content: string }[],
  _format: object,
): Promise<ChatResponse> {
  const url = `${getHost()}/chat/completions`;
  const apiKey = getApiKey();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`DeepSeek API error ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];

  return {
    model: data.model || MODEL,
    created_at: new Date(),
    message: {
      role: 'assistant' as const,
      content: choice?.message?.content || '',
    },
    done: true,
    done_reason: choice?.finish_reason || 'stop',
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: data.usage?.prompt_tokens || 0,
    prompt_eval_duration: 0,
    eval_count: data.usage?.completion_tokens || 0,
    eval_duration: 0,
  };
}

// ─── Health check ─────────────────────────────────────────────────────────

const DEEPSEEK_CONTEXT_LENGTH = 1048576;

export async function healthCheck(tokenThreshold: number): Promise<HealthCheckResult> {
  startSpinner('Powered by DeepSeek. Initializing');
  const startTime = Date.now();

  try {
    const { motd } = await probeModel(retryChat, MODEL);

    stopSpinner();
    const elapsed = Date.now() - startTime;
    console.log(`[deepseek] Health check passed (${elapsed}ms)`);
    console.log(chalk.cyan(`✨ ${motd}`));

    const maxThreshold = Math.floor(DEEPSEEK_CONTEXT_LENGTH * 0.8);
    if (tokenThreshold > maxThreshold) {
      return {
        ok: false,
        error: `TOKEN_THRESHOLD (${tokenThreshold}) exceeds 80% of model context length (${DEEPSEEK_CONTEXT_LENGTH}). Reduce TOKEN_THRESHOLD to ${maxThreshold} or less.`,
      };
    }

    return {
      ok: true,
      modelInfo: {
        name: MODEL,
        contextLength: DEEPSEEK_CONTEXT_LENGTH,
      },
    };
  } catch (err) {
    stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `DeepSeek API error for model '${MODEL}'. ${msg}. Check DEEPSEEK_API_KEY and DEEPSEEK_MODEL in .mycc/.env.`,
    };
  }
}
