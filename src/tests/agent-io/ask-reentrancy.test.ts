/**
 * ask-reentrancy.test.ts - Verify ask() re-entrancy guard
 *
 * Reproduces the bug where two concurrent ask() calls (e.g. from two
 * teammates sending external_path_access IPC simultaneously) cause the
 * second call to overwrite the first's askResolver singleton, orphaning
 * the first call's Promise and permanently blocking the first caller.
 *
 * The fix queues the second ask() until the first resolves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the onDone callback so tests can simulate user input.
let capturedOnDone: ((value: string) => void) | null = null;

// Mock LineEditor — capture onDone so we can trigger resolution manually.
// Must be a constructor (used with `new` in agent-io.ts).
vi.mock('../../utils/line-editor.js', () => {
  return {
    LineEditor: vi.fn().mockImplementation(function (this: unknown, opts: { onDone: (value: string) => void }) {
      capturedOnDone = opts.onDone;
      return {
        handleKey: vi.fn(),
        resize: vi.fn(),
        getHistory: vi.fn().mockReturnValue([]),
        close: vi.fn(),
        setContent: vi.fn(),
        setWhisper: vi.fn(),
        clearScreen: vi.fn(),
        insertAtCursor: vi.fn(),
      };
    }),
  };
});

// Mock esc-wrap-up so ask() doesn't try to poll real wrap-up state.
vi.mock('../../loop/esc-wrap-up.js', () => ({
  getWrapUpState: vi.fn(() => ({ promise: null })),
  tryDisplayWrapUp: vi.fn(() => false),
  startWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

import { agentIO } from '../../loop/agent-io.js';

// Helper to access private fields
const io = agentIO as unknown as {
  isMainProcessFlag: boolean;
  askResolver: ((value: string) => void) | null;
  askOnEsc: string | null;
  askOnEnter: string | null;
  activeLineEditor: unknown;
  askQueue: Array<() => void>;
  neglectedModeFlag: boolean;
  outputBuffer: Array<{ method: string; args: unknown[] }>;
};

describe('ask() re-entrancy guard', () => {
  beforeEach(() => {
    io.isMainProcessFlag = true;
    io.askResolver = null;
    io.askOnEsc = null;
    io.askOnEnter = null;
    io.activeLineEditor = null;
    io.askQueue = [];
    io.neglectedModeFlag = false;
    io.outputBuffer = [];
    capturedOnDone = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should queue the second concurrent ask() until the first resolves', async () => {
    // Start first ask() — sets askResolver and activeLineEditor
    const ask1 = agentIO.ask('Q1: first question');
    // capturedOnDone belongs to Q1's LineEditor
    const q1OnDone = capturedOnDone;
    expect(q1OnDone).not.toBeNull();
    expect(io.askResolver).not.toBeNull();
    expect(io.askQueue.length).toBe(0);

    // Start second ask() CONCURRENTLY while Q1 is still pending.
    // Without the guard this would overwrite askResolver, orphaning ask1.
    const ask2 = agentIO.ask('Q2: second question');

    // Q2 should be queued — not started yet.
    // askResolver still points to Q1, askQueue has one waiting entry.
    expect(io.askQueue.length).toBe(1);
    // capturedOnDone is still Q1's (Q2's LineEditor was not created yet)
    expect(capturedOnDone).toBe(q1OnDone);

    // Resolve Q1 by simulating user pressing Enter with "answer1"
    q1OnDone!('answer1');
    const result1 = await ask1;
    expect(result1).toBe('answer1');

    // Q1 resolved — the queue should have been drained, waking Q2.
    // Now Q2's LineEditor is created and askResolver points to Q2.
    expect(io.askQueue.length).toBe(0);
    expect(io.askResolver).not.toBeNull();
    // capturedOnDone is now Q2's
    const q2OnDone = capturedOnDone;
    expect(q2OnDone).not.toBeNull();
    expect(q2OnDone).not.toBe(q1OnDone);

    // Resolve Q2
    q2OnDone!('answer2');
    const result2 = await ask2;
    expect(result2).toBe('answer2');

    // Both resolved, ask state cleared
    expect(io.askResolver).toBeNull();
  });

  it('should not orphan the first ask() Promise (regression test)', async () => {
    // This is the core regression: before the fix, the second ask()
    // would overwrite askResolver, so ask1's Promise would NEVER resolve.
    const ask1 = agentIO.ask('Q1');
    const q1OnDone = capturedOnDone!;

    const ask2 = agentIO.ask('Q2');

    // With the guard, Q1 is still the active ask — resolving Q1 works.
    q1OnDone('first-answer');
    const r1 = await ask1;
    expect(r1).toBe('first-answer');

    // Now resolve Q2
    const q2OnDone = capturedOnDone!;
    q2OnDone('second-answer');
    const r2 = await ask2;
    expect(r2).toBe('second-answer');
  });

  it('should handle three concurrent ask() calls in FIFO order', async () => {
    const ask1 = agentIO.ask('Q1');
    const q1Done = capturedOnDone!;
    const ask2 = agentIO.ask('Q2');
    const ask3 = agentIO.ask('Q3');

    expect(io.askQueue.length).toBe(2);

    // Resolve Q1
    q1Done('a1');
    expect(await ask1).toBe('a1');
    // Q2 is now active
    const q2Done = capturedOnDone!;
    q2Done('a2');
    expect(await ask2).toBe('a2');
    // Q3 is now active
    const q3Done = capturedOnDone!;
    q3Done('a3');
    expect(await ask3).toBe('a3');

    expect(io.askResolver).toBeNull();
  });
});