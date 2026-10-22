/**
 * edit.test.ts - Tests for the edit tool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { editTool } from '../../tools/edit.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('editTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('should replace exact text in file', async () => {
    const testFile = path.join(tempDir, 'edit.txt');
    fs.writeFileSync(testFile, 'Hello, World!');

    const result = await editTool.handler(ctx, {
      path: 'edit.txt',
      old_text: 'World',
      new_text: 'Universe',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('Hello, Universe!');
  });

  it('should handle multi-line old_text', async () => {
    const testFile = path.join(tempDir, 'multiline.txt');
    fs.writeFileSync(testFile, 'line1\nline2\nline3');

    const result = await editTool.handler(ctx, {
      path: 'multiline.txt',
      old_text: 'line1\nline2',
      new_text: 'replaced',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('replaced\nline3');
  });

  it('should delete text by using empty new_text', async () => {
    const testFile = path.join(tempDir, 'delete.txt');
    fs.writeFileSync(testFile, 'Hello, World!');

    const result = await editTool.handler(ctx, {
      path: 'delete.txt',
      old_text: ', World',
      new_text: '',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('Hello!');
  });

  it('should fail when old_text not found', async () => {
    const testFile = path.join(tempDir, 'notfound.txt');
    fs.writeFileSync(testFile, 'Hello, World!');

    const result = await editTool.handler(ctx, {
      path: 'notfound.txt',
      old_text: 'Goodbye',
      new_text: 'test',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Text not found');
  });

  it('should fail when old_text is not unique', async () => {
    const testFile = path.join(tempDir, 'duplicate.txt');
    fs.writeFileSync(testFile, 'foo bar foo baz foo');

    const result = await editTool.handler(ctx, {
      path: 'duplicate.txt',
      old_text: 'foo',
      new_text: 'replaced',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Found 3 occurrences');
    expect(result).toContain('more context to make it unique');
  });

  it('should succeed when old_text is unique', async () => {
    const testFile = path.join(tempDir, 'unique.txt');
    fs.writeFileSync(testFile, 'foo bar baz foo');

    const result = await editTool.handler(ctx, {
      path: 'unique.txt',
      old_text: 'bar',
      new_text: 'replaced',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('foo replaced baz foo');
  });

  it('should block path traversal attacks', async () => {
    // Use a traversal target that is NOT a sensitive system path. A pattern
    // like `../../../etc/passwd` RESOLVES to `/etc/passwd`, which IS sensitive,
    // so edit short-circuits to the protected-path rejection ("Cannot edit
    // /etc/passwd — system configuration directory") BEFORE the external-
    // access check — that is correct, secure behavior, but it is the WRONG
    // target for asserting the external-access branch. A non-sensitive
    // external target reaches requestExternalPathAccess → 'Path escapes
    // workspace'. (The sensitive-path branch is covered in path-validation.)
    const result = await editTool.handler(ctx, {
      path: '../../../tmp/mycc-traversal-probe.txt',
      old_text: 'root',
      new_text: 'hacked',
    });

    // Traversal patterns resolve outside the workspace but are not sensitive
    // system paths, so they reach the requestExternalPathAccess denial.
    expect(result).toContain('Error: Path escapes workspace');
  });

  it('should handle non-existent file', async () => {
    const result = await editTool.handler(ctx, {
      path: 'nonexistent.txt',
      old_text: 'something',
      new_text: 'else',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('ENOENT');
  });

  it('should handle special characters in replacement', async () => {
    const testFile = path.join(tempDir, 'special.txt');
    fs.writeFileSync(testFile, 'placeholder');

    const result = await editTool.handler(ctx, {
      path: 'special.txt',
      old_text: 'placeholder',
      new_text: 'Line1\nLine2\tTabbed\nUnicode: \u4e2d\u6587',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('Line1\nLine2\tTabbed\nUnicode: \u4e2d\u6587');
  });

  it('should handle exact whitespace matching', async () => {
    const testFile = path.join(tempDir, 'whitespace.txt');
    fs.writeFileSync(testFile, '  indented\n\ttabbed\n  more');

    // Should match exact indentation
    const result = await editTool.handler(ctx, {
      path: 'whitespace.txt',
      old_text: '  indented',
      new_text: 'replaced',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('replaced\n\ttabbed\n  more');
  });

  it('should match substring old_text', async () => {
    const testFile = path.join(tempDir, 'partial.txt');
    fs.writeFileSync(testFile, 'HelloWorld');

    // 'World' is a substring of 'HelloWorld' and should be found
    const result = await editTool.handler(ctx, {
      path: 'partial.txt',
      old_text: 'World',
      new_text: 'Universe',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('HelloUniverse');
  });

  it('should handle empty file', async () => {
    const testFile = path.join(tempDir, 'empty.txt');
    fs.writeFileSync(testFile, '');

    const result = await editTool.handler(ctx, {
      path: 'empty.txt',
      old_text: 'anything',
      new_text: 'something',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Text not found');
  });

  it('should handle paths with spaces', async () => {
    const dir = path.join(tempDir, 'space folder');
    fs.mkdirSync(dir);
    const testFile = path.join(dir, 'space file.txt');
    fs.writeFileSync(testFile, 'original');

    const result = await editTool.handler(ctx, {
      path: 'space folder/space file.txt',
      old_text: 'original',
      new_text: 'edited',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('edited');
  });

  it('should match LF old_text in CRLF file', async () => {
    const testFile = path.join(tempDir, 'crlf.txt');
    fs.writeFileSync(testFile, 'line1\r\nline2\r\nline3');

    // LLM provides LF-only old_text (as always happens in JSON tool calls)
    const result = await editTool.handler(ctx, {
      path: 'crlf.txt',
      old_text: 'line1\nline2',
      new_text: 'replaced',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('replaced\r\nline3');
  });

  it('should preserve CRLF in output after edit', async () => {
    const testFile = path.join(tempDir, 'preserve-crlf.txt');
    fs.writeFileSync(testFile, 'header\r\ncontent\r\nfooter');

    const result = await editTool.handler(ctx, {
      path: 'preserve-crlf.txt',
      old_text: 'content',
      new_text: 'modified',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    // File should still use CRLF after edit
    expect(edited).toBe('header\r\nmodified\r\nfooter');
  });

  it('should handle CRLF old_text in LF file', async () => {
    const testFile = path.join(tempDir, 'lf-file.txt');
    fs.writeFileSync(testFile, 'a\nb\nc');

    // LLM might send CRLF if it previously read a CRLF file
    const result = await editTool.handler(ctx, {
      path: 'lf-file.txt',
      old_text: 'a\r\nb',
      new_text: 'replaced',
    });

    expect(result).toMatch(/^OK/);

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('replaced\nc');
  });

  it('should preserve BOM by default (strip_bom unset) when editing a BOM file', async () => {
    const testFile = path.join(tempDir, 'bom.txt');
    fs.writeFileSync(testFile, '﻿' + 'Hello, World!');

    // LLM sends old_text without BOM (from read output after BOM stripping)
    const result = await editTool.handler(ctx, {
      path: 'bom.txt',
      old_text: 'Hello',
      new_text: 'Bonjour',
    });

    expect(result).toMatch(/^OK/);
    // The self-check should report bom=true (preserved)
    expect(result).toContain('bom=true');

    const raw = fs.readFileSync(testFile);
    // First 3 bytes must be the UTF-8 BOM (EF BB BF)
    expect(raw[0]).toBe(0xef);
    expect(raw[1]).toBe(0xbb);
    expect(raw[2]).toBe(0xbf);
    // Content after BOM is the replaced text
    expect(raw.slice(3).toString('utf-8')).toBe('Bonjour, World!');
  });

  it('should strip BOM when strip_bom=true', async () => {
    const testFile = path.join(tempDir, 'bom-strip.txt');
    fs.writeFileSync(testFile, '﻿' + 'Hello, World!');

    const result = await editTool.handler(ctx, {
      path: 'bom-strip.txt',
      old_text: 'Hello',
      new_text: 'Bonjour',
      strip_bom: true,
    });

    expect(result).toMatch(/^OK/);
    expect(result).toContain('bom=false');

    const raw = fs.readFileSync(testFile);
    // No BOM — first byte is 'B' (0x42)
    expect(raw[0]).toBe(0x42);
    expect(raw.toString('utf-8')).toBe('Bonjour, World!');
  });

  it('should NOT add a BOM when the file had none (strip_bom default)', async () => {
    const testFile = path.join(tempDir, 'nobom.txt');
    fs.writeFileSync(testFile, 'Hello, World!');

    const result = await editTool.handler(ctx, {
      path: 'nobom.txt',
      old_text: 'Hello',
      new_text: 'Bonjour',
    });

    expect(result).toMatch(/^OK/);
    expect(result).toContain('bom=false');

    const raw = fs.readFileSync(testFile);
    expect(raw[0]).toBe(0x42); // 'B'
    expect(raw.toString('utf-8')).toBe('Bonjour, World!');
  });







  it('should have correct metadata', () => {
    expect(editTool.name).toBe('edit_file');
    expect(editTool.scope).toEqual(['main', 'child']);
    expect(editTool.input_schema.required).toContain('path');
    expect(editTool.input_schema.required).toContain('old_text');
    expect(editTool.input_schema.required).toContain('new_text');
  });

  // Regression test for the reported bug: a missing/non-string `path` argument
  // previously crashed with "Cannot read properties of undefined (reading
  // 'startsWith')" because edit's pre-try setup called resolvePath(undefined)
  // outside its try/catch, letting the throw escape to the dispatcher as
  // "Error executing edit_file: ...". The handler must now return a clean
  // Error string (not throw) so the agent gets an actionable message.
  it('should return a clean Error when path arg is missing (no escaping throw)', async () => {
    const result = await editTool.handler(ctx, {
      old_text: 'foo',
      new_text: 'bar',
    });

    expect(result).toBe('Error: `path` argument is required and must be a non-empty string.');
    expect(result).not.toContain('Cannot read properties of undefined');
  });

  it('should return a clean Error when path arg is an empty string', async () => {
    const result = await editTool.handler(ctx, {
      path: '',
      old_text: 'foo',
      new_text: 'bar',
    });

    expect(result).toBe('Error: `path` argument is required and must be a non-empty string.');
  });

  it('should return a clean Error when old_text arg is missing', async () => {
    const testFile = path.join(tempDir, 'exists.txt');
    fs.writeFileSync(testFile, 'Hello');

    const result = await editTool.handler(ctx, {
      path: 'exists.txt',
      new_text: 'bar',
    });

    expect(result).toBe('Error: `old_text` argument is required and must be a string.');
  });

  it('should return a clean Error when new_text arg is missing', async () => {
    const testFile = path.join(tempDir, 'exists2.txt');
    fs.writeFileSync(testFile, 'Hello');

    const result = await editTool.handler(ctx, {
      path: 'exists2.txt',
      old_text: 'Hello',
    });

    expect(result).toBe('Error: `new_text` argument is required and must be a string.');
  });

  // ── Line-ending preservation ────────────────────────────────────────
  // edit_file must respect the original file line-ending style: a CRLF
  // file stays CRLF after the edit, an LF file stays LF. The LLM always
  // sends LF-only old_text/new_text (JSON tool-call args), so the tool
  // normalizes to LF for matching then restores the original style on write.
  describe('line-ending preservation', () => {
    it('should preserve CRLF line endings after edit', async () => {
      const testFile = path.join(tempDir, 'le-crlf.txt');
      fs.writeFileSync(testFile, 'alpha\r\nbeta\r\ngamma');

      const result = await editTool.handler(ctx, {
        path: 'le-crlf.txt',
        old_text: 'beta',
        new_text: 'BETA',
      });

      expect(result).toMatch(/^OK/);
      expect(result).toContain('newline=crlf');
      expect(fs.readFileSync(testFile, 'utf-8')).toBe('alpha\r\nBETA\r\ngamma');
    });

    it('should preserve LF line endings after edit (no CRLF introduced)', async () => {
      const testFile = path.join(tempDir, 'le-lf.txt');
      fs.writeFileSync(testFile, 'alpha\nbeta\ngamma');

      const result = await editTool.handler(ctx, {
        path: 'le-lf.txt',
        old_text: 'beta',
        new_text: 'BETA',
      });

      expect(result).toMatch(/^OK/);
      expect(result).toContain('newline=lf');
      const edited = fs.readFileSync(testFile, 'utf-8');
      expect(edited).toBe('alpha\nBETA\ngamma');
      expect(edited).not.toContain('\r');
    });


  });
});
