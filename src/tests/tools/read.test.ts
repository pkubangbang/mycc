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

    expect(result).toBe('Hello, World!');
  });

  it('should read file with limit parameter', () => {
    const testFile = path.join(tempDir, 'test.txt');
    const content = 'line1\nline2\nline3\nline4\nline5';
    fs.writeFileSync(testFile, content);

    const result = readTool.handler(ctx, { path: 'test.txt', limit: 2 });

    expect(result).toBe('line1\nline2\n... (3 more lines)');
  });

  it('should handle limit larger than file', () => {
    const testFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFile, 'single line');

    const result = readTool.handler(ctx, { path: 'test.txt', limit: 100 });

    expect(result).toBe('single line');
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

    expect(result).toBe('nested content');
  });

  it('should handle non-existent file', () => {
    const result = readTool.handler(ctx, { path: 'nonexistent.txt' });

    expect(result).toContain('Error:');
    expect(result).toContain('ENOENT');
  });

  it('should truncate large files at 50000 chars', async () => {
    const testFile = path.join(tempDir, 'large.txt');
    const largeContent = 'x'.repeat(60000);
    fs.writeFileSync(testFile, largeContent);

    const result = await readTool.handler(ctx, { path: 'large.txt' });

    expect(result.length).toBe(50000);
  });

  it('should handle file with only newlines', () => {
    const testFile = path.join(tempDir, 'newlines.txt');
    fs.writeFileSync(testFile, '\n\n\n');

    const result = readTool.handler(ctx, { path: 'newlines.txt' });

    expect(result).toBe('\n\n\n');
  });

  it('should handle symlink within workspace', () => {
    const realFile = path.join(tempDir, 'real.txt');
    fs.writeFileSync(realFile, 'real content');

    const symlink = path.join(tempDir, 'link.txt');
    fs.symlinkSync(realFile, symlink);

    const result = readTool.handler(ctx, { path: 'link.txt' });

    expect(result).toBe('real content');
  });

  it('should handle paths with spaces', () => {
    const dir = path.join(tempDir, 'space folder');
    fs.mkdirSync(dir);
    const testFile = path.join(dir, 'space file.txt');
    fs.writeFileSync(testFile, 'space content');

    const result = readTool.handler(ctx, { path: 'space folder/space file.txt' });

    expect(result).toBe('space content');
  });

  it('should have correct metadata', () => {
    expect(readTool.name).toBe('read_file');
    expect(readTool.scope).toEqual(['main', 'child', 'bg']);
    expect(readTool.input_schema.required).toContain('path');
  });
});