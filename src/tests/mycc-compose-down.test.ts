/**
 * mycc-compose-down.test.ts — the P2-b regression suite: `down` must stop the
 * peers (unconditionally) BEFORE deleting the channel files and report failure
 * through the exit code when a stop does not happen.
 *
 * Why the always-stop shape: the channel files are a running peer's IPC
 * surface (its poll turns them into mail channels). Removing the channels
 * alone — without stopping the peers — has no meaning, so `down` always
 * terminates the peers; there is no channels-only mode and no `--stop` flag.
 *
 * Why the order matters: the stop runs BEFORE the deletion, so a refused stop
 * does not leave a running peer with dead channels, and the exit code is the
 * honest signal a caller can act on.
 *
 * Why a REFUSED stop must be NON-ZERO: `down` is the operator's "teardown"
 * verb; a non-zero exit is the only signal a caller can act on. The stop
 * itself is exercised through the REAL stopPeer/isMyccProcess chain (the
 * same positive-identity rules P1-4 pinned).
 *
 * Module-graph pattern (issue #8 lesson, same as the up-pipeline suite):
 * discovery.ts pins DISCOVERY_DIR/HEARTBEAT_DIR at MODULE LOAD, so NOTHING
 * compose-lib is imported statically — every import happens after the
 * MYCC_DISCOVERY_DIR override is in place, seeds go through the imported
 * module's own exported constants, a fresh random SID per test prevents
 * cross-suite leaks, and process.exit is stubbed to "return" out of cmdDown
 * with its code recorded instead of killing the vitest worker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

type Discovery = typeof import('../../scripts/mycc-compose/lib/discovery.js');
type Channels = typeof import('../../scripts/mycc-compose/lib/channels.js');

const ARGS = '--auto --skip-healthcheck';

let tempDir = '';
let specFile = '';
let SID = '';
let SID_P2 = '';
let channelsMod: Channels | null = null;
let d: Discovery | null = null;

/** Seed a heartbeat at the DISCOVERY-side path for the given pid. */
function seedHeartbeat(sid: string, pid: number | undefined): void {
  const hbFile = path.join(d!.HEARTBEAT_DIR, `${sid}.json`);
  fs.mkdirSync(path.dirname(hbFile), { recursive: true });
  const data: Record<string, unknown> = { heartbeats: [Date.now()], briefs: [] };
  if (pid !== undefined) data.pid = pid;
  fs.writeFileSync(hbFile, JSON.stringify(data));
}

/** Seed identity.json with a live-pid entry pinned to THIS temp dir.
 * The durable NAME is what matching resolves on now (identity, not the sid) —
 * the entry must publish it, exactly as register() does for a `--name` peer. */
function seedIdentity(sid: string, pid: number, name: string): void {
  const map = d!.readIdentityMap();
  map[sid] = {
    sessionId: sid,
    name,
    pid,
    workDir: tempDir,
    args: ARGS,
    startedAt: Date.now(),
  };
  d!.writeIdentityMap(map);
}

/**
 * Seed BOTH peers as LIVE (name p1→SID, p2→SID_P2), on a pid that is alive
 * but is NOT a mycc process (this test runner's own pid). This is the state
 * `down` actually operates on — running peers — and it makes production's
 * name-resolution (resolveLivePeer) yield EXACTLY the sids the fixture's
 * channel helpers use, so the expected filename set and production's agree.
 * stopPeer then refuses on the argv-identity gate (no `--name` in this pid's
 * argv), which is what the per-test expectations assert.
 */
function seedBothLive(): void {
  seedIdentity(SID, process.pid, 'p1');
  seedIdentity(SID_P2, process.pid, 'p2');
  seedHeartbeat(SID, process.pid);
  seedHeartbeat(SID_P2, process.pid);
}

/**
 * The channel files the DOWN path can see for the current spec: the name-set is
 * {p1,p2} and the only spec label is 'review', so every planted materialized
 * file (which carries ownerName/peerName p1/p2) is deletable by name (R1).
 * NOTE: this is the NAME-attributed replacement for channelFileNames(); the
 * down path no longer keys on the resolved sids.
 */
function ownedNames(): string[] {
  return channelFileNames();
}

/** Two peers' spec (a channel's ends must differ per spec.ts); both peers
 * share the SAME workdir + args. No `sessionId` — identity is the durable NAME
 * (`--name`), resolved from identity.json at runtime. The channel is p1→p2 so
 * file removal is real; stop assertions target p1. */
function writeSpec(withChannel: boolean): void {
  const spec: Record<string, unknown> = {
    group: 'grp',
    peers: [
      { name: 'p1', workdir: tempDir, args: ARGS, renew: 'onMismatch' },
      { name: 'p2', workdir: tempDir, args: ARGS, renew: 'onMismatch' },
    ],
    channels: [] as unknown[],
  };
  if (withChannel) {
    spec.channels = [{ from: 'p1', to: 'p2', label: 'review', prompt: 'ping {{to}}' }];
  }
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
}

/** Materialize real channel files (via the REAL channels module) under the
 * SAME sids production resolves (seedBothLive), so removeChannels has exactly
 * the files `down` will target and `channels gone` is a real assertion. */
function materializeChannels(): void {
  channelsMod!.materializeChannels({
    group: 'grp',
    peers: [
      { name: 'p1', sessionId: SID },
      { name: 'p2', sessionId: SID_P2 },
    ],
    channels: [{ from: 'p1', to: 'p2', label: 'review', prompt: 'ping {{to}}' }],
  } as never);
}

/** The exact channel filenames the current spec owns (materialized fixtures). */
function channelFileNames(): string[] {
  return [`${SID}-review.json`, `${SID_P2}-review.json`];
}

/** True when every channel file the spec owns is gone from disk. */
function channelsGone(): boolean {
  return channelFileNames().every((name) => !fs.existsSync(path.join(d!.CHANNELS_DIR, name)));
}

/** True when they all exist on disk. */
function channelsPresent(): boolean {
  return channelFileNames().every((name) => fs.existsSync(path.join(d!.CHANNELS_DIR, name)));
}

/** Run cmdDown with out()/exit captured; returns exit code + printed rows. */
async function runDown(): Promise<{ rows: string[]; exitCode: unknown }> {
  const mod = await import('../../scripts/mycc-compose/lib/cmd-down.js');
  const cmdDown = (mod as { cmdDown: (file: string) => void }).cmdDown;
  const rows: string[] = [];
  let exitCode: unknown = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    rows.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null | undefined) => {
    exitCode = code;
    throw new Error(`__cmd_down_exit__:${String(code)}`);
  }) as typeof process.exit);
  try {
    cmdDown(specFile);
  } catch (err) {
    if (!(err instanceof Error) || !(err as Error).message.startsWith('__cmd_down_exit__')) throw err;
  } finally {
    vi.restoreAllMocks();
  }
  return { rows, exitCode };
}

beforeEach(() => {
  vi.resetModules();
  d = null as unknown as Discovery;
  channelsMod = null;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-down-'));
  process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
  fs.mkdirSync(path.join(process.env.MYCC_DISCOVERY_DIR!, 'heartbeat'), { recursive: true });
  fs.mkdirSync(process.env.MYCC_DISCOVERY_DIR!, { recursive: true });
  SID = randomUUID();
  SID_P2 = randomUUID();
  specFile = path.join(tempDir, 'spec.json');
});

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  d = null;
  channelsMod = null;
  vi.restoreAllMocks();
});

describe('cmdDown: always-stop + stop-before-delete + honest exit code (P2-b)', () => {
  it('down: removes the channel files and reports each peer stop result', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    materializeChannels();
    // Both peers are live but on a NON-mycc pid (this runner) → stopPeer
    // refuses on the argv-identity gate. That refusal is a non-zero exit, but
    // the channel removal still happens (teardown is decoupled from the stop).
    seedBothLive();

    const preNames = ownedNames();
    expect(preNames.length).toBeGreaterThan(0);
    expect(channelsPresent()).toBe(true);

    const { exitCode, rows } = await runDown();

    expect(exitCode).toBe(1); // both stops refused (their pid is not a --name peer)
    expect(rows.join('')).toMatch(/p1: refused-not-mycc/);
    expect(rows.join('')).toMatch(/p2: refused-not-mycc/);
    expect(channelsGone()).toBe(true);
    expect(rows.join('')).toMatch(/removed \d+ channel file/);
  });

  it('down on a live name-identified peer: stops p1, removes channels', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    materializeChannels();
    // p1: the REAL owner shape — node running a script WITH the peer's durable
    // NAME in argv as `--name p1` (the exact argv isMyccProcess demands).
    const script = path.join(tempDir, 'owner.js');
    fs.writeFileSync(script, 'setTimeout(function(){},600000);');
    const child = spawn(process.execPath, [script, '--name', 'p1'], { stdio: 'ignore' });
    seedIdentity(SID, child.pid as number, 'p1');
    seedHeartbeat(SID, child.pid as number);
    // p2: live but non-mycc (this runner) → its stop refuses, exit is non-zero.
    seedIdentity(SID_P2, process.pid, 'p2');
    seedHeartbeat(SID_P2, process.pid);

    const { exitCode, rows } = await runDown();

    expect(exitCode).toBe(1); // p2 refused
    expect(rows.join('')).toMatch(/p1: stopped/);
    expect(rows.join('')).toMatch(/p2: refused-not-mycc/);
    expect(channelsGone()).toBe(true);
    // The stop happened BEFORE deletion and actually terminated the owner.
    expect(await waitForDead(child.pid as number)).toBe(true);
  }, 15_000);

  it('[M3] removes a STALE by-name-owned file (embedded sids from a previous, now-dead run) that the old sid-keyed path could never see', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    // The CURRENT peers have NOT materialized channels yet — as if `up` ran,
    // the peers beat, then the process was torn down and relaunched under the
    // SAME names but FRESH sids. The channel files left on disk carry the OLD
    // run's sids (both now dead), but the NEW owners' NAMES (p1/p2).
    const OLD_SID_1 = randomUUID();
    const OLD_SID_2 = randomUUID();
    const dir = path.join(d!.CHANNELS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const stale1 = path.join(dir, `${OLD_SID_1}-review.json`);
    const stale2 = path.join(dir, `${OLD_SID_2}-review.json`);
    fs.writeFileSync(stale1, JSON.stringify({
      channelId: 'review', ownerSessionId: OLD_SID_1, peerSessionId: OLD_SID_2,
      ownerName: 'p1', peerName: 'p2',
    }));
    fs.writeFileSync(stale2, JSON.stringify({
      channelId: 'review', ownerSessionId: OLD_SID_2, peerSessionId: OLD_SID_1,
      ownerName: 'p2', peerName: 'p1',
    }));
    // No identity/heartbeat for the old sids → they are dead.
    seedBothLive();

    const { rows } = await runDown();

    // The stale files are attributed BY NAME to p1/p2 and removed — the old
    // sid-keyed channelFileNames() would have looked for `<today's-sid>-review`
    // and seen nothing.
    expect(fs.existsSync(stale1)).toBe(false);
    expect(fs.existsSync(stale2)).toBe(false);
    expect(rows.join('')).toMatch(/removed 2 channel file/);
  }, 15_000);

  it('[M3] a LIVE FOREIGN same-label file SURVIVES down (name attribution spares it)', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    materializeChannels(); // ours: names p1/p2
    seedBothLive();
    // A FOREIGN peer's file with the SAME label 'review' but names outside the
    // spec's name-set → kept (never deletion evidence).
    const FOREIGN_SID = randomUUID();
    const foreign = path.join(d!.CHANNELS_DIR, `${FOREIGN_SID}-review.json`);
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, JSON.stringify({
      channelId: 'review', ownerSessionId: FOREIGN_SID, peerSessionId: SID,
      ownerName: 'grp:other', peerName: 'grp:elsewhere',
    }));

    await runDown();

    expect(channelsGone()).toBe(true);          // ours removed
    expect(fs.existsSync(foreign)).toBe(true);  // foreign survives
  }, 15_000);

  it('runs the stop attempt BEFORE deleting channel files (ordering guard)', async () => {
    // Order proof by observation: cmdDown calls stopPeer() FIRST. With a
    // REFUSING owner (no --name in argv), stopPeer performs a full
    // readProcessCommandLine round-trip before refusing, so the channel
    // deletion — which only happens after the stop loop — is measurable
    // AFTER that refusal. We assert the printed LOG order instead: the
    // per-peer stop result line must precede the "removed N channel file(s)"
    // line (out() writes in command order).
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    materializeChannels();
    seedBothLive();

    const { rows } = await runDown();
    const text = rows.join('');
    const stopIdx = text.indexOf('refused-not-mycc');
    const delIdx = text.indexOf('removed');
    expect(stopIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(delIdx); // stop printed/published FIRST
  }, 15_000);

  it('down with an identity-unverifiable pid: NON-ZERO exit, explicit refusal line, peer survives, channels still removed', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    materializeChannels();
    seedBothLive();

    try {
      const { exitCode, rows } = await runDown();

      expect(exitCode).toBe(1);
      expect(rows.join('')).toMatch(/p1: refused-not-mycc/);
      // The refusal is legible to a human scanning the log for what failed.
      expect(rows.join('')).toMatch(/stop refused for 2 peer/);
      // No process was killed (refuse-not-kill, P1-4): this runner is alive.
      let stillAlive = true;
      try { process.kill(process.pid, 0); } catch { stillAlive = false; }
      expect(stillAlive).toBe(true);
      // Channel deletion still happens (the requested-stop FAILURE does not
      // undo the teardown of the spec's own files).
      expect(channelsGone()).toBe(true);
    } finally {
      // nothing to clean up — we never spawned a throwaway process here
    }
  }, 15_000);
});

/** Poll until the pid is dead or the deadline passes. */
async function waitForDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}