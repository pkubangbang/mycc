/**
 * discovery.ts — readers + liveness predicates over mycc's discovery store.
 *
 * Mirrors the read logic in src/peer/identity.ts. Everything here is
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

import * as fs from 'fs';
import path from 'path';
import os from 'os';
// Liveness helpers are CENTRALIZED in src/utils/process-liveness.ts (the same
// module the runtime peer subsystem uses) so a restart/duplicate-name decision
// here can never drift from identity.ts/daemon-init.ts. Re-exported below to
// keep discovery.ts's public surface unchanged.
import {
  isPidAlive,
  getProcessStartTime,
  didPidStartAfter,
} from '../../../src/utils/process-liveness.js';

export { isPidAlive, getProcessStartTime, didPidStartAfter };

/**
 * Synchronously wait (bounded) for `pid` to stop probing as alive, then return
 * whether it is finally dead. Used by `mycc-compose down` BEFORE culling an
 * identity entry: `stopPeer` returns the instant SIGTERM is *delivered*, but on
 * POSIX signal delivery is asynchronous, so the target may still probe alive
 * for a few ms — a delete-time `!isPidAlive` check run too early would keep a
 * perfectly cullable entry and silently no-op the cull.
 *
 * Windows is typically immediate (SIGTERM = TerminateProcess), but the loop is
 * harmless there. Returns false when the pid is still alive at the deadline —
 * the caller treats that as unproven death and KEEPS the entry.
 */
export function waitForPidDeath(pid: number, timeoutMs = 1_000): boolean {
  if (typeof pid !== 'number') return false;
  const deadline = Date.now() + timeoutMs;
  // Busy-wait is acceptable here: this runs once per successfully-stopped peer
  // in a teardown CLI, and a synchronous sleep would block the event loop the
  // same way. Sleep in ~10ms slices to stay gentle on the CPU.
  const sleepSlice = (ms: number): void => {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  };
  while (Date.now() <= deadline) {
    if (!isPidAlive(pid)) return true;
    sleepSlice(10);
  }
  return !isPidAlive(pid);
}

/** Root of the discovery store. Overridable for tests via MYCC_DISCOVERY_DIR. */
export const DISCOVERY_DIR: string =
  process.env.MYCC_DISCOVERY_DIR || path.join(os.homedir(), '.mycc-store', 'discovery');
export const IDENTITY_FILE: string = path.join(DISCOVERY_DIR, 'identity.json');
export const HEARTBEAT_DIR: string = path.join(DISCOVERY_DIR, 'heartbeat');
export const CHANNELS_DIR: string = path.join(DISCOVERY_DIR, 'channels');

/** Absolute freshness window — mirrors FRESHNESS_WINDOW_MS in identity.ts. */
export const FRESHNESS_WINDOW_MS = 90_000;

/** The subset of a peer record discovery needs in order to answer "is it running?". */
export interface PeerRef {
  /** Spec-local leaf name. */
  name?: string;
  /** Fully qualified durable identity (`<group>:<peer>`). */
  identityName?: string;
  sessionId?: string | null;
  workdir?: string;
}

/** One identity registry entry as written by the running mycc instance. */
export interface IdentityEntry {
  sessionId?: string;
  pid?: number;
  workdir?: string;
  workDir?: string;
  args?: string;
  updatedAt?: number;
  /**
   * Optional durable peer NAME (`<group>:<peer>`), launcher-injected (mycc-compose).
   * DATA-ONLY identity: the stable handle a peer is addressed by across the
   * per-run session-id churn (see src/types.ts IdentityEntry.name). Mirrors the
   * src-side field so compose can resolve a spec peer → its live sid by name.
   */
  name?: string;
  /** Anything else the instance may publish; discovery never assumes its shape. */
  [key: string]: unknown;
}

/** One heartbeat document as written by the running mycc instance. */
export interface HeartbeatData {
  pid?: number;
  sessionId?: string;
  updatedAt?: number;
  brief?: string;
  [key: string]: unknown;
}

/** One brief entry as written by the recording mycc instance. */
export interface BriefEntry {
  time: number;
  content: string;
  confidence: number;
}

/** The parsed heartbeat file shape returned by readHeartbeatData(). */
export interface ParsedHeartbeat {
  heartbeats: number[];
  briefs: BriefEntry[];
  pid: number | undefined;
}

/** Read identity.json into a session-keyed map. {} if missing/malformed. */
export function readIdentityMap(): Record<string, IdentityEntry> {
  if (!fs.existsSync(IDENTITY_FILE)) return {} as Record<string, IdentityEntry>;
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
export function readHeartbeatData(sessionId: string): ParsedHeartbeat {
  const empty: ParsedHeartbeat = { heartbeats: [], briefs: [], pid: undefined };
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
export function isSessionLive(sessionId: string): boolean {
  if (!sessionId) return false;
  const map = readIdentityMap();
  if (!(sessionId in map)) return false;
  const { heartbeats } = readHeartbeatData(sessionId);
  if (heartbeats.length === 0) return false;
  return Date.now() - heartbeats[heartbeats.length - 1] <= FRESHNESS_WINDOW_MS;
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
export function isRecordedPidAlive(sessionId: string): boolean {
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
 * NOTE: the implementation is CENTRALIZED in src/utils/process-liveness.ts and
 * re-exported at the top of this file (see the import block) so the compose
 * launcher and the runtime peer subsystem share ONE liveness decision.
 */

/** The pid recorded for a session (heartbeat first, then identity entry). */
export function peerPid(sessionId: string): number | undefined {
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
export function heartbeatPid(sessionId: string): number | undefined {
  const { pid } = readHeartbeatData(sessionId);
  return typeof pid === 'number' ? pid : undefined;
}

/** The heartbeat file's mtime — when its most recent beat was written — or 0. */
export function heartbeatFileMtimeMs(sessionId: string): number {
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
export function isPeerRunning(peer: PeerRef | null | undefined): boolean {
  if (!peer || !peer.sessionId) return false;
  if (!isSessionLive(peer.sessionId)) return false;
  const pid = peerPid(peer.sessionId);
  if (typeof pid !== 'number') return true; // no pid recorded → trust freshness
  return isPidAlive(pid);
}

/**
 * Resolve a peer record to the session id of its LIVE instance by scanning
 * identity.json for an entry whose durable `name` matches AND whose workdir
 * matches — the name is what is stable across the per-run sid churn, so this
 * is how the launcher/stopper/dispatcher find "the currently-running instance
 * of peer X" without the spec ever authoring a sid.
 *
 * Matching rules (mirror findMatchingLiveEntry's workdir tolerance):
 *   - `peer.name` is REQUIRED; a nameless peer resolves to null (compose always
 *     names its peers, so a missing name is a programming error, not a query).
 *   - workdir must match (sameWorkdir semantics: separator/trailing-slash/
 *     case tolerant) — two groups may share a peer leaf name, and a peer
 *     relaunched in a different workdir is a DIFFERENT instance.
 *   - the entry must be RUNNING (fresh heartbeat AND alive recorded pid), per
 *     isPeerRunning's strict predicate — a dead-twin's lingering identity entry
 *     must never be handed out as "the live sid".
 *
 * AMBIGUITY: name uniqueness is enforced at register() time (assertNameNotLive
 * exits a second live twin), so >1 live match should be impossible. If it
 * somehow happens (a peer that crashed and was relaunched before its old entry
 * aged out, leaving two live-looking entries), pick the NEWEST `startedAt`
 * deterministically and WARN — never return an arbitrary one, so repeated runs
 * resolve identically.
 *
 * Returns the resolved sid, or null when no live instance matches.
 */
function normalizePeerName(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

export function resolveLivePeer(peer: PeerRef | null | undefined): string | null {
  if (!peer) return null;
  const name = peer.identityName ?? peer.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  const normalizedName = normalizePeerName(name);
  const map = readIdentityMap();
  const matches: Array<{ sid: string; startedAt: number }> = [];
  for (const [sid, entry] of Object.entries(map)) {
    if (typeof entry?.name !== 'string' || normalizePeerName(entry.name) !== normalizedName) continue;
    if (!sameWorkdirRef(entry.workDir ?? entry.workdir, peer.workdir)) continue;
    if (!isPeerRunning({ sessionId: sid, workdir: peer.workdir })) continue;
    matches.push({ sid, startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : 0 });
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].sid;
  // Deterministic tiebreak: newest startedAt wins; stable by sid on a tie.
  matches.sort((a, b) => (b.startedAt - a.startedAt) || a.sid.localeCompare(b.sid));
  console.warn(
    `[mycc-compose] WARNING: ${matches.length} live identity entries match peer ` +
    `name "${peer.name}" — resolving to the newest (${matches[0].sid}). This should ` +
    `be impossible (name uniqueness is enforced at register); investigate stale entries.`,
  );
  return matches[0].sid;
}

/**
 * Workdir comparison for {@link resolveLivePeer} — tolerant of separators,
 * trailing slashes and case, mirroring peers-state's sameWorkdir. Duplicated
 * here (rather than imported) to keep discovery.ts free of a peers-state
 * dependency cycle; discovery is the lower layer.
 */
function sameWorkdirRef(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** The last brief recorded for a session, or null. */
export function lastBrief(sessionId: string): BriefEntry | null {
  const { briefs } = readHeartbeatData(sessionId);
  if (briefs.length === 0) return null;
  return briefs[briefs.length - 1];
}

/** Atomic-ish write of identity.json (tmp + rename). */
export function writeIdentityMap(map: Record<string, IdentityEntry>): void {
  const dir = path.dirname(IDENTITY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${IDENTITY_FILE}.mycc-compose.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
  fs.renameSync(tmp, IDENTITY_FILE);
}