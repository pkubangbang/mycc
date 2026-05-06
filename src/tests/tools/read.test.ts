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

  it('should read file contents', () => {
    const testFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFile, 'Hello, World!');

    const result = readTool.handler(ctx, { path: 'test.txt' });

    // Result now includes header with file stats
    expect(result).toContain('Hello, World!');
    expect(result).toContain('File: test.txt');
    expect(result).toContain('Chars:');
  });

  it('should read file with limit parameter', () => {
    const testFile = path.join(tempDir, 'test.txt');
    const content = 'line1\nline2\nline3\nline4\nline5';
    fs.writeFileSync(testFile, content);

    const result = readTool.handler(ctx, { path: 'test.txt', limit: 2 });

    // Result now includes header
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).toContain('File: test.txt');
  });

  it('should handle limit larger than file', () => {
    const testFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFile, 'single line');

    const result = readTool.handler(ctx, { path: 'test.txt', limit: 100 });

    // Result now includes header
    expect(result).toContain('single line');
    expect(result).toContain('File: test.txt');
  });

  it('should block path traversal attacks', () => {
    const result = readTool.handler(ctx, { path: '../../../etc/passwd' });

    expect(result).toContain('Error:');
    expect(result).toContain('Path escapes workspace');
  });

  it('should block absolute path outside workspace', () => {
    const result = readTool.handler(ctx, { path: '/etc/passwd' });

    expect(result).toContain('Error:');
    expect(result).toContain('Path escapes workspace');
  });

  it('should block null byte injection', () => {
    const result = readTool.handler(ctx, { path: 'test.txt\x00../../../etc/passwd' });

    expect(result).toContain('Error:');
  });

  it('should read file from subdirectory', () => {
    const subdir = path.join(tempDir, 'subdir');
    fs.mkdirSync(subdir);
    const testFile = path.join(subdir, 'nested.txt');
    fs.writeFileSync(testFile, 'nested content');

    const result = readTool.handler(ctx, { path: 'subdir/nested.txt' });

    expect(result).toContain('nested content');
    expect(result).toContain('File: subdir/nested.txt');
  });

  it('should handle non-existent file', () => {
    const result = readTool.handler(ctx, { path: 'nonexistent.txt' });

    expect(result).toContain('Error:');
    expect(result).toContain('File not found');
  });

  it('should handle large single-line files', async () => {
    const testFile = path.join(tempDir, 'large.txt');
    // Create a file with one very long line (60000 chars, no newlines)
    const largeContent = 'x'.repeat(60000);
    fs.writeFileSync(testFile, largeContent);

    const result = await readTool.handler(ctx, { path: 'large.txt' });

    // Result should contain header with file stats
    expect(result).toContain('File: large.txt');
    // Single-line files are displayed with char count
    expect(result).toContain('Chars:');
    // File content should be present (either full or truncated)
    expect(result).toContain('x');
  });

  it('should handle file with only newlines', () => {
    const testFile = path.join(tempDir, 'newlines.txt');
    fs.writeFileSync(testFile, '\n\n\n');

    const result = readTool.handler(ctx, { path: 'newlines.txt' });

    // Result now includes header
    expect(result).toContain('\n\n\n');
    expect(result).toContain('File: newlines.txt');
  });

  it('should handle symlink within workspace', () => {
    const realFile = path.join(tempDir, 'real.txt');
    fs.writeFileSync(realFile, 'real content');

    const symlink = path.join(tempDir, 'link.txt');
    fs.symlinkSync(realFile, symlink);

    const result = readTool.handler(ctx, { path: 'link.txt' });

    expect(result).toContain('real content');
    expect(result).toContain('File: link.txt');
  });

  it('should handle paths with spaces', () => {
    const dir = path.join(tempDir, 'space folder');
    fs.mkdirSync(dir);
    const testFile = path.join(dir, 'space file.txt');
    fs.writeFileSync(testFile, 'space content');

    const result = readTool.handler(ctx, { path: 'space folder/space file.txt' });

    expect(result).toContain('space content');
    expect(result).toContain('File: space folder/space file.txt');
  });

  it('should have correct metadata', () => {
    expect(readTool.name).toBe('read_file');
    expect(readTool.scope).toEqual(['main', 'child', 'bg']);
    expect(readTool.input_schema.required).toContain('path');
  });
});