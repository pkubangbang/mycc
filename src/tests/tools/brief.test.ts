/**
 * brief.test.ts - Tests for the brief tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { briefTool } from '../../tools/brief.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('briefTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('happy path', () => {
    it('should send simple message and return OK', () => {
      const result = briefTool.handler(ctx, { message: 'Task completed' });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', 'Task completed');
    });

    it('should send message with details', () => {
      briefTool.handler(ctx, { message: 'Processed 5 files' });

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', 'Processed 5 files');
    });

    it('should send multi-line message', () => {
      const multiLineMessage = 'Line 1\nLine 2\nLine 3';
      const result = briefTool.handler(ctx, { message: multiLineMessage });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', multiLineMessage);
    });

    it('should send progress update', () => {
      briefTool.handler(ctx, { message: '50% complete' });

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', '50% complete');
    });

    it('should accept very long message (1000+ chars)', () => {
      const longMessage = 'x'.repeat(1500);
      const result = briefTool.handler(ctx, { message: longMessage });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', longMessage);
    });

    it('should preserve message with special characters', () => {
      const specialMessage = 'Error: 💥 [FAIL]';
      const result = briefTool.handler(ctx, { message: specialMessage });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', specialMessage);
    });

    it('should pass through markdown content as-is', () => {
      const markdownMessage = '# Status\n- Item 1\n- Item 2';
      const result = briefTool.handler(ctx, { message: markdownMessage });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', markdownMessage);
    });

    it('should handle unicode and emojis', () => {
      const unicodeMessage = '✓ Complete ✓ 🎉';
      const result = briefTool.handler(ctx, { message: unicodeMessage });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', unicodeMessage);
    });
  });

  describe('edge cases', () => {
    it('should return error for empty string message', () => {
      const result = briefTool.handler(ctx, { message: '' });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return error for missing message parameter', () => {
      const result = briefTool.handler(ctx, {});

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for null message', () => {
      const result = briefTool.handler(ctx, { message: null });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for undefined message', () => {
      const result = briefTool.handler(ctx, { message: undefined });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for non-string message (number)', () => {
      const result = briefTool.handler(ctx, { message: 123 });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for non-string message (object)', () => {
      const result = briefTool.handler(ctx, { message: { text: 'test' } });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });
  });

  describe('tool metadata and integration', () => {
    it('should have correct tool name', () => {
      expect(briefTool.name).toBe('brief');
    });

    it('should have correct scope (main and child)', () => {
      expect(briefTool.scope).toEqual(['main', 'child']);
    });

    it('should require message parameter', () => {
      expect(briefTool.input_schema.required).toContain('message');
    });

    it('should have message property in input schema as string', () => {
      const properties = briefTool.input_schema.properties;
      expect(properties.message).toBeDefined();
      expect(properties.message.type).toBe('string');
    });

    it('should always use info log level', () => {
      briefTool.handler(ctx, { message: 'test1' });
      briefTool.handler(ctx, { message: 'test2' });

      expect(ctx.core.brief).toHaveBeenCalledTimes(2);
      expect(ctx.core.brief).toHaveBeenNthCalledWith(1, 'info', 'brief', 'test1');
      expect(ctx.core.brief).toHaveBeenNthCalledWith(2, 'info', 'brief', 'test2');
    });

    it('should always use brief tag', () => {
      briefTool.handler(ctx, { message: 'any message' });

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', 'any message');
    });
  });
});