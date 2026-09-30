/**
 * mycc-compose-peers.test.ts — launcher/liveness correctness for the
 * mycc-compose peer layer (scripts/mycc-compose/lib/peers.ts + discovery.ts).
 *
 * Every test here FAILS against the pre-fix modules and PASSES after. The
 * defects pinned:
 *   - B-LAUNCH-2 / A-M3: stopPeer killed a RECYCLED pid, because its only
 *     identity check accepted any node.exe. Now the heartbeat's own recorded
 *     pid is the evidence, and a pid that provably started after the heartbeat
 *     file was written (a recycle) is refused.
 *   - A-M1: launchPeer resolved 'started' from a STALE heartbeat file even when
 *     the spawned process died instantly. Now it requires a beat newer than any
 *     recorded before the spawn AND a live pid, and it fails fast on child exit.
 *   - A-M2 / D-5: repairIdentity's single read-merge-write clobbered a
 *     concurrent register(). Now it re-reads/verifies in a retry loop.
 *   - m2: repairIdentity resurrected identity entries for cleanly-stopped peers.
 *   - A-M4 / m3: peerArgv passed the secret placeholder `***` to the child and
 *     let a spec-authored --session-id double the launcher's own flag.
 *
 * All disk state lives in a per-test temp dir (MYCC_DISCOVERY_DIR), never the
 * real ~/.mycc-store. `fs.renameSync` is wrapped (not replaced) so a test can
 * inject a concurrent registration into repairIdentity's read→write window.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

const hook = vi.hoisted(() => ({
  onRename: null as null | ((dst: string) => void),
  onIdentityRead: null as null | (() => void),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const renameSync = (...args: Parameters<typeof actual.renameSync>) => {
    hook.onRename?.(String(args[1]));
    return actual.renameSync(...args);
  };
  const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
    const result = actual.readFileSync(...args);
    // Fire AFTER the real read so a test can simulate a concurrent writer that
    // landed between this read and the caller's next write.
    if (hook.onIdentityRead && String(args[0]).endsWith('identity.json')) hook.onIdentityRead();
    return result;
  };
  return { ...actual, renameSync, readFileSync, default: { ...actual, renameSync, readFileSync } };
});

const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SID_C = 'cccccccc-3333-4333-8333-333333333333';

let tempDir = '';
let hbDir = '';
let identityFile = '';

/** Fresh module instances bound to the per-test MYCC_DISCOVERY_DIR. */
async function loadModules() {
  vi.resetModules();
  const discovery = await import('../../scripts/mycc-compose/lib/discovery.js');
  const peers = await import('../../scripts/mycc-compose/lib/peers.js');
  return { discovery, peers };
}

/** Start a long-lived `node -e` process (stands in for a live mycc instance). */
function startLiveProcess(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 600000)'], { stdio: 'ignore' });
  return { pid: child.pid as number, kill: () => child.kill() };
}

/** Start a long-lived process whose command line looks like a mycc instance. */
function startMyccShapedProcess(): { pid: number; kill: () => void } {
  // The script path contains "mycc" → the command line matches the same
  // positive-identity test a real `node …/bin/mycc.js` launch satisfies.
  const script = path.join(tempDir, 'mycc-owner.js');
  fs.writeFileSync(script, 'setTimeout(function(){},600000);');
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  return { pid: child.pid as number, kill: () => child.kill() };
}

/** A pid that is provably dead (spawn a process that exits at once). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise((r) => child.on('exit', r));
  return pid;
}

/** True when `pid` is still alive (EPERM also counts as alive). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function writeIdentity(sid: string, extra: Record<string, unknown> = {}) {
  const map: Record<string, unknown> = {};
  if (fs.existsSync(identityFile)) Object.assign(map, JSON.parse(fs.readFileSync(identityFile, 'utf-8')));
  map[sid] = { sessionId: sid, workDir: tempDir, mailbox: 'mb', startedAt: Date.now(), ...extra };
  fs.writeFileSync(identityFile, JSON.stringify(map, null, 2));
}

function writeHeartbeat(sid: string, pid: number | undefined, when = Date.now()) {
  const data: Record<string, unknown> = { heartbeats: [when], briefs: [] };
  if (pid !== undefined) data.pid = pid;
  fs.writeFileSync(path.join(hbDir, `${sid}.json`), JSON.stringify(data));
}

function peer(name: string, sessionId: string, args = '--auto') {
  return { name, sessionId, workdir: tempDir, args, parsedArgs: { _: [], auto: true } };
}

/** Poll until `pred()` or the deadline; returns pred()'s last value. */
async function waitFor(pred: () => boolean, timeoutMs = 3000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

/** Write a fixture bin and point resolveMyccBin() at it. */
function setBin(source: string): void {
  const bin = path.join(tempDir, `bin-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(bin, source);
  process.env.MYCC_COMPOSE_BIN = bin;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-peers-'));
  hbDir = path.join(tempDir, 'discovery', 'heartbeat');
  identityFile = path.join(tempDir, 'discovery', 'identity.json');
  fs.mkdirSync(hbDir, { recursive: true });
  fs.writeFileSync(identityFile, '{}');
  process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
  delete process.env.MYCC_COMPOSE_BIN;
  hook.onRename = null;
});

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  delete process.env.MYCC_COMPOSE_BIN;
  vi.restoreAllMocks();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// B-LAUNCH-2: stopPeer must not kill a recycled pid
// ---------------------------------------------------------------------------

describe('stopPeer: positive identity, never a recycled pid (B-LAUNCH-2)', () => {
  it('refuses an unrelated live Node process (command line is not mycc)', async () => {
    const { peers } = await loadModules();
    const victim = startLiveProcess(); // `node -e setTimeout…`, never --session-id
    const beatAt = Date.now();
    writeHeartbeat(SID_A, victim.pid, beatAt);
    writeIdentity(SID_A);
    // Backdate the heartbeat file so the victim provably STARTED after the beat
    // that names it → it cannot be the process that wrote that beat (recycled).
    const old = (beatAt - 60_000) / 1000;
    fs.utimesSync(path.join(hbDir, `${SID_A}.json`), old, old);
    try {
      expect(peers.stopPeer(peer('victim', SID_A))).toBe('refused-recycled-pid');
      expect(isAlive(victim.pid)).toBe(true); // the innocent process survived
    } finally {
      victim.kill();
    }
  });

  it('refuses an unrelated Node process even without the recycle signal', async () => {
    const { peers } = await loadModules();
    const victim = startLiveProcess();
    writeHeartbeat(SID_A, victim.pid); // normal (fresh) heartbeat file
    writeIdentity(SID_A);
    try {
      // No recycle provable, but the command line is a plain `node -e` — not
      // mycc. The old check accepted it because it matched /node\.exe|mycc/i.
      expect(peers.stopPeer(peer('victim', SID_A))).toBe('refused-not-mycc');
      expect(isAlive(victim.pid)).toBe(true);
    } finally {
      victim.kill();
    }
  });

  it('refuses when the heartbeat file records no pid (cannot name an owner)', async () => {
    const { peers } = await loadModules();
    writeHeartbeat(SID_A, undefined);
    writeIdentity(SID_A);
    expect(peers.stopPeer(peer('legacy', SID_A))).toBe('refused-no-recorded-pid');
  });

  it('does nothing for a session whose recorded pid is dead', async () => {
    const { peers } = await loadModules();
    writeHeartbeat(SID_A, await deadPid());
    writeIdentity(SID_A);
    expect(peers.stopPeer(peer('dead', SID_A))).toBe('heartbeat-fresh-but-pid-dead');
  });

  it('terminates a genuinely live owner (started before its own heartbeat file)', async () => {
    const { peers } = await loadModules();
    const owner = startMyccShapedProcess(); // command line carries a mycc path
    writeIdentity(SID_A);
    writeHeartbeat(SID_A, owner.pid); // file written after the process started
    expect(peers.stopPeer(peer('owner', SID_A))).toBe('stopped');
    expect(await waitFor(() => !isAlive(owner.pid), 3000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A-M1: launchPeer must not resolve from a stale heartbeat
// ---------------------------------------------------------------------------

describe('launchPeer: requires a NEW beat from the spawned child (A-M1)', () => {
  it('does NOT report success from a stale heartbeat while the child never beats', async () => {
    const { peers } = await loadModules();
    const pidFile = path.join(tempDir, 'child.pid');
    // Alive for 4s, never writes a heartbeat → the pre-fix poll resolved
    // 'started' from the STALE fresh heartbeat below within ~500ms.
    setBin(
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      'setTimeout(function(){}, 4000);',
    );
    writeHeartbeat(SID_A, await deadPid()); // fresh file, dead pid → not a live holder
    writeIdentity(SID_A);

    let resolved: string | null = null;
    const pending = peers.launchPeer(peer('silent', SID_A)).then(
      (v: unknown) => { resolved = String(v); return `resolved:${v}`; },
      (e: Error) => `rejected:${e.message}`,
    );

    expect(await waitFor(() => resolved !== null, 1500)).toBe(false);
    // Drain: the child exits at ~4s → launchPeer rejects (no leaked interval).
    expect(await pending).toMatch(/^rejected:/);
  });

  it('reports the child exit reason instead of a generic timeout', async () => {
    const { peers } = await loadModules();
    setBin('process.exit(7);');
    writeIdentity(SID_A); // no heartbeat at all → no holder, spawn proceeds

    const err = await peers.launchPeer(peer('crash', SID_A)).then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/exited before registering/);
    expect(err!.message).toContain('code=7');
  });

  it('resolves once the child actually beats', async () => {
    const { peers } = await loadModules();
    // Writes a NEW beat + its own pid a moment after spawn, mimicking a real
    // mycc instance registering + beating.
    setBin(
      "const fs=require('fs'),p=require('path');" +
      "const d=process.env.MYCC_DISCOVERY_DIR;" +
      `fs.writeFileSync(p.join(d,'heartbeat','${SID_A}.json'),JSON.stringify({heartbeats:[Date.now()],briefs:[],pid:process.pid}));` +
      'setTimeout(function(){},600000);',
    );
    writeIdentity(SID_A); // registered; no heartbeat yet → not held

    expect(await peers.launchPeer(peer('boots', SID_A))).toBe('started');
  });
});

// ---------------------------------------------------------------------------
// A-M2 / D-5: repairIdentity must not clobber a concurrent register()
// ---------------------------------------------------------------------------

describe('repairIdentity: merge-retry preserves concurrent registrations (A-M2/D-5)', () => {
  it('reconciles a registration that lands between its read and its write', async () => {
    const { peers } = await loadModules();
    const selfPid = process.pid;
    writeHeartbeat(SID_B, selfPid); // B needs repair (fresh beat + live pid, no entry)

    // Inject a concurrent register() into the read→write window: it lands
    // right AFTER repairIdentity's first identity.json read. The old single
    // read-merge-write then renamed its stale map over it and SID_A vanished.
    let injected = false;
    hook.onIdentityRead = () => {
      if (injected) return;
      injected = true;
      const cur = JSON.parse(fs.readFileSync(identityFile, 'utf-8'));
      cur[SID_A] = { sessionId: SID_A, workDir: tempDir, mailbox: 'mb', startedAt: Date.now() };
      fs.writeFileSync(identityFile, JSON.stringify(cur, null, 2));
    };

    const repaired = peers.repairIdentity([peer('B', SID_B)]);
    hook.onIdentityRead = null;
    hook.onRename = null;
    expect(injected).toBe(true);

    const map = JSON.parse(fs.readFileSync(identityFile, 'utf-8'));
    expect(repaired).toBe(1);
    expect(map[SID_B]).toBeDefined();
    expect(map[SID_A]).toBeDefined(); // the concurrent register survived
  });

  it('does NOT resurrect an entry for a cleanly-stopped peer (dead pid)', async () => {
    const { peers } = await loadModules();
    writeHeartbeat(SID_C, await deadPid()); // fresh file, process already gone
    fs.writeFileSync(identityFile, '{}'); // as after stop() → unregister()

    expect(peers.repairIdentity([peer('stopped', SID_C)])).toBe(0);
    expect(JSON.parse(fs.readFileSync(identityFile, 'utf-8'))[SID_C]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A-M4 / m3: argv for the spawned child
// ---------------------------------------------------------------------------

describe('peerArgv: spawn argv carries real secrets, no launcher flag (A-M4/m3)', () => {
  it('never passes the redaction placeholder as a real value', async () => {
    const { peers } = await loadModules();
    const rendered = peers.peerArgv({
      parsedArgs: { _: [], auto: true, 'ollama-api-key': 'sk-real', 'wire-token': 'tok-123' },
    });
    expect(rendered).not.toContain('***');
    expect(rendered).toContain('sk-real');
    expect(rendered).toContain('tok-123');
  });

  it('strips a spec-authored --session-id (the launcher supplies it)', async () => {
    const { peers } = await loadModules();
    const rendered = peers.peerArgv({ parsedArgs: { _: [], auto: true, 'session-id': SID_A } });
    expect(rendered).not.toContain('--session-id');
    expect(rendered).toEqual(['--auto']);
  });
});
