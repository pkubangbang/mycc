/**
 * ollama.ts - Ollama client initialization utility
 *
 * Centralizes Ollama client configuration for all agent files.
 */

import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse } from 'ollama';
// Configuration
export const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
export const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
export const MODEL = process.env.OLLAMA_MODEL || 'glm-5:cloud';

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
  modelInfo?: {
    name: string;
    contextLength: number;
    family?: string;
    parameterSize?: string;
  };
}

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

    // 3. Query model for context length via inference
    let contextLength = 4096; // Default fallback

    try {
      const response = await ollama.chat({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: 'What is your context window size in tokens? Reply with only a JSON object: {"context_length": <number>}',
          },
        ],
        format: 'json',
      });

      const content = response.message.content || '';
      const parsed = JSON.parse(content);
      if (typeof parsed.context_length === 'number') {
        contextLength = parsed.context_length;
      }
    } catch {
      // If inference fails, use fallback - model exists but context query failed
      // This is non-fatal, we'll use the default
    }

    // 4. Validate TOKEN_THRESHOLD doesn't exceed 80% of context length
    const maxThreshold = Math.floor(contextLength * 0.8);
    if (tokenThreshold > maxThreshold) {
      return {
        ok: false,
        error: `TOKEN_THRESHOLD (${tokenThreshold}) exceeds 80% of model context length (${contextLength}). Reduce TOKEN_THRESHOLD to ${maxThreshold} or less.`,
      };
    }

    return {
      ok: true,
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
 */
export async function retryChat(
  request: Omit<ChatRequest, 'stream'> & { stream?: false },
  config?: Partial<RetryConfig>
): Promise<ChatResponse> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;

  startSpinner();

  try {
    for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
      try {
        // Apply timeout if specified
        const chatPromise = ollama.chat(request as ChatRequest & { stream?: false });

        if (cfg.timeoutMs) {
          const response = await Promise.race([
            chatPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Request timed out after ${cfg.timeoutMs}ms`)), cfg.timeoutMs)
            ),
          ]);
          return response;
        }

        return await chatPromise;
      } catch (err) {
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
