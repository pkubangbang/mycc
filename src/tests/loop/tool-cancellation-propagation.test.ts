/**
 * tool-cancellation-propagation.test.ts - Cancellation must survive the REAL
 * tool wrappers and the REAL Loader.
 *
 * The peer review found that a loader-only fix was insufficient: both web
 * tools caught every exception from `ctx.core.web*(..., signal)` and returned
 * `Error: ${message}`, so by the time Loader.execute ran there was nothing left
 * to classify. These tests drive the actual tool handlers through an actual
 * Loader instance (no mocks of either seam) and pin both halves of the
 * contract:
 *
 *   cancelled        -> the call throws (TOOL state owns STOP/wrap-up)
 *   ordinary failure -> the call still returns an `Error: ...` string
 *
 * That second half matters as much as the first: a "fix" that rethrows
 * everything would break every consumer that expects a string tool result.
 */

import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Loader } from '../../context/shared/loader.js';
import { webFetchTool } from '../../tools/web_fetch.js';
import { webSearchTool } from '../../tools/web_search.js';
import { readPictureTool } from '../../tools/read-picture.js';
import { createMockContext } from '../tools/test-utils.js';
import { isCancellation } from '../../loop/cancellation.js';
import type { AgentContext } from '../../types.js';

/**
 * Inject a tool into a real Loader's private registry (built-in layer). Using
 * the real `execute` — not a stub — is the point: its try/catch is the seam
 * that used to stringify cancellations.
 */
function loaderFor(tool: { name: string }): Loader {
  const loader = new Loader(true);
  (loader as unknown as { tools: Map<string, unknown> }).tools.set(tool.name, {
    tool,
    layer: 'built-in'
  });
  return loader;
}

describe('cancellation survives the real tool wrappers and Loader.execute', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    ctx = createMockContext('/tmp/cancel-propagation');
    vi.clearAllMocks();
  });

  it('web_fetch: a cancelled engine call THROWS through tool -> loader', async () => {
    const loader = loaderFor(webFetchTool);
    const controller = new AbortController();
    vi.mocked(ctx.core.webFetch).mockImplementation(async (_url: string, signal?: AbortSignal) => {
      controller.abort();
      expect(signal?.aborted).toBe(true);
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    await expect(loader.execute('web_fetch', ctx, { url: 'https://example.com' }, controller.signal)).rejects.toSatisfy(
      (err: unknown) => isCancellation(err, controller.signal)
    );
  });

  it('web_fetch: an ordinary network failure still returns an Error string', async () => {
    const loader = loaderFor(webFetchTool);
    vi.mocked(ctx.core.webFetch).mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com'));

    const out = await loader.execute('web_fetch', ctx, { url: 'https://example.com' }, new AbortController().signal);
    expect(typeof out).toBe('string');
    expect(out).toBe('Error: getaddrinfo ENOTFOUND example.com');
    // And it was briefed as a failure, which a cancellation must never be.
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'web_fetch', expect.any(String));
  });

  it('web_search: a cancelled engine call THROWS, and is not briefed as an error', async () => {
    const loader = loaderFor(webSearchTool);
    const controller = new AbortController();
    vi.mocked(ctx.core.webSearch).mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });

    await expect(loader.execute('web_search', ctx, { query: 'x' }, controller.signal)).rejects.toThrow();
    expect(ctx.core.brief).not.toHaveBeenCalledWith('error', 'web_search', expect.any(String));
  });

  it('web_search: an ordinary failure still returns an Error string', async () => {
    const loader = loaderFor(webSearchTool);
    vi.mocked(ctx.core.webSearch).mockRejectedValue(new Error('rate limit exceeded'));

    const out = await loader.execute('web_search', ctx, { query: 'x' }, new AbortController().signal);
    expect(out).toBe('Error: rate limit exceeded');
  });

  it('read_picture: a cancelled vision call THROWS through the tool catch', async () => {
    // The tool resolves against ctx.core.getWorkDir() and refuses paths outside
    // it, so the fixture must live INSIDE the mocked workspace.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-prop-'));
    ctx = createMockContext(workspace);
    vi.clearAllMocks();
    const loader = loaderFor(readPictureTool);
    const controller = new AbortController();
    vi.mocked(ctx.core.readPictureCached).mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });

    const pic = path.join(workspace, 'pic.png');
    fs.writeFileSync(pic, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      await expect(loader.execute('read_picture', ctx, { path: pic }, controller.signal)).rejects.toSatisfy(
        (err: unknown) => isCancellation(err, controller.signal)
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('a signal-aborted failure is classified by the signal even if the error is re-wrapped', async () => {
    const loader = loaderFor(webFetchTool);
    const controller = new AbortController();
    vi.mocked(ctx.core.webFetch).mockImplementation(async () => {
      controller.abort();
      // Not an AbortError, not a StreamAbortedError: only the signal tells the truth.
      throw new Error('fetch failed');
    });

    await expect(loader.execute('web_fetch', ctx, { url: 'https://example.com' }, controller.signal)).rejects.toThrow(
      'fetch failed'
    );
  });
});
