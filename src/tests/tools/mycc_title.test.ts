/**
 * Tests for mycc_title tool
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { myccTitleTool } from '../../tools/mycc_title.js';

describe('myccTitleTool', () => {
  it('should have correct name and scope', () => {
    expect(myccTitleTool.name).toBe('mycc_title');
    expect(myccTitleTool.scope).toContain('main');
    expect(myccTitleTool.scope).toContain('child');
  });

  it('should require title parameter', () => {
    expect(myccTitleTool.input_schema.required).toContain('title');
  });

  it('should return error for missing title', () => {
    const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
    const result = myccTitleTool.handler(ctx, {});
    expect(result).toBe('Error: title parameter is required and must be a string');
  });

  it('should return error for non-string title', () => {
    const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
    const result = myccTitleTool.handler(ctx, { title: 123 });
    expect(result).toBe('Error: title parameter is required and must be a string');
  });

  it('should return OK for valid title', () => {
    const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
    const result = myccTitleTool.handler(ctx, { title: 'test title' });
    expect(result).toBe('OK');
  });
});
