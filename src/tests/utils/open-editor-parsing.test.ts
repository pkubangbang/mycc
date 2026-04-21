/**
 * open-editor-parsing.test.ts - File parsing tests
 */

import { describe, it, expect } from 'vitest';

// Import the function
const { parseFile } = await import('../../utils/open-editor.js');

describe('parseFile', () => {
  it('should parse file without line or column', () => {
    const result = parseFile('file.ts');
    expect(result).toEqual({ file: 'file.ts' });
  });

  it('should parse file with line number', () => {
    const result = parseFile('file.ts:10');
    expect(result).toEqual({ file: 'file.ts', line: 10 });
  });

  it('should parse file with line and column', () => {
    const result = parseFile('file.ts:10:5');
    expect(result).toEqual({ file: 'file.ts', line: 10, column: 5 });
  });

  it('should handle paths with dots', () => {
    const result = parseFile('/path/to/file.test.ts');
    expect(result).toEqual({ file: '/path/to/file.test.ts' });
  });

  it('should handle paths with line number', () => {
    const result = parseFile('/path/to/file.ts:42');
    expect(result).toEqual({ file: '/path/to/file.ts', line: 42 });
  });

  it('should handle paths with line and column', () => {
    const result = parseFile('/path/to/file.ts:42:15');
    expect(result).toEqual({ file: '/path/to/file.ts', line: 42, column: 15 });
  });

  it('should handle Windows-style paths', () => {
    const result = parseFile('C:\\Users\\test\\file.ts:10:5');
    expect(result.file).toBe('C:\\Users\\test\\file.ts');
    expect(result.line).toBe(10);
    expect(result.column).toBe(5);
  });

  it('should handle relative paths', () => {
    const result = parseFile('./src/file.ts:10');
    expect(result).toEqual({ file: './src/file.ts', line: 10 });
  });

  it('should parse line as integer', () => {
    const result = parseFile('file.ts:007');
    expect(result.line).toBe(7);
  });

  it('should parse column as integer', () => {
    const result = parseFile('file.ts:10:003');
    expect(result.column).toBe(3);
  });

  it('should handle file with special characters in name', () => {
    const result = parseFile('my-file_name.test.ts');
    expect(result).toEqual({ file: 'my-file_name.test.ts' });
  });

  it('should handle file path with spaces', () => {
    const result = parseFile('path/with spaces/file.ts:10');
    expect(result).toEqual({ file: 'path/with spaces/file.ts', line: 10 });
  });
});