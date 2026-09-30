/**
 * peers.js — peer launch / stop / match / repair (§5 steps 1–3, §6.2, §6.4).
 *
 * The launch path is deliberately SHELL-FREE: we resolve mycc's bin entry and
 * spawn `node <bin/mycc.js> …` with {detached:true, stdio:'ignore'}. Spawning
 * the npm shim with shell:true on Windows runs `title %COMSPEC%` attached to
 * the caller's console, which negates detach and grabs the foreground (§ pitfall).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';

import { formatLaunchArgs, formatLaunchArgsForSpawn, argsMatch, LAUNCHER_FLAGS } from '../../../src/utils-esm/arg-canonical.js';
import {
  readIdentityMap,
  writeIdentityMap,
  readHeartbeatData,
  isSessionLive,
  isPeerRunning,
  isPidAlive,
  isRecordedPidAlive,
  didPidStartAfter,
  heartbeatPid,
  heartbeatFileMtimeMs,
  lastBrief,
  FRESHNESS_WINDOW_MS,
} from './discovery.js';

/** How long to wait for a launched peer to register + beat, per peer. */
export const LAUNCH_TIMEOUT_MS = 30_000;
/** Poll interval while waiting for a launched peer to come up. */
export const LAUNCH_POLL_MS = 500;
/**
 * How long `launchPeer` waits for a previous holder of the same session id to
 * die before it refuses to spawn a duplicate (see the renew path in cmdUp:
 * `stopPeer` SIGTERMs, then the replacement starts while the old instance may
 * still be inside its graceful teardown).
 */
export const HOLDER_RELEASE_TIMEOUT_MS = 5_000;
/** Poll interval while waiting for a holder to release the session id. */
export const HOLDER_RELEASE_POLL_MS = 200;
/** Staged-wave size: launching ~20 at once drops identity registrations (§6.4). */
export const WAVE_SIZE = 5;
/** Delay between waves, giving identity.json writes time to settle. */
export const WAVE_DELAY_MS = 1_500;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Matching (§6.2)
// ---------------------------------------------------------------------------

/** Compare two workdirs, tolerant of separators and trailing slash. */
export function sameWorkdir(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Find the best live identity entry matching a peer record: same sessionId,
 * same workdir, and canonical args equal (via argsMatch, *** as wildcard).
 * Returns the entry or null.
 */
export function findMatchingLiveEntry(peer) {
  if (!peer.sessionId || !isPeerRunning(peer)) return null;
  const map = readIdentityMap();
  const entry = map[peer.sessionId];
  if (!entry) return null;
  if (!sameWorkdir(entry.workDir, peer.workdir)) return null;
  // Old instances may lack `args`; argsMatch treats missing as '(none)'.
  if (!argsMatch(entry.args ?? '(none)', peer.args)) return null;
  return entry;
}

// ---------------------------------------------------------------------------
// Launch / stop (§5 step 2)
// ---------------------------------------------------------------------------

/**
 * Split a peer's args string into argv for the `mycc` launcher. Uses the table
 * parser so `--k v` / `--k=v` / bare flags round-trip faithfully, then
 * re-renders via formatLaunchArgsForSpawn (order-preserving, NO secret
 * redaction — the spawn path must carry the real value, unlike the display
 * form which redacts to `***`).
 *
 * Launcher-managed flags ({@link LAUNCHER_FLAGS}, e.g. `session-id`) are
 * stripped: launchPeer supplies `--session-id` itself, and a spec that also
 * authored one would otherwise yield a doubled flag → minimist array →
 * getPinnedSessionId() returns null → the peer mints a RANDOM uuid and the
 * launch poll waits for an id that never registers. Returns an argv array.
 */
export function peerArgv(peer) {
  const parsed = stripLauncherFlags(peer.parsedArgs);
  const rendered = formatLaunchArgsForSpawn(parsed);
  if (rendered === '(none)') return [];
  // Re-split honoring the same rule the formatter uses: a value token never
  // starts with `--`, so regrouping on `--` boundaries is unambiguous.
  const argv = [];
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
function stripLauncherFlags(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (LAUNCHER_FLAGS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

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
 *
 * @param {number} pid
 * @param {string} [sessionId] the session whose heartbeat named this pid
 */
export function isMyccProcess(pid, sessionId) {
  if (!pid || typeof pid !== 'number') return false;
  const sidPattern = typeof sessionId === 'string' && sessionId.length > 0
    ? new RegExp(`--session-id[= ]+${sessionId}`, 'i')
    : null;
  const looksLikeMycc = (line) =>
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
function readProcessCommandLine(pid) {
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
 *   - {@link didPidStartAfter}: a pid that provably started AFTER the heartbeat
 *     file was written cannot be the process that wrote that file, so it was
 *     recycled → refuse (`refused-recycled-pid`).
 *   - a legacy heartbeat with no `pid` cannot name an owner at all → refuse
 *     (`refused-no-recorded-pid`) rather than kill on a guess.
 */
export function stopPeer(peer) {
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
    return `kill-failed:${err.code || err.message}`;
  }
}

/**
 * Wait until any live holder of `sessionId` has released it, so a renewal can
 * spawn the replacement without tripping the `--session-id` held-guard.
 *
 * After {@link stopPeer} SIGTERMs an instance, its teardown is asynchronous —
 * the SIGTERM handler awaits `bg.killAllRunning()` before it reaches
 * `peer.stop()` → `identity.unregister()` (src/loop/signal-handlers.ts), so the
 * instance keeps beating (and holding the id) for a while. Starting the
 * replacement immediately would make it refuse to boot. Returns 'released' when
 * no live holder remains, else 'still-held' on timeout.
 */
export async function waitForHolderRelease(sessionId, timeoutMs = HOLDER_RELEASE_TIMEOUT_MS) {
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
export function isSessionHeld(sessionId) {
  if (!isSessionLive(sessionId)) return false;
  const hbPid = heartbeatPid(sessionId);
  if (typeof hbPid !== 'number') return true; // cannot disprove → assume held
  return isPidAlive(hbPid);
}

/**
 * Resolve the absolute path to mycc's bin entry (bin/mycc.js) so we can spawn
 * it with `node` DIRECTLY — no shell. See the module header for why.
 *
 * Resolution order:
 *   0. MYCC_COMPOSE_BIN env — explicit override (used by the test suite to
 *      point at a fixture bin, and as an operational escape hatch).
 *   1. THIS SCRIPT's own package tree (<scripts/mycc-compose>/../../bin/mycc.js).
 *      Preferred over any PATH shim: after `npm link` the global `mycc` may be
 *      a junction to an OLDER checkout whose bin predates `--session-id`, in
 *      which case the pinned id is ignored and the launch poll waits forever.
 *   2. MYCC_ROOT env (set by bin/mycc.js) → <root>/bin/mycc.js
 *   3. The global npm package next to the resolved `mycc` shim
 *      (<npm-prefix>/node_modules/mycc/bin/mycc.js) — a junction to the repo
 *      after `npm link`.
 *   4. null → the caller REFUSES to launch (never falls back to a shell; the
 *      shell path re-introduces the `title %COMSPEC%` foregrounding bug on
 *      Windows and, on Unix, makes the detached group leader a `/bin/sh` whose
 *      SIGTERM orphans the node grandchild).
 */
export function resolveMyccBin() {
  const candidates = [];
  if (process.env.MYCC_COMPOSE_BIN) {
    candidates.push(process.env.MYCC_COMPOSE_BIN);
  }
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
    const finder = process.platform === 'win32' ? ['where', ['mycc']] : ['which', ['mycc']];
    const found = execFileSync(finder[0], finder[1], { encoding: 'utf-8', timeout: 5_000 })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const shim of found) {
      // <dir>/mycc(.cmd|.ps1|) → <dir>/node_modules/mycc/bin/mycc.js
      const dir = path.dirname(shim);
      candidates.push(path.join(dir, 'node_modules', 'mycc', 'bin', 'mycc.js'));
    }
  } catch {
    // `where`/`which` unavailable — fall through to the remaining candidates.
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

/** The latest heartbeat timestamp recorded for a session, or 0. */
function latestBeatMs(sessionId) {
  const { heartbeats } = readHeartbeatData(sessionId);
  return heartbeats.length > 0 ? heartbeats[heartbeats.length - 1] : 0;
}

/**
 * Launch one peer DETACHED: `node <bin/mycc.js> --session-id <sid> <args…>`
 * with cwd = workdir, stdio ignored, windowsHide, and its own process group.
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
export function launchPeer(peer) {
  return new Promise((resolve, reject) => {
    const argv = peerArgv(peer);
    const finalArgv = ['--session-id', peer.sessionId, ...argv];
    const bin = resolveMyccBin();

    if (!bin) {
      reject(new Error(
        `cannot locate bin/mycc.js for "${peer.name}" — refusing to launch via a shell ` +
        '(set MYCC_ROOT or run from the mycc checkout).',
      ));
      return;
    }

    // A live holder of this session id (the instance `stopPeer` just SIGTERMed,
    // which is still inside its graceful teardown) would make the replacement
    // refuse to boot via the --session-id held-guard. Wait it out first.
    const spawnAt = Date.now();
    const prevBeat = latestBeatMs(peer.sessionId);

    let child;
    let poll = null;
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      fn(arg);
    };

    void (async () => {
      const release = await waitForHolderRelease(peer.sessionId);
      if (release !== 'released') {
        done(reject, new Error(
          `session ${peer.sessionId} is still held by a live process after ` +
          `${HOLDER_RELEASE_TIMEOUT_MS}ms — not launching a second instance for "${peer.name}".`,
        ));
        return;
      }

      try {
        child = spawn(process.execPath, [bin, ...finalArgv], {
          cwd: peer.workdir,
          detached: true,
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        });
      } catch (err) {
        done(reject, new Error(`spawn failed for "${peer.name}": ${err.message}`));
        return;
      }
      child.on('error', (err) => done(reject, new Error(`spawn failed for "${peer.name}": ${err.message}`)));
      child.on('exit', (code, signal) => done(reject, new Error(
        `peer "${peer.name}" exited before registering (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}).`,
      )));
      child.unref();

      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      poll = setInterval(() => {
        if (latestBeatMs(peer.sessionId) > prevBeat && isPeerRunning(peer)) {
          done(resolve, 'started');
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

// ---------------------------------------------------------------------------
// Identity repair pass (§6.4)
// ---------------------------------------------------------------------------

/**
 * For each peer with a FRESH heartbeat, a LIVE recorded pid and NO identity
 * entry, read-merge-write the entry back into identity.json (register() loses
 * races under concurrency). Returns the number of entries repaired.
 *
 * Two defects the naive single read-merge-write had:
 *   - it clobbered a concurrent register(): the map it read was stale by the
 *     time its rename landed, silently dropping another instance's entry —
 *     including the entry the `--session-id` held-guard depends on, which is
 *     what let two `sync` runs split-brain. Fixed with the same retry +
 *     re-read/verify loop register() uses: every iteration re-reads, merges the
 *     missing entries on top, writes, and re-verifies.
 *   - it resurrected identity entries for peers that had cleanly unregistered
 *     (`peer.stop()` → `unregister()`), because it gated on heartbeat freshness
 *     alone. A dead peer's heartbeat file lingers for up to 90s; gating on the
 *     recorded pid being ALIVE avoids minting a ghost entry.
 */
export function repairIdentity(peers) {
  const pending = new Map(); // sessionId → entry to (re)insert
  for (const peer of peers) {
    if (!peer.sessionId) continue;
    const { heartbeats, pid } = readHeartbeatData(peer.sessionId);
    if (heartbeats.length === 0) continue;
    const fresh = Date.now() - heartbeats[heartbeats.length - 1] <= FRESHNESS_WINDOW_MS;
    if (!fresh) continue;
    // A fresh beat with no live pid is either a legacy writer (cannot repair
    // faithfully) or a peer that already exited → do not resurrect it.
    if (typeof pid !== 'number' || !isPidAlive(pid)) continue;

    // Reconstitute a minimal, correct entry. mailbox follows the lead
    // convention under ~/.mycc-store/sessions/<sid>/unread-lead.jsonl.
    pending.set(peer.sessionId, {
      sessionId: peer.sessionId,
      workDir: peer.workdir,
      mailbox: path.join(os.homedir(), '.mycc-store', 'sessions', peer.sessionId, 'unread-lead.jsonl'),
      startedAt: heartbeats[0],
      args: formatLaunchArgs(peer.parsedArgs),
      pid,
    });
  }
  if (pending.size === 0) return 0;

  let repaired = 0;
  for (let attempt = 0; attempt < 5 && pending.size > 0; attempt++) {
    // Re-read EVERY iteration so a registration that landed since the last
    // write is preserved (we merge on top of it, never clobber it).
    const map = readIdentityMap();
    for (const [sid, entry] of pending) {
      if (!(sid in map)) map[sid] = entry;
    }

    // Re-read again immediately before the write and merge whatever landed
    // since the first read. The read→write gap is the lost-update window the
    // original single read-merge-write fell into: a concurrent register()
    // completing in that gap was silently overwritten by our rename.
    const latest = readIdentityMap();
    for (const [sid, entry] of Object.entries(latest)) {
      if (!(sid in map)) map[sid] = entry;
    }
    // Our own pending entries always win for their own session id.
    for (const [sid, entry] of pending) map[sid] = entry;

    writeIdentityMap(map);

    // Verify: entries present after the rename are done (count them once).
    const after = readIdentityMap();
    for (const sid of [...pending.keys()]) {
      if (sid in after) {
        pending.delete(sid);
        repaired++;
      }
    }
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Per-peer status row: {name, sessionId, live, matching, lastBrief}. */
export function peerStatus(peer) {
  return {
    name: peer.name,
    sessionId: peer.sessionId,
    // "live" reflects an actually-running process (fresh heartbeat AND alive
    // pid), not merely a not-yet-expired heartbeat file.
    live: isPeerRunning(peer),
    matching: findMatchingLiveEntry(peer) !== null,
    lastBrief: lastBrief(peer.sessionId),
  };
}
