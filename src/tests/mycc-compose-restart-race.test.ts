/**
 * mycc-compose-restart-race.test.ts — P2 #1 regression: restart is a
 * SEQUENCED operation.
 *
 * The stop primitive `stopPeerByAddress()` sends SIGTERM and then CONFIRMS the
 * process actually exited before returning 'stopped' — a delivered signal is
 * never mistaken for a terminated peer. So cmd-up, before queueing a
 * replacement, has already waited (inside the primitive) for the previous
 * holder to demonstrably release its identity (the process is provably dead).
 * A refused / still-up stop NEVER queues a launch; a holder that does not die
 * within the confirm window aborts the restart with a non-zero exit.
 *
 * Module-graph pattern is identical to mycc-compose-up-pipeline.test.ts:
 * discovery.ts pins DISCOVERY_DIR at MODULE LOAD, so NOTHING compose-lib is
 * imported statically — every import happens after the MYCC_DISCOVERY_DIR
 * override, a fresh random SID per test prevents cross-suite leaks, and
 * process.exit is stubbed to return through cmdUp with the code recorded.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

type Discovery = typeof import('../../scripts/mycc-compose/lib/discovery.js');

const ARGS = '--auto --skip-healthcheck';
const PEER_NAME = 'restart-peer';
const PEER_IDENTITY_NAME = 'grp:restart-peer';

let tempDir = '';
let specFile = '';
let SID = '';
let d: Discovery | null = null;
let peersMod: typeof import('../../scripts/mycc-compose/lib/peers.js');
let stopMod: typeof import('../../scripts/mycc-compose/lib/peers-stop.js');
let launchPeerSpy: ReturnType<typeof vi.fn>;
let stopPeerSpy: ReturnType<typeof vi.fn>;

function seedIdentity(): void {
  const map: Record<string, unknown> = {};
  map[SID] = {
    sessionId: SID,
    name: PEER_IDENTITY_NAME,
    pid: process.pid,
    workDir: tempDir,
    args: ARGS,
    startedAt: Date.now(),
  };
  d!.writeIdentityMap(map as never);
}

function seedHeartbeat(sid: string, pid: number = process.pid): void {
  const hbFile = path.join(d!.HEARTBEAT_DIR, `${sid}.json`);
  fs.mkdirSync(path.dirname(hbFile), { recursive: true });
  fs.writeFileSync(hbFile, JSON.stringify({ heartbeats: [Date.now()], briefs: [], pid }));
}

function writeSpec(renew: 'always' | 'onMismatch'): void {
  fs.writeFileSync(specFile, JSON.stringify({
    group: 'grp',
    peers: [{ name: PEER_NAME, workdir: tempDir, args: ARGS, renew }],
    channels: [],
  }, null, 2));
}

/**
 * Run cmdUp with launchPeer (peers barrel) + stopPeerByAddress (peers-stop)
 * spied. `stopVerdict` is the StopVerdict the stop primitive spy returns
 * ('stopped', 'refused-not-mycc', 'still-up', ...). CONFIRM (wait-for-death) is
 * now INSIDE the primitive, so a holder that never releases is modeled as the
 * primitive returning 'still-up' — there is no separate waitForPeerGone seam.
 */
async function runCmdUp(opts: {
  allowStop: boolean;
  stopVerdict?: string;
}): Promise<{ rows: string[]; exitCode: unknown }> {
  peersMod = await import('../../scripts/mycc-compose/lib/peers.js');
  launchPeerSpy = vi.spyOn(peersMod, 'launchPeer').mockImplementation(
    async (peer: { name?: string; identityName?: string; sessionId?: string | null }) => {
      const sid = randomUUID();
      peer.sessionId = sid;
      const map = d!.readIdentityMap();
      map[sid] = {
        sessionId: sid,
        name: peer.identityName ?? (peer.name ? 'grp:' + peer.name : PEER_IDENTITY_NAME),
        pid: process.pid,
        workDir: tempDir,
        args: ARGS,
        startedAt: Date.now(),
      };
      d!.writeIdentityMap(map as never);
      seedHeartbeat(sid);
      return { ok: true, pid: process.pid } as never;
    },
  );
  stopMod = await import('../../scripts/mycc-compose/lib/peers-stop.js');
  stopPeerSpy = vi.spyOn(stopMod, 'stopPeerByAddress').mockImplementation(
    (async () => ({ verdict: (opts.stopVerdict ?? 'stopped') as never, sessionId: SID })) as never,
  );
  const mod = await import('../../scripts/mycc-compose/lib/cmd-up.js');
  const cmdUp = (mod as { cmdUp: (file: string, o: { allowStop: boolean }) => Promise<void> }).cmdUp;
  const rows: string[] = [];
  let exitCode: unknown = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    rows.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    rows.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null | undefined) => {
    exitCode = code;
    throw new Error(`__cmd_up_exit__:${String(code)}`);
  }) as typeof process.exit);
  try {
    await cmdUp(specFile, { allowStop: opts.allowStop });
  } catch (err) {
    if (!(err instanceof Error) || !(err as Error).message.startsWith('__cmd_up_exit__')) throw err;
  } finally {
    vi.restoreAllMocks();
  }
  return { rows, exitCode };
}

beforeEach(() => {
  vi.resetModules();
  d = null as unknown as Discovery;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-restart-'));
  process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
  fs.mkdirSync(path.join(process.env.MYCC_DISCOVERY_DIR!, 'heartbeat'), { recursive: true });
  fs.mkdirSync(process.env.MYCC_DISCOVERY_DIR!, { recursive: true });
  SID = randomUUID();
  specFile = path.join(tempDir, 'spec.json');
});

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  d = null;
  vi.restoreAllMocks();
});

describe('cmdUp: sequenced restart — wait for the prior holder before relaunch (P2 #1)', () => {
  it('stop=stopped + holder released → the replacement IS launched (happy path)', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    writeSpec('always');
    seedIdentity();
    seedHeartbeat(SID);

    const { rows, exitCode } = await runCmdUp({ allowStop: true, stopVerdict: 'stopped' });

    expect(stopPeerSpy).toHaveBeenCalledTimes(1);
    expect(launchPeerSpy).toHaveBeenCalledTimes(1);
    expect(rows.join('')).toMatch(/renew:always → stop=stopped, start/);
    expect(exitCode).toBe(0);
  }, 20_000);

  it('stop REFUSED → NO launch is queued, restart aborted, non-zero exit', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    writeSpec('always');
    seedIdentity();
    seedHeartbeat(SID);

    const { rows, exitCode } = await runCmdUp({ allowStop: true, stopVerdict: 'refused-not-mycc' });

    // The successful-launch spy must NOT have fired: a refusal cannot be
    // papered over by a launch the name guard would reject.
    expect(stopPeerSpy).toHaveBeenCalledTimes(1);
    expect(launchPeerSpy).not.toHaveBeenCalled();
    expect(rows.join('')).toMatch(/restart ABORTED \(refused\)/);
    expect(rows.join('')).toMatch(/restart aborted for 1 peer/);
    expect(exitCode).toBe(1);
  }, 20_000);

  it('still-up (holder never confirmed dead) → NO launch is queued, restart aborted, non-zero exit', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    writeSpec('always');
    seedIdentity();
    seedHeartbeat(SID);

    // The primitive CONFIRM window expired with the process still alive: the
    // peer could NOT be confirmed down, so no replacement may be queued.
    const { rows, exitCode } = await runCmdUp({ allowStop: true, stopVerdict: 'still-up' });

    expect(launchPeerSpy).not.toHaveBeenCalled();
    expect(rows.join('')).toMatch(/restart ABORTED \(refused\)/);
    expect(rows.join('')).toMatch(/restart aborted for 1 peer/);
    expect(exitCode).toBe(1);
  }, 20_000);

  it('mismatch restart uses the SAME sequencing (stop=stopped + released → launch)', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    // A live peer whose args DIFFER from the spec → treated as a mismatch.
    writeSpec('onMismatch');
    const map: Record<string, unknown> = {};
    map[SID] = {
      sessionId: SID,
      name: PEER_IDENTITY_NAME,
      pid: process.pid,
      workDir: tempDir,
      args: '--auto --skip-healthcheck --ollama-model glm-5:cloud', // differs from ARGS
      startedAt: Date.now(),
    };
    d.writeIdentityMap(map as never);
    seedHeartbeat(SID);

    const { rows, exitCode } = await runCmdUp({ allowStop: true, stopVerdict: 'stopped' });

    expect(rows.join('')).toMatch(/mismatch → stop=stopped, start/);
    expect(launchPeerSpy).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(0);
  }, 20_000);
});

describe('stopPeerByAddress CONFIRM: the bounded death-wait (real, short timeout)', () => {
  it('returns the death verdict once a recorded pid is provably dead (already-stopped)', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    const stop = await import('../../scripts/mycc-compose/lib/peers-stop.js');
    // Seed a holder whose pid is PROVABLY DEAD and whose heartbeat is fresh →
    // the address resolves, the recorded pid is dead → already-stopped.
    const deadPid = await (async () => {
      const { spawn } = await import('child_process');
      const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      const pid = child.pid as number;
      await new Promise<void>((r) => child.on('exit', () => r()));
      return pid;
    })();
    const map: Record<string, unknown> = {};
    map[SID] = { sessionId: SID, name: PEER_IDENTITY_NAME, pid: deadPid, workDir: tempDir, args: ARGS, startedAt: Date.now() };
    d.writeIdentityMap(map as never);
    seedHeartbeat(SID, deadPid); // fresh heartbeat but DEAD pid

    const result = await stop.stopPeerByAddress(
      { cwd: tempDir, group: 'grp', name: PEER_NAME },
      { confirmTimeoutMs: 500, pollMs: 50 },
    );
    expect(result.verdict).toBe('already-stopped');
    expect(result.sessionId).toBe(SID);
  }, 10_000);

  it('still-up: a live non-mycc holder refuses (never signaled), so the verdict is a refusal', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    const stop = await import('../../scripts/mycc-compose/lib/peers-stop.js');
    // A LIVE holder (this runner's pid, alive) whose argv does NOT claim the
    // peer's durable name → the primitive refuses on the argv-identity gate
    // rather than signal an unrelated process. It never reaches CONFIRM.
    seedIdentity();
    seedHeartbeat(SID, process.pid);

    const result = await stop.stopPeerByAddress(
      { cwd: tempDir, group: 'grp', name: PEER_NAME },
      { confirmTimeoutMs: 300, pollMs: 50 },
    );
    expect(result.verdict).toBe('refused-not-mycc');
    expect(result.sessionId).toBe(SID);
    // Refuse-not-kill: this runner is still alive.
    let alive = true;
    try { process.kill(process.pid, 0); } catch { alive = false; }
    expect(alive).toBe(true);
  }, 10_000);
});
