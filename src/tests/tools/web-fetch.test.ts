/**
 * web-fetch.test.ts - Tests for the web_fetch tool
 *
 * Focus: URL validation at the tool layer (dir-5 Bug 4). `new URL()` accepts
 * any scheme (file:, ftp:, data:, javascript:, ...), but the tool's error
 * message has always promised "http:// or https://". The fix enforces a
 * protocol allowlist (http/https only) as the sole URL-validation
 * chokepoint before the URL is forwarded to the provider's fetch.
 *
 * The actual fetch is performed server-side by the provider (Ollama cloud's
 * ollama.webFetch, or 'not supported' under DeepSeek), so this test mocks
 * ctx.core.webFetch and only asserts the validation gate — it does NOT
 * exercise the network path. Private-IP / SSRF blocking is intentionally NOT
 * tested here (out of scope per design: the fetch is server-side, so a
 * request to a private/metadata IP originates from the provider's infra,
 * not the mycc process).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { webFetchTool } from '../../tools/web_fetch.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';

describe('webFetchTool', () => {
  let tempDir: string;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  // ── Required-arg + format validation ───────────────────────────────────

  it('returns an Error when url is missing', async () => {
    const out = await webFetchTool.handler(ctx, {});
    expect(out).toContain('Error:');
    expect(out).toContain('url is required');
    expect(ctx.core.webFetch).not.toHaveBeenCalled();
  });

  it('returns an Error for an unparseable URL', async () => {
    const out = await webFetchTool.handler(ctx, { url: 'not a url at all' });
    expect(out).toContain('Error:');
    expect(out).toContain('Invalid URL format');
    expect(ctx.core.webFetch).not.toHaveBeenCalled();
  });

  // ── Protocol allowlist (dir-5 Bug 4) ───────────────────────────────────

  it.each([
    ['file:', 'file:///etc/passwd'],
    ['ftp:', 'ftp://example.com/file'],
    ['data:', 'data:text/plain,hello'],
    ['javascript:', 'javascript:alert(1)'],
  ])('rejects a %s URL with an unsupported-protocol Error (no fetch)', async (_scheme, url) => {
    const out = await webFetchTool.handler(ctx, { url });
    expect(out).toContain('Error:');
    expect(out).toContain('Unsupported URL protocol');
    // The exact non-http(s) protocol is surfaced so the LLM can self-correct.
    expect(out).toMatch(/protocol "(file:|ftp:|data:|javascript:)"/);
    expect(ctx.core.webFetch).not.toHaveBeenCalled();
  });

  it('lets an http URL through to the fetch (not rejected at the gate)', async () => {
    vi.mocked(ctx.core.webFetch).mockResolvedValue({ title: 'T', url: 'http://x', content: 'c', links: [] });
    await webFetchTool.handler(ctx, { url: 'http://example.com/page' });
    expect(ctx.core.webFetch).toHaveBeenCalledTimes(1);
    expect(ctx.core.webFetch).toHaveBeenCalledWith('http://example.com/page');
  });

  it('lets an https URL through to the fetch (not rejected at the gate)', async () => {
    vi.mocked(ctx.core.webFetch).mockResolvedValue({ title: 'T', url: 'https://x', content: 'c', links: [] });
    await webFetchTool.handler(ctx, { url: 'https://example.com/page' });
    expect(ctx.core.webFetch).toHaveBeenCalledTimes(1);
  });

  // ── Happy path formatting ──────────────────────────────────────────────

  it('formats title + content + links from a successful fetch', async () => {
    vi.mocked(ctx.core.webFetch).mockResolvedValue({
      title: 'Example Page',
      url: 'https://example.com',
      content: 'Main body text',
      links: ['https://a.com', 'https://b.com'],
    });
    const out = await webFetchTool.handler(ctx, { url: 'https://example.com' });
    expect(out).toContain('Fetched: Example Page');
    expect(out).toContain('**URL:** https://example.com');
    expect(out).toContain('Main body text');
    expect(out).toContain('- https://a.com');
    expect(out).toContain('- https://b.com');
  });

  it('caps the rendered links at 20 and notes the remainder', async () => {
    const links = Array.from({ length: 23 }, (_, i) => `https://l${i}.com`);
    vi.mocked(ctx.core.webFetch).mockResolvedValue({
      title: 'T', url: 'https://x', content: 'c', links,
    });
    const out = await webFetchTool.handler(ctx, { url: 'https://x' });
    expect(out).toContain('- https://l19.com');
    expect(out).toContain('... and 3 more links');
  });

  it('returns an Error when the underlying webFetch throws', async () => {
    vi.mocked(ctx.core.webFetch).mockRejectedValue(new Error('network down'));
    const out = await webFetchTool.handler(ctx, { url: 'https://example.com' });
    expect(out).toContain('Error:');
    expect(out).toContain('network down');
  });
});