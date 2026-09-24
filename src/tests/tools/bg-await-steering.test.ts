/**
 * bg-await-steering.test.ts — bg_await must honor WebUI steering notes.
 *
 * Bug: bg_await's blocking wait loop only watched ESC (agentIO.onNeglected)
 * and task status. A WebUI steering note (mid-task direction) is only
 * consumed at COLLECT's 2c drain (or peeked in AWAIT's awaitTeammates), so a
 * note queued while the agent blocked inside bg_await sat buffered until the
 * tool returned — the user's direction was NOT honored while waiting.
 *
 * Fix: the poll loop PEEKS the steering queue (getServeHub().isRunning() &&
 * getSteeringNotes().length > 0) and, when a note is present, breaks the wait
 * and returns early WITHOUT consuming the note, so the state machine reaches
 * COLLECT to drain and honor it.
 *
 * These tests drive the REAL bgAwaitTool.handler with a mocked serve hub and
 * a mocked bg module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock agent-io so isMainProcess()/onNeglected() are controllable without a
// real process/IPC environment. bg_await only needs isMainProcess + onNeglected.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    isMainProcess: vi.fn(() => true),
    onNeglected: vi.fn(() => () => { /* unsubscribe no-op */ }),
  },
}));

// Mock the serve hud so getServeHub().isRunning()/getSteeringNotes() are
// controllable (mirrors await-steering-reentry.test.ts).
vi.mock('../../serve/serve-registry.js', () => ({
  getServeHub: vi.fn(),
}));

// --- Imports after mocks ----------------------------------------------------
import { bgAwaitTool } from '../../tools/bg_await.js';
import { getServeHub } from '../../serve/serve-registry.js';
import { agentIO } from '../../loop/agent-io.js';
import type { AgentContext, BgModule } from '../../types.js';

/** Minimal ctx with a controllable bg module. */
function makeCtx(bg: Partial<BgModule>): AgentContext {
  return {
    core: { brief: vi.fn() } as never,
    bg: bg as never,
  } as unknown as AgentContext;
}

describe('bg_await — WebUI steering note breaks the wait', () => {
  let hub: {
    isRunning: ReturnType<typeof vi.fn>;
    getSteeringNotes: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentIO.isMainProcess).mockReturnValue(true);
    hub = {
      isRunning: vi.fn(() => true),
      getSteeringNotes: vi.fn(() => []),
    };
    vi.mocked(getServeHub).mockReturnValue(hub as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns early (without consuming) when a steering note is queued', async () => {
    // A task that never completes: without the steering peek the wait would
    // run to timeout. With the fix, the queued note breaks the loop at once.
    const getTask = vi.fn(() => ({ pid: 7, status: 'running', output: undefined }));
    hub.getSteeringNotes.mockReturnValue(['please stop and do X']);

    const ctx = makeCtx({ getTask: getTask as never });
    const result = await bgAwaitTool.handler(ctx, { pid: 7, timeout: 60_000 });

    expect(result).toContain('steering note received');
    expect(result).toContain('please stop and do X');
    // Peek only — the drain point must remain COLLECT, so getSteeringNotes is
    // called but nothing consumes the queue here.
    expect(hub.getSteeringNotes).toHaveBeenCalled();
    // It must NOT have treated the running task as completed.
    expect(result).not.toContain('completed');
  });

  it('steering peek is inert when serve is not running', async () => {
    hub.isRunning.mockReturnValue(false);
    // If getSteeringNotes were (wrongly) consulted despite serve being off,
    // this note would break the wait. Assert it does NOT.
    hub.getSteeringNotes.mockReturnValue(['should be ignored']);

    // Task completes immediately on the first poll.
    const getTask = vi.fn(() => ({ pid: 8, status: 'completed', output: 'done!' }));
    const ctx = makeCtx({ getTask: getTask as never });

    const result = await bgAwaitTool.handler(ctx, { pid: 8, timeout: 60_000 });

    expect(result).toContain('Task 8 completed');
    expect(result).not.toContain('steering note received');
    // serve is off → the steering queue is not even peeked.
    expect(hub.getSteeringNotes).not.toHaveBeenCalled();
  });

  it('returns OK for all-tasks when none are running (unaffected path)', async () => {
    const ctx = makeCtx({ hasRunningBgTasks: vi.fn(async () => false) as never });
    const result = await bgAwaitTool.handler(ctx, { timeout: 60_000 });
    expect(result).toBe('OK');
  });
});

describe('bg_await — tool metadata', () => {
  it('has correct name and scope', () => {
    expect(bgAwaitTool.name).toBe('bg_await');
    expect(bgAwaitTool.scope).toEqual(['main', 'child']);
  });
});
