// bg_* tools — merged from bg-create and bg-await-steering

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bgCreateTool } from '../../tools/bg_create.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';
import { BackgroundTasks } from '../../context/shared/bg.js';
import { getSteeringManager } from '../../loop/steering-manager.js';
import { agentIO } from '../../loop/agent-io.js';
import type { CoreModule } from '../../types.js';

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    isMainProcess: vi.fn(() => true),
    onNeglected: vi.fn(() => () => { /* unsubscribe no-op */ }),
  },
}));

describe('bg-create', () => {
  ﻿/**
   * bg-create.test.ts - Tests for the bg_create tool
   */


  describe('bgCreateTool', () => {
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
      it('should run a background command and return pid', async () => {
        vi.mocked(ctx.bg!.runCommand).mockResolvedValueOnce(42);
        const result = await bgCreateTool.handler(ctx, { command: 'sleep 10', intent: 'RUN SYSTEM TO test background task' });
        expect(result).toBe('OK: 42');
        expect(ctx.bg!.runCommand).toHaveBeenCalledWith('sleep 10');
      });

      it('should request grant before running', async () => {
        vi.mocked(ctx.bg!.runCommand).mockResolvedValueOnce(1);
        await bgCreateTool.handler(ctx, { command: 'echo hello', intent: 'RUN SYSTEM TO test grant' });
        expect(ctx.core.requestGrant).toHaveBeenCalledWith('bash', { command: 'echo hello', intent: 'RUN SYSTEM TO test grant' });
      });
    });

    describe('input validation', () => {
      it('should return error for missing command', async () => {
        const result = await bgCreateTool.handler(ctx, { intent: 'test' });
        expect(result).toContain('Error');
        expect(result).toContain('command parameter is required');
      });
      it('should return error for non-string command', async () => {
        const result = await bgCreateTool.handler(ctx, { command: 123, intent: 'test' });
        expect(result).toContain('Error');
        expect(result).toContain('command parameter is required');
      });
      it('should return error for empty command string', async () => {
        const result = await bgCreateTool.handler(ctx, { command: '', intent: 'test' });
        expect(result).toContain('Error');
        expect(result).toContain('command parameter is required');
      });
      it('should return error for missing intent', async () => {
        const result = await bgCreateTool.handler(ctx, { command: 'echo hello' });
        expect(result).toContain('Error');
        expect(result).toContain('intent parameter is required');
      });
      it('should return error for non-string intent', async () => {
        const result = await bgCreateTool.handler(ctx, { command: 'echo hello', intent: 42 });
        expect(result).toContain('Error');
        expect(result).toContain('intent parameter is required');
      });
    });

    describe('grant rejection', () => {
      it('should return reason when grant is denied', async () => {
        vi.mocked(ctx.core.requestGrant).mockResolvedValueOnce({ approved: false, reason: 'Operation not permitted in plan mode' });
        const result = await bgCreateTool.handler(ctx, { command: 'rm -rf /', intent: 'dangerous' });
        expect(result).toContain('Operation not permitted in plan mode');
        expect(ctx.bg!.runCommand).not.toHaveBeenCalled();
      });
      it('should return default reason when grant has no reason', async () => {
        vi.mocked(ctx.core.requestGrant).mockResolvedValueOnce({ approved: false });
        const result = await bgCreateTool.handler(ctx, { command: 'some command', intent: 'test' });
        expect(result).toBe('Operation not permitted in current mode');
        expect(ctx.bg!.runCommand).not.toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should handle runCommand throwing an error', async () => {
        vi.mocked(ctx.bg!.runCommand).mockRejectedValueOnce(new Error('Failed to spawn process'));
        const result = await bgCreateTool.handler(ctx, { command: 'bad-command', intent: 'RUN SYSTEM TO test error' });
        expect(result).toContain('Error');
        expect(result).toContain('Failed to spawn process');
      });
    });

  });
});

describe('bg-await-steering', () => {
  /**
   * bg-await-steering.test.ts — bg_await must honor WebUI steering notes.
   *
   * Bug: the blocking wait loop only watched ESC (agentIO.onNeglected) and task
   * status. A WebUI steering note (mid-task direction) is only consumed at
   * COLLECT's 2c drain (or peeked in AWAIT's awaitTeammates), so a note queued
   * while the agent blocked in the wait sat buffered until the tool returned —
   * the user's direction was NOT honored while waiting.
   *
   * Fix: the wait loop PEEKS the steering queue (getServeHub().isRunning() &&
   * getSteeringNotes().length > 0) and, when a note is present, breaks the wait
   * and returns early WITHOUT consuming the note, so the state machine reaches
   * COLLECT to drain and honor it.
   *
   * REFACTOR: all the wait/steering/ESC logic now lives in the bg module
   * (`BackgroundTasks.waitForTasks`), so these tests drive the REAL
   * BackgroundTasks (constructed with a mocked core) rather than reaching into
   * the tool. The tool is a thin formatter over that result.
   */

  // Mock agent-io so isMainProcess()/onNeglected() are controllable without a
  // real process/IPC environment. waitForTasks only needs those two.

  // The bg module's wait loop no longer touches the serve hub at all — it peeks
  // the loop-homed steering manager (src/loop/steering-manager.ts) directly, so
  // the earlier serve-registry mock is obsolete. These tests drive the REAL
  // manager singleton (L1 rule: steering tests use the real manager, no mocks);
  // the addNote/clear pair seeds and resets the queue per test.

  // --- Imports after mocks ----------------------------------------------------

  /** Minimal core module — waitForTasks only touches brief() on failures. */
  function makeCore(): CoreModule {
    return { brief: vi.fn(), getWorkDir: vi.fn(() => process.cwd()) } as never;
  }

  /** Build a BackgroundTasks with a fake task map (no real spawn). */
  function makeBg(tasks: Map<number, { pid: number; command: string; status: string; output?: string }>): BackgroundTasks {
    const bg = new BackgroundTasks(makeCore());
    // Inject the fake tasks into the private map (test seam).
    (bg as unknown as { tasks: Map<number, unknown> }).tasks = tasks as never;
    return bg;
  }

  describe('bg module waitForTasks — WebUI steering note breaks the wait', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(agentIO.isMainProcess).mockReturnValue(true);
    });

    afterEach(() => {
      getSteeringManager().clear();
      vi.useRealTimers();
    });

    it('returns early (without consuming) when a steering note is queued', async () => {
      // A task that never completes: without the steering peek the wait would
      // run to timeout. With the fix, the queued note breaks the loop at once.
      getSteeringManager().addNote('please stop and do X');
      const tasks = new Map([[7, { pid: 7, command: 'sleep', status: 'running' }]]);
      const bg = makeBg(tasks);

      const result = await bg.waitForTasks({ pid: 7, timeoutMs: 60_000 });

      expect(result.reason).toBe('steering');
      expect(result.notes).toEqual(['please stop and do X']);
      // Peek only — the drain point must remain COLLECT, so the note is still
      // queued after the wait returns.
      expect(getSteeringManager().peekTexts()).toEqual(['please stop and do X']);
    });

    it('steering peek is inert when the queue is empty', async () => {
      // The old isRunning() guard is gone (plan §6): an empty manager is a
      // natural no-flag, so a non-serve session never breaks the wait via
      // steering. With an empty queue the wait proceeds to the task path.
      // Task completes immediately on the first poll.
      const tasks = new Map([[8, { pid: 8, command: 'echo', status: 'completed', output: 'done!' }]]);
      const bg = makeBg(tasks);

      const result = await bg.waitForTasks({ pid: 8, timeoutMs: 60_000 });

      expect(result.reason).toBe('completed');
      expect(result.output).toBe('done!');
    });

    it('reports completed for all-tasks when none are running', async () => {
      const bg = makeBg(new Map());
      const result = await bg.waitForTasks({ timeoutMs: 60_000 });
      expect(result.reason).toBe('completed');
    });
  });

  describe('bg_await — required parameters', () => {
    it('has correct name and scope', async () => {
      const { bgAwaitTool } = await import('../../tools/bg_await.js');
      expect(bgAwaitTool.name).toBe('bg_await');
      expect(bgAwaitTool.scope).toEqual(['main', 'child']);
    });
  });
});
