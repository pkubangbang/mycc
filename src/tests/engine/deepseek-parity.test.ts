import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../loop/agent-io.js', () => ({ agentIO: { verbose: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../engine/health-check.js', () => ({ probeModel: vi.fn(), probeEmbeddingModel: vi.fn() }));
vi.mock('../../config.js', () => ({ isVisionEnabled: vi.fn(() => false), DEFAULT_DEEPSEEK_VISION_MODEL: 'deepseek-flash' }));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

import { retryChat, webSearch, webFetch } from '../../engine/deepseek.js';
import type { ChatResponse } from '../../engine/provider-types.js';

function responseWithReasoning(): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"done","reasoning_content":"thinking"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200 });
}

describe('DeepSeek provider-neutral contract', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.DEEPSEEK_API_KEY = 'test-key';
  });

  it('forwards canonical tool_choice and returns reasoning_content', async () => {
    fetchMock.mockResolvedValue(responseWithReasoning());
    const response: ChatResponse = await retryChat({
      model: 'deepseek-v4-pro',
      messages: [],
      tools: [{ type: 'function', function: { name: 'extract_keywords' } }],
      tool_choice: 'required',
    }, { noSpinner: true });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.tool_choice).toBe('required');
    expect(body.toolChoice).toBeUndefined();
    expect(response.message.reasoning_content).toBe('thinking');
    expect(response.message.content).toBe('done');
  });

  // ── Web tools: signal parity with the Ollama provider ──────────────────
  // `export const webSearch = active.webSearch` in chat-provider.ts type-checks
  // a narrower function against a wider one, so a missing signal there is a
  // SILENT drop. These tests pin the behaviour instead of the signature.
  it('threads the caller signal into the web search request', async () => {
    fetchMock.mockImplementationOnce((_url, init) => {
      // The request must observe cancellation, not merely unwind the await.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by caller')));
      });
    });
    const controller = new AbortController();
    const pending = webSearch('cancellable', controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('rejects webFetch asynchronously so callers can always attach handlers', async () => {
    // A synchronous throw would escape `.catch()` attached after the call.
    const promise = webFetch('https://example.com');
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow('not supported by DeepSeek');
  });

  it('retains the legacy toolChoice alias', async () => {
    fetchMock.mockResolvedValue(responseWithReasoning());
    await retryChat({
      model: 'deepseek-v4-pro', messages: [],
      toolChoice: 'none',
    } as Parameters<typeof retryChat>[0], { noSpinner: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).tool_choice).toBe('none');
  });
});
