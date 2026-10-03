/**
 * mycc-compose-down.test.ts — the P2-b regression suite: `down --stop` must
 * stop BEFORE deleting the channel files and report failure through the
 * exit code when a requested stop does not happen.
 *
 * Why the order matters: the channel files are a running peer's IPC surface
 * (its poll turns them into mail channels). The old cmdDown deleted them
 * first, then attempted the stop — a refused stop left a running peer with
 * dead channels — and always exited 0, so scripts/cron could not tell a
 * failed stop from success.
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

/** Start a long-lived plain node process (NOT mycc by argv — stopPeer must refuse it). */
function startPlainNodeProcess(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 600000)'], { stdio: 'ignore' });
  return { pid: child.pid as number, kill: () => child.kill() };
}

/** Seed a heartbeat at the DISCOVERY-side path for the given pid. */
function seedHeartbeat(sid: string, pid: number | undefined): void {
  const hbFile = path.join(d!.HEARTBEAT_DIR, `${sid}.json`);
  fs.mkdirSync(path.dirname(hbFile), { recursive: true });
  const data: Record<string, unknown> = { heartbeats: [Date.now()], briefs: [] };
  if (pid !== undefined) data.pid = pid;
  fs.writeFileSync(hbFile, JSON.stringify(data));
}

/** Seed identity.json with a live-pid entry pinned to THIS temp dir. */
function seedIdentity(sid: string, pid: number): void {
  const map: Record<string, unknown> = {};
  map[sid] = {
    sessionId: sid,
    pid,
    workDir: tempDir,
    args: ARGS,
    startedAt: Date.now(),
  };
  d!.writeIdentityMap(map as never);
}

/** Two pinned peers' spec (a channel's ends must differ per spec.ts); both
 * peers share the SAME workdir + args. The channel is p1→p2 so file removal
 * is real; stop assertions target p1 (p2's stop result is 'already-stopped'
 * unless a heartbeat is seeded for it, which keeps exit codes predictable). */
function writeSpec(withChannel: boolean): void {
  const spec: Record<string, unknown> = {
    group: 'grp',
    peers: [
      { name: 'p1', workdir: tempDir, args: ARGS, sessionId: SID, renew: 'onMismatch' },
      { name: 'p2', workdir: tempDir, args: ARGS, sessionId: SID_P2, renew: 'onMismatch' },
    ],
    channels: [] as unknown[],
  };
  if (withChannel) {
    spec.channels = [{ from: 'p1', to: 'p2', label: 'review', prompt: 'ping {{to}}' }];
  }
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
}

/** Materialize real channel files (via the REAL channels module) so
 * removeChannels has something to remove and `channels gone` is a real
 * assertion, not a vacuous one. */
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

/** The exact channel filenames the current spec owns. */
function specChannelNames(): string[] {
  return channelsMod!.channelFileNames(
    {
      group: 'grp',
      peers: [
        { name: 'p1', sessionId: SID },
        { name: 'p2', sessionId: SID_P2 },
      ],
      channels: [{ from: 'p1', to: 'p2', label: 'review', prompt: 'ping {{to}}' }],
    } as never,
  );
}

/** True when every channel file the spec owns is gone from disk. */
function channelsGone(): boolean {
  return specChannelNames().every((name) => !fs.existsSync(path.join(d!.CHANNELS_DIR, name)));
}

/** True when they all exist on disk. */
function channelsPresent(): boolean {
  return specChannelNames().every((name) => fs.existsSync(path.join(d!.CHANNELS_DIR, name)));
}

/** Run cmdDown with out()/exit captured; returns exit code + printed rows. */
async function runDown(stop: boolean): Promise<{ rows: string[]; exitCode: unknown }> {
  const mod = await import('../../scripts/mycc-compose/lib/cmd-down.js');
  const cmdDown = (mod as { cmdDown: (file: string, stop: boolean) => void }).cmdDown;
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
    cmdDown(specFile, stop);
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

describe('cmdDown: stop-before-delete + honest exit code (P2-b)', () => {
  it('down WITHOUT --stop: exits 0 and removes the channel files', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    materializeChannels();

    const preNames = specChannelNames();
    expect(preNames.length).toBeGreaterThan(0);
    expect(channelsPresent()).toBe(true);

    const { exitCode, rows } = await runDown(false);

    expect(exitCode).toBe(0);
    expect(channelsGone()).toBe(true);
    expect(rows.join('')).toMatch(/removed \d+ channel file/);
  });

  it('down --stop on a live pinned-sid peer: 0, channels gone, peer terminated', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    materializeChannels();
    // The REAL owner shape: node running a script WITH the pinned sid in argv
    // (the exact argv isMyccProcess demands). Its argv carries our random SID
    // (a UUID needs no regex quoting, so this stays a fair identity fixture).
    const script = path.join(tempDir, 'owner.js');
    fs.writeFileSync(script, 'setTimeout(function(){},600000);');
    const child = spawn(process.execPath, [script, '--session-id', SID], { stdio: 'ignore' });
    seedIdentity(SID, child.pid as number);
    seedHeartbeat(SID, child.pid as number);

    const { exitCode, rows } = await runDown(true);

    expect(exitCode).toBe(0);
    expect(rows.join('')).toMatch(/p1: stopped/);
    expect(channelsGone()).toBe(true);
    // The stop happened BEFORE deletion and actually terminated the owner.
    expect(await waitForDead(child.pid as number)).toBe(true);
  }, 15_000);

  it('runs the stop attempt BEFORE deleting channel files (ordering guard)', async () => {
    // Order proof by observation: cmdDown's --stop branch calls stopPeer()
    // FIRST. With a REFUSING owner (no sid in argv), stopPeer performs a full
    // readProcessCommandLine round-trip before refusing, so the channel
    // deletion — which only happens after the stop loop — is measurable
    // AFTER that refusal. We assert the printed LOG order instead: the
    // per-peer stop result line must precede the "removed N channel file(s)"
    // line (out() writes in command order).
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    materializeChannels();
    const stubborn = startPlainNodeProcess();
    seedIdentity(SID, stubborn.pid);
    seedHeartbeat(SID, stubborn.pid);

    try {
      const { rows } = await runDown(true);
      const text = rows.join('');
      const stopIdx = text.indexOf('refused-not-mycc');
      const delIdx = text.indexOf('removed');
      expect(stopIdx).toBeGreaterThan(-1);
      expect(delIdx).toBeGreaterThan(-1);
      expect(stopIdx).toBeLessThan(delIdx); // stop printed/published FIRST
    } finally {
      stubborn.kill();
    }
  }, 15_000);

  it('down --stop with an identity-unverifiable pid: NON-ZERO exit, explicit refusal line, peer survives, channels still removed', async () => {
    d = await import('../../scripts/mycc-compose/lib/discovery.js');
    channelsMod = await import('../../scripts/mycc-compose/lib/channels.js');
    writeSpec(true);
    materializeChannels();
    const innocent = startPlainNodeProcess(); // `node -e …` — no sid in argv
    seedIdentity(SID, innocent.pid);
    seedHeartbeat(SID, innocent.pid);

    try {
      const { exitCode, rows } = await runDown(true);

      expect(exitCode).toBe(1);
      expect(rows.join('')).toMatch(/p1: refused-not-mycc/);
      // The refusal is legible to a human scanning the log for what failed.
      expect(rows.join('')).toMatch(/stop refused for 1 peer/);
      // The innocent process was NOT killed (refuse-not-kill, P1-4).
      let stillAlive = true;
      try { process.kill(innocent.pid, 0); } catch { stillAlive = false; }
      expect(stillAlive).toBe(true);
      // Channel deletion still happens (the requested-stop FAILURE does not
      // undo the teardown of the spec's own files).
      expect(channelsGone()).toBe(true);
    } finally {
      innocent.kill();
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