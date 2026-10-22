/**
 * plan-off.test.ts - Tests for the plan_off tool
 *
 * Regression coverage for the [y/N] confirmation convention:
 * pressing Enter (empty response) must be treated as "No" (stay in plan mode),
 * consistent with plan_on.ts. Previously an empty response fell into the
 * ambiguous `!granted` branch and surfaced `User responded: ""`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { planOffTool } from '../../tools/plan_off.js';
import { createMockContext, createTempDir, removeTempDir, askResult } from './test-utils.js';
import type { AgentContext } from '../../types.js';
import type { Core } from '../../context/parent/core.js';
import type { TeamManager } from '../../context/parent/team.js';

describe('planOffTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    vi.clearAllMocks();
    // Default: in plan mode so the confirmation prompt is reached
    vi.mocked(ctx.core.getMode).mockReturnValue('plan');
    vi.mocked(ctx.core.question).mockResolvedValue(askResult(''));
    // Core cast adds setMode; TeamManager cast adds broadcastModeChange
    (ctx.core as unknown as Core).setMode = vi.fn();
    (ctx.team as unknown as TeamManager).broadcastModeChange = vi.fn();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('idempotent in normal mode', () => {
    it('should return success without prompting when already in normal mode', async () => {
      vi.mocked(ctx.core.getMode).mockReturnValue('normal');
      const result = await planOffTool.handler(ctx, {});
      expect(result).toContain('Already in normal mode');
      expect(ctx.core.question).not.toHaveBeenCalled();
    });
  });

  describe('[y/N] confirmation convention', () => {
    it('should treat empty response (Enter) as No and stay in plan mode', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult(''));
      const result = await planOffTool.handler(ctx, {});
      expect(result).toContain('User declined');
      expect(result).toContain('Staying in plan mode');
      expect((ctx.core as unknown as Core).setMode).not.toHaveBeenCalledWith('normal');
    });

    it('should treat whitespace-only response as No', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('   '));
      const result = await planOffTool.handler(ctx, {});
      expect(result).toContain('User declined');
      expect((ctx.core as unknown as Core).setMode).not.toHaveBeenCalledWith('normal');
    });

    it('should treat "n" as No and stay in plan mode', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('n'));
      const result = await planOffTool.handler(ctx, {});
      expect(result).toContain('User declined');
      expect((ctx.core as unknown as Core).setMode).not.toHaveBeenCalledWith('normal');
    });

    it('should treat "no" as No and stay in plan mode', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('no'));
      const result = await planOffTool.handler(ctx, {});
      expect(result).toContain('User declined');
      expect((ctx.core as unknown as Core).setMode).not.toHaveBeenCalledWith('normal');
    });

    it('should treat "y" as Yes and exit plan mode', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('y'));
      const result = await planOffTool.handler(ctx, {});
      expect(result).toContain('Normal mode activated');
      expect((ctx.core as unknown as Core).setMode).toHaveBeenCalledWith('normal');
    });

    it('should treat "yes" as Yes and exit plan mode', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('yes'));
      const result = await planOffTool.handler(ctx, {});
      expect(result).toContain('Normal mode activated');
      expect((ctx.core as unknown as Core).setMode).toHaveBeenCalledWith('normal');
    });

    it('should treat quoted "y" as Yes', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('"y"'));
      const result = await planOffTool.handler(ctx, {});
      expect(result).toContain('Normal mode activated');
      expect((ctx.core as unknown as Core).setMode).toHaveBeenCalledWith('normal');
    });

    it('should treat quoted empty as No (not a stray User responded "")', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('""'));
      const result = await planOffTool.handler(ctx, {});
      // Quoted empty normalizes to '' -> denied branch, not the ambiguous branch
      expect(result).toContain('User declined');
      expect(result).not.toContain('User responded: ""');
    });
  });

  describe('ambiguous non-empty response', () => {
    it('should ask for clarification when user types something other than y/n', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('maybe'));
      const result = await planOffTool.handler(ctx, {});
      expect(result).toContain('did not confirm');
      expect(result).toContain('maybe');
      expect((ctx.core as unknown as Core).setMode).not.toHaveBeenCalledWith('normal');
    });
  });

  describe('tool metadata', () => {
    it('should have correct name', () => { expect(planOffTool.name).toBe('plan_off'); });
    it('should have main-only scope', () => { expect(planOffTool.scope).toEqual(['main']); });
  });
});