/**
 * rag-embeddinggemma.ts - RAG embedding provider for embeddinggemma.
 *
 * embeddinggemma REQUIRES task-specific prompt prefixes for optimal
 * performance. Without prefixes, embeddings fall into a suboptimal
 * region of the vector space, degrading search quality.
 *
 * Query mode:    "task: search result | query: {text}"
 * Document mode: "title: none | text: {text}"
 *
 * Verified: Ollama's /api/embed endpoint does NOT auto-apply prefixes
 * (no template/raw parameter, Modelfile EMBED deprecated in PR #759).
 * Real users report "non-sense results" without prefixes (GitHub #12191).
 *
 * Note: This implementation uses "none" as the default title. If a
 * document has a meaningful title, callers should pre-format the text
 * or extend the signature to accept a title parameter.
 */

import { Ollama } from 'ollama';
import { getOllamaHost } from '../config.js';

const ollama = new Ollama({
  host: getOllamaHost(),
});

export const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma';

/**
 * Embedding dimensionality.
 * embeddinggemma outputs 768-dim vectors (full dimension). This is
 * hardcoded because the RAG provider is materialized from the model name
 * — specifying the model also specifies the dimension.
 */
export const EMBEDDING_DIM = 768;

/**
 * Namespace isolates vectors from different models into separate LanceDB
 * tables. Using the full model name prevents collisions.
 */
export const NAMESPACE = EMBEDDING_MODEL;

/**
 * Generate an embedding vector for the given text with the appropriate
 * prompt prefix applied based on the mode.
 *
 * @param text - Raw text to embed
 * @param mode - 'query' for search queries, 'document' for stored content (default)
 * @returns Embedding vector (768-dim)
 */
export async function getEmbedding(text: string, mode: 'query' | 'document' = 'document'): Promise<number[]> {
  const input = mode === 'query'
    ? `task: search result | query: ${text}`
    : `title: none | text: ${text}`;

  const response = await ollama.embed({
    model: EMBEDDING_MODEL,
    input,
  });

  if (!response.embeddings || response.embeddings.length === 0) {
    throw new Error('Failed to generate embedding');
  }

  return response.embeddings[0];
}

/**
 * Generate embedding vectors for multiple texts in a single Ollama request.
 *
 * Ollama's /api/embed endpoint accepts an array of inputs and returns a
 * parallel array of embeddings, so N texts cost one network round-trip
 * instead of N. Each text receives the mode-specific prompt prefix before
 * being sent (embeddinggemma requires prefixes for quality).
 *
 * @param texts - Raw texts to embed (must be non-empty)
 * @param mode - 'query' for search queries, 'document' for stored content (default)
 * @returns Array of embedding vectors, one per input text (same order)
 */
export async function getEmbeddings(texts: string[], mode: 'query' | 'document' = 'document'): Promise<number[][]> {
  if (texts.length === 0) return [];

  const prefixed = texts.map((text) =>
    mode === 'query'
      ? `task: search result | query: ${text}`
      : `title: none | text: ${text}`,
  );

  const response = await ollama.embed({
    model: EMBEDDING_MODEL,
    input: prefixed,
  });

  if (!response.embeddings || response.embeddings.length === 0) {
    throw new Error('Failed to generate embeddings');
  }

  return response.embeddings;
}