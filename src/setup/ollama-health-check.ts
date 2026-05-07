/**
 * ollama-health-check.ts — Startup health check for Ollama connectivity and model validation
 *
 * Validates:
 * 1. Ollama server is reachable
 * 2. Model exists and can process requests
 * 3. TOKEN_THRESHOLD doesn't exceed 80% of model's context length
 */

import chalk from 'chalk';
import { isVisionEnabled } from '../config.js';
import {
  ollama,
  OLLAMA_HOST,
  MODEL,
  isTransientError,
  DEFAULT_RETRY_CONFIG,
  calculateDelay,
  sleep,
  startSpinner,
  stopSpinner,
} from '../ollama.js';

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
 * Inline startup tool — exclusive to checkHealth, not mixed with built-in tools
 */
const STARTUP_TOOL = {
  type: 'function' as const,
  function: {
    name: 'start_up',
    description:
      'Report model capabilities and provide a fun message of the day. Call this tool exactly once with your model information.',
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

        // Success — break out of retry loop
        lastError = null;
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
          console.log(
            `[ollama] Health check attempt ${attempt}/${maxRetries + 1} failed: ${msg}. Retrying in ${delay}ms...`,
          );
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
      warnings: isVisionEnabled()
        ? undefined
        : [
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
    stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Model '${MODEL}' not found or unavailable. ${msg}. Run 'ollama list' to see available models.`,
    };
  }
}
