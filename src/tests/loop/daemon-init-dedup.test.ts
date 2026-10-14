/**
 * daemon-init-dedup.test.ts — FIX B regression: the `--daemon <skill>` dedup
 * gate must require BOTH a fresh heartbeat AND an alive recorded pid.
 *
 * BEFORE FIX B: the dedup gate refused to start whenever
 * `ctx.peer.isFresh(entry.sessionId)` was true — heartbeat freshness ONLY,
 * no pid check. After `mycc-compose down` a stopped peer's identity entry
 * survives (its own unregister() never runs under a SIGTERM/TerminateProcess)
 * and its heartbeat file may still look recent, so a dead-but-fresh entry
 * wrongly blocked a legitimate re-launch (the "Stage-7" bug).
 *
 * AFTER FIX B: a fresh-but-dead-pid entry is NOT refused (boot proceeds);
 * a fresh-and-alive-pid entry still IS refused.
 *
 * The test mocks config.js (shouldDaemon / getDaemonSkill) and auto-state.js
 * (no-op) so initDaemonMode reaches the dedup block, and drives it with a
 * synthetic ctx.peer whose listIdentities()/isFresh()/getPid() are scripted.
 * process.exit(1) and ctx.peer.stop() are spied so the refusal path is
 * observable without killing the test runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock config so daemon-init sees a service skill name + daemon mode ------
let daemonSkill: string | null = 'svc-skill';
vi.mock('../../config.js', () => ({
  shouldDaemon: () => true,
  getDaemonSkill: () => daemonSkill,
}));

// --- autoState: no-op (daemon-init only calls resetStreak/setAuto) -----------
vi.mock('../../loop/auto-state.js', () => ({
  autoState: {
    resetStreak: vi.fn(),
    setAuto: vi.fn(),
  },
}));

import { initDaemonMode } from '../../loop/daemon-init.js';
import type { AgentContext, IdentityEntry } from '../../types.js';

const SELF_SID = 'self0000-0000-0000-0000-000000000000';
const PEER_SID = 'peer1111-1111-1111-1111-111111111111';

/**
 * Build a synthetic AgentContext exposing only the surface initDaemonMode
 * touches: ctx.peer.{listIdentities,getSelfSessionId,isFresh,getPid,stop},
 * ctx.mail.appendMail, plus the triologue/loader passed separately.
 */
function makeCtx(opts: {
  identities: IdentityEntry[];
  fresh: (sid: string) => boolean;
  pid: (sid: string) => number | null;
}): { ctx: AgentContext; stopCalls: () => number } {
  let stops = 0;
  const peer = {
    listIdentities: () => opts.identities,
    getSelfSessionId: () => SELF_SID,
    isFresh: (sid: string) => opts.fresh(sid),
    getPid: (sid: string) => opts.pid(sid),
    stop: () => {
      stops++;
    },
  };
  const ctx = {
    peer,
    mail: { appendMail: vi.fn() },
  } as unknown as AgentContext;
  return { ctx, stopCalls: () => stops };
}

function daemonEntry(overrides: Partial<IdentityEntry> = {}): IdentityEntry {
  return {
    sessionId: PEER_SID,
    workDir: process.cwd(),
    mailbox: '/tmp/mailbox',
    startedAt: Date.now(),
    pid: 4242,
    role: 'svc-skill',
    daemon: true,
    ...overrides,
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  daemonSkill = 'svc-skill';
  // initDaemonMode calls process.exit(1) on refusal — intercept so the test
  // survives, and treat it like a thrown refusal for the assertions below.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errorSpy.mockRestore();
  vi.restoreAllMocks();
});

/** A loader whose getSkill returns a benign service skill (post-dedup path). */
const loader = {
  getSkill: (name: string) => ({
    name,
    description: 'test',
    keywords: [],
    content: 'x',
  }),
};

/** A triologue stub — only note() is called. */
const triologue = { note: vi.fn() } as unknown as Parameters<typeof initDaemonMode>[2];

describe('initDaemonMode dedup gate — FIX B (pid-aware liveness)', () => {
  it('FRESH heartbeat + DEAD pid → relaunch NOT refused (boot proceeds)', () => {
    // The Stage-7 scenario: a stopped peer's entry survives `down` with a
    // stale-but-fresh heartbeat, but its pid is dead. Boot must proceed.
    const { ctx, stopCalls } = makeCtx({
      identities: [daemonEntry()],
      fresh: () => true,
      pid: () => 999999, // dead pid
    });

    // Must NOT throw (exit intercepted) and must NOT stop the peer.
    expect(() => initDaemonMode(ctx, loader, triologue)).not.toThrow();
    expect(stopCalls()).toBe(0);
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('is already running for this workDir'),
    );
  });

  it('FRESH heartbeat + ALIVE pid → relaunch IS refused', () => {
    // A genuinely live daemon with the same role+workDir must still block.
    const { ctx, stopCalls } = makeCtx({
      identities: [daemonEntry()],
      fresh: () => true,
      pid: () => process.pid, // our own pid: definitely alive
    });

    expect(() => initDaemonMode(ctx, loader, triologue)).toThrow(/process\.exit\(1\)/);
    expect(stopCalls()).toBe(1);
  });

  it('FRESH heartbeat + NO pid recorded → treated as alive → refused (legacy behavior preserved)', () => {
    // A missing pid must not silently bypass the guard: legacy entries
    // without a recorded pid keep the old refuse-on-fresh behavior.
    const entry = daemonEntry({ pid: undefined });
    const { ctx, stopCalls } = makeCtx({
      identities: [entry],
      fresh: () => true,
      pid: () => null,
    });

    expect(() => initDaemonMode(ctx, loader, triologue)).toThrow(/process\.exit\(1\)/);
    expect(stopCalls()).toBe(1);
  });

  it('NOT fresh heartbeat → NOT refused, even with an alive pid', () => {
    // Freshness is still required: a stale entry never blocks a relaunch.
    const { ctx, stopCalls } = makeCtx({
      identities: [daemonEntry()],
      fresh: () => false,
      pid: () => process.pid,
    });

    expect(() => initDaemonMode(ctx, loader, triologue)).not.toThrow();
    expect(stopCalls()).toBe(0);
  });

  it('different role or different workDir → NOT refused (match is role AND workDir)', () => {
    const { ctx, stopCalls } = makeCtx({
      identities: [
        daemonEntry({ sessionId: 'other-role-0000-0000-000000000000', role: 'different-role' }),
        daemonEntry({ sessionId: 'other-wd-0000-0000-0000-000000000000', workDir: '/some/other/dir' }),
      ],
      fresh: () => true,
      pid: () => process.pid,
    });

    expect(() => initDaemonMode(ctx, loader, triologue)).not.toThrow();
    expect(stopCalls()).toBe(0);
  });

  it('self entry with matching role+workDir is skipped (never refuses on self)', () => {
    const { ctx, stopCalls } = makeCtx({
      identities: [daemonEntry({ sessionId: SELF_SID })],
      fresh: () => true,
      pid: () => process.pid,
    });

    expect(() => initDaemonMode(ctx, loader, triologue)).not.toThrow();
    expect(stopCalls()).toBe(0);
  });
});
