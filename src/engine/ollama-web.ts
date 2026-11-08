/**
 * ollama-web.ts - Host-aware routing for Ollama web tools.
 *
 * Direct cloud hosts use /api/web_*, while local/custom OLLAMA_HOST servers
 * receive their experimental equivalents. Responses are normalized into
 * mycc's provider-neutral public contracts.
 *
 * HTTP, error classification and Retry-After parsing come from ollama-http.ts
 * (`postJson` / `httpError` / `parseRetryAfter`) so the web path and the chat
 * path cannot drift apart — they previously disagreed on the Retry-After
 * format and on how an `{ error }` body over HTTP 200 was reported.
 */

import { normalizeHost, postJson } from './ollama-http.js';
import type { WebSearchResult, WebFetchResponse } from './provider-types.js';

export interface OllamaWebClient {
  webSearch(request: { query: string }, signal?: AbortSignal): Promise<{ results?: WebSearchResult[] }>;
  webFetch(request: { url: string }, signal?: AbortSignal): Promise<WebFetchResponse>;
}

interface WebClientConfig {
  host: string;
  apiKey?: string;
}

/**
 * Hosts that may receive the configured OLLAMA_API_KEY on a web request.
 *
 * This is an EXACT allow-list, not a suffix match. A `*.ollama.com` wildcard
 * would send the user's cloud credential to any subdomain that resolves under
 * ollama.com — including one delegated to a third party in the future — for no
 * functional gain: the direct cloud endpoint is `ollama.com` itself (and its
 * `api.` alias). Anything else is treated as a local/custom server, which
 * never sees the key.
 */
const DIRECT_CLOUD_HOSTS: ReadonlySet<string> = new Set(['ollama.com', 'api.ollama.com']);

export function isDirectOllamaCloud(host: string): boolean {
  const url = new URL(normalizeHost(host));
  if (url.protocol !== 'https:') return false;
  // normalizeHost lowercases via URL parsing and strips a trailing dot.
  return DIRECT_CLOUD_HOSTS.has(url.hostname.toLowerCase());
}

async function postWeb(
  config: WebClientConfig,
  path: 'web_search' | 'web_fetch',
  body: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const directCloud = isDirectOllamaCloud(config.host);
  const route = directCloud ? `/api/${path}` : `/api/experimental/${path}`;
  const endpoint = `${normalizeHost(config.host)}${route}`;
  const signals = [AbortSignal.timeout(30_000)];
  if (signal) signals.push(signal);
  return await postJson(endpoint, body, {
    // The key is forwarded ONLY to an allow-listed cloud host. A local or
    // self-hosted server authenticates its own web backend (e.g. `ollama
    // signin`); mycc must not leak OLLAMA_API_KEY to it.
    apiKey: directCloud ? config.apiKey : undefined,
    signal: AbortSignal.any(signals)
  });
}

function normalizeSearchResponse(data: unknown): WebSearchResult[] {
  if (typeof data !== 'object' || data === null || !('results' in data)) {
    throw new Error('Ollama web_search response is missing results');
  }
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error('Ollama web_search results must be an array');
  return results.filter(
    (result): result is WebSearchResult =>
      typeof result === 'object' && result !== null && typeof (result as { content?: unknown }).content === 'string'
  );
}

function normalizeFetchResponse(data: unknown, requestedUrl: string): WebFetchResponse {
  const response = (typeof data === 'object' && data !== null ? data : {}) as {
    title?: unknown;
    url?: unknown;
    content?: unknown;
    links?: unknown;
  };
  if (typeof response.content !== 'string') {
    throw new Error('Ollama web_fetch response is missing string content');
  }
  return {
    title: typeof response.title === 'string' ? response.title : requestedUrl,
    url: typeof response.url === 'string' ? response.url : requestedUrl,
    content: response.content,
    links: Array.isArray(response.links)
      ? response.links.filter((link): link is string => typeof link === 'string')
      : []
  };
}

/**
 * Own HTTP client for Ollama web operations: no SDK web methods are used.
 * Direct cloud requests carry the configured key; local/custom hops do not.
 */
export function createOllamaWebClient(config: WebClientConfig): OllamaWebClient {
  return {
    async webSearch({ query }, signal) {
      const response = await postWeb(config, 'web_search', { query }, signal);
      return { results: normalizeSearchResponse(response) };
    },
    async webFetch({ url }, signal) {
      const response = await postWeb(config, 'web_fetch', { url }, signal);
      return normalizeFetchResponse(response, url);
    }
  };
}
