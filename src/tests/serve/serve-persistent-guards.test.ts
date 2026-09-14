/**
 * serve-persistent-guards.test.ts - persistent-mode sentinels & WS dispatch
 *
 * Unit tests for the pure, directly-assertable contracts of the
 * serve-persistent Phase 1 work that do NOT require a live server:
 *
 *   1. ServeDetachedExitError — the sentinel thrown by WebInputProvider when
 *      serve is down and there is no terminal to fall back to. Its shape
 *      (code 'SERVE_DETACHED_EXIT', name, message) is the contract the REPL
 *      exit path in agent-repl.ts catches to terminate cleanly so a
 *      supervisor (systemd) can restart the process.
 *
 *   2. handleWsMessage 'restart-webui' dispatch — the 重启 button's WS
 *      message must route to hub.restartServe() (the in-process recycle),
 *      NOT to hub.gracefulShutdown() (which would kill a headless daemon).
 *      Tested with a stub HubHandler so no Express/Vite/WS stack is needed.
 *
 *   3. The 'exit' case still routes to gracefulShutdown() — so a real
 *      terminal session's 退出 button keeps today's behaviour, distinct
 *      from the persistent-mode 重启 button.
 *
 * The disconnect-timer persist predicate is covered separately in
 * serve-disconnect-timer.test.ts (start() short-circuits when persist() is
 * true). The /health + /config endpoint shapes are covered live in
 * serve-health.test.ts (tmux). This file covers the remaining pure logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock agentIO before importing serve-ws-handler — it imports agentIO for
// the 'interrupt' and 'exit' verbose logs. Only the verbose methods are
// needed; no behaviour depends on them here.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), brief: vi.fn(), exec: vi.fn(), triggerNeglection: vi.fn() },
}));

// autoState is read by the 'auto' case; not exercised here, but the import
// must resolve.
vi.mock('../../loop/auto-state.js', () => ({
  autoState: { resetStreak: vi.fn(), setAuto: vi.fn() },
}));

import { ServeDetachedExitError } from '../../serve/serve-errors.js';
import { handleWsMessage, type HubHandler } from '../../serve/serve-ws-handler.js';
import type { WsMessage } from '../../serve/serve-types.js';

/** Build a stub HubHandler that records which lifecycle method was called. */
function makeStubHub(): HubHandler & {
  calls: string[];
  restartServe: ReturnType<typeof vi.fn>;
  gracefulShutdown: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  return {
    calls,
    submitInput: vi.fn(),
    submitCardResponse: vi.fn(),
    pushSteer: vi.fn(),
    pushFileUpload: vi.fn(),
    resolveSteering: vi.fn(),
    gracefulShutdown: vi.fn(async () => { calls.push('gracefulShutdown'); }),
    restartServe: vi.fn(async () => { calls.push('restartServe'); }),
    broadcast: vi.fn(),
    broadcastExcept: vi.fn(),
    getAutoState: vi.fn(() => false),
    enterAuto: vi.fn(() => true),
  };
}

/** A minimal "ws" stand-in — handleWsMessage only uses it for broadcastExcept. */
const fakeWs = {} as never;

describe('ServeDetachedExitError sentinel', () => {
  it('has code SERVE_DETACHED_EXIT', () => {
    const err = new ServeDetachedExitError();
    expect(err.code).toBe('SERVE_DETACHED_EXIT');
  });

  it('has name ServeDetachedExitError', () => {
    const err = new ServeDetachedExitError();
    expect(err.name).toBe('ServeDetachedExitError');
  });

  it('is an Error subclass (catchable by `instanceof Error`)', () => {
    const err = new ServeDetachedExitError();
    expect(err).toBeInstanceOf(Error);
  });

  it('carries a human-readable message mentioning the supervisor restart', () => {
    const err = new ServeDetachedExitError();
    expect(err.message).toContain('serve stopped');
    expect(err.message).toMatch(/supervisor|restart/i);
  });

  it('can be thrown and caught by the sentinel class', () => {
    expect(() => { throw new ServeDetachedExitError(); }).toThrow(ServeDetachedExitError);
  });
});

describe('handleWsMessage restart-webui dispatch', () => {
  let hub: ReturnType<typeof makeStubHub>;

  beforeEach(() => {
    hub = makeStubHub();
  });

  it('routes restart-webui to hub.restartServe()', () => {
    const msg: WsMessage = { type: 'restart-webui' };
    handleWsMessage(hub, fakeWs, JSON.stringify(msg));
    expect(hub.restartServe).toHaveBeenCalledTimes(1);
  });

  it('does NOT route restart-webui to gracefulShutdown()', () => {
    const msg: WsMessage = { type: 'restart-webui' };
    handleWsMessage(hub, fakeWs, JSON.stringify(msg));
    expect(hub.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('routes exit to gracefulShutdown(), not restartServe()', () => {
    // The 退出 button (terminal / non-persistent session) must keep killing
    // the session — distinct from the persistent-mode 重启 recycle.
    const msg: WsMessage = { type: 'exit' };
    handleWsMessage(hub, fakeWs, JSON.stringify(msg));
    expect(hub.gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(hub.restartServe).not.toHaveBeenCalled();
  });

  it('ignores a malformed (unparseable) message without throwing', () => {
    expect(() => handleWsMessage(hub, fakeWs, '{not json')).not.toThrow();
    expect(hub.restartServe).not.toHaveBeenCalled();
    expect(hub.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('ignores an unknown message type without throwing', () => {
    expect(() => handleWsMessage(hub, fakeWs, JSON.stringify({ type: 'no-such-type' }))).not.toThrow();
    expect(hub.restartServe).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Drift guards (Section 3b / 8 of the serve-persistent plan)
// ═══════════════════════════════════════════════════════════════════════════
//
// The plan's Section 8 specifies "a drift-guard test asserting
// WATCHDOG_GRACE_MS > FRESHNESS_WINDOW_MS". With the watchdog dropped
// (Section 7d runs the Lead in the foreground under Restart=always), the
// relationship to guard drifts into two in-codebase anchors instead:
//
//   (a) FRESHNESS_WINDOW_MS stays 90 s — the budget a hard-crashed daemon's
//       stale identity blocks a restart for. Section 7d's RestartSec=20 is
//       sized so the 5th restart attempt (+100 s) clears it; changing the
//       constant without re-sizing the unit's retry cadence reintroduces
//       the deadlock. Pin the value so a change fails this test and points
//       the author at Section 3b / 7d.
//
//   (b) Every ServeDetachedExitError throw in web-input-provider.ts must be
//       gated on shouldDaemon() — the regression where a plain (non-daemon)
//       mycc Lead under the Coordinator (piped stdin → !isTTY) hit the
//       headless-exit path on the first getInput() and exited with
//       "Web UI unavailable and no terminal". The gate is the `--daemon`
//       CLI flag (not a `!process.stdin.isTTY` heuristic, which fired in
//       EVERY Coordinator-piped lead). A source-text scan is the drift
//       guard: if a future edit drops the shouldDaemon() gate from any
//       throw site, this test fails and names the line.
import * as fs from 'fs';
import * as path from 'path';

describe('drift guards (serve-persistent plan §3b/§8)', () => {
  it('FRESHNESS_WINDOW_MS is pinned at 90_000 ms (Section 3b / 7d sizing)', () => {
    const identitySrc = fs.readFileSync(
      path.resolve(__dirname, '../../peer/identity.ts'),
      'utf-8',
    );
    // The constant is module-private; assert its declaration value so a
    // silent edit (e.g. raising it past the RestartSec=20 cadence's 5th
    // attempt at +100 s) is caught here rather than in a deployed deadlock.
    expect(identitySrc).toMatch(/FRESHNESS_WINDOW_MS\s*=\s*90_000\b/);
  });

  it('every ServeDetachedExitError throw in web-input-provider.ts is gated on shouldDaemon()', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../serve/web-input-provider.ts'),
      'utf-8',
    );
    // Find each "throw new ServeDetachedExitError()" and assert the
    // surrounding block (the enclosing if-statement text within ~3 lines
    // before the throw) contains the shouldDaemon() gate. This is the
    // regression guard: a bare `if (!process.stdin.isTTY) throw …` (the bug
    // that killed plain mycc) must not reappear.
    const lines = src.split('\n');
    const throwLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('throw new ServeDetachedExitError')) {
        throwLines.push(i);
      }
    }
    // Sanity: there must be throw sites to guard (currently 5). If the file
    // is refactored to remove all of them, this guard is vacuous — fail
    // loudly so a maintainer re-evaluates rather than silently passing.
    expect(throwLines.length).toBeGreaterThan(0);

    for (const lineIdx of throwLines) {
      // Collect the enclosing condition text: scan upward for the nearest
      // `if (` that governs this throw, then check the gate is present in
      // the lines between that if and the throw.
      let ifLine = lineIdx;
      while (ifLine > 0 && !/\bif\s*\(/.test(lines[ifLine])) ifLine--;
      const block = lines.slice(ifLine, lineIdx + 1).join('\n');
      expect(block).toContain('shouldDaemon()');
    }
  });
});