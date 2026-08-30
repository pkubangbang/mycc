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
import { probeModel, probeEmbeddingModel } from './health-check.js';
import {
  collectStream,
  isTransientError,
  calculateDelay,
  escalateFirstTokenTimeout,
  sleep,
  startSpinner,
  stopSpinner,
  retryWithBackoff,
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

  // Tool calls on assistant messages — ensure arguments are serialized as JSON strings
  if (extended.tool_calls && extended.tool_calls.length > 0) {
    normalized.tool_calls = extended.tool_calls.map((tc) => ({
      ...tc,
      type: (tc as unknown as Record<string, unknown>).type || 'function',
      function: {
        ...tc.function,
        arguments:
          typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments),
      },
    })) as unknown as OllamaToolCall[];

    // DeepSeek requires reasoning_content on ALL assistant messages with tool_calls
    // when thinking mode is enabled, even for messages from before the mode switch.
    if (!normalized.reasoning_content) {
      normalized.reasoning_content = '';
    }
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
  tool_choice?: 'none' | 'auto' | 'required';
  response_format?: { type: 'json_object' | 'text' };
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

/**
 * Parse accumulated tool-call argument fragments into an object.
 *
 * DeepSeek streams tool-call `function.arguments` as incremental string
 * fragments that are concatenated across chunks. If the stream ends
 * prematurely (connection drop, or `finish_reason='length'` due to the
 * max_tokens cap), the accumulated string is incomplete JSON and
 * `JSON.parse` throws `SyntaxError: Unterminated string in JSON ...`.
 *
 * Left unguarded, that SyntaxError is NOT matched by `isTransientError()`
 * (the message contains neither "premature" nor any network pattern), so
 * `retryChat` treats it as fatal and re-throws immediately — the user sees
 * the raw `Retry? [Y/n]` prompt instead of an automatic retry.
 *
 * We wrap the parse and, on failure, throw an error whose message includes
 * "premature close" so `isTransientError()` classifies it as transient and
 * `retryChat` auto-retries (a fresh stream usually completes successfully).
 */
// ollama's ToolCall.function.arguments is typed as { [key: string]: any },
// so the parsed object must match that shape. We cast JSON.parse's result
// rather than annotating the return type, to avoid the no-explicit-any rule.
type ToolCallArgs = ChatResponse['message']['tool_calls'] extends Array<infer T>
  ? T extends { function: { arguments: infer A } }
    ? A
    : never
  : never;

function safeParseToolArgs(args: string): ToolCallArgs {
  try {
    return JSON.parse(args) as ToolCallArgs;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `DeepSeek stream truncated: tool call arguments are incomplete JSON (${detail}). ` +
      `Likely finish_reason='length' or connection drop (premature close).`,
      { cause: err },
    );
  }
}

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

  // Detect max_tokens truncation BEFORE attempting to parse tool-call
  // arguments. When finish_reason='length', the stream was cut off mid-
  // generation and the accumulated tool-call argument fragments are almost
  // certainly incomplete JSON. Surfacing this as a transient error (the
  // message includes "premature close" so isTransientError() matches) lets
  // retryChat auto-retry with a fresh stream instead of failing inside
  // safeParseToolArgs or — worse — silently returning truncated arguments.
  if (finishReason === 'length') {
    throw new Error(
      `DeepSeek response truncated (finish_reason='length'): max_tokens limit ` +
      `hit mid-generation (premature close). Tool call arguments may be incomplete.`,
    );
  }

  const toolCalls: ChatResponse['message']['tool_calls'] = sortedBuilders.length > 0
    ? sortedBuilders.map((b) => ({
        id: b.id,
        type: b.type as 'function',
        function: {
          name: b.functionName,
          arguments: b.functionArgs ? safeParseToolArgs(b.functionArgs) : {},
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

  let spinnerStarted = false;
  if (!noSpinner) {
    startSpinner(neglected ? NEGLECTED_SPINNER_TEXT : 'Thinking');
    spinnerStarted = true;
  }

  try {
    for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
      if (signal?.aborted) throw new StreamAbortedError();

      if (attempt > 1) {
        agentIO.verbose('deepseek', `Retry attempt ${attempt}/${cfg.maxRetries + 1}`);
      }

      // Escalate the first-token timeout when the previous attempt failed with
      // a first-token timeout. Doubling per attempt (20→40→80→120s) lets a slow
      // model eventually make out instead of hitting the same wall 4× in a row.
      // Non-timeout transient errors (ECONNRESET, etc.) keep the base — more
      // time won't help a connectivity issue.
      const previousWasTimeout = lastError instanceof StreamTimeoutError;
      const attemptTimeoutMs = escalateFirstTokenTimeout(
        cfg.firstTokenTimeoutMs ?? 20000,
        attempt,
        cfg.responseTimeoutMs ?? 120000,
        previousWasTimeout,
      );
      if (previousWasTimeout && attempt > 1) {
        agentIO.verbose('deepseek', `Escalating first-token timeout to ${attemptTimeoutMs}ms for attempt ${attempt}`);
      }

      try {
        // Normalize messages from Ollama format to DeepSeek format.
        // Filter out any undefined / null / non-object entries defensively —
        // getMessages() already filters, but this is a second chokepoint so a
        // hole from any other caller (forkChat, retryMultipleChoice, wrap-up)
        // can never reach normalizeMessage and crash on `extended.role`.
        const messages = (request.messages || [])
          .filter((m): m is OllamaMessage => !!m && typeof m === 'object' && m.role !== undefined)
          .map(normalizeMessage);

        // Build DeepSeek request body
        const body: DeepSeekRequestBody = {
          model: request.model,
          messages,
          stream: true,
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
          // Set an explicit max_tokens to avoid the API's undocumented
          // default (inherited from legacy deepseek-chat, ~4096) silently
          // truncating large tool calls — e.g. write_file with a 35K-token
          // file. finish_reason='length' truncation produces incomplete
          // tool-call argument JSON, which surfaces as
          // "Unterminated string in JSON" errors.
          //
          // 65536 comfortably covers large file writes while staying well
          // within the V4 384K output ceiling; mycc keeps the prompt under
          // TOKEN_THRESHOLD (default 50K), so there is ample context budget.
          // max_tokens is an upper bound, not a forced length — the model
          // still stops naturally (finish_reason='stop') when done.
          max_tokens: 65536,
        };

        // Convert Ollama `think` param to DeepSeek thinking toggle
        if (request.think !== undefined) {
          if (request.think === false) {
            body.thinking = { type: 'disabled' };
            delete body.reasoning_effort;
          }
          // `true` / `'high'` / `'medium'` / `'low'` all map to enabled
        }

        if (request.tools && request.tools.length > 0) {
          body.tools = request.tools as unknown[];
        }

        // Allow callers to override tool_choice (e.g., 'none' for wrap-up)
        const toolChoice = (request as Record<string, unknown>).toolChoice;
        if (toolChoice) {
          body.tool_choice = toolChoice as DeepSeekRequestBody['tool_choice'];
        }

        // DeepSeek only supports { type: 'json_object' | 'text' }, not a raw
        // JSON Schema. The schema is communicated through the prompt instead.
        if (request.format) {
          body.response_format = { type: 'json_object' };
        }

        const stream = await deepseekChat(body, signal);

        const chunks = await collectStream<DeepSeekChunk>(
          stream,
          () => stream.abort(),
          {
            firstTokenTimeoutMs: attemptTimeoutMs,
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
          await sleep(delay, signal);
        }
      }
    }

    throw lastError || new Error('All retry attempts failed');
  } finally {
    if (spinnerStarted) stopSpinner();
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
          if (lastMessage && lastMessage.role === 'user') {
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

// ─── Auxiliary ────────────────────────────────────────────────────────────

// ============================================================================
// Web Search via DeepSeek Responses API
// ============================================================================
//
// DeepSeek exposes server-side web search ONLY through the Responses API
// (`POST /responses`), not `/chat/completions`. The `web_search` tool type is
// executed entirely on the server: the model decides whether to search, the
// server performs the search / page opens, and the model synthesises a final
// answer from the results.
//
// Wire format (verified live): the response `output` array is a list of items.
// Each `web_search_call` item records one search action:
//   { type: 'web_search_call', status, action: { type: 'search'|'open_page',
//     queries?: string[], url?: string } }
// and each `message` item carries model output in `content[].text` with a
// `phase` ('commentary' | 'final_answer'). The raw search snippets are NOT
// exposed to the client — the server folds them into the model's context and
// the distilled result appears in the final_answer message text.
//
// For mycc's `webSearch()` contract (`WebSearchResult[]`, each rendered as a
// numbered block) we return ONE result whose `content` is the obtained answer,
// prefixed with a compact search-activity summary (queries run / pages opened)
// so the caller can see what was actually searched. Mirrors ollama.ts's use of
// retryWithBackoff and throws on hard (non-transient) errors.

/** Shape of the `output` items returned by `POST /responses`. */
interface ResponsesOutputItem {
  type?: string;
  status?: string;
  id?: string;
  action?: {
    type?: string;
    queries?: string[];
    url?: string;
  };
  content?: Array<{ type?: string; text?: string }>;
  phase?: string;
  role?: string;
}

interface ResponsesResponse {
  status?: string;
  error?: { code?: string; message?: string } | null;
  output?: ResponsesOutputItem[];
}

/**
 * Call the DeepSeek Responses API (non-streaming) and extract the useful
 * content for a web search. Returns the synthesis (final answer) along with a
 * summary of the search actions the server performed.
 */
async function deepseekResponsesWebSearch(query: string): Promise<string> {
  const url = `${getHost()}/responses`;
  const apiKey = getApiKey();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: query,
      tools: [{ type: 'web_search' }],
      stream: false,
    }),
  });

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      // ignore
    }
    throw new Error(`DeepSeek Responses API error ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  const data = (await response.json()) as ResponsesResponse;
  if (data.status === 'failed') {
    throw new Error(
      `DeepSeek Responses API failed: ${data.error?.message || 'unknown error'}`,
    );
  }

  const items = data.output || [];

  // Collect search activity for a transparency summary.
  const searchLines: string[] = [];
  for (const item of items) {
    const action = item.action;
    if (!action) continue;
    if (action.type === 'search' && action.queries?.length) {
      searchLines.push(`Searched: ${action.queries.join('; ')}`);
    } else if (action.type === 'open_page' && action.url) {
      searchLines.push(`Opened page: ${action.url}`);
    }
  }

  // Extract the final answer: prefer the message whose phase is 'final_answer',
  // falling back to the last message item that carries output_text.
  let answer = '';
  const messages = items.filter((i) => i.type === 'message');
  const finalMsg = messages.find((m) => m.phase === 'final_answer') || messages[messages.length - 1];
  if (finalMsg?.content) {
    answer = finalMsg.content
      .filter((c) => c.type === 'output_text' && c.text)
      .map((c) => c.text as string)
      .join('\n')
      .trim();
  }

  // If the model produced no message text (e.g. answered only in reasoning or
  // returned an empty message), surface something actionable rather than an
  // empty result the caller would misread as "no results found".
  if (!answer) {
    const reason = items
      .filter((i) => i.type === 'reasoning')
      .flatMap((r) => (r.content || []).map((c) => c.text || ''))
      .join('\n')
      .trim();
    answer = reason ? `(No answer text returned; model reasoning: ${reason})` : '(No answer text returned by web search)';
  }

  const header =
    searchLines.length > 0 ? `Web search "${query}" — DeepSeek server-side result:\n${searchLines.join('\n')}\n\n` : '';

  return `${header}${answer}`;
}

export async function webSearch(query: string): Promise<WebSearchResult[]> {
  return retryWithBackoff(async () => {
    const content = await deepseekResponsesWebSearch(query);
    return [{ content }];
  }, { maxRetries: 2 });
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
  options?: { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
): Promise<ChatResponse> {
  const url = `${getHost()}/chat/completions`;
  const apiKey = getApiKey();
  const timeoutMs = options?.timeoutMs ?? 60000;
  const maxRetries = options?.maxRetries ?? 2;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Combine caller's signal with a timeout signal so a hung API call
    // can be aborted (ESC via caller signal, or the built-in timeout).
    // AbortSignal.any() is available on Node 20.3+; the project targets
    // Node 20+ (per @types/node ^24), so this is safe.
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (options?.signal) signals.push(options.signal);
    const combinedSignal = AbortSignal.any(signals);

    try {
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
        signal: combinedSignal,
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
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry on caller abort — propagate immediately.
      if (options?.signal?.aborted) throw lastError;
      // Don't retry on non-transient 4xx errors (bad request, auth).
      if (err instanceof Error && /DeepSeek API error 4\d\d/.test(err.message)) {
        throw err;
      }
      if (attempt < maxRetries) {
        // Linear backoff: 1s, 2s, ...
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError || new Error('structuredChat: all retries exhausted');
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

    // Probe embedding model. DeepSeek does not provide embeddings — Ollama
    // does, regardless of the chat API provider. A failure is a WARNING,
    // not a hard error — the agent can still run chat-only; RAG features
    // just fail at first use with an actionable hint.
    const embeddingWarning = await probeEmbeddingModel();
    if (embeddingWarning) {
      return {
        ok: true,
        warnings: [embeddingWarning],
        modelInfo: {
          name: MODEL,
          contextLength: DEEPSEEK_CONTEXT_LENGTH,
        },
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
