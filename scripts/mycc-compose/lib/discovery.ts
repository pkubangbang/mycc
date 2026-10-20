/**
 * discovery.ts — readers + liveness predicates over mycc's discovery store.
 *
 * Mirrors the read logic in src/peer/identity.ts. Everything here is
 * read-only EXCEPT writeIdentityMap() (the identity-repair pass) and
 * writeTombstone() (the stopper's marker, §6.7).
 *
 * Liveness has TWO predicates on purpose:
 *   - isSessionLive()  — heartbeat freshness only. Cheap, used for DISPLAY and
 *                        for the "did the launched peer register yet?" poll.
 *   - isPeerRunning()  — freshness AND a live PID that is consistent with the
 *                        heartbeat file's write time when process-start evidence
 *                        is available. Used for RESTART / mutual-exclusion
 *                        decisions, so an OS-recycled PID does not keep a dead
 *                        peer looking healthy.
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
  isOriginalHolderAlive,
} from '../../../src/utils/process-liveness.js';

export { isPidAlive, getProcessStartTime, didPidStartAfter, isOriginalHolderAlive };

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
  /** Epoch-ms stop request (the "tombstone", §6.7 of docs/peers/peer-topology.md),
   * or undefined when none is stamped. Preserved across the peer's own rewrites. */
  tombstone: number | undefined;
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
  const empty: ParsedHeartbeat = { heartbeats: [], briefs: [], pid: undefined, tombstone: undefined };
  const hbFile = path.join(HEARTBEAT_DIR, `${sessionId}.json`);
  if (!fs.existsSync(hbFile)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(hbFile, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return empty;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
    const tombstone = typeof parsed.tombstone === 'number' ? parsed.tombstone : undefined;
    if (Array.isArray(parsed.timestamps)) {
      return { heartbeats: parsed.timestamps, briefs: [], pid, tombstone };
    }
    return {
      heartbeats: Array.isArray(parsed.heartbeats) ? parsed.heartbeats : [],
      briefs: Array.isArray(parsed.briefs) ? parsed.briefs : [],
      pid,
      tombstone,
    };
  } catch {
    return empty;
  }
}

/**
 * Stamp a TOMBSTONE (epoch-ms stop request) into a session's heartbeat file,
 * preserving its heartbeats/briefs/pid. This is the WRITE half of the
 * self-termination protocol (§6.7 of docs/peers/peer-topology.md): the stop
 * primitive (`mycc-stop` / `mycc-compose down`) writes this marker — after the
 * peer's identity is PROVEN, BEFORE it signals — then best-effort SIGTERMs the
 * peer, so a peer the signal did NOT reach (e.g. on Windows, where SIGTERM maps
 * to TerminateProcess and no handler runs) retires itself on its next beat.
 * Mirrors writeTombstone() in src/peer/identity.ts.
 *
 * Lives in the heartbeat file (keyed by the sid the stopper already resolved),
 * NOT identity.json — the live peer owns and rewrites this file every beat, so
 * detection is free and a rewrite that dropped the field would lose the marker;
 * discovery's own readHeartbeatData therefore reads it and the peer's writers
 * preserve it.
 *
 * Best-effort: returns false (never throws) when the file cannot be written — a
 * tombstone is a courtesy, not a guarantee; the signal path stays primary.
 */
export function writeTombstone(sessionId: string, when: number = Date.now()): boolean {
  try {
    const existing = readHeartbeatData(sessionId);
    const data: Record<string, unknown> = {
      heartbeats: existing.heartbeats,
      briefs: existing.briefs,
    };
    if (existing.pid !== undefined) data.pid = existing.pid;
    data.tombstone = when;
    const hbFile = path.join(HEARTBEAT_DIR, `${sessionId}.json`);
    const dir = path.dirname(hbFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${hbFile}.mycc-compose.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, hbFile);
    return true;
  } catch {
    return false;
  }
}

/** Read the tombstone (epoch-ms) for a session, or undefined when none. */
export function readTombstone(sessionId: string): number | undefined {
  return readHeartbeatData(sessionId).tombstone;
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
 * Requires: registered AND fresh heartbeat AND the recorded pid is alive and
 * not demonstrably newer than its heartbeat file. When process-start evidence
 * is unavailable, the decision is conservative (treat as alive). Falls back
 * to the heartbeat-only verdict when no pid is recorded (legacy writers) —
 * we cannot disprove liveness and must not restart a peer we might be double-starting.
 */
export function isPeerRunning(peer: PeerRef | null | undefined): boolean {
  if (!peer || !peer.sessionId) return false;
  if (!isSessionLive(peer.sessionId)) return false;
  const pid = peerPid(peer.sessionId);
  if (typeof pid !== 'number') return true; // no pid recorded → trust freshness
  // PID existence alone is insufficient: the recorded process may have exited
  // and the OS may have recycled its PID. isOriginalHolderAlive checks OS
  // liveness first, then uses heartbeat mtime when available; an unavailable
  // mtime preserves the conservative "alive" verdict without overriding a dead PID.
  return isOriginalHolderAlive(pid, heartbeatFileMtimeMs(peer.sessionId));
}

/**
 * Is the original process recorded for this SID demonstrably gone?
 * A dead PID or positive PID-reuse evidence means yes. Missing or conflicting
 * evidence means no, so destructive callers must fail fast instead of guessing.
 */
export function isSessionHolderDead(sessionId: string): boolean {
  if (!sessionId) return false;
  const heartbeat = readHeartbeatData(sessionId);
  const entry = readIdentityMap()[sessionId];
  const beatPid = typeof heartbeat.pid === 'number' ? heartbeat.pid : undefined;
  const entryPid = typeof entry?.pid === 'number' ? entry.pid : undefined;

  if (beatPid !== undefined && entryPid !== undefined && beatPid !== entryPid) return false;
  const pid = beatPid ?? entryPid;
  if (typeof pid !== 'number') return false;
  if (!isPidAlive(pid)) return true;

  const evidenceTime = beatPid !== undefined
    ? heartbeatFileMtimeMs(sessionId)
    : typeof entry?.startedAt === 'number'
      ? entry.startedAt
      : 0;
  return !isOriginalHolderAlive(pid, evidenceTime);
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
 * Resolve a peer by durable name for stop/teardown, independent of heartbeat
 * freshness. Duplicate LIVE matches violate the identity invariant; never guess.
 *
 * DEAD-TWIN FILTER (F1): a lingering identity entry whose recorded holder is
 * provably gone is NOT a competing owner — it is residue. On Windows a peer
 * stopped by SIGTERM is TerminateProcess'd, so its own unregister() never runs
 * and its entry survives `down`/`up`; the next launch registers a SECOND entry
 * under the same durable name. Counting both as owners made every subsequent
 * stop throw `refused-ambiguous-identity`, and the only code that removes the
 * dead entry (cullStoppedPeers) runs AFTER a successful stop — a self-locking
 * state that could only be cleared by hand-editing identity.json.
 *
 * So filter dead holders FIRST (the same predicate resolveLivePeer uses), and
 * refuse only when more than one entry still has a live/provable holder. When
 * the filter leaves exactly one, that entry IS the peer's owner.
 *
 * When the filter leaves NONE (every entry is dead), fall through to the
 * unfiltered answer: a single dead entry is returned so the stop path can report
 * `already-stopped` and cull it; two or more dead entries are still ambiguous
 * (which dead sid should the cull key on?) and refuse.
 */
export function resolvePeerForStop(peer: PeerRef | null | undefined): string | null {
  if (!peer) return null;
  const name = peer.identityName ?? peer.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  const normalizedName = normalizePeerName(name);
  const matches = Object.entries(readIdentityMap()).filter(([_, entry]) =>
    typeof entry?.name === 'string' &&
    normalizePeerName(entry.name) === normalizedName &&
    sameWorkdirRef(entry.workDir ?? entry.workdir, peer.workdir),
  );
  if (matches.length <= 1) return matches[0]?.[0] ?? null;

  // >1 entry: prefer the ones whose holder is not provably dead.
  const liveOwners = matches.filter(([sid]) => !isSessionHolderDead(sid));
  if (liveOwners.length === 1) return liveOwners[0][0];
  if (liveOwners.length === 0) {
    // Every entry is provably dead. One survivor is still a decidable answer
    // (the caller will report already-stopped and cull it); several are not.
    if (matches.length === 1) return matches[0][0];
    const sids = matches.map(([sid]) => sid).join(', ');
    throw new Error(
      `[mycc-compose] refusing to guess which session owns peer "${name}" in ${peer.workdir}: ` +
      `${sids} (all recorded holders are gone, so there is no live owner to pick)`,
    );
  }
  const sids = liveOwners.map(([sid]) => sid).join(', ');
  throw new Error(
    `[mycc-compose] refusing to guess which session owns peer "${name}" in ${peer.workdir}: ` +
    `${sids} (more than one entry has a live or unprovable holder)`,
  );
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