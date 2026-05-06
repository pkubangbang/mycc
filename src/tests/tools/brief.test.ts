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
      const result = briefTool.handler(ctx, { message: 'Task completed', confidence: 10 });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', 'Task completed');
    });

    it('should send message with details', () => {
      briefTool.handler(ctx, { message: 'Processed 5 files', confidence: 9 });

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', 'Processed 5 files');
    });

    it('should send multi-line message', () => {
      const multiLineMessage = 'Line 1\nLine 2\nLine 3';
      const result = briefTool.handler(ctx, { message: multiLineMessage, confidence: 8 });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', multiLineMessage);
    });

    it('should send progress update', () => {
      briefTool.handler(ctx, { message: '50% complete', confidence: 7 });

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', '50% complete');
    });

    it('should accept very long message (1000+ chars)', () => {
      const longMessage = 'x'.repeat(1500);
      const result = briefTool.handler(ctx, { message: longMessage, confidence: 6 });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', longMessage);
    });

    it('should preserve message with special characters', () => {
      const specialMessage = 'Error: 💥 [FAIL]';
      const result = briefTool.handler(ctx, { message: specialMessage, confidence: 5 });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', specialMessage);
    });

    it('should pass through markdown content as-is', () => {
      const markdownMessage = '# Status\n- Item 1\n- Item 2';
      const result = briefTool.handler(ctx, { message: markdownMessage, confidence: 4 });

      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', markdownMessage);
    });

    it('should handle unicode and emojis', () => {
      const unicodeMessage = '✓ Complete ✓ 🎉';
      const result = briefTool.handler(ctx, { message: unicodeMessage, confidence: 3 });

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
      const result = briefTool.handler(ctx, { confidence: 10 });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for null message', () => {
      const result = briefTool.handler(ctx, { message: null, confidence: 10 });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for undefined message', () => {
      const result = briefTool.handler(ctx, { message: undefined, confidence: 10 });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for non-string message (number)', () => {
      const result = briefTool.handler(ctx, { message: 123, confidence: 10 });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for non-string message (object)', () => {
      const result = briefTool.handler(ctx, { message: { text: 'test' }, confidence: 10 });

      expect(result).toBe('Error: message parameter is required and must be a string');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for missing confidence parameter', () => {
      const result = briefTool.handler(ctx, { message: 'test' });

      expect(result).toBe('Error: confidence parameter is required and must be a number between 0 and 10');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for confidence out of range (high)', () => {
      const result = briefTool.handler(ctx, { message: 'test', confidence: 11 });

      expect(result).toBe('Error: confidence parameter is required and must be a number between 0 and 10');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for confidence out of range (low)', () => {
      const result = briefTool.handler(ctx, { message: 'test', confidence: -1 });

      expect(result).toBe('Error: confidence parameter is required and must be a number between 0 and 10');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });

    it('should return error for non-number confidence', () => {
      const result = briefTool.handler(ctx, { message: 'test', confidence: 'high' });

      expect(result).toBe('Error: confidence parameter is required and must be a number between 0 and 10');
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

    it('should require confidence parameter', () => {
      expect(briefTool.input_schema.required).toContain('confidence');
    });

    it('should have message property in input schema as string', () => {
      const properties = briefTool.input_schema.properties;
      expect(properties.message).toBeDefined();
      if (properties && typeof properties === 'object' && 'message' in properties) {
        const message = properties.message;
        if (message && typeof message === 'object' && 'type' in message) {
          expect(message.type).toBe('string');
        }
      }
    });

    it('should have confidence property in input schema as number', () => {
      const properties = briefTool.input_schema.properties;
      expect(properties.confidence).toBeDefined();
      if (properties && typeof properties === 'object' && 'confidence' in properties) {
        const confidence = properties.confidence;
        if (confidence && typeof confidence === 'object' && 'type' in confidence) {
          expect(confidence.type).toBe('number');
        }
      }
    });

    it('should always use info log level', () => {
      briefTool.handler(ctx, { message: 'test1', confidence: 10 });
      briefTool.handler(ctx, { message: 'test2', confidence: 9 });

      expect(ctx.core.brief).toHaveBeenCalledTimes(2);
      expect(ctx.core.brief).toHaveBeenNthCalledWith(1, 'info', 'brief', 'test1');
      expect(ctx.core.brief).toHaveBeenNthCalledWith(2, 'info', 'brief', 'test2');
    });

    it('should always use brief tag', () => {
      briefTool.handler(ctx, { message: 'any message', confidence: 8 });

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', 'any message');
    });

    it('should update confusion index based on confidence', () => {
      // High confidence (10) should reduce confusion (delta = 8 - 10 = -2)
      briefTool.handler(ctx, { message: 'test', confidence: 10 });
      expect(ctx.core.increaseConfusionIndex).toHaveBeenCalledWith(-2);

      // Low confidence (5) should increase confusion (delta = 8 - 5 = 3)
      briefTool.handler(ctx, { message: 'test', confidence: 5 });
      expect(ctx.core.increaseConfusionIndex).toHaveBeenCalledWith(3);
    });
  });
});