/**
 * read-picture.test.ts - Tests for the read_picture tool
 *
 * The tool is a thin wrapper over ctx.core.readPictureCached(). These tests
 * cover: path validation, result formatting, delegation to readPictureCached,
 * and error handling. The caching/vision logic itself lives in Core and is
 * not exercised here (readPictureCached is mocked).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readPictureTool } from '../../tools/read-picture.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext, PictureResult } from '../../types.js';

describe('readPictureTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  /** Create a dummy image file (any bytes; readPictureCached is mocked). */
  function makeImage(name: string): string {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, Buffer.from('89504E470D0A1A0A', 'hex')); // PNG header bytes
    return file;
  }

  // ── Delegation & formatting ────────────────────────────────────────────

  it('should delegate to readPictureCached and format pairs + token on first read', async () => {
    makeImage('img.png');
    const result: PictureResult = {
      pairs: [{ focus: 'general description', description: 'A login form with two fields.' }],
      cacheToken: 'aaaaaaaaaaaaaaaa',
    };
    (ctx.core.readPictureCached as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    const out = await readPictureTool.handler(ctx, { path: 'img.png' });

    expect(ctx.core.readPictureCached).toHaveBeenCalledTimes(1);
    // Called with the absolute path, undefined prompt, undefined cache token
    const [absPath, prompt, cacheToken] = (ctx.core.readPictureCached as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(absPath).toBe(path.join(tempDir, 'img.png'));
    expect(prompt).toBeUndefined();
    expect(cacheToken).toBeUndefined();

    // Output contains the focus pair, the cache token, and the hint
    expect(out).toContain('[general description]: A login form with two fields.');
    expect(out).toContain('Cache token: aaaaaaaaaaaaaaaa');
    expect(out).toContain('cache="aaaaaaaaaaaaaaaa"');
  });

  it('should pass prompt and cache token through to readPictureCached', async () => {
    makeImage('img.png');
    const result: PictureResult = {
      pairs: [
        { focus: 'general description', description: 'desc1' },
        { focus: 'What text is visible?', description: 'desc2' },
      ],
      cacheToken: 'bbbbbbbbbbbbbbbb',
    };
    (ctx.core.readPictureCached as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    const out = await readPictureTool.handler(ctx, {
      path: 'img.png',
      prompt: 'What text is visible?',
      cache: 'aaaaaaaaaaaaaaaa',
    });

    const [absPath, prompt, cacheToken] = (ctx.core.readPictureCached as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(absPath).toBe(path.join(tempDir, 'img.png'));
    expect(prompt).toBe('What text is visible?');
    expect(cacheToken).toBe('aaaaaaaaaaaaaaaa');

    // Both pairs are rendered
    expect(out).toContain('[general description]: desc1');
    expect(out).toContain('[What text is visible?]: desc2');
    // The returned (new) token is surfaced
    expect(out).toContain('Cache token: bbbbbbbbbbbbbbbb');
  });

  it('should return cached pairs only when readPictureCached returns them (no vision detail at tool layer)', async () => {
    makeImage('img.png');
    const result: PictureResult = {
      pairs: [{ focus: 'general description', description: 'cached desc' }],
      cacheToken: 'cccccccccccccccc',
    };
    (ctx.core.readPictureCached as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    const out = await readPictureTool.handler(ctx, { path: 'img.png' });

    expect(out).toContain('cached desc');
    expect(out).toContain('Cache token: cccccccccccccccc');
  });

  // ── Path validation (unchanged from before) ────────────────────────────

  it('should block path traversal attacks', async () => {
    const out = await readPictureTool.handler(ctx, { path: '../../../etc/passwd' });
    expect(out).toContain('Error:');
  });

  it('should block absolute path outside workspace', async () => {
    const out = await readPictureTool.handler(ctx, { path: '/etc/passwd' });
    expect(out).toContain('Error:');
  });

  it('should handle non-existent file', async () => {
    const out = await readPictureTool.handler(ctx, { path: 'nope.png' });
    expect(out).toContain('Error:');
    expect(out).toContain('not found');
    expect(ctx.core.readPictureCached).not.toHaveBeenCalled();
  });

  it('should warn on unsupported extension', async () => {
    const file = path.join(tempDir, 'doc.txt');
    fs.writeFileSync(file, 'hello');

    const out = await readPictureTool.handler(ctx, { path: 'doc.txt' });

    expect(out).toContain('Warning:');
    expect(out).toContain('.txt');
    expect(ctx.core.readPictureCached).not.toHaveBeenCalled();
  });

  it('should read image from subdirectory', async () => {
    const sub = path.join(tempDir, 'sub');
    fs.mkdirSync(sub);
    const file = path.join(sub, 'nested.png');
    fs.writeFileSync(file, Buffer.from('89504E470D0A1A0A', 'hex'));

    (ctx.core.readPictureCached as ReturnType<typeof vi.fn>).mockResolvedValue({
      pairs: [{ focus: 'general description', description: 'nested' }],
      cacheToken: 'dddddddddddddddd',
    });

    const out = await readPictureTool.handler(ctx, { path: 'sub/nested.png' });

    const [absPath] = (ctx.core.readPictureCached as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(absPath).toBe(path.join(tempDir, 'sub', 'nested.png'));
    expect(out).toContain('nested');
  });

  // ── Error handling ──────────────────────────────────────────────────────

  it('should return an error message if readPictureCached throws', async () => {
    makeImage('img.png');
    (ctx.core.readPictureCached as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('vision model failed'));

    const out = await readPictureTool.handler(ctx, { path: 'img.png' });

    expect(out).toContain('Error:');
    expect(out).toContain('vision model failed');
  });

  // ── Tool metadata ──────────────────────────────────────────────────────

  it('should have correct metadata', () => {
    expect(readPictureTool.name).toBe('read_picture');
    expect(readPictureTool.scope).toEqual(['main', 'child']);
    expect(readPictureTool.input_schema.required).toContain('path');
    // cache and prompt are optional properties
    const props = readPictureTool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('cache');
    expect(props).toHaveProperty('prompt');
  });
});