/**
 * discovery.js — readers + liveness predicates over mycc's discovery store.
 *
 * Mirrors the read logic in src/peer/identity.ts (which cannot be imported by a
 * plain `node` process — see the mycc-compose.js header). Everything here is
 * read-only EXCEPT writeIdentityMap(), which the identity-repair pass uses.
 *
 * Liveness has TWO predicates on purpose:
 *   - isSessionLive()  — heartbeat freshness only. Cheap, used for DISPLAY and
 *                        for the "did the launched peer register yet?" poll.
 *   - isPeerRunning()  — freshness AND a live pid. Used for every RESTART /
 *                        mutual-exclusion decision: a peer SIGKILLed within the
 *                        freshness window still has a fresh heartbeat file and
 *                        would otherwise never be restarted (§ pitfall).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

/** Root of the discovery store. Overridable for tests via MYCC_DISCOVERY_DIR. */
export const DISCOVERY_DIR =
  process.env.MYCC_DISCOVERY_DIR || path.join(os.homedir(), '.mycc-store', 'discovery');
export const IDENTITY_FILE = path.join(DISCOVERY_DIR, 'identity.json');
export const HEARTBEAT_DIR = path.join(DISCOVERY_DIR, 'heartbeat');
export const CHANNELS_DIR = path.join(DISCOVERY_DIR, 'channels');

/** Absolute freshness window — mirrors FRESHNESS_WINDOW_MS in identity.ts. */
export const FRESHNESS_WINDOW_MS = 90_000;

/** Read identity.json into a session-keyed map. {} if missing/malformed. */
export function readIdentityMap() {
  if (!fs.existsSync(IDENTITY_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read the full heartbeat data for a session. Accepts both the current
 * {heartbeats:[], briefs:[]} and legacy {timestamps:[]} schemas.
 * Returns { heartbeats: [], briefs: [], pid: undefined } if missing/malformed.
 */
export function readHeartbeatData(sessionId) {
  const empty = { heartbeats: [], briefs: [], pid: undefined };
  const hbFile = path.join(HEARTBEAT_DIR, `${sessionId}.json`);
  if (!fs.existsSync(hbFile)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(hbFile, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return empty;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
    if (Array.isArray(parsed.timestamps)) {
      return { heartbeats: parsed.timestamps, briefs: [], pid };
    }
    return {
      heartbeats: Array.isArray(parsed.heartbeats) ? parsed.heartbeats : [],
      briefs: Array.isArray(parsed.briefs) ? parsed.briefs : [],
      pid,
    };
  } catch {
    return empty;
  }
}

/**
 * Is the session live? Mirrors isSessionLive() in identity.ts: registered AND
 * latest heartbeat within the absolute FRESHNESS_WINDOW_MS.
 *
 * NOTE this is the *heartbeat* predicate only — a peer that was SIGKILLed
 * within the last 90s still has a "fresh" heartbeat file. For restart decisions
 * use isPeerRunning(), which also verifies the pid.
 */
export function isSessionLive(sessionId) {
  if (!sessionId) return false;
  const map = readIdentityMap();
  if (!(sessionId in map)) return false;
  const { heartbeats } = readHeartbeatData(sessionId);
  if (heartbeats.length === 0) return false;
  return Date.now() - heartbeats[heartbeats.length - 1] <= FRESHNESS_WINDOW_MS;
}

/** True when `pid` looks like a live process. Cross-platform-ish. */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours to signal → treat as alive.
    return err && err.code === 'EPERM';
  }
}

/**
 * True when a session's own heartbeat file records a live pid — i.e. a real
 * mycc instance provably owns this pid, rather than a bare "some pid is alive".
 *
 * This is the positive-identity gate `stopPeer` needs: `pid` is stamped by
 * `IdentityManager.beat()` from the recording process itself
 * (src/peer/identity.ts), so a fresh file + a live pid *is* evidence that a
 * mycc instance is at that pid. A legacy file without `pid` cannot make that
 * claim → false (the caller must not kill on a guess).
 *
 * NOTE: this is evidence, not proof. A file left by a peer that died seconds
 * ago can still name a pid the OS has since recycled; the caller narrows that
 * with {@link didPidStartAfter}.
 */
export function isRecordedPidAlive(sessionId) {
  if (!sessionId) return false;
  const { pid } = readHeartbeatData(sessionId);
  return typeof pid === 'number' && isPidAlive(pid);
}

/**
 * Best-effort read of when process `pid` started (ms since epoch), or null when
 * we cannot tell. Used to detect PID RECYCLING before we kill: a recycled pid
 * started AFTER the heartbeat file that names it, whereas the process that
 * wrote a given heartbeat necessarily started BEFORE that file was written.
 *
 * Windows: `wmic process where processid=<pid> get creationdate` (falling back
 * to PowerShell `Get-Process`). Unix: `ps -o lstart=`. Every path returns null
 * on failure — callers must treat null as "unknown" and fall back to other
 * evidence, never as "started at 0".
 */
export function getProcessStartTime(pid) {
  if (!pid || typeof pid !== 'number') return null;
  try {
    if (process.platform === 'win32') {
      // wmic prints `CreationDate` as an ISO-ish compact stamp, e.g.
      // 20260930120000.000000+120. Try it first (present on Win10/11).
      try {
        const out = execFileSync('wmic', ['process', 'where', `processid=${pid}`, 'get', 'creationdate', '/value'], {
          encoding: 'utf-8',
          timeout: 5_000,
          windowsHide: true,
        });
        const m = /CreationDate=(\d{14})/.exec(out);
        if (m) return compactStampToMs(m[1]);
      } catch {
        // wmic absent/deprecated → fall through to PowerShell.
      }
      const psOut = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
        { encoding: 'utf-8', timeout: 5_000, windowsHide: true },
      );
      const fileTime = Number(psOut.trim());
      // FILETIME is 100-ns ticks since 1601-01-01; convert to Unix ms.
      if (Number.isFinite(fileTime) && fileTime > 0) return fileTime / 10_000 - 11_644_473_600_000;
      return null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    const ms = Date.parse(out.trim());
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** `YYYYMMDDhhmmss` (local) → ms since epoch, or null. */
function compactStampToMs(stamp) {
  const y = Number(stamp.slice(0, 4));
  const mo = Number(stamp.slice(4, 6)) - 1;
  const d = Number(stamp.slice(6, 8));
  const h = Number(stamp.slice(8, 10));
  const mi = Number(stamp.slice(10, 12));
  const s = Number(stamp.slice(12, 14));
  const ms = new Date(y, mo, d, h, mi, s).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when we can PROVE the process at `pid` started after `notBeforeMs` — a
 * strong indication the pid was recycled (the original owner is gone). Returns
 * false when the start time is unknown, so the caller never refuses to kill a
 * legitimate instance just because introspection failed.
 */
export function didPidStartAfter(pid, notBeforeMs) {
  if (!Number.isFinite(notBeforeMs)) return false;
  const startedAt = getProcessStartTime(pid);
  if (startedAt === null) return false;
  // 2s of slack absorbs coarse clock resolution (wmic stamps are whole
  // seconds; `ps lstart` likewise) so a genuine owner is never misjudged.
  return startedAt > notBeforeMs + 2_000;
}

/** The pid recorded for a session (heartbeat first, then identity entry). */
export function peerPid(sessionId) {
  const hb = heartbeatPid(sessionId);
  if (typeof hb === 'number') return hb;
  const entry = readIdentityMap()[sessionId];
  return entry && typeof entry.pid === 'number' ? entry.pid : undefined;
}

/**
 * The pid recorded in the session's HEARTBEAT file ONLY — never the identity
 * entry. `stopPeer` must use this as its evidence: the heartbeat `pid` is
 * stamped by the recording process itself on every beat
 * (IdentityManager.beat()), so a fresh file naming a live pid is positive
 * evidence that a mycc instance owns that pid — unlike "some node process is
 * alive at this pid", which a recycled pid also satisfies.
 */
export function heartbeatPid(sessionId) {
  const { pid } = readHeartbeatData(sessionId);
  return typeof pid === 'number' ? pid : undefined;
}

/** The heartbeat file's mtime — when its most recent beat was written — or 0. */
export function heartbeatFileMtimeMs(sessionId) {
  try {
    return fs.statSync(path.join(HEARTBEAT_DIR, `${sessionId}.json`)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Is a peer actually RUNNING? A fresh heartbeat is necessary but NOT sufficient:
 * a peer killed within the freshness window (or a heartbeat left by a crashed
 * process) would otherwise read as "live" and never be restarted by `sync`.
 *
 * Requires: registered AND fresh heartbeat AND the recorded pid is alive.
 * Falls back to the heartbeat-only verdict when the entry carries no pid
 * (legacy writers) — in that case we cannot disprove liveness and must not
 * restart a peer we might be double-starting.
 */
export function isPeerRunning(peer) {
  if (!peer || !peer.sessionId) return false;
  if (!isSessionLive(peer.sessionId)) return false;
  const pid = peerPid(peer.sessionId);
  if (typeof pid !== 'number') return true; // no pid recorded → trust freshness
  return isPidAlive(pid);
}

/** The last brief recorded for a session, or null. */
export function lastBrief(sessionId) {
  const { briefs } = readHeartbeatData(sessionId);
  if (briefs.length === 0) return null;
  return briefs[briefs.length - 1];
}

/** Atomic-ish write of identity.json (tmp + rename). */
export function writeIdentityMap(map) {
  const dir = path.dirname(IDENTITY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${IDENTITY_FILE}.mycc-compose.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
  fs.renameSync(tmp, IDENTITY_FILE);
}
