/**
 * web-routing.test.ts - Ollama web tools follow the configured Ollama host.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSearchResult } from '../../engine/provider-types.js';

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  getOllamaHost: vi.fn(() => 'http://127.0.0.1:11434'),
  getOllamaApiKey: vi.fn(() => 'must-not-be-forwarded'),
  getOllamaModel: vi.fn(() => 'test-model'),
  getVisionModel: vi.fn(() => 'test-vision'),
  isVisionEnabled: vi.fn(() => false),
}));

vi.mock('../../engine/health-check.js', () => ({
  probeModel: vi.fn(),
  probeEmbeddingModel: vi.fn(),
}));

vi.mock('../../engine/ollama-http.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../engine/ollama-http.js')>(),
  OllamaHttpClient: class {
    chat = vi.fn(() => { throw new Error('HTTP chat must not be called by web tools'); });
  },
}));

vi.mock('../../engine/chat-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../engine/chat-helpers.js')>();
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

import { webSearch, webFetch } from '../../engine/ollama.js';
import { createOllamaWebClient, isDirectOllamaCloud } from '../../engine/ollama-web.js';
import { normalizeHost } from '../../engine/ollama-http.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Ollama web routing', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    'https://ollama.com',
    'https://ollama.com:443',
    'https://api.ollama.com',
    'https://OLLAMA.COM',
  ])('recognizes direct cloud host %s', (host) => {
    expect(isDirectOllamaCloud(host)).toBe(true);
  });

  it('uses cloud /api/web_search and credentials for a direct cloud host', async () => {
    const cloud = createOllamaWebClient({ host: 'https://ollama.com', apiKey: 'cloud-key' });
    fetchMock.mockResolvedValue(jsonResponse({ results: [{ content: 'cloud result' }] }));
    await expect(cloud.webSearch({ query: 'cloud routing' })).resolves.toEqual({
      results: [{ content: 'cloud result' }],
    });
    expect(fetchMock).toHaveBeenCalledWith('https://ollama.com/api/web_search', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cloud-key' },
      body: JSON.stringify({ query: 'cloud routing' }),
    }));
  });

  it('uses cloud /api/web_fetch and credentials for a direct cloud host', async () => {
    const cloud = createOllamaWebClient({ host: 'https://ollama.com/', apiKey: 'cloud-key' });
    fetchMock.mockResolvedValue(jsonResponse({
      title: 'Cloud', url: 'https://example.com', content: 'cloud content', links: [],
    }));
    await expect(cloud.webFetch({ url: 'https://example.com' })).resolves.toEqual({
      title: 'Cloud', url: 'https://example.com', content: 'cloud content', links: [],
    });
    expect(fetchMock).toHaveBeenCalledWith('https://ollama.com/api/web_fetch', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cloud-key' },
      body: JSON.stringify({ url: 'https://example.com' }),
    }));
  });

  it('posts web_search to OLLAMA_HOST without forwarding the API key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      results: [{ title: 'Local', url: 'http://local/result', content: 'result text' }],
    }));

    await expect(webSearch('local routing')).resolves.toEqual([
      { title: 'Local', url: 'http://local/result', content: 'result text' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/experimental/web_search',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'local routing' }),
      }),
    );
  });

  it('normalizes missing search results and drops malformed result content', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: null }));
    await expect(webSearch('empty')).rejects.toThrow('results must be an array');

    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        { content: 'kept' },
        { title: 'missing content' },
        { content: 42 },
        null,
      ],
    }));
    const results: WebSearchResult[] = await webSearch('filter');
    expect(results).toEqual([{ content: 'kept' }]);
  });

  it('posts web_fetch to OLLAMA_HOST and normalizes the response contract', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      title: 'Local page',
      content: 'page text',
      links: null,
    }));

    await expect(webFetch('http://local/page')).resolves.toEqual({
      title: 'Local page',
      url: 'http://local/page',
      content: 'page text',
      links: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/experimental/web_fetch',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://local/page' }),
      }),
    );
  });

  it('preserves a returned fetch URL and filters non-string links', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      title: 'Page', url: 'https://example.com/final', content: 'body',
      links: ['https://example.com/a', 42, null],
    }));
    await expect(webFetch('https://example.com/start')).resolves.toEqual({
      title: 'Page', url: 'https://example.com/final', content: 'body',
      links: ['https://example.com/a'],
    });
  });

  it('retries transient failures and preserves the local endpoint', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ results: [{ content: 'recovered' }] }));
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const helpers = await import('../../engine/chat-helpers.js');
    vi.spyOn(helpers, 'sleep').mockImplementation(sleepMock);

    await expect(webSearch('retry')).resolves.toEqual([{ content: 'recovered' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(fetchMock.mock.calls[1][0]);
  });

  it('does not retry a 404 from a server without experimental web routes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
    await expect(webSearch('unsupported')).rejects.toThrow(
      'HTTP 404: not found',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not forward cloud credentials to plaintext ollama.com', async () => {
    expect(isDirectOllamaCloud('http://ollama.com')).toBe(false);
    const client = createOllamaWebClient({ host: 'http://ollama.com', apiKey: 'secret' });
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    await client.webSearch({ query: 'safe transport' });
    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe('http://ollama.com/api/experimental/web_search');
    expect(new Headers(request[1]?.headers).has('authorization')).toBe(false);
    expect(request[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves a reverse-proxy path prefix', async () => {
    const client = createOllamaWebClient({ host: 'http://proxy/ollama/' });
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    await client.webSearch({ query: 'path' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://proxy/ollama/api/experimental/web_search');
  });

  it('retries HTTP 429 and honors Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    let caught: unknown;
    const client = createOllamaWebClient({ host: 'http://127.0.0.1:11434' });
    try { await client.webSearch({ query: 'rate limit' }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ status: 429, retryAfterMs: 1000 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
    await webSearch('rate limit');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels the web request through the supplied signal', async () => {
    let requestSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementationOnce((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    });
    const controller = new AbortController();
    const pending = webSearch('cancel', controller.signal);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('classifies an error payload delivered over HTTP 200 as an auth failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized', signin_url: 'https://ollama.com/signin' }));
    // Ollama signals an unusable credential with `{ error }` over 200, not 401.
    // Reporting status 200 made the error look like a generic fault; postJson
    // now raises it as kind 'auth' so base-core's sign-in guidance fires.
    await expect(webSearch('unauthorized')).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
      signinUrl: 'https://ollama.com/signin',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(webFetch('https://example.com')).rejects.toThrow('missing string content');
  });

  it('does NOT call an unrelated error payload over HTTP 200 an auth failure', async () => {
    // Narrowed per peer review: only an explicitly auth-shaped message may be
    // reclassified. A backend complaining about something else must keep its
    // status so base-core shows the real error instead of "check your API key".
    fetchMock.mockResolvedValue(jsonResponse({ error: 'web search backend disabled' }));
    const err: unknown = await webSearch('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 200, kind: 'transport' });
    expect((err as Error).message).toContain('web search backend disabled');
  });

  it('rejects invalid successful JSON instead of silently returning empty content', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await expect(webFetch('https://example.com')).rejects.toThrow(
      /returned a non-object response/,
    );
  });

  // ── Credential boundary ────────────────────────────────────────────────
  // The allow-list is exact: an attacker-controlled or newly delegated
  // subdomain under ollama.com must NOT receive the user's cloud key.
  it.each([
    'https://evil.ollama.com',
    'https://ollama.com.evil.test',
    'https://api.evil.ollama.com',
  ])('does not treat %s as the direct cloud endpoint', (host) => {
    // Valid URL, valid host — just not on the credential allow-list. The route
    // falls back to the non-forwarding local/experimental form.
    expect(isDirectOllamaCloud(host)).toBe(false);
  });

  it('refuses a host with embedded credentials outright', () => {
    expect(() => isDirectOllamaCloud('https://user:pw@ollama.com')).toThrow(/credentials/);
    expect(() => normalizeHost('file:///etc/passwd')).toThrow(/protocol/);
  });

  it('treats a trailing-dot cloud host as the same host, not a wildcard match', () => {
    expect(isDirectOllamaCloud('https://ollama.com.')).toBe(true);
  });

  it('never forwards the key to an unlisted subdomain', async () => {
    const client = createOllamaWebClient({ host: 'https://evil.ollama.com', apiKey: 'secret' });
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    await client.webSearch({ query: 'x' });
    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe('https://evil.ollama.com/api/experimental/web_search');
    expect(new Headers(request[1]?.headers).has('authorization')).toBe(false);
  });
});
