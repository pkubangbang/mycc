/**
 * exit-auto.test.ts — one owner for "leave auto mode on ESC" (row lead-001).
 *
 * Before the extraction, STOP and AWAIT each flipped autoState, cleared
 * neglected mode, printed the same "auto mode is off. Prompt resumed." line,
 * and only one of them flushed output. These tests pin the single owner:
 * `exitAutoMode()` flips once, clears neglected mode, flushes BEFORE the
 * caller returns to PROMPT, and prints the line only when a flip happened.
 *
 * `agentIO` is mocked (it starts a line editor); `autoState` is the real
 * singleton so the flag transition is observed, not stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logSpy = vi.fn();

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    setNeglectedMode: vi.fn(),
    flushOutput: vi.fn(),
    verbose: vi.fn(),
    log: (msg: string) => logSpy(msg),
  },
}));

import { exitAutoMode } from '../../loop/exit-auto.js';
import { autoState } from '../../loop/auto-state.js';
import { agentIO } from '../../loop/agent-io.js';

/** Capture console.log lines produced by the helper (it prints directly). */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg?: unknown) => { lines.push(String(msg ?? '')); };
  return { lines, restore: () => { console.log = original; } };
}

describe('exitAutoMode — the single leave-auto owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logSpy.mockClear();
    autoState.setAuto(false);
  });

  it('flips auto off, clears neglected mode, flushes and announces once', () => {
    autoState.setAuto(true);
    const cap = captureConsole();
    try {
      const flipped = exitAutoMode('stop');
      expect(flipped).toBe(true);
    } finally {
      cap.restore();
    }

    expect(autoState.getAuto()).toBe(false);
    expect(agentIO.setNeglectedMode).toHaveBeenCalledWith(false);
    expect(agentIO.flushOutput).toHaveBeenCalledTimes(1);
    const announce = cap.lines.filter(l => l.includes('auto mode is off'));
    expect(announce).toHaveLength(1);
  });

  it('does not announce when the session was never in auto mode', () => {
    const cap = captureConsole();
    try {
      const flipped = exitAutoMode('await');
      expect(flipped).toBe(false);
    } finally {
      cap.restore();
    }

    expect(cap.lines.filter(l => l.includes('auto mode is off'))).toHaveLength(0);
    // Still clears/starts the prompt cleanly — an ESC outside auto mode is
    // also "give me control back".
    expect(agentIO.setNeglectedMode).toHaveBeenCalledWith(false);
    expect(agentIO.flushOutput).toHaveBeenCalledTimes(1);
  });

  it('traces which state observed the ESC', () => {
    autoState.setAuto(true);
    const cap = captureConsole();
    try {
      exitAutoMode('await');
    } finally {
      cap.restore();
    }

    expect(agentIO.verbose).toHaveBeenCalledWith(
      'auto',
      expect.stringContaining('via await'),
    );
  });
});
