/**
 * Tests for sanitize.ts - safeNodeId utility
 */
import { describe, it, expect } from 'vitest';
import { safeNodeId } from '../../utils/sanitize.js';

describe('safeNodeId', () => {
  it('should convert spaces to hyphens', () => {
    expect(safeNodeId('Hello World')).toBe('hello-world');
  });

  it('should convert slashes to hyphens', () => {
    expect(safeNodeId('foo/bar')).toBe('foo-bar');
    expect(safeNodeId('a/b/c')).toBe('a-b-c');
  });

  it('should remove special characters', () => {
    expect(safeNodeId('test@name!')).toBe('testname');
    expect(safeNodeId('hello#world$')).toBe('helloworld');
  });

  it('should preserve letters, numbers, dots, underscores, and hyphens', () => {
    expect(safeNodeId('hello.world')).toBe('hello.world');
    expect(safeNodeId('hello_world')).toBe('hello_world');
    expect(safeNodeId('hello-world')).toBe('hello-world');
    expect(safeNodeId('test123')).toBe('test123');
  });

  it('should handle empty string', () => {
    expect(safeNodeId('')).toBe('');
  });

  it('should handle Unicode characters (CJK)', () => {
    const result = safeNodeId('测试项目');
    expect(result).toBe('测试项目');
  });

  it('should collapse multiple spaces', () => {
    expect(safeNodeId('hello   world')).toBe('hello-world');
  });

  it('should trim leading and trailing dashes', () => {
    expect(safeNodeId('  hello  ')).toBe('hello');
    expect(safeNodeId('-hello-')).toBe('hello');
    expect(safeNodeId('--hello--')).toBe('hello');
  });

  it('should handle mixed content', () => {
    expect(safeNodeId('Hello World! Test@Case')).toBe('hello-world-testcase');
  });

  it('should handle very long strings', () => {
    const long = 'a'.repeat(1000);
    expect(safeNodeId(long)).toBe(long);
  });

  it('should handle strings with only special characters', () => {
    expect(safeNodeId('@#$%^&*()')).toBe('');
  });

  it('should handle numbers', () => {
    expect(safeNodeId('123 test')).toBe('123-test');
  });

  it('should handle mixed CJK and Latin', () => {
    expect(safeNodeId('Hello测试World')).toBe('hello测试world');
  });

  it('should handle dots in the middle', () => {
    expect(safeNodeId('my.file.name')).toBe('my.file.name');
  });

  it('should handle consecutive special characters', () => {
    expect(safeNodeId('a!!!b@@@c')).toBe('abc');
  });
});
