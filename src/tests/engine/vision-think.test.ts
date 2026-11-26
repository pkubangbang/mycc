/**
 * vision-think.test.ts - the vision call must disable reasoning
 *
 * `imgDescribe` is a one-shot "describe this" call: its answer is consumed
 * verbatim, so a thinking pass only adds latency and tokens (and makes the
 * non-spinner timeout windows harder to tune). Both providers must put
 * `think: false` on the request; Ollama forwards the field to `/api/chat`,
 * DeepSeek converts it to `thinking: {type:'disabled'}` and drops
 * `reasoning_effort`.
 *
 * These are WIRE-level tests: fetch is stubbed and the real provider functions
 * are driven end to end, so the assertion is on the bytes that would leave the
 * process — not on a mock of our own call site.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

/** Minimal valid 1x1 PNG so the DeepSeek MIME sniffer sees a real header. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Streamed NDJSON body carrying one content chunk and a done chunk. */
function ollamaNdjson(content: string): Response {
  const encoder = new TextEncoder();
  const frame = (payload: unknown) => encoder.encode(`${JSON.stringify(payload)}\n`);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(frame({ model: 'v', created_at: '2026-01-01', message: { role: 'assistant', content } }));
        controller.enqueue(frame({ model: 'v', created_at: '2026-01-01', message: { role: 'assistant', content: '' }, done: true }));
        controller.close();
      }
    }),
    { status: 200 }
  );
}

/** DeepSeek SSE body: one content delta then [DONE]. */
function deepseekSse(content: string): Response {
  const encoder = new TextEncoder();
  const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content } }] })));
        controller.enqueue(encoder.encode(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

/** The JSON body of the n-th fetch call (single-request tests use index 0). */
function requestBody(index = 0): Record<string, unknown> {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  expect(typeof body).toBe('string');
  return JSON.parse(String(body)) as Record<string, unknown>;
}

describe('vision imgDescribe disables thinking', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('ollama: sends think:false to /api/chat and still returns the description', async () => {
    process.env.OLLAMA_VISION_MODEL = 'test-vision';
    fetchMock.mockResolvedValue(ollamaNdjson('a screenshot of a form'));

    const { imgDescribe } = await import('../../engine/ollama.js');
    const text = await imgDescribe(TINY_PNG_BASE64, 'describe');

    expect(text).toBe('a screenshot of a form');
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/chat');
    const body = requestBody();
    expect(body.think).toBe(false);
    expect(body.model).toBe('test-vision');
  });

  it('deepseek: converts think:false into thinking disabled and drops reasoning_effort', async () => {
    process.env.DEEPSEEK_HOST = 'https://deepseek.test';
    process.env.DEEPSEEK_API_KEY = 'key';
    process.env.DEEPSEEK_VISION_MODEL = 'test-vision';
    fetchMock.mockResolvedValue(deepseekSse('a chart'));

    const { imgDescribe } = await import('../../engine/deepseek.js');
    const text = await imgDescribe(TINY_PNG_BASE64, 'describe');

    expect(text).toBe('a chart');
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/chat/completions');
    const body = requestBody();
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('reasoning_effort');
    // The synthetic Ollama-style field must not leak onto the DeepSeek wire.
    expect(body).not.toHaveProperty('think');
  });

  it('deepseek: the image rides a user message as an image_url block', async () => {
    process.env.DEEPSEEK_HOST = 'https://deepseek.test';
    process.env.DEEPSEEK_API_KEY = 'key';
    process.env.DEEPSEEK_VISION_MODEL = 'test-vision';
    fetchMock.mockResolvedValue(deepseekSse('ok'));

    const { imgDescribe } = await import('../../engine/deepseek.js');
    await imgDescribe(TINY_PNG_BASE64, 'describe');

    const body = requestBody();
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.role).toBe('user');
    const blocks = messages[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.some((b) => b.type === 'image_url' && (b.image_url?.url ?? '').startsWith('data:image/png;base64,'))).toBe(
      true
    );
  });
});
