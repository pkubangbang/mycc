/**
 * rag-provider.ts - Single facade for embedding (RAG) functionality.
 *
 * Based on OLLAMA_EMBEDDING_MODEL env var, selects the active RAG
 * provider and re-exports its embedding function and metadata.
 *
 * This mirrors the chat-provider.ts pattern: static imports + ternary
 * selection at module load time, re-exporting the active module's
 * functions. No TypeScript interface — providers use duck-typed
 * module exports with identical signatures.
 *
 * The provider is auto-inferred from the model name:
 *   - starts with "embeddinggemma" → embeddinggemma provider
 *   - otherwise (e.g. nomic-embed-text, mxbai-embed-large) → nomic provider
 *
 * NAMESPACE is used by wiki.ts to isolate vectors from different models
 * into separate LanceDB tables (e.g. wiki_nomic-embed-text, wiki_embeddinggemma).
 * It equals the configured model name, so different non-embeddinggemma models
 * (e.g. mxbai-embed-large, bge-m3) get separate tables — no collision.
 */

import { getRagProvider } from '../config.js';
import * as nomicMod from './rag-nomic.js';
import * as gemmaMod from './rag-embeddinggemma.js';

/** Embedding mode — query for search, document for stored content */
export type EmbedMode = 'query' | 'document';

const active = getRagProvider() === 'embeddinggemma' ? gemmaMod : nomicMod;

/** Generate an embedding vector. Mode controls prompt prefix (ignored by nomic). */
export const getEmbedding = active.getEmbedding;

/**
 * Generate embedding vectors for multiple texts in a single Ollama request.
 * Mode controls prompt prefix (ignored by nomic). Order is preserved.
 */
export const getEmbeddings = active.getEmbeddings;

/** Configured embedding model name */
export const EMBEDDING_MODEL = active.EMBEDDING_MODEL;

/** Embedding vector dimensionality */
export const EMBEDDING_DIM = active.EMBEDDING_DIM;

/** Namespace identifier for LanceDB table isolation */
export const NAMESPACE = active.NAMESPACE;