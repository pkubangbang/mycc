/**
 * peers-lifecycle.ts — launch a peer, stop a peer, and decide whether a
 * session id is still held.
 *
 * Everything that touches the OPERATING SYSTEM sits here: spawning the Lead,
 * reading a process command line, signalling a pid, and resolving the launcher
 * bin. The launch path is SHELL-FREE (never the npm shim with shell:true — its
 * `title %COMSPEC%` foregrounds the child on Windows). On Windows the peer is
 * launched via bin/mycc-daemon.exe (hidden-console wrapper); on Unix it is
 * spawned detached as a process-group leader.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';

import { getProjectRoot, getTsxLoaderPath } from '../../../src/utils/tsx-run.js';
import { formatLaunchArgsForSpawn } from '../../../src/utils/arg-canonical.js';
import {
  readHeartbeatData,
  isSessionLive,
  isPeerRunning,
  isPidAlive,
  isRecordedPidAlive,
  didPidStartAfter,
  heartbeatPid,
  heartbeatFileMtimeMs,
} from './discovery.js';
import type { PeerRef } from './discovery.js';
import {
  LAUNCH_TIMEOUT_MS,
  LAUNCH_POLL_MS,
  HOLDER_RELEASE_TIMEOUT_MS,
  HOLDER_RELEASE_POLL_MS,
  sleep,
  isLauncherFlag,
} from './peers-types.js';
import type { Peer } from './peers-types.js';

// ---------------------------------------------------------------------------
// argv rendering
// ---------------------------------------------------------------------------

/**
 * Split a peer's args string into argv for the `mycc` launcher. Uses the table
 * parser so `--k v` / `--k=v` / bare flags round-trip faithfully, then
 * re-renders via formatLaunchArgsForSpawn (order-preserving, NO secret
 * redaction — the spawn path must carry the real value, unlike the display
 * form which redacts to `***`).
 *
 * Launcher-managed flags (e.g. `session-id`) are stripped: launchPeer supplies
 * `--session-id` itself, and a spec that also authored one would otherwise
 * yield a doubled flag → minimist array → getPinnedSessionId() returns null →
 * the peer mints a RANDOM uuid and the launch poll waits for an id that never
 * registers. Returns an argv array.
 */
export function peerArgv(peer: Peer): string[] {
  const parsed = stripLauncherFlags(peer.parsedArgs);
  const rendered = formatLaunchArgsForSpawn(parsed);
  if (rendered === '(none)') return [];
  // Re-split honoring the same rule the formatter uses: a value token never
  // starts with `--`, so regrouping on `--` boundaries is unambiguous.
  const argv: string[] = [];
  for (const group of rendered.split(/\s+(?=--)/)) {
    const sp = group.indexOf(' ');
    if (sp === -1) argv.push(group);
    else {
      argv.push(group.slice(0, sp));
      argv.push(group.slice(sp + 1));
    }
  }
  return argv;
}

/** Shallow-copy `parsed` without the launcher-managed flags (never mutates). */
function stripLauncherFlags(parsed: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isLauncherFlag(key)) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process identity — "is this pid really MY mycc?"
// ---------------------------------------------------------------------------

/**
 * Does the live process at `pid` actually belong to mycc? Positive identity —
 * the check that keeps `stopPeer` from killing an unrelated Node process whose
 * pid the OS recycled.
 *
 * `tasklist` / `ps -o command` alone were useless: every Node process matches
 * "node", so the old check returned true for ANY node.exe (and its documented
 * "cannot tell" fallback returned true as well, i.e. every ambiguity became a
 * kill authorisation). We now read the COMMAND LINE and require either
 *   - the mycc bin in the path (`mycc`, `mycc.js`, a `mycc` checkout), or
 *   - the exact `--session-id <sid>` the heartbeat recorded for this session.
 *
 * When the command line cannot be read at all we return FALSE — refusal. The
 * caller has already established (via `didPidStartAfter`) that the pid is not a
 * provably-recycled one, but "we cannot tell" must never authorise a kill.
 */
export function isMyccProcess(pid: number, sessionId?: string | null): boolean {
  if (!pid || typeof pid !== 'number') return false;
  const sidPattern = typeof sessionId === 'string' && sessionId.length > 0
    ? new RegExp(`--session-id[= ]+${sessionId}`, 'i')
    : null;
  const looksLikeMycc = (line: string): boolean =>
    /mycc/i.test(line) || (sidPattern !== null && sidPattern.test(line));

  const commandLine = readProcessCommandLine(pid);
  if (commandLine === null) return false; // cannot introspect → refuse
  return looksLikeMycc(commandLine);
}

/**
 * Best-effort command line of `pid`, or null when it cannot be read.
 * Windows: `Get-CimInstance Win32_Process` (wmic is gone from current Windows).
 * Unix: `ps -p <pid> -o args=`.
 */
export function readProcessCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf-8', timeout: 8_000, windowsHide: true },
      ).trim();
      return out.length > 0 ? out : null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Stop a peer: verify the heartbeat's recorded pid is alive AND owned by this
 * session, then terminate it. Refuses otherwise. Returns a short status string.
 *
 * Identity, not "looks like node": the heartbeat `pid` is stamped by the
 * recording process itself every beat, so a live pid IN THAT FILE is positive
 * evidence that a mycc instance owns it — unlike `isMyccProcess`, which
 * accepted any node.exe and therefore killed a recycled pid. Two extra guards
 * close the remaining recycle window:
 *
 *   - `didPidStartAfter`: a pid that provably started AFTER the heartbeat
 *     file was written cannot be the process that wrote that file, so it was
 *     recycled → refuse (`refused-recycled-pid`).
 *   - a legacy heartbeat with no `pid` cannot name an owner at all → refuse
 *     (`refused-no-recorded-pid`) rather than kill on a guess.
 */
export function stopPeer(peer: Peer): string {
  if (!peer.sessionId) return 'no-session';
  const hbPid = heartbeatPid(peer.sessionId);

  // The heartbeat file names no owner: never kill on a guess.
  if (typeof hbPid !== 'number') {
    return isSessionLive(peer.sessionId) ? 'refused-no-recorded-pid' : 'already-stopped';
  }
  if (!isSessionLive(peer.sessionId)) {
    return isPidAlive(hbPid) ? 'stale-kept-alive-pid' : 'already-stopped';
  }
  if (!isRecordedPidAlive(peer.sessionId)) return 'heartbeat-fresh-but-pid-dead';
  if (didPidStartAfter(hbPid, heartbeatFileMtimeMs(peer.sessionId))) {
    // The pid is alive but was started after the beat that named it → recycled.
    return 'refused-recycled-pid';
  }
  if (!isMyccProcess(hbPid, peer.sessionId)) return 'refused-not-mycc';
  try {
    process.kill(hbPid, 'SIGTERM');
    return 'stopped';
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return `kill-failed:${e.code || e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Session hold
// ---------------------------------------------------------------------------

/**
 * Wait until any live holder of `sessionId` has released it, so a renewal can
 * spawn the replacement without tripping the `--session-id` held-guard.
 *
 * After `stopPeer` SIGTERMs an instance, its teardown is asynchronous — the
 * SIGTERM handler awaits `bg.killAllRunning()` before it reaches
 * `peer.stop()` → `identity.unregister()` (src/loop/signal-handlers.ts), so the
 * instance keeps beating (and holding the id) for a while. Starting the
 * replacement immediately would make it refuse to boot. Returns 'released' when
 * no live holder remains, else 'still-held' on timeout.
 */
export async function waitForHolderRelease(
  sessionId: string,
  timeoutMs: number = HOLDER_RELEASE_TIMEOUT_MS,
): Promise<'released' | 'still-held'> {
  const deadline = Date.now() + timeoutMs;
  while (isSessionHeld(sessionId)) {
    if (Date.now() >= deadline) return 'still-held';
    await sleep(HOLDER_RELEASE_POLL_MS);
  }
  return 'released';
}

/**
 * True when a session id is currently HELD by a live process — a mycc-side
 * mirror of `isSessionHeld()` in src/peer/identity.ts: registered AND fresh
 * heartbeat AND (a recorded pid that is alive, or no pid at all, in which case
 * we cannot disprove the hold). Deliberately conservative: a false "held"
 * merely delays a launch, while a false "free" starts two instances under one
 * session dir.
 */
export function isSessionHeld(sessionId: string): boolean {
  if (!isSessionLive(sessionId)) return false;
  const hbPid = heartbeatPid(sessionId);
  if (typeof hbPid !== 'number') return true; // cannot disprove → assume held
  return isPidAlive(hbPid);
}

// ---------------------------------------------------------------------------
// Bin resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to mycc's bin entry (bin/mycc.js) so we can spawn
 * it with `node` DIRECTLY — no shell. See the module header for why.
 *
 * Resolution order:
 *   1. THIS SCRIPT's own package tree (<scripts/mycc-compose>/../../bin/mycc.js).
 *      Preferred over any PATH shim: after `npm link` the global `mycc` may be
 *      a junction to an OLDER checkout whose bin predates `--session-id`, in
 *      which case the pinned id is ignored and the launch poll waits forever.
 *   2. MYCC_ROOT env (set by bin/mycc.js) → <root>/bin/mycc.js
 *   3. The `mycc` package resolved from THIS module's require graph via
 *      require.resolve('mycc/bin/mycc.js') — a junction to the repo after
 *      `npm link`, and host-independent (no dependency on a PATH shim).
 *   4. null → the caller REFUSES to launch (never falls back to a shell; the
 *      shell path re-introduces the `title %COMSPEC%` foregrounding bug on
 *      Windows and, on Unix, makes the detached group leader a `/bin/sh` whose
 *      SIGTERM orphans the node grandchild).
 */
export function resolveMyccBin(): string | null {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // .../lib
    candidates.push(path.join(here, '..', '..', 'bin', 'mycc.js'));
  } catch {
    // import.meta.url unavailable (exotic loader) — fall through.
  }
  if (process.env.MYCC_ROOT) {
    candidates.push(path.join(process.env.MYCC_ROOT, 'bin', 'mycc.js'));
  }
  try {
    const require = createRequire(import.meta.url);
    candidates.push(require.resolve('mycc/bin/mycc.js'));
  } catch {
    // `mycc` not resolvable from here — fall through to the remaining candidates.
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/** The latest heartbeat timestamp recorded for a session, or 0. */
function latestBeatMs(sessionId: string): number {
  const { heartbeats } = readHeartbeatData(sessionId);
  return heartbeats.length > 0 ? heartbeats[heartbeats.length - 1] : 0;
}

/** Outcome of a launch attempt. */
export type LaunchResult = 'started';

/**
 * Windows-only: spawn the peer via bin/mycc-daemon.exe so CreateProcessW
 * gives the Lead a HIDDEN console (no popup) that survives the launcher.
 *
 * The wrapper is one-shot: it starts the Lead, prints the Lead's pid on stdout
 * as a bare integer, and exits 0. That printed pid is NOT consumed here — the
 * historical `leadPid` promise that read it has been removed because the caller
 * discarded it (launchPeer returns only the ChildProcess) and the Lead's real
 * pid is independently recoverable from the heartbeat via
 * discovery.peerPid(sessionId). Removing it deletes a promise that could reject
 * unhandled and a stdout buffer nobody read. If a caller ever needs the
 * wrapper's printed pid, restore a `leadPid` field here (mirroring
 * resolveWrapperLeadPid) rather than re-deriving it by string-matching.
 */
function launchPeerWindowsWrapper(peer: Peer, finalArgv: string[]): import('child_process').ChildProcess {
  const PROJECT_ROOT = getProjectRoot();
  const wrapperPath = path.join(PROJECT_ROOT, 'bin', 'mycc-daemon.exe');
  const loaderPath = getTsxLoaderPath();
  const scriptPath = path.join(PROJECT_ROOT, 'src', 'index.ts');
  return spawn(wrapperPath, [process.execPath, loaderPath, scriptPath, ...finalArgv], {
    cwd: peer.workdir as string,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MYCC_ROOT: PROJECT_ROOT },
    detached: true, // safe on the wrapper (console app that exits instantly)
    shell: false,
    windowsHide: true,
  });
}

/**
 * Launch one peer to outlive the launcher: `node <bin/mycc.js> --session-id <sid> <args…>`
 * with cwd = workdir, stdio ignored, windowsHide, and proc.unref() so the
 * launcher can exit without tearing the peer down. (NO `detached:true` on
 * Windows: DETACHED_PROCESS forces a console for a console-subsystem process
 * and Windows ignores CREATE_NO_WINDOW when it is set, so `detached:true` +
 * `windowsHide:true` cannot suppress the blank window — the window is created
 * by `detached` itself. unref() + stdio:'ignore' is enough for survival.)
 * Resolves once the peer is live — i.e. it has REGISTERED, BEATEN (a beat
 * newer than any recorded before the spawn), and its recorded pid is alive —
 * or rejects on timeout / early child exit / shell-less bin resolution failure.
 *
 * Two correctness rules the earlier version missed:
 *   - the poll requires a NEW beat, not merely `isSessionLive()`. The stale
 *     heartbeat left by a just-killed peer satisfies freshness for up to 90s,
 *     so the old poll resolved "started" in ~500ms even when the spawned
 *     process died instantly (false success + a silent duplicate/absent peer).
 *   - the child's own exit is observed, so a refused/failed spawn is reported
 *     with its exit code instead of surfacing as a 30s timeout.
 */
export function launchPeer(peer: Peer): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    if (!peer.sessionId) {
      reject(new Error(`cannot launch "${peer.name}": no session id`));
      return;
    }
    const sid = peer.sessionId;
    const argv = peerArgv(peer);
    const finalArgv = ['--session-id', sid, ...argv];

    // Decide the launch path. Windows + the Go wrapper binary present → the
    // wrapper path (bin/mycc-daemon.exe), which gives the Lead a HIDDEN console
    // that SURVIVES the launcher (CREATE_NEW_CONSOLE + SW_HIDE). This is the
    // only spawn shape on Windows that satisfies BOTH no-popup AND survival —
    // a direct `spawn(node, bin, …)` cannot (detached forces a visible console;
    // no-detached dies with the launcher). See launchPeerWindowsWrapper + the
    // Go wrapper source (src/native/daemon-wrapper/main.go).
    //
    // The choice is made on the WHOLE FLEET's platform, never per-launch: there
    // is deliberately no per-launch env override, so a stray variable cannot
    // silently put one peer on a different spawn shape than its siblings.
    //
    // EXCEPTION — an explicit MYCC_ROOT: the wrapper boots the checkout at
    // getProjectRoot() (and its own <root>/bin/mycc.js) and short-circuits
    // resolveMyccBin() entirely, so it cannot honor a MYCC_ROOT that names a
    // DIFFERENT tree. When MYCC_ROOT is set we therefore take the direct
    // `node <bin>` branch and spawn the bin resolveMyccBin() resolves from that
    // root. The test suite relies on exactly this to point launchPeer at a
    // fixture bin instead of the real repo bin; the operational sim never sets
    // MYCC_ROOT, so it keeps the no-popup wrapper.
    //
    // Fallback (Unix, or Windows without the wrapper binary) → the direct
    // `node <bin/mycc.js>` spawn. Unix uses process groups (detached:true) for
    // survival — no console concept, no popup. The Windows-wrapper-MISSING
    // fallback cannot guarantee survival; it warns and proceeds.
    const PROJECT_ROOT = getProjectRoot();
    const wrapperPath = path.join(PROJECT_ROOT, 'bin', 'mycc-daemon.exe');
    const rootOverride = typeof process.env.MYCC_ROOT === 'string' && process.env.MYCC_ROOT.length > 0;
    const useWrapper = !rootOverride && process.platform === 'win32' && fs.existsSync(wrapperPath);
    const bin = useWrapper ? null : resolveMyccBin();

    if (!useWrapper && !bin) {
      reject(new Error(
        `cannot locate bin/mycc.js for "${peer.name}" — refusing to launch via a shell ` +
        '(set MYCC_ROOT or run from the mycc checkout).',
      ));
      return;
    }
    if (process.platform === 'win32' && !useWrapper) {
      // Wrapper missing on Windows: survival past the launcher is imperfect
      // (a non-detached console child dies with the launcher). Warn but
      // proceed — the operator should build the wrapper (see
      // src/native/daemon-wrapper) for correct behavior.
      process.stderr.write(
        `Warning: bin/mycc-daemon.exe not found — launching "${peer.name}" via a direct ` +
        `node spawn, which may not survive the launcher on Windows. Build the Go wrapper ` +
        `for correct no-popup + survival behavior.\n`,
      );
    }

    // A live holder of this session id (the instance `stopPeer` just SIGTERMed,
    // which is still inside its graceful teardown) would make the replacement
    // refuse to boot via the --session-id held-guard. Wait it out first.
    const spawnAt = Date.now();
    const prevBeat = latestBeatMs(sid);

    let poll: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    // `fn` is typed generically over its own `arg` so resolve (which accepts
    // only LaunchResult) and reject (which accepts only Error) both type-check:
    // each call infers T from the concrete arg, so fn is never called with the
    // full union.
    const done = <T>(fn: (v: T) => void, arg: T): void => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      fn(arg);
    };

    void (async () => {
      const release = await waitForHolderRelease(sid);
      if (release !== 'released') {
        done(reject, new Error(
          `session ${peer.sessionId} is still held by a live process after ` +
          `${HOLDER_RELEASE_TIMEOUT_MS}ms — not launching a second instance for "${peer.name}".`,
        ));
        return;
      }

      try {
        // Bind to a const so the handler closures capture a non-null ChildProcess.
        // Windows -> mycc-daemon.exe (own hidden console: survives launch, no window).
        const proc = useWrapper
          ? launchPeerWindowsWrapper(peer, finalArgv)
          : spawn(process.execPath, [bin as string, ...finalArgv], {
              cwd: peer.workdir as string,
              stdio: 'ignore',
              shell: false,
              windowsHide: true,
              detached: process.platform !== 'win32', // Unix: process-group leader for survival
            });
        proc.on('error', (err: Error) => done(reject, new Error(`spawn failed for "${peer.name}": ${err.message}`)));
        // The wrapper is one-shot (prints the Lead PID, exits) — its 'exit' is
        // NORMAL, not a launch failure, so only the direct-spawn branch wires
        // exit→reject. The Lead's real liveness is polled via heartbeats.
        if (!useWrapper) {
          proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => done(reject, new Error(
            `peer "${peer.name}" exited before registering (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}).`,
          )));
        }
        proc.unref();
      } catch (err) {
        done(reject, new Error(`spawn failed for "${peer.name}": ${(err as Error).message}`));
        return;
      }

      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      poll = setInterval(() => {
        if (latestBeatMs(sid) > prevBeat && isPeerRunning(peer as PeerRef)) {
          done(resolve, 'started' as LaunchResult);
          return;
        }
        if (Date.now() > deadline) {
          done(reject, new Error(
            `peer "${peer.name}" did not come up within ${LAUNCH_TIMEOUT_MS}ms ` +
            `(spawned at ${spawnAt}).`,
          ));
        }
      }, LAUNCH_POLL_MS);
    })();
  });
}
