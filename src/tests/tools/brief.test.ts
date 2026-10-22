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
    ctx = createMockContext({ workdir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('happy path', () => {
    it('should send simple message and return the success result', () => {
      const result = briefTool.handler(ctx, { message: 'Task completed', confidence: 10 });

      // The success line ends with a period: the loop may append the plan-scope
      // reflection to it in plan mode (see src/loop/plan-scope.ts).
      expect(result).toBe('OK.');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', 'Task completed', 'confidence: 100%');
    });

    it('should record the brief into the peer heartbeat via recordBrief', () => {
      briefTool.handler(ctx, { message: 'Task completed', confidence: 10 });
      // The brief tool must forward message + confidence to the peer heartbeat
      // so the `peers` tool can surface this instance's progress.
      expect(ctx.peer.recordBrief).toHaveBeenCalledWith('Task completed', 10);
    });

    it('should not call recordBrief before validating inputs (empty message)', () => {
      briefTool.handler(ctx, { message: '', confidence: 10 });
      expect(ctx.peer.recordBrief).not.toHaveBeenCalled();
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





    it('should return error for missing confidence parameter', () => {
      const result = briefTool.handler(ctx, { message: 'test' });

      expect(result).toContain('Error: confidence parameter is required and must be a number between 0 and 10');
      // The prescriptive tail tells the LLM how to repair the call in one retry.
      expect(result).toContain('brief(message="<status>", confidence=7)');
      expect(ctx.core.brief).not.toHaveBeenCalled();
    });



  });

  describe('confusion-index integration', () => {
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
