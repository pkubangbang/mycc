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

  it('should write content to file', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'new.txt',
      content: 'Hello, World!',
    });

    expect(result).toMatch(/^OK/);

    const written = fs.readFileSync(path.join(tempDir, 'new.txt'), 'utf-8');
    expect(written).toBe('Hello, World!');
  });

  it('should create parent directories automatically', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'deep/nested/dir/file.txt',
      content: 'nested content',
    });

    expect(result).toMatch(/^OK/);

    const written = fs.readFileSync(
      path.join(tempDir, 'deep/nested/dir/file.txt'),
      'utf-8'
    );
    expect(written).toBe('nested content');
  });

  it('should overwrite existing file', async () => {
    const testFile = path.join(tempDir, 'existing.txt');
    fs.writeFileSync(testFile, 'original content');

    const result = await writeTool.handler(ctx, {
      path: 'existing.txt',
      content: 'new content',
    });

    expect(result).toMatch(/^OK/);

    const written = fs.readFileSync(testFile, 'utf-8');
    expect(written).toBe('new content');
  });

  it('should write empty content', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'empty.txt',
      content: '',
    });

    expect(result).toMatch(/^OK/);

    const written = fs.readFileSync(path.join(tempDir, 'empty.txt'), 'utf-8');
    expect(written).toBe('');
  });

  it('should block path traversal attacks', async () => {
    const result = await writeTool.handler(ctx, {
      path: '../../../tmp/malicious.txt',
      content: 'malicious',
    });

    // Traversal patterns resolve outside the workspace but are not sensitive
    // system paths, so they reach the requestExternalPathAccess denial.
    expect(result).toContain('Error: Path escapes workspace');
  });

  it('should block absolute path outside workspace', async () => {
    const result = await writeTool.handler(ctx, {
      path: '/tmp/malicious.txt',
      content: 'malicious',
    });

    expect(result).toContain('Error: Path escapes workspace');
  });

  it('should handle special characters in content', async () => {
    const specialContent = 'Line1\nLine2\tTabbed\nUnicode: \u4e2d\u6587';

    const result = await writeTool.handler(ctx, {
      path: 'special.txt',
      content: specialContent,
      // Pin LF so the round-trip equality check is stable across platforms;
      // the default 'auto' would convert to CRLF on Windows.
      newline: 'lf',
    });

    expect(result).toMatch(/^OK/);

    const written = fs.readFileSync(path.join(tempDir, 'special.txt'), 'utf-8');
    expect(written).toBe(specialContent);
  });

  it('should handle large content', async () => {
    const largeContent = 'x'.repeat(100000);

    const result = await writeTool.handler(ctx, {
      path: 'large.txt',
      content: largeContent,
    });

    expect(result).toMatch(/^OK/);

    const written = fs.readFileSync(path.join(tempDir, 'large.txt'), 'utf-8');
    expect(written.length).toBe(100000);
  });

  it('should handle file with same name as directory', async () => {
    // Create a directory first
    fs.mkdirSync(path.join(tempDir, 'mydir'));

    // Writing to a path that would conflict
    const result = await writeTool.handler(ctx, {
      path: 'mydir',
      content: 'content',
    });

    // Should fail because mydir is a directory (EISDIR from writeFileSync)
    expect(result).toContain('Error:');
    expect(result).toMatch(/EISDIR|illegal operation on a directory|is a directory/);
  });

  it('should handle paths with spaces', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'folder with spaces/file name.txt',
      content: 'content',
    });

    expect(result).toMatch(/^OK/);

    const written = fs.readFileSync(
      path.join(tempDir, 'folder with spaces/file name.txt'),
      'utf-8'
    );
    expect(written).toBe('content');
  });

  it('should strip BOM from content before writing', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'bom.txt',
      content: '﻿' + 'Hello, World!',
    });

    expect(result).toMatch(/^OK/);

    const written = fs.readFileSync(path.join(tempDir, 'bom.txt'), 'utf-8');
    // BOM should NOT be in the written file
    expect(written).toBe('Hello, World!');
    expect(written.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('should not add BOM to output', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'no-bom.txt',
      content: 'Normal content without BOM',
    });

    expect(result).toMatch(/^OK/);

    const written = fs.readFileSync(path.join(tempDir, 'no-bom.txt'), 'utf-8');
    expect(written).toBe('Normal content without BOM');
    expect(written.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('should write CRLF when newline is crlf', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'crlf.txt',
      content: 'line1\nline2\nline3',
      newline: 'crlf',
    });

    expect(result).toMatch(/^OK/);
    expect(result).toContain('newline=crlf');

    const buf = fs.readFileSync(path.join(tempDir, 'crlf.txt'));
    // CRLF bytes present, no bare LF
    expect(buf.includes(Buffer.from('\r\n'))).toBe(true);
    expect(buf.includes(Buffer.from('\n'))).toBe(true); // \n is part of \r\n
    // Ensure no lone LF (not preceded by CR)
    const text = buf.toString('utf-8');
    expect(text).toBe('line1\r\nline2\r\nline3');
  });

  it('should write LF when newline is lf', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'lf.txt',
      content: 'line1\r\nline2\r\nline3',
      newline: 'lf',
    });

    expect(result).toMatch(/^OK/);
    expect(result).toContain('newline=lf');

    const written = fs.readFileSync(path.join(tempDir, 'lf.txt'), 'utf-8');
    expect(written).toBe('line1\nline2\nline3');
  });

  it('should report byte-level self-check in return string', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'selfcheck.txt',
      content: 'Hello',
      newline: 'lf',
    });

    expect(result).toMatch(/^OK/);
    // Self-check fields: first4 (hex bytes), bom (bool), newline (style)
    expect(result).toContain('first4=');
    expect(result).toContain('bom=false');
    expect(result).toContain('newline=lf');
    // 'Hello' → 48 65 6c 6c 6f
    expect(result).toContain('first4=48 65 6c 6c');
  });

  it('should add BOM when bom: true is set', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'with-bom.txt',
      content: 'Hello',
      bom: true,
    });

    expect(result).toMatch(/^OK/);
    expect(result).toContain('bom=true');

    const buf = fs.readFileSync(path.join(tempDir, 'with-bom.txt'));
    // UTF-8 BOM = EF BB BF
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
  });

  it('should default to no BOM (bom: false)', async () => {
    const result = await writeTool.handler(ctx, {
      path: 'default-no-bom.txt',
      content: 'Hello',
    });

    expect(result).toMatch(/^OK/);
    expect(result).toContain('bom=false');

    const buf = fs.readFileSync(path.join(tempDir, 'default-no-bom.txt'));
    expect(buf[0]).not.toBe(0xef);
  });

  it('should strip a BOM from content even when bom: true re-adds it (no double BOM)', async () => {
    // Content already has a BOM; bom:true should yield exactly one BOM.
    const result = await writeTool.handler(ctx, {
      path: 'single-bom.txt',
      content: '\uFEFF' + 'Hello',
      bom: true,
    });

    expect(result).toMatch(/^OK/);
    const buf = fs.readFileSync(path.join(tempDir, 'single-bom.txt'));
    // Exactly one BOM at start, not two
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
    expect(buf[3]).toBe(0x48); // 'H' immediately after the single BOM
  });

  it('should have correct metadata', () => {
    expect(writeTool.name).toBe('write_file');
    expect(writeTool.scope).toEqual(['main', 'child']);
    expect(writeTool.input_schema.required).toContain('path');
    expect(writeTool.input_schema.required).toContain('content');
  });
});