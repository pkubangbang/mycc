/**
 * rag-nomic.ts - RAG embedding provider for nomic-embed-text.
 *
 * nomic-embed-text requires NO prompt prefixes — raw text is passed
 * directly to the model. The `mode` parameter is accepted for interface
 * compatibility with the rag-provider facade but is ignored.
 */

import { Ollama } from 'ollama';
import { getOllamaHost } from '../config.js';

const ollama = new Ollama({
  host: getOllamaHost(),
});

export const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';

/**
 * Embedding dimensionality.
 * nomic-embed-text outputs 768-dim vectors. This is hardcoded because the
 * RAG provider is materialized from the model name — specifying the model
 * also specifies the dimension.
 */
export const EMBEDDING_DIM = 768;

/**
 * Namespace isolates vectors from different models into separate
 * LanceDB tables (e.g. wiki_nomic-embed-text, wiki_mxbai-embed-large).
 * Using the full model name (not a hardcoded 'nomic') prevents collisions
 * when multiple non-embeddinggemma models share the nomic provider.
 */
export const NAMESPACE = EMBEDDING_MODEL;

/**
 * Generate an embedding vector for the given text.
 *
 * @param text - Raw text to embed
 * @param _mode - Ignored (nomic does not use prompt prefixes)
 * @returns Embedding vector (768-dim)
 */
export async function getEmbedding(text: string, _mode?: 'query' | 'document'): Promise<number[]> {
  const response = await ollama.embed({
    model: EMBEDDING_MODEL,
    input: text,
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
 * instead of N. The `mode` parameter is accepted for interface
 * compatibility but ignored (nomic does not use prompt prefixes).
 *
 * @param texts - Raw texts to embed (must be non-empty)
 * @param _mode - Ignored (nomic does not use prompt prefixes)
 * @returns Array of embedding vectors, one per input text (same order)
 */
export async function getEmbeddings(texts: string[], _mode?: 'query' | 'document'): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await ollama.embed({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  if (!response.embeddings || response.embeddings.length === 0) {
    throw new Error('Failed to generate embeddings');
  }

  return response.embeddings;
}