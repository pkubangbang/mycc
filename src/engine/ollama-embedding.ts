/**
 * ollama-embedding.ts - Ollama embedding client for the wiki knowledge base.
 *
 * Always uses a local Ollama instance regardless of the chat provider.
 * The embedding model runs locally and is independent of the chat LLM.
 */

import { Ollama } from 'ollama';
import { getOllamaHost } from '../config.js';

const ollama = new Ollama({
  host: getOllamaHost(),
});

const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';

/**
 * Generate an embedding vector for the given text.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const response = await ollama.embed({
    model: EMBEDDING_MODEL,
    input: text,
  });

  if (!response.embeddings || response.embeddings.length === 0) {
    throw new Error('Failed to generate embedding');
  }

  return response.embeddings[0];
}
