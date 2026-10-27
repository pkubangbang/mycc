/**
 * brief.test.ts - Tests for the brief tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { briefTool } from '../../tools/brief.js';
import { BRIEF_MESSAGE_TARGET_TOKENS, MAX_BRIEF_MESSAGE_TOKENS, estimateBriefMessageTokens } from '../../loop/triologue/brief.js';
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

  describe('message token cap', () => {
    // Two tiers: <=100 tokens is silent, (100, 200] succeeds WITH a warning,
    // >200 is a hard failure that records nothing. The estimator is
    // `estimateTextTokens` (language-aware, ~1.33 tokens per word), so these
    // fixtures are sized by GROWING a word list until the measured cost lands in
    // the intended band — asserting on the band, not on a magic word count.
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 7}`).join(' ');
    const sizedTo = (predicate: (cost: number) => boolean) => {
      for (let n = 5; n < 400; n++) {
        const candidate = words(n);
        if (predicate(estimateBriefMessageTokens(candidate))) return candidate;
      }
      throw new Error('could not size a fixture into the intended token band');
    };

    it('accepts a short message with the plain OK result and no warning', () => {
      const message = 'Checked the parser; the failure is a stale index.';
      expect(estimateBriefMessageTokens(message)).toBeLessThanOrEqual(BRIEF_MESSAGE_TARGET_TOKENS);
      const result = briefTool.handler(ctx, { message, confidence: 8 });
      expect(result).toBe('OK.');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', message, 'confidence: 80%');
    });

    it('accepts an over-target but under-limit message VERBATIM, with a warning in the result', async () => {
      const message = sizedTo((c) => c > BRIEF_MESSAGE_TARGET_TOKENS + 10 && c <= MAX_BRIEF_MESSAGE_TOKENS - 10);

      const result = await briefTool.handler(ctx, { message, confidence: 7 });

      expect(result.startsWith('OK.')).toBe(true);
      // The nudge names the problem and the fix; it quotes the TARGET (100) but
      // never the hard ceiling, so the model cannot aim just under a limit.
      expect(result).toContain('your message is longer than the limit (100 tokens)');
      expect(result).toContain('please be concise next time');
      expect(result).not.toMatch(/\b200\b/);
      // SUCCESS means the whole message was still recorded and displayed —
      // never silently clipped to fit the target.
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'brief', message, 'confidence: 70%');
      expect(ctx.peer.recordBrief).toHaveBeenCalledWith(message, 7);
    });

    it('rejects an over-limit message and records nothing', async () => {
      const message = sizedTo((c) => c > MAX_BRIEF_MESSAGE_TOKENS + 20);

      const result = await briefTool.handler(ctx, { message, confidence: 9 });

      expect(result).toContain('Error: message too long');
      expect(result).toContain('Nothing was recorded');
      // No ceiling number: the model is nudged toward concision, not taught a
      // threshold it could target.
      expect(result).not.toMatch(/\b200\b/);
      expect(ctx.core.brief).not.toHaveBeenCalled();
      expect(ctx.peer.recordBrief).not.toHaveBeenCalled();
      expect(ctx.core.increaseConfusionIndex).not.toHaveBeenCalled();
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
