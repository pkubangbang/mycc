/**
 * ollama.ts - Ollama client initialization utility
 *
 * Centralizes Ollama client configuration for all agent files.
 */

import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse } from 'ollama';
import chalk from 'chalk';
import { isVerbose, getOllamaHost, getOllamaApiKey, getOllamaModel, isVisionEnabled } from './config.js';

// Configuration (resolved via config.ts)
export const OLLAMA_HOST = getOllamaHost();
export const OLLAMA_API_KEY = getOllamaApiKey();
export const MODEL = getOllamaModel();

// Initialize Ollama client
export const ollama = new Ollama({
  host: OLLAMA_HOST,
  ...(OLLAMA_API_KEY ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } } : {}),
});

/**
 * Transient error patterns that indicate recoverable network issues
 */
const TRANSIENT_ERROR_PATTERNS = [
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'unexpected eof',
  'connection reset',
  'socket hang up',
  'network error',
  'fetch failed',
  'rate limit',
  'timeout',
  'aborted',
  'service temporarily unavailable',
  '503',
  '500',
  '502',
  '504',
  'internal server error',
  'bad gateway',
  'gateway timeout',
];

/**
 * Check if an error is transient (recoverable with retry)
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

/**
 * Error types for different handling strategies
 */
export type ErrorType = 'transient' | 'auth' | 'model' | 'config' | 'fatal';

/**
 * Classify an error by type for appropriate handling
 */
export function classifyError(err: unknown): ErrorType {
  if (!(err instanceof Error)) return 'fatal';
  const msg = err.message.toLowerCase();

  // Auth errors - user action required
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return 'auth';
  }

  // Model errors - user action required
  if (msg.includes('model') && (msg.includes('not found') || msg.includes('does not exist'))) {
    return 'model';
  }

  // Config errors - context length exceeded
  if (msg.includes('context') && msg.includes('exceed')) {
    return 'config';
  }

  // Transient errors - auto-retry
  if (isTransientError(err)) return 'transient';

  return 'fatal';
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
  modelInfo?: {
    name: string;
    contextLength: number;
    family?: string;
    parameterSize?: string;
  };
}

/**
 * Inline startup tool definition for health check
 * This tool is exclusive to checkHealth and not mixed with built-in tools
 */
const STARTUP_TOOL = {
  type: 'function' as const,
  function: {
    name: 'start_up',
    description: 'Report model capabilities and provide a fun message of the day. Call this tool exactly once with your model information.',
    parameters: {
      type: 'object',
      properties: {
        context_length: {
          type: 'number',
          description: 'The maximum context window size in tokens for this model',
        },
        motd: {
          type: 'string',
          description: 'A fun, creative, or witty message of the day (a short phrase, wordplay, or greeting)',
        },
      },
      required: ['context_length', 'motd'],
    },
  },
};

/**
 * Check Ollama server connectivity and model availability
 *
 * Validates:
 * 1. Ollama server is reachable
 * 2. Model exists and responds
 * 3. TOKEN_THRESHOLD doesn't exceed 80% of model's context length
 */
export async function checkHealth(tokenThreshold: number): Promise<HealthCheckResult> {
  try {
    // 1. Check server connectivity
    await ollama.list();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Cannot connect to Ollama at ${OLLAMA_HOST}. ${msg}. Make sure Ollama is running.`,
    };
  }

  try {
    // 2. Check model exists via show()
    const modelInfo = await ollama.show({ model: MODEL });

    // 3. Use model info as the input
    const modelInfoDisplay = JSON.stringify(modelInfo, null, 2);

    // 4. Query model for context length via tool call (with retry)
    let contextLength = 4096; // Default fallback
    let motd = 'Ready to code!'; // Default MOTD

    startSpinner('Powered by Ollama. Initializing');
    const startTime = Date.now();

    const maxRetries = 3;
    const baseDelayMs = 1000;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const response = await ollama.chat({
          model: MODEL,
          messages: [
            {
              role: 'user',
              content: `You are starting up. Here is your model information:\n\n${modelInfoDisplay}\n\nCall the start_up tool to report your context length and provide a fun message of the day.`,
            },
          ],
          tools: [STARTUP_TOOL],
        });

        // Extract tool call result
        if (response.message.tool_calls && response.message.tool_calls.length > 0) {
          const toolCall = response.message.tool_calls[0];
          if (toolCall.function.name === 'start_up') {
            const args = toolCall.function.arguments as { context_length?: number; motd?: string };
            if (typeof args.context_length === 'number') {
              contextLength = args.context_length;
            }
            if (typeof args.motd === 'string' && args.motd.trim()) {
              motd = args.motd.trim();
            }
          }
        }

        // Success - break out of retry loop
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = err instanceof Error ? err : new Error(msg);

        // Only retry on transient errors
        if (!isTransientError(err)) {
          stopSpinner();
          return {
            ok: false,
            error: `Model '${MODEL}' error: ${msg}. Ensure the model is running and can process requests.`,
          };
        }

        // Check if this was the last attempt
        if (attempt <= maxRetries) {
          const delay = calculateDelay(attempt, { ...DEFAULT_RETRY_CONFIG, baseDelayMs, maxDelayMs: 10000 });
          console.log(`[ollama] Health check attempt ${attempt}/${maxRetries + 1} failed: ${msg}. Retrying in ${delay}ms...`);
          await sleep(delay);
        }
      }
    }

    // Check if all retries exhausted
    if (lastError) {
      stopSpinner();
      return {
        ok: false,
        error: `Model '${MODEL}' error after ${maxRetries + 1} attempts: ${lastError.message}. Ensure the model is running and can process requests.`,
      };
    }

    stopSpinner();
    const elapsed = Date.now() - startTime;
    console.log(`[ollama] Health check passed (${elapsed}ms)`);
    console.log(chalk.cyan(`✨ ${motd}`));

    // 5. Validate TOKEN_THRESHOLD doesn't exceed 80% of context length
    const maxThreshold = Math.floor(contextLength * 0.8);
    if (tokenThreshold > maxThreshold) {
      return {
        ok: false,
        error: `TOKEN_THRESHOLD (${tokenThreshold}) exceeds 80% of model context length (${contextLength}). Reduce TOKEN_THRESHOLD to ${maxThreshold} or less.`,
      };
    }

    return {
      ok: true,
      warnings: isVisionEnabled() ? undefined : [
        'OLLAMA_VISION_MODEL is not set. Vision features (screen/read_picture tools) are disabled.',
        'Set it to a vision model (e.g., OLLAMA_VISION_MODEL=gemma4:31b-cloud) or "none" to dismiss this warning.',
      ],
      modelInfo: {
        name: MODEL,
        contextLength,
        family: modelInfo.details?.family,
        parameterSize: modelInfo.details?.parameter_size,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Model '${MODEL}' not found or unavailable. ${msg}. Run 'ollama list' to see available models.`,
    };
  }
}

/**
 * Retry configuration for Ollama API calls
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs: number;
  /** Request timeout in milliseconds (default: 300000 = 5 minutes) */
  timeoutMs?: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  timeoutMs: 300000, // 5 minutes default
};

/**
 * Generic retry with exponential backoff
 * Can be used for any async operation that may fail transiently
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config?: Partial<RetryConfig>
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
    try {
      // Apply timeout if specified
      if (cfg.timeoutMs) {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Request timed out after ${cfg.timeoutMs}ms`)), cfg.timeoutMs)
          ),
        ]);
      }
      return await operation();
    } catch (err) {
      // Check if it's a transient error
      if (!isTransientError(err)) {
        throw err;
      }

      lastError = err instanceof Error ? err : new Error(String(err));

      const isLastAttempt = attempt > cfg.maxRetries;
      if (!isLastAttempt) {
        const delay = calculateDelay(attempt, cfg);
        console.log(`[retry] Attempt ${attempt}/${cfg.maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('All retry attempts failed');
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
  // Add jitter (±25%) to prevent thundering herd
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Simple spinner for indicating API activity
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

function startSpinner(prefix: string = 'Thinking'): void {
  if (spinnerInterval) return; // Already running

  process.stderr.write('\x1b[?25l'); // Hide cursor
  spinnerFrame = 0;
  spinnerInterval = setInterval(() => {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    process.stderr.write(`\r${frame} ${prefix}...`);
    spinnerFrame++;
  }, 80);
}

/**
 * Spinner text for neglected mode
 */
const NEGLECTED_SPINNER_TEXT = 'Hold on';

function stopSpinner(): void {
  if (!spinnerInterval) return;

  clearInterval(spinnerInterval);
  spinnerInterval = null;
  process.stderr.write('\r\x1b[K'); // Clear line
  process.stderr.write('\x1b[?25h'); // Show cursor
}

/**
 * Chat with automatic retry on transient errors
 *
 * Wraps ollama.chat() with:
 * - Spinner indicator during API call
 * - Exponential backoff retry (1s → 2s → 4s)
 * - Jitter to prevent thundering herd
 * - Transient error detection
 * - Optional request timeout
 * - Abort signal support for Ctrl+C
 */
export async function retryChat(
  request: Omit<ChatRequest, 'stream'> & { stream?: false },
  config?: Partial<RetryConfig> & { signal?: AbortSignal; neglected?: boolean; noSpinner?: boolean }
): Promise<ChatResponse> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  const signal = config?.signal;
  const neglected = config?.neglected ?? false;
  const noSpinner = config?.noSpinner ?? false;
  let lastError: Error | null = null;

  if (!noSpinner) {
    startSpinner(neglected ? NEGLECTED_SPINNER_TEXT : 'Thinking');
  }

  // Verbose: Log request
  if (isVerbose()) {
    console.log(chalk.magenta('[verbose][ollama] Request:'));
    console.log(chalk.gray(`  Model: ${request.model}`));
    console.log(chalk.gray(`  Messages: ${request.messages?.length || 0}`));
    if (request.tools && request.tools.length > 0) {
      console.log(chalk.gray(`  Tools: ${request.tools.length} (${request.tools.map(t => t.function?.name || 'unknown').join(', ')})`));
    }
    if (request.format) {
      console.log(chalk.gray(`  Format: ${request.format}`));
    }
  }

  try {
    for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
      // Check if aborted before starting
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      // Verbose: Log retry attempt
      if (attempt > 1 && isVerbose()) {
        console.log(chalk.magenta(`[verbose][ollama] Retry attempt ${attempt}/${cfg.maxRetries + 1}`));
      }

      try {
        // Apply timeout if specified
        const chatPromise = ollama.chat(request as ChatRequest & { stream?: false });

        // Create abort promise if signal provided
        const abortPromise = signal
          ? new Promise<never>((_, reject) => {
              const handler = () => reject(new Error('Request aborted'));
              signal.addEventListener('abort', handler, { once: true });
            })
          : null;

        // Create timeout promise if timeout specified
        const timeoutPromise = cfg.timeoutMs
          ? new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Request timed out after ${cfg.timeoutMs}ms`)), cfg.timeoutMs)
            )
          : null;

        // Race between chat, abort, and timeout
        const promises: Promise<ChatResponse | never>[] = [chatPromise];
        if (abortPromise) promises.push(abortPromise);
        if (timeoutPromise) promises.push(timeoutPromise);

        const response = await Promise.race(promises);

        // Verbose: Log response
        if (isVerbose()) {
          console.log(chalk.magenta('[verbose][ollama] Response:'));
          const content = response.message.content || '';
          console.log(chalk.gray(`  Content (${content.length} chars): ${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`));
          if (response.message.tool_calls && response.message.tool_calls.length > 0) {
            console.log(chalk.gray(`  Tool calls: ${response.message.tool_calls.length}`));
            for (const tc of response.message.tool_calls) {
              const argsPreview = JSON.stringify(tc.function.arguments).slice(0, 100);
              console.log(chalk.gray(`    - ${tc.function.name}: ${argsPreview}${argsPreview.length >= 100 ? '...' : ''}`));
            }
          }
          if (response.done_reason) {
            console.log(chalk.gray(`  Done reason: ${response.done_reason}`));
          }
        }

        return response;
      } catch (err) {
        // Check if aborted
        if (err instanceof Error && err.message === 'Request aborted') {
          throw err;
        }

        // Check if it's a transient error
        if (!isTransientError(err)) {
          // Non-transient error - throw immediately
          throw err;
        }

        lastError = err instanceof Error ? err : new Error(String(err));

        // Log retry attempt
        const isLastAttempt = attempt > cfg.maxRetries;
        if (!isLastAttempt) {
          const delay = calculateDelay(attempt, cfg);
          console.log(`[ollama] Attempt ${attempt}/${cfg.maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`);
          await sleep(delay);
        }
      }
    }

    // All retries exhausted
    throw lastError || new Error('All retry attempts failed');
  } finally {
    stopSpinner();
  }
}
