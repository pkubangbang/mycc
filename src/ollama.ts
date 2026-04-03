/**
 * ollama.ts - Ollama client initialization utility
 *
 * Centralizes Ollama client configuration for all agent files.
 */

import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse } from 'ollama';
import 'dotenv/config';

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
 * Retry configuration for Ollama API calls
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

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
        const response = await ollama.chat(request as ChatRequest & { stream?: false });
        return response;
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
