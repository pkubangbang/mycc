/**
 * write.test.ts - Tests for the write tool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { writeTool } from '../../tools/write.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('writeTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('should write content to file', () => {
    const result = writeTool.handler(ctx, {
      path: 'new.txt',
      content: 'Hello, World!',
    });

    expect(result).toBe('OK');

    const written = fs.readFileSync(path.join(tempDir, 'new.txt'), 'utf-8');
    expect(written).toBe('Hello, World!');
  });

  it('should create parent directories automatically', () => {
    const result = writeTool.handler(ctx, {
      path: 'deep/nested/dir/file.txt',
      content: 'nested content',
    });

    expect(result).toBe('OK');

    const written = fs.readFileSync(
      path.join(tempDir, 'deep/nested/dir/file.txt'),
      'utf-8'
    );
    expect(written).toBe('nested content');
  });

  it('should overwrite existing file', () => {
    const testFile = path.join(tempDir, 'existing.txt');
    fs.writeFileSync(testFile, 'original content');

    const result = writeTool.handler(ctx, {
      path: 'existing.txt',
      content: 'new content',
    });

    expect(result).toBe('OK');

    const written = fs.readFileSync(testFile, 'utf-8');
    expect(written).toBe('new content');
  });

  it('should write empty content', () => {
    const result = writeTool.handler(ctx, {
      path: 'empty.txt',
      content: '',
    });

    expect(result).toBe('OK');

    const written = fs.readFileSync(path.join(tempDir, 'empty.txt'), 'utf-8');
    expect(written).toBe('');
  });

  it('should block path traversal attacks', () => {
    const result = writeTool.handler(ctx, {
      path: '../../../tmp/malicious.txt',
      content: 'malicious',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Path escapes workspace');
  });

  it('should block absolute path outside workspace', () => {
    const result = writeTool.handler(ctx, {
      path: '/tmp/malicious.txt',
      content: 'malicious',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Path escapes workspace');
  });

  it('should handle special characters in content', () => {
    const specialContent = 'Line1\nLine2\tTabbed\nUnicode: \u4e2d\u6587';

    const result = writeTool.handler(ctx, {
      path: 'special.txt',
      content: specialContent,
    });

    expect(result).toBe('OK');

    const written = fs.readFileSync(path.join(tempDir, 'special.txt'), 'utf-8');
    expect(written).toBe(specialContent);
  });

  it('should handle large content', () => {
    const largeContent = 'x'.repeat(100000);

    const result = writeTool.handler(ctx, {
      path: 'large.txt',
      content: largeContent,
    });

    expect(result).toBe('OK');

    const written = fs.readFileSync(path.join(tempDir, 'large.txt'), 'utf-8');
    expect(written.length).toBe(100000);
  });

  it('should handle file with same name as directory', () => {
    // Create a directory first
    fs.mkdirSync(path.join(tempDir, 'mydir'));

    // Writing to a path that would conflict
    const result = writeTool.handler(ctx, {
      path: 'mydir',
      content: 'content',
    });

    // Should fail because mydir is a directory
    expect(result).toContain('Error:');
  });

  it('should handle paths with spaces', () => {
    const result = writeTool.handler(ctx, {
      path: 'folder with spaces/file name.txt',
      content: 'content',
    });

    expect(result).toBe('OK');

    const written = fs.readFileSync(
      path.join(tempDir, 'folder with spaces/file name.txt'),
      'utf-8'
    );
    expect(written).toBe('content');
  });

  it('should have correct metadata', () => {
    expect(writeTool.name).toBe('write_file');
    expect(writeTool.scope).toEqual(['main', 'child', 'bg']);
    expect(writeTool.input_schema.required).toContain('path');
    expect(writeTool.input_schema.required).toContain('content');
  });
});