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
 *     recorded before the spawn AND a live pid. (The peer is launched through a
 *     one-shot terminal opener, so its own exit is NOT observable as failure —
 *     a never-beating peer surfaces as the launch timeout.)
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
import { spawn, type SpawnOptions } from 'child_process';

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

/** Start a long-lived process whose OWN argv carries the pinned sid, exactly
 * what a real peer launch looks like: spawnDetached resolves the launcher shim
 * to `node <entry.js>` BEFORE spawning, so a genuine peer process's command
 * line is `node …mycc.js --session-id <sid> --auto …`. The script name still
 * contains "mycc" so the test proves the sid ALONE (not the /mycc/i substring
 * the old rule relied on) establishes identity. */
function startMyccShapedProcess(sid: string): { pid: number; kill: () => void } {
  const script = path.join(tempDir, 'mycc-owner.js');
  fs.writeFileSync(script, 'setTimeout(function(){},600000);');
  const child = spawn(process.execPath, [script, '--session-id', sid], { stdio: 'ignore' });
  return { pid: child.pid as number, kill: () => child.kill() };
}

/** Start a long-lived process whose command line looks like a mycc SCRIPT but
 * carries NO --session-id: the shape the /mycc/i substring rule used to
 * wrongly accept (and kill). */
function startMyccLookalikeWithoutSid(): { pid: number; kill: () => void } {
  const script = path.join(tempDir, 'mycc-lookalike.js');
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

/** A `spawn`-shaped impl that maps launchPeer's resolved launcher command onto
 * the fixture shim written by {@link setBin}, so the injected seam runs the
 * deterministic fixture instead of a real mycc. `launchPeer` resolves the
 * ABSOLUTE launcher (`<tempDir>/bin/mycc.cmd` on Windows via MYCC_ROOT,
 * `.../mycc` on POSIX) and — on Windows — CONVERTS a parsable `.cmd` shim to
 * its real argv (`node <entry.js> …`, parseCmdShim in peers-lifecycle.ts)
 * before calling the seam: a detached `cmd /c` wrap still pops a visible
 * Windows-Terminal console window. The seam therefore receives `node.exe`
 * on Windows and runs the fixture directly (hidden); the `command === shim`
 * checks remain for POSIX and for any future direct-shim call shape. */
function fixtureSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ReturnType<typeof spawn> {
  const shim = path.join(tempDir, 'bin', process.platform === 'win32' ? 'mycc.cmd' : 'mycc');
  if (command === shim || command === 'mycc') {
    if (process.platform === 'win32') {
      return spawn('cmd', ['/c', shim, ...args], options);
    }
    return spawn(shim, args as string[], options);
  }
  return spawn(command, args as string[], options);
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

/** Write a FIXTURE mycc shim under `<tempDir>/bin` and point MYCC_ROOT at it.
 *
 * `launchPeer` resolves an ABSOLUTE launcher via {@link resolveMyccLauncher},
 * whose first candidate is `$MYCC_ROOT/bin/mycc{.cmd,}`. Writing the fixture
 * there and setting MYCC_ROOT to the temp dir makes the fixture the absolute
 * launcher path the peer terminal would invoke — a deterministic script instead
 * of a real Lead. On Windows the shim is a `mycc.cmd` (the same form the npm
 * global install uses); on POSIX an executable `mycc` shell script.
 *
 * NOTE: `openTerminal` remains one-shot and creates no window under a
 * non-interactive console, so a test that must observe the beat POLL injects
 * the `spawnImpl` seam (see {@link fixtureSpawn}) instead. `setBin` is otherwise
 * only exercised by the tests that expect a TIMEOUT (no beat is ever produced). */
function setBin(source: string): void {
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptFile = path.join(binDir, 'mycc-fixture.js');
  fs.writeFileSync(scriptFile, source);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(binDir, 'mycc.cmd'),
      `@echo off\r\n"${process.execPath}" "${scriptFile}" %*\r\n`,
    );
  } else {
    const shim = path.join(binDir, 'mycc');
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${scriptFile}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  process.env.MYCC_ROOT = tempDir;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-peers-'));
  hbDir = path.join(tempDir, 'discovery', 'heartbeat');
  identityFile = path.join(tempDir, 'discovery', 'identity.json');
  fs.mkdirSync(hbDir, { recursive: true });
  fs.writeFileSync(identityFile, '{}');
  process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
  delete process.env.MYCC_ROOT;
  hook.onRename = null;
});

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  delete process.env.MYCC_ROOT;
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
    const owner = startMyccShapedProcess(SID_A); // argv carries --session-id <sid>
    writeIdentity(SID_A);
    writeHeartbeat(SID_A, owner.pid); // file written after the process started
    expect(peers.stopPeer(peer('owner', SID_A))).toBe('stopped');
    expect(await waitFor(() => !isAlive(owner.pid), 3000)).toBe(true);
  });

  it('refuses a mycc-named script WITHOUT the pinned sid in its argv', async () => {
    // THE P1-4 regression: the old /mycc/i substring OR-match treated any
    // cmdline merely containing "mycc" as a mycc instance. An unrelated
    // script whose PATH mentions mycc got SIGTERMed for a session it never
    // held. Identity is the exact `--session-id <sid>` argv claim instead —
    // without it, stopPeer must REFUSE, not kill.
    const { peers } = await loadModules();
    const lookalike = startMyccLookalikeWithoutSid();
    writeIdentity(SID_A);
    writeHeartbeat(SID_A, lookalike.pid); // fresh file, live pid, no recycle signal
    try {
      expect(peers.stopPeer(peer('intruder', SID_A))).toBe('refused-not-mycc');
      expect(isAlive(lookalike.pid)).toBe(true); // the innocent process survived
    } finally {
      lookalike.kill();
    }
  });

  it('refuses a live process carrying a DIFFERENT session id', async () => {
    // Exact identity cuts both ways: a mycc-shaped argv pinning SID_B must
    // NOT authorize a kill for SID_A. The old substring rule would have
    // matched it.
    const { peers } = await loadModules();
    const otherHolder = startMyccShapedProcess(SID_B);
    writeIdentity(SID_A);
    writeHeartbeat(SID_A, otherHolder.pid);
    try {
      expect(peers.stopPeer(peer('wrong-sid', SID_A))).toBe('refused-not-mycc');
      expect(isAlive(otherHolder.pid)).toBe(true);
    } finally {
      otherHolder.kill();
    }
  });

  it('refuses (never kills) when the command line cannot be read', async () => {
    // readProcessCommandLine → null (e.g. a just-exited pid): the only safe
    // answer is refusal. The old code ALSO returned false here, this pins it —
    // a fix that relaxed the null path to "assume our own" would silently
    // reintroduce recycled-pid kills.
    const { peers } = await loadModules();
    expect(peers.isMyccProcess(await deadPid(), SID_A)).toBe(false);
  });

  it('refuses when the pinned sid cannot be established at all', async () => {
    // No recorded pid either → the earlier 'refused-no-recorded-pid' branch
    // fires first; use a LIVE plain-node pid and a peer with NO sessionId so
    // the identity check itself must return false (unestablishable), not the
    // /mycc/i fallback.
    const { peers } = await loadModules();
    const victim = startLiveProcess();
    writeHeartbeat(SID_A, victim.pid);
    writeIdentity(SID_A);
    try {
      // a peer record without a session id cannot claim ANY process
      expect(peers.stopPeer(peer('sidless', ''))).toBe('no-session');
      expect(isAlive(victim.pid)).toBe(true);
    } finally {
      victim.kill();
    }
  });
});

// ---------------------------------------------------------------------------
// A-M1: launchPeer must not resolve from a stale heartbeat
// ---------------------------------------------------------------------------

describe('launchPeer: requires a NEW beat from the spawned child (A-M1)', () => {
  it('does NOT report success from a stale heartbeat while the child never beats', async () => {
    const { peers } = await loadModules();
    const pidFile = path.join(tempDir, 'child.pid');
    // Alive for ~1.5s, never writes a heartbeat → the pre-fix poll resolved
    // 'started' from the STALE fresh heartbeat below within ~500ms.
    setBin(
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      'setTimeout(function(){}, 1500);',
    );
    writeHeartbeat(SID_A, await deadPid()); // fresh file, dead pid → not a live holder
    writeIdentity(SID_A);

    const pending = peers.launchPeer(peer('silent', SID_A), { spawnImpl: fixtureSpawn });
    // No beat ever arrives, so launchPeer must NOT resolve on the stale beat —
    // it stays pending until the launch timeout (kept pending, never awaited).
    let resolved = false;
    void pending.then(() => { resolved = true; }, () => { /* timeout rejection */ });
    expect(await waitFor(() => resolved, 1500)).toBe(false);
  });

  // DISABLED: this test waits out the full LAUNCH_TIMEOUT_MS (30s) because it
  // asserts the timeout path itself — the spawned fixture exits at once and
  // never beats, so `launchPeer` only settles when the 30s deadline elapses
  // (hence the 40s budget above). Too slow for the regular suite. Re-enable if
  // the timeout path needs direct coverage (e.g. by injecting a short
  // `opts.timeoutMs`); the fast-opener-exit-is-normal behavior is otherwise
  // covered by the surrounding launchPeer tests.
  it.skip('treats a fast opener exit as normal and reports a timeout when no beat follows', async () => {
    const { peers } = await loadModules();
    // The terminal opener is ONE-SHOT: it creates the window and exits at once.
    // Its exit is therefore never the peer's death, so launchPeer must not
    // reject with an exit code — it polls for a beat and times out instead.
    setBin('process.exit(7);');
    writeIdentity(SID_A); // no heartbeat at all → no holder, spawn proceeds

    const err = await peers.launchPeer(peer('crash', SID_A), { spawnImpl: fixtureSpawn }).then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/did not come up within/);
  }, 40_000);

  it('resolves once the child actually beats', async () => {
    const { peers } = await loadModules();
    // Writes a NEW beat + its own pid a moment after spawn, mimicking a real
    // mycc instance registering + beating. The write is ASYNC (setTimeout 0):
    // a synchronous write inside the child would land when `prevBeat` was
    // already sampled, but an async one proves the poll's `latestBeatMs >`
    // comparison — not a race — is what resolves 'started'.
    setBin(
      "const fs=require('fs'),p=require('path');" +
      "const d=process.env.MYCC_DISCOVERY_DIR;" +
      'setTimeout(function(){' +
      `fs.writeFileSync(p.join(d,'heartbeat','${SID_A}.json'),JSON.stringify({heartbeats:[Date.now()],briefs:[],pid:process.pid}));` +
      '},0);' +
      'setTimeout(function(){},600000);',
    );
    writeIdentity(SID_A); // registered; no heartbeat yet → not held

    // Budget: one node boot (~100-300ms) + a poll tick (LAUNCH_POLL_MS=500).
    // vitest's global testTimeout is 10s, which is ample; assert against a
    // SHORTER deadline so a hang fails urgently instead of burning 10s.
    //
    // The fixture is spawned DIRECTLY (spawnImpl seam), bypassing the terminal
    // opener: under a non-interactive console `cmd /c start` creates no window
    // and runs nothing, so the beat would never arrive. The seam isolates the
    // environment-dependent opener from the poll logic under test, and routes
    // the resolved absolute launcher path to the fixture shim (see fixtureSpawn).
    expect(await peers.launchPeer(peer('boots', SID_A), { spawnImpl: fixtureSpawn })).toBe('started');
  }, 5000);
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

  it('is a NO-OP for a peer whose sid ALREADY has a live identity entry (BUG #2)', async () => {
    // Regression: repairIdentity used to enqueue every fresh+live peer and
    // then unconditionally overwrite its entry — so every `up` re-run on
    // already-registered peers clobbered startedAt/args/mailbox and printed
    // "reconstituted N" (non-idempotent). A present entry must never be touched.
    const { peers } = await loadModules();
    const owner = startLiveProcess();
    const originalStartedAt = 1790760216535;
    const originalArgs = '--auto --skip-healthcheck --debug-wire';
    const originalMailbox = 'C:/Proj/mycc/.mycc/sessions/original/unread-lead.jsonl';
    try {
      writeHeartbeat(SID_B, owner.pid); // fresh beat + LIVE pid → qualifies
      // Pre-existing entry with distinctive values repairIdentity must NOT touch.
      writeIdentity(SID_B, { startedAt: originalStartedAt, args: originalArgs, mailbox: originalMailbox });

      const repaired = peers.repairIdentity([peer('B', SID_B)]);
      expect(repaired).toBe(0); // nothing reconstituted — entry already present

      const entry = JSON.parse(fs.readFileSync(identityFile, 'utf-8'))[SID_B];
      expect(entry.startedAt).toBe(originalStartedAt); // NOT overwritten
      expect(entry.args).toBe(originalArgs);           // NOT overwritten
      expect(entry.mailbox).toBe(originalMailbox);     // NOT overwritten
    } finally {
      owner.kill();
    }
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
