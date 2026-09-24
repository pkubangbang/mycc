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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock agent-io so isMainProcess()/onNeglected() are controllable without a
// real process/IPC environment. waitForTasks only needs those two.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    isMainProcess: vi.fn(() => true),
    onNeglected: vi.fn(() => () => { /* unsubscribe no-op */ }),
  },
}));

// Mock the serve hub so getServeHub().isRunning()/getSteeringNotes() are
// controllable (mirrors await-steering-reentry.test.ts).
vi.mock('../../serve/serve-registry.js', () => ({
  getServeHub: vi.fn(),
}));

// --- Imports after mocks ----------------------------------------------------
import { BackgroundTasks } from '../../context/shared/bg.js';
import { getServeHub } from '../../serve/serve-registry.js';
import { agentIO } from '../../loop/agent-io.js';
import type { CoreModule } from '../../types.js';

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
    hub.getSteeringNotes.mockReturnValue(['please stop and do X']);
    const tasks = new Map([[7, { pid: 7, command: 'sleep', status: 'running' }]]);
    const bg = makeBg(tasks);

    const result = await bg.waitForTasks({ pid: 7, timeoutMs: 60_000 });

    expect(result.reason).toBe('steering');
    expect(result.notes).toEqual(['please stop and do X']);
    // Peek only — the drain point must remain COLLECT, so getSteeringNotes is
    // called but nothing consumes the queue here.
    expect(hub.getSteeringNotes).toHaveBeenCalled();
  });

  it('steering peek is inert when serve is not running', async () => {
    hub.isRunning.mockReturnValue(false);
    // If getSteeringNotes were (wrongly) consulted despite serve being off,
    // this note would break the wait. Assert it does NOT.
    hub.getSteeringNotes.mockReturnValue(['should be ignored']);

    // Task completes immediately on the first poll.
    const tasks = new Map([[8, { pid: 8, command: 'echo', status: 'completed', output: 'done!' }]]);
    const bg = makeBg(tasks);

    const result = await bg.waitForTasks({ pid: 8, timeoutMs: 60_000 });

    expect(result.reason).toBe('completed');
    expect(result.output).toBe('done!');
    // serve is off → the steering queue is not even peeked.
    expect(hub.getSteeringNotes).not.toHaveBeenCalled();
  });

  it('reports completed for all-tasks when none are running', async () => {
    const bg = makeBg(new Map());
    const result = await bg.waitForTasks({ timeoutMs: 60_000 });
    expect(result.reason).toBe('completed');
  });
});

describe('bg_await — tool metadata', () => {
  it('has correct name and scope', async () => {
    const { bgAwaitTool } = await import('../../tools/bg_await.js');
    expect(bgAwaitTool.name).toBe('bg_await');
    expect(bgAwaitTool.scope).toEqual(['main', 'child']);
  });
});
