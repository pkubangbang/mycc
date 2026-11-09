/** Tests for mycc-owned Ollama REST transport (no ollama-js runtime). */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { OllamaHttpClient, OllamaHttpError, normalizeHost, parseRetryAfter } from '../../engine/ollama-http.js';
import { isTransientError } from '../../engine/chat-helpers.js';

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function ndjson(...chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        // Exercise split UTF-8/NDJSON frames, not only one-line-per-chunk mocks.
        const bytes = encoder.encode(chunks.map((chunk) => JSON.stringify(chunk) + '\n').join(''));
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17));
        controller.close();
      }
    }),
    { status: 200 }
  );
}

describe('OllamaHttpClient', () => {
  beforeEach(() => fetchMock.mockReset());

  it('uses Ollama REST paths and credentials for model and embedding calls', async () => {
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434/', apiKey: 'key' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [] }));
    await client.list();
    fetchMock.mockResolvedValueOnce(jsonResponse({ model_info: {}, details: {} }));
    await client.show('test-model');
    fetchMock.mockResolvedValueOnce(jsonResponse({ embeddings: [[0.1, 0.2]] }));
    await expect(client.embed({ model: 'embed', input: ['a', 'b'] })).resolves.toEqual({ embeddings: [[0.1, 0.2]] });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:11434/api/tags',
      'http://127.0.0.1:11434/api/show',
      'http://127.0.0.1:11434/api/embed'
    ]);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('authorization')).toBe('Bearer key');
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ model: 'embed', input: ['a', 'b'] });
  });

  it('parses streamed NDJSON chat into provider-neutral responses', async () => {
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });
    fetchMock.mockResolvedValue(
      ndjson(
        {
          model: 'm',
          created_at: '2026-01-01',
          message: { role: 'assistant', content: 'hel', thinking: 'why' },
          done: false
        },
        {
          model: 'm',
          created_at: '2026-01-01',
          message: { role: 'assistant', content: 'lo' },
          done: true,
          done_reason: 'stop'
        }
      )
    );
    const stream = await client.chat({ model: 'm', messages: [], stream: true });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.message.content)).toEqual(['hel', 'lo']);
    expect(chunks[0].created_at).toBeInstanceOf(Date);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: 'm', stream: true });
  });

  it('aborts a streamed chat through its own controller', async () => {
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const stream = await client.chat({ model: 'm', stream: true });
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    stream.abort();
    expect(signal?.aborted).toBe(true);
  });

  it('releases an abandoned stream body on abort, and abort is idempotent', async () => {
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });
    let cancelled = false;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start() {
            /* never produces data: simulates a hung/large stream */
          },
          cancel() {
            cancelled = true;
          }
        })
      )
    );
    const stream = await client.chat({ model: 'm', stream: true });
    stream.abort();
    // Let the cancel() microtask run.
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(() => stream.abort()).not.toThrow();
  });

  it('aborts a stream that has a PENDING read in flight and releases the body', async () => {
    // The abandoned-stream case above covers "nobody ever iterated". This is the
    // harder one: the consumer is blocked inside read(). releaseLock() throws
    // while a read is pending, so abort() must let the pending read settle via
    // cancel() rather than leaving the body (and its socket) pinned.
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });
    let cancelled = false;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start() {
            /* no chunks yet: the consumer is parked in read() */
          },
          cancel() {
            cancelled = true;
          }
        })
      )
    );
    const stream = await client.chat({ model: 'm', stream: true });
    const iterator = stream[Symbol.asyncIterator]();
    const pendingRead = iterator.next();
    expect(() => stream.abort()).not.toThrow();
    const settled = await pendingRead;
    expect(settled.done).toBe(true);
    expect(cancelled).toBe(true);
  });

  it.each([
    ['120', 120_000],
    [new Date(Date.now() + 60_000).toUTCString(), 60_000],
    ['not-a-date', undefined],
    [null, undefined]
  ])('parses Retry-After %s in both wire forms', (raw, expected) => {
    const parsed = parseRetryAfter(raw as string | null);
    if (expected === undefined) expect(parsed).toBeUndefined();
    else expect(parsed).toBeGreaterThan(expected - 5_000);
  });

  it('classifies transport errors for callers instead of message sniffing', () => {
    expect(new OllamaHttpError('no', 401).kind).toBe('auth');
    expect(new OllamaHttpError('no', 403).kind).toBe('auth');
    expect(new OllamaHttpError('no', 429).kind).toBe('rate-limit');
    expect(new OllamaHttpError('no', 503).kind).toBe('server');
    expect(new OllamaHttpError('no', 404).kind).toBe('client');
  });

  it('rejects hosts with embedded credentials or a non-http scheme', () => {
    expect(() => normalizeHost('https://user:pw@ollama.com')).toThrow(/credentials/);
    expect(() => normalizeHost('file:///etc/passwd')).toThrow(/protocol/);
    // Trailing dot is the same DNS name and must not defeat host comparison.
    // The default-port rule is unchanged by this hardening: an https URL
    // without an explicit port stays port-less (URL serialization drops :443).
    expect(normalizeHost('https://ollama.com.')).toBe('https://ollama.com');
  });

  it.each([
    [':11434', 'http://127.0.0.1:11434'],
    ['localhost', 'http://localhost:11434'],
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://example.com', 'http://example.com'],
    ['https://example.com', 'https://example.com'],
    ['http://proxy/ollama/', 'http://proxy/ollama']
  ])('normalizes legacy host %s', (host, expected) => {
    expect(normalizeHost(host)).toBe(expected);
  });

  it('aborts the initial fetch before response headers arrive', async () => {
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });
    let requestSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementationOnce((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });
    const controller = new AbortController();
    const pending = client.chat({ model: 'm', stream: true }, controller.signal);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('classifies an EOF-truncated NDJSON record as retryable', async () => {
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });
    fetchMock.mockResolvedValue(new Response('{"model":"m","done":', { status: 200 }));
    const stream = await client.chat({ model: 'm', stream: true });
    let error: unknown;
    try {
      for await (const _chunk of stream) {
        /* consume truncated stream */
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('truncated at EOF');
    expect(isTransientError(error)).toBe(true);
  });

  it('aborts transport cleanup when a successful chat has no body', async () => {
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(client.chat({ model: 'm', stream: true })).rejects.toThrow('empty response body');
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('encodes binary images for streaming and non-streaming chat', async () => {
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });
    const images: Array<string | Uint8Array> = ['already-base64', new Uint8Array([1, 2, 253, 254])];
    const request = { model: 'm', messages: [{ role: 'user', content: 'look', images }] };
    fetchMock.mockResolvedValueOnce(
      ndjson({ model: 'm', created_at: '2026-01-01', message: { role: 'assistant', content: 'ok' }, done: true })
    );
    const stream = await client.chat({ ...request, stream: true });
    for await (const _chunk of stream) {
      /* consume */
    }
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ model: 'm', created_at: '2026-01-01', message: { role: 'assistant', content: 'ok' }, done: true })
    );
    await client.chat({ ...request, stream: false });
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body)).messages[0].images).toEqual(['already-base64', 'AQL9/g==']);
    }
  });

  it('returns structured non-streaming chat and parses HTTP errors', async () => {
    const client = new OllamaHttpClient({ host: 'http://127.0.0.1:11434' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        model: 'm',
        created_at: '2026-01-01',
        message: { role: 'assistant', content: 'ok' },
        done: true
      })
    );
    const response = await client.chat({ model: 'm', messages: [] });
    expect(response.created_at).toBeInstanceOf(Date);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ stream: false });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'model missing' }, 404));
    await expect(client.show('missing')).rejects.toMatchObject({
      name: 'OllamaHttpError',
      message: 'HTTP 404: model missing',
      status: 404
    } satisfies Partial<OllamaHttpError>);
  });
});
