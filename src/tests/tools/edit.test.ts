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

  it('should replace exact text in file', () => {
    const testFile = path.join(tempDir, 'edit.txt');
    fs.writeFileSync(testFile, 'Hello, World!');

    const result = editTool.handler(ctx, {
      path: 'edit.txt',
      old_text: 'World',
      new_text: 'Universe',
    });

    expect(result).toBe('OK');

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('Hello, Universe!');
  });

  it('should handle multi-line old_text', () => {
    const testFile = path.join(tempDir, 'multiline.txt');
    fs.writeFileSync(testFile, 'line1\nline2\nline3');

    const result = editTool.handler(ctx, {
      path: 'multiline.txt',
      old_text: 'line1\nline2',
      new_text: 'replaced',
    });

    expect(result).toBe('OK');

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('replaced\nline3');
  });

  it('should delete text by using empty new_text', () => {
    const testFile = path.join(tempDir, 'delete.txt');
    fs.writeFileSync(testFile, 'Hello, World!');

    const result = editTool.handler(ctx, {
      path: 'delete.txt',
      old_text: ', World',
      new_text: '',
    });

    expect(result).toBe('OK');

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('Hello!');
  });

  it('should fail when old_text not found', () => {
    const testFile = path.join(tempDir, 'notfound.txt');
    fs.writeFileSync(testFile, 'Hello, World!');

    const result = editTool.handler(ctx, {
      path: 'notfound.txt',
      old_text: 'Goodbye',
      new_text: 'test',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Text not found');
  });

  it('should fail when old_text is not unique', () => {
    const testFile = path.join(tempDir, 'duplicate.txt');
    fs.writeFileSync(testFile, 'foo bar foo baz foo');

    const result = editTool.handler(ctx, {
      path: 'duplicate.txt',
      old_text: 'foo',
      new_text: 'replaced',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Found 3 occurrences');
    expect(result).toContain('more context to make it unique');
  });

  it('should succeed when old_text is unique', () => {
    const testFile = path.join(tempDir, 'unique.txt');
    fs.writeFileSync(testFile, 'foo bar baz foo');

    const result = editTool.handler(ctx, {
      path: 'unique.txt',
      old_text: 'bar',
      new_text: 'replaced',
    });

    expect(result).toBe('OK');

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('foo replaced baz foo');
  });

  it('should block path traversal attacks', () => {
    const result = editTool.handler(ctx, {
      path: '../../../etc/passwd',
      old_text: 'root',
      new_text: 'hacked',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Path escapes workspace');
  });

  it('should handle non-existent file', () => {
    const result = editTool.handler(ctx, {
      path: 'nonexistent.txt',
      old_text: 'something',
      new_text: 'else',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('ENOENT');
  });

  it('should handle special characters in replacement', () => {
    const testFile = path.join(tempDir, 'special.txt');
    fs.writeFileSync(testFile, 'placeholder');

    const result = editTool.handler(ctx, {
      path: 'special.txt',
      old_text: 'placeholder',
      new_text: 'Line1\nLine2\tTabbed\nUnicode: \u4e2d\u6587',
    });

    expect(result).toBe('OK');

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('Line1\nLine2\tTabbed\nUnicode: \u4e2d\u6587');
  });

  it('should handle exact whitespace matching', () => {
    const testFile = path.join(tempDir, 'whitespace.txt');
    fs.writeFileSync(testFile, '  indented\n\ttabbed\n  more');

    // Should match exact indentation
    const result = editTool.handler(ctx, {
      path: 'whitespace.txt',
      old_text: '  indented',
      new_text: 'replaced',
    });

    expect(result).toBe('OK');

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('replaced\n\ttabbed\n  more');
  });

  it('should match substring old_text', () => {
    const testFile = path.join(tempDir, 'partial.txt');
    fs.writeFileSync(testFile, 'HelloWorld');

    // 'World' is a substring of 'HelloWorld' and should be found
    const result = editTool.handler(ctx, {
      path: 'partial.txt',
      old_text: 'World',
      new_text: 'Universe',
    });

    expect(result).toBe('OK');

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('HelloUniverse');
  });

  it('should handle empty file', () => {
    const testFile = path.join(tempDir, 'empty.txt');
    fs.writeFileSync(testFile, '');

    const result = editTool.handler(ctx, {
      path: 'empty.txt',
      old_text: 'anything',
      new_text: 'something',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Text not found');
  });

  it('should handle paths with spaces', () => {
    const dir = path.join(tempDir, 'space folder');
    fs.mkdirSync(dir);
    const testFile = path.join(dir, 'space file.txt');
    fs.writeFileSync(testFile, 'original');

    const result = editTool.handler(ctx, {
      path: 'space folder/space file.txt',
      old_text: 'original',
      new_text: 'edited',
    });

    expect(result).toBe('OK');

    const edited = fs.readFileSync(testFile, 'utf-8');
    expect(edited).toBe('edited');
  });

  it('should have correct metadata', () => {
    expect(editTool.name).toBe('edit_file');
    expect(editTool.scope).toEqual(['main', 'child', 'bg']);
    expect(editTool.input_schema.required).toContain('path');
    expect(editTool.input_schema.required).toContain('old_text');
    expect(editTool.input_schema.required).toContain('new_text');
  });
});