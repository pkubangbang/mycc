/**
 * read.test.ts - Tests for the read tool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readTool } from '../../tools/read.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('readTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('should read file contents', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFile, 'Hello, World!');

    const result = await readTool.handler(ctx, { path: 'test.txt' });

    // Result now includes header with file stats
    expect(result).toContain('Hello, World!');
    expect(result).toContain('File: test.txt');
    expect(result).toContain('Chars:');
  });

  it('should read file with limit parameter', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    const content = 'line1\nline2\nline3\nline4\nline5';
    fs.writeFileSync(testFile, content);

    const result = await readTool.handler(ctx, { path: 'test.txt', limit: 2 });

    // Result now includes header
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).toContain('File: test.txt');
  });

  it('should handle limit larger than file', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFile, 'single line');

    const result = await readTool.handler(ctx, { path: 'test.txt', limit: 100 });

    // Result now includes header
    expect(result).toContain('single line');
    expect(result).toContain('File: test.txt');
  });

  it('should block path traversal attacks', async () => {
    const result = await readTool.handler(ctx, { path: '../../../etc/passwd' });

    expect(result).toContain('Error:');
  });

  it('should block absolute path outside workspace', async () => {
    const result = await readTool.handler(ctx, { path: '/etc/passwd' });

    expect(result).toContain('Error:');
  });

  it('should block null byte injection', async () => {
    const result = await readTool.handler(ctx, { path: 'test.txt\x00../../../etc/passwd' });

    expect(result).toContain('Error:');
  });

  it('should read file from subdirectory', async () => {
    const subdir = path.join(tempDir, 'subdir');
    fs.mkdirSync(subdir);
    const testFile = path.join(subdir, 'nested.txt');
    fs.writeFileSync(testFile, 'nested content');

    const result = await readTool.handler(ctx, { path: 'subdir/nested.txt' });

    expect(result).toContain('nested content');
    expect(result).toContain('File: subdir/nested.txt');
  });

  it('should handle non-existent file', async () => {
    const result = await readTool.handler(ctx, { path: 'nonexistent.txt' });

    expect(result).toContain('Error:');
    expect(result).toContain('File not found');
  });

  it('should show head/tail preview for minified files with extremely long lines', async () => {
    const testFile = path.join(tempDir, 'large.txt');
    // Create a file with one very long line (300,000 chars, no newlines)
    // This exceeds MAX_LINE_LENGTH (5000) and should show a preview
    const largeContent = 'x'.repeat(300000);
    fs.writeFileSync(testFile, largeContent);

    const result = await readTool.handler(ctx, { path: 'large.txt' });

    // Should show a preview with head + tail of the long line, not an error
    expect(result).toContain('File: large.txt');
    // Source emits "Extremely long lines (likely minified)" — capital E.
    expect(result).toContain('Extremely long lines');
    expect(result).toContain('minified');
    // Should still contain actual file content (the x's)
    expect(result).toContain('x');
    // Should show the omitted chars count
    expect(result).toContain('chars omitted');
  });

  it('should handle file with only newlines', async () => {
    const testFile = path.join(tempDir, 'newlines.txt');
    fs.writeFileSync(testFile, '\n\n\n');

    const result = await readTool.handler(ctx, { path: 'newlines.txt' });

    // Result now includes header
    expect(result).toContain('\n\n\n');
    expect(result).toContain('File: newlines.txt');
  });

  it('should handle symlink within workspace', async () => {
    // Skip on Windows: symlink creation requires admin privileges
    if (process.platform === 'win32') {
      return;
    }
    const realFile = path.join(tempDir, 'real.txt');
    fs.writeFileSync(realFile, 'real content');

    const symlink = path.join(tempDir, 'link.txt');
    fs.symlinkSync(realFile, symlink);

    const result = await readTool.handler(ctx, { path: 'link.txt' });

    expect(result).toContain('real content');
    expect(result).toContain('File: link.txt');
  });

  it('should handle paths with spaces', async () => {
    const dir = path.join(tempDir, 'space folder');
    fs.mkdirSync(dir);
    const testFile = path.join(dir, 'space file.txt');
    fs.writeFileSync(testFile, 'space content');

    const result = await readTool.handler(ctx, { path: 'space folder/space file.txt' });

    expect(result).toContain('space content');
    expect(result).toContain('File: space folder/space file.txt');
  });

  it('should strip BOM from UTF-8 file', async () => {
    const testFile = path.join(tempDir, 'bom.txt');
    fs.writeFileSync(testFile, '﻿' + 'Hello, World!');

    const result = await readTool.handler(ctx, { path: 'bom.txt' });

    // Should contain the content but NOT the BOM character
    expect(result).toContain('Hello, World!');
    expect(result).not.toContain('﻿');
  });

  it('should read normal file without BOM unchanged', async () => {
    const testFile = path.join(tempDir, 'no-bom.txt');
    fs.writeFileSync(testFile, 'Normal content');

    const result = await readTool.handler(ctx, { path: 'no-bom.txt' });

    expect(result).toContain('Normal content');
  });

  it('should handle CJK content with BOM', async () => {
    const testFile = path.join(tempDir, 'cjk-bom.txt');
    fs.writeFileSync(testFile, '﻿' + '你好世界');

    const result = await readTool.handler(ctx, { path: 'cjk-bom.txt' });

    expect(result).toContain('你好世界');
    expect(result).not.toContain('﻿');
  });

  it('should have correct metadata', () => {
    expect(readTool.name).toBe('read_file');
    expect(readTool.scope).toEqual(['main', 'child']);
    expect(readTool.input_schema.required).toContain('path');
  });

  // ── pure read: no handler intercepts special file types ──

  it('should return full content for a crossroad JSON file (no handler intercepts)', async () => {
    // read_file is now pure: it always returns the actual file content to the
    // LLM. Previously a crossroad-json-handler intercepted and returned a short
    // summary instead of the content — the LLM could never edit what it
    // "read". Now the full JSON is returned, so edit_file old_text matching
    // works. The display/replay concern moved to bash display=true +
    // mycc-pretty-print --type=crossroad.
    const record = {
      sessionId: 'test-session',
      timestamp: 1700000000000,
      prefix: 'I was about to say one thing.',
      candidates: ['go forward option', 'go backward option', 'synthesize option'],
      continuation: 'But actually, let me reconsider the assumptions.',
    };
    const testFile = path.join(tempDir, 'crossroad-1700000000000.json');
    fs.writeFileSync(testFile, JSON.stringify(record, null, 2));

    const result = await readTool.handler(ctx, { path: 'crossroad-1700000000000.json' });

    // The FULL JSON content is returned to the LLM (with header), not a short
    // confirmation. The LLM can see the real text and edit it.
    expect(result).toContain('File: crossroad-1700000000000.json');
    expect(result).toContain('"prefix"');
    expect(result).toContain('"continuation"');
    expect(result).toContain('I was about to say one thing.');
    expect(result).toContain('But actually, let me reconsider the assumptions.');
    // No handler summary — that mechanism was removed.
    expect(result).not.toContain('replayed to terminal');
  });
});