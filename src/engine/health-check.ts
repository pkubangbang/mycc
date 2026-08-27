/**
 * health-check.ts — Shared health check types and probe helper.
 * Each provider exports its own healthCheck() function.
 */

import type { ChatResponse } from 'ollama';
import { Ollama } from 'ollama';
import { getOllamaHost } from '../config.js';
import type { RetryChatRequest, RetryChatConfig } from './chat-helpers.js';

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

export const STARTUP_TOOL = {
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

export async function probeModel(
  retryChat: (req: RetryChatRequest, cfg?: RetryChatConfig) => Promise<ChatResponse>,
  MODEL: string,
  modelInfo?: Record<string, unknown>,
): Promise<{ contextLength: number; motd: string }> {
  let contextLength = 0;
  let motd = 'Ready!';

  // Pass model_info so the LLM can parse it for context_length.
  // Keys are architecture-dependent (e.g. glm5.context_length, qwen3.context_length),
  // so the LLM is best placed to identify the right key.
  const modelInfoPrompt = modelInfo
    ? `\n\nHere is the model metadata from ollama.show().model_info. Read it and extract the context length:\n${JSON.stringify(modelInfo, null, 2)}`
    : '';

  const response = await retryChat(
    {
      model: MODEL,
      messages: [
        {
          role: 'user',
          content:
            `You are starting up. Call the start_up tool to report your context length ` +
            `by reading the model_info metadata provided below, ` +
            `and provide a fun message of the day.${modelInfoPrompt}`,
        },
      ],
      tools: [STARTUP_TOOL],
    },
    { noSpinner: true },
  );

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

  if (contextLength === 0) {
    throw new Error(
      `Failed to extract context_length from model_info. ` +
      `The LLM did not return a valid context_length. Please retry.`,
    );
  }

  return { contextLength, motd };
}

/**
 * Probe the embedding model via a lightweight `ollama.embed()` call.
 *
 * Embeddings are required for wiki/RAG semantic search, skill matching, and
 * document similarity — all of which would otherwise fail at runtime on the
 * first `getEmbedding()` call with a confusing error if the model is missing
 * or misnamed. Probing at health-check time surfaces the problem early with
 * an actionable message (the exact `ollama pull <model>` command).
 *
 * Uses the Ollama JS client (same path as `rag-nomic.ts`/`rag-embeddinggemma.ts`
 * at runtime) rather than a raw REST call, so the probe exercises the real
 * code path. The embedding model is provided by Ollama regardless of the
 * chat API provider (Ollama or DeepSeek) — both providers call this.
 *
 * @returns A warning string on failure (non-fatal — the agent can still run
 *   chat-only; RAG features just won't work), or `null` on success.
 */
export async function probeEmbeddingModel(): Promise<string | null> {
  const embeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
  try {
    const ollama = new Ollama({ host: getOllamaHost() });
    const response = await ollama.embed({ model: embeddingModel, input: 'test' });
    if (!response.embeddings || response.embeddings.length === 0) {
      throw new Error('Model returned no embeddings');
    }
    return null; // success
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Embedding model '${embeddingModel}' is not available on Ollama: ${msg}. ` +
      `RAG/wiki/skill-matching features will fail at runtime. ` +
      `Run 'ollama pull ${embeddingModel}' to fix this.`;
  }
}
