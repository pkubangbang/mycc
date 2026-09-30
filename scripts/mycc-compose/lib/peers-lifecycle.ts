/**
 * peers-lifecycle.ts — launch a peer, stop a peer, and decide whether a
 * session id is still held.
 *
 * Everything that touches the OPERATING SYSTEM sits here: spawning the Lead,
 * reading a process command line, signalling a pid, and resolving the launcher
 * bin. The launch path is SHELL-FREE (never the npm shim with shell:true — its
 * `title %COMSPEC%` foregrounds the child on Windows). The peer is spawned
 * DETACHED (its own process group on Unix, its own console/process group on
 * Windows) so it outlives the launcher, and with stdio ignored so it never
 * blocks on the launcher's terminal.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';

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
  // FRONT OF THE LINE after the module-relative bin: MYCC_ROOT names the tree
  // THIS launcher was started from (bin/mycc.js exports it), so its bin is
  // authoritative when it differs from the module-relative one (e.g. a linked
  // checkout). Without this, an explicit MYCC_ROOT was only a fallback and the
  // module-relative bin shadowed it.
  if (process.env.MYCC_ROOT) {
    candidates.splice(1, 0, path.join(process.env.MYCC_ROOT, 'bin', 'mycc.js'));
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
 * Launch one peer to outlive the launcher.
 *
 * ALWAYS DETACHED, one spawn shape on every platform:
 *   `node <bin/mycc.js> --session-id <sid> <args…>` with cwd = workdir,
 *   stdio ignored, detached:true, windowsHide, then unref().
 *
 * detached:true gives the peer its own process group (Unix) / its own process
 * group + console (Windows), so it survives the launcher's exit — on Windows a
 * child sharing the launcher's console group would receive CTRL_CLOSE_EVENT
 * and die. There is deliberately NO wrapper binary and NO per-launch or env
 * override: whether a peer self-daemonizes is decided by its OWN argv
 * (`--daemon` in the spec), not by the spawn shape, so one stray variable
 * cannot put a peer on a different spawn shape than its siblings.
 *
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

    const bin = resolveMyccBin();
    if (!bin) {
      reject(new Error(
        `cannot locate bin/mycc.js for "${peer.name}" — refusing to launch via a shell ` +
        '(run from the mycc checkout, or set MYCC_ROOT to one).',
      ));
      return;
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
        // ONE spawn shape: detached `node <bin>`, stdio ignored, unref'd. The
        // peer's own argv decides whether it self-daemonizes.
        const proc = spawn(process.execPath, [bin, ...finalArgv], {
          cwd: peer.workdir as string,
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
          detached: true, // own process group / console → survives the launcher
        });
        proc.on('error', (err: Error) => done(reject, new Error(`spawn failed for "${peer.name}": ${err.message}`)));
        // The peer's own exit before it registers is a launch failure, reported
        // with its exit code rather than surfacing as a 30s timeout.
        proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => done(reject, new Error(
          `peer "${peer.name}" exited before registering (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}).`,
        )));
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
