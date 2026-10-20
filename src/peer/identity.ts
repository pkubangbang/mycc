/**
 * identity.ts - Identity registration + heartbeat freshness
 *
 * Each mycc instance registers itself in a centralized identity.json file at
 * ~/.mycc-store/discovery/identity.json and maintains a rolling heartbeat at
 * ~/.mycc-store/discovery/heartbeat/[session-id].json.
 *
 * Freshness rule: fresh ⟺ (remote has ≥1 heartbeat) AND
 *                              (now - remoteLatest < FRESHNESS_WINDOW_MS) AND
 *                              (remoteLatest > localOldest OR remoteLatest is recent)
 * - localOldest = local.timestamps[0] || -Infinity
 * - remoteLatest = remote.timestamps[last]
 *   (a remote with ZERO heartbeats is NOT fresh — it is not provably live;
 *    it may have crashed between register() and its first beat(). The earlier
 *    synthetic `Date.now() - 30000` fallback matched the `recent` clause on
 *    the nose and judged never-beat instances fresh indefinitely.)
 * - recent = (now - remoteLatest <= HEARTBEAT_INTERVAL_MS) — closes the
 *   startup race so a peer that started before the local instance is
 *   discovered instantly instead of after ~HEARTBEAT_INTERVAL_MS (30s).
 */

import * as fs from 'fs';
import type { IdentityEntry } from '../types.js';
import { getIdentityFile, getHeartbeatFile, getLaunchArgs, getPeerName } from '../config.js';
import { isOriginalHolderAlive, heartbeatMtimeMs } from '../utils/process-liveness.js';
import { truncateToTokens } from '../utils/token.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { withFileLock, FileLockTimeoutError } from '../utils/file-lock.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_HEARTBEATS = 3;
const MAX_BRIEFS = 3;
/** Hard cap on brief content stored in the heartbeat file (estimated tokens, for brevity). */
const MAX_BRIEF_TOKENS = 200;
/**
 * Absolute freshness window: a remote is fresh only if its latest heartbeat
 * is within this many ms of now. Without this, a dead instance whose last
 * beat was hours ago stays "fresh" forever (the relative remoteLatest >
 * localOldest check passes as long as it beat after the local oldest).
 */
const FRESHNESS_WINDOW_MS = 90_000;
/**
 * Pruning cutoff: on register(), an identity entry is a prune CANDIDATE once
 * its latest heartbeat is older than this. Age only proves the peer is
 * unhealthy, NOT that its process is gone — see {@link pruneStaleEntries},
 * which additionally requires the recorded holder to be provably dead. This
 * reclaims orphans left by instances that crashed/were SIGKILLed without
 * running peer.stop() → unregister(). Set to the same 1h the `peers` tool uses
 * to hide dead peers, so an entry is pruned exactly when it stops appearing in
 * the listing.
 */
const IDENTITY_PRUNE_CUTOFF_MS = 60 * 60 * 1000;

/**
 * A recorded brief entry, stored alongside heartbeats in the heartbeat file.
 * Surfaces an instance's recent progress to peers via the `peers` tool.
 */
export interface BriefEntry {
  time: number;
  content: string;
  confidence: number;
}

/**
 * On-disk heartbeat schema.
 *
 * Evolution: the original schema was `{ timestamps: [ts1, ts2, ts3] }`. The
 * current schema adds a `briefs` array (last {@link MAX_BRIEFS} briefs) and
 * renames `timestamps` → `heartbeats`. `readHeartbeatData` accepts BOTH
 * shapes for backward-compat with files written by older instances.
 *
 * `pid` (the recording process's OS PID) is written so peers can discover
 * how to terminate the instance — primarily for daemon mode, where the Lead
 * is a detached background process with no terminal. `pid` lives in the
 * heartbeat (not identity.json) so it stays live even across Coordinator
 * restarts and is refreshed every beat. The cron timer croner runs lives
 * INSIDE the Lead's event loop (and is `unref`'d), so killing this PID stops
 * the cron with no orphaned timer.
 */
interface HeartbeatData {
  heartbeats: number[];
  briefs: BriefEntry[];
  /** Recording process's OS PID (so peers can kill the instance). */
  pid?: number;
  /**
   * Tombstone: epoch-ms when a stop was REQUESTED for this session. Written by
   * the stopper (`mycc-stop` / `mycc-compose down`) — after identity is PROVEN,
   * before the signal — so a peer the signal did NOT reach retires itself on its
   * next beat. Lives in the heartbeat file (not identity.json) because the live
   * peer already rewrites this file every beat — see docs/peers/peer-topology.md §6.7.
   *
   * PRESERVATION IS LOAD-BEARING: every rewrite of the heartbeat file MUST carry
   * this field forward (a rewrite that dropped it would lose the tombstone on the
   * very next beat). `writeHeartbeats` and `writeBrief` therefore both preserve it.
   */
  tombstone?: number;
}

/**
 * Read identity.json and parse into a session-keyed map.
 * Returns {} if file does not exist or is malformed.
 * (Exported for the remote-wire locality check, wire-client.ts: the dialer
 * refuses same-store targets — a sid present here is a LOCAL peer already
 * reachable via discovery + channel files, docs/peers/remote-peer-protocol.md §2
 * step 1.5. Reading the same map the IdentityManager uses keeps the check
 * consistent with listIdentities.)
 */
export function readIdentityMap(): Record<string, IdentityEntry> {
  const identityFile = getIdentityFile();
  if (!fs.existsSync(identityFile)) return {};
  let parsed: unknown;
  try {
    const content = fs.readFileSync(identityFile, 'utf-8');
    parsed = JSON.parse(content);
  } catch {
    return {};
  }
  // Normalize HERE, once, at the parse boundary — every consumer of this map
  // (prune, assertNameNotLive, listIdentities, isFresh, getRemoteMailbox, and
  // the loop's todo nudge reading entry.sessionId) then sees only well-formed
  // entries and needs no per-call null guards. An entry is kept only when its
  // value is an object whose `sessionId` is a non-empty string and whose
  // `mailbox` is a string (the two fields every reader dereferences); anything
  // else is corrupt state (hand-edited file, crashed concurrent writer, or a
  // synthetic test fixture) and is dropped instead of crashing a live session.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const map: Record<string, IdentityEntry> = {};
  for (const [sid, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Partial<IdentityEntry>;
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') continue;
    if (typeof entry.mailbox !== 'string') continue;
    map[sid] = entry as IdentityEntry;
  }
  return map;
}

/**
 * Write the full identity map atomically.
 */
function writeIdentityMap(map: Record<string, IdentityEntry>): void {
  atomicWrite(getIdentityFile(), JSON.stringify(map, null, 2));
}

/**
 * Run `fn` holding the shared identity.json lock in STRICT mode, so a lock
 * timeout surfaces as {@link FileLockTimeoutError} instead of a silent unheld
 * write. On timeout we DEGRADE LOUDLY: run `fn` once, unheld, and warn — the
 * caller's read-merge-write still lands (only the lost-update protection is
 * weakened), so identity registration never crashes the agent at startup.
 *
 * This is the deliberate resolution of the strict-vs-best-effort tradeoff: the
 * lock's exclusion is honoured whenever it can be acquired; when it cannot (a
 * live holder outlasting {@link ACQUIRE_TIMEOUT_MS}, or an uncreatable lock
 * path), we prefer a noisy degraded write over aborting a live instance.
 */
function withIdentityLock<T>(fn: () => T): T {
  try {
    return withFileLock(getIdentityFile(), fn, { strict: true });
  } catch (err) {
    if (!(err instanceof FileLockTimeoutError)) throw err;
    console.warn(
      `[identity] WARNING: could not acquire the identity.json lock (${err.message}); ` +
      'proceeding WITHOUT cross-process exclusion — a concurrent register/unregister may be lost.',
    );
    return fn();
  }
}

// ============================================================================
// Session liveness predicates
// ============================================================================

/**
 * True when a session id provably belongs to a LIVE process.
 *
 * Standalone (module-level) form of the freshness rule so callers that have no
 * IdentityManager — the session bootstrap, and the `mycc-compose` repair path —
 * can ask the same question without re-deriving it. A THIRD variant of this
 * check would be a drift hazard: `IdentityManager.isFresh()`,
 * `pruneStaleEntries()` and `cleanupEmptySessions()` already touch the same
 * ground, and a disagreement silently turns a live peer into an "offline" one.
 *
 * Live ⟺ the sid is registered AND its heartbeat file has a beat newer than
 * {@link FRESHNESS_WINDOW_MS}. An instance that is registered but has never
 * beaten is NOT live — it may have crashed between register() and its first
 * beat().
 *
 * NOTE: this is the ABSOLUTE window only. `IdentityManager.isFresh()` adds a
 * relative clause (remoteLatest vs the local instance's oldest beat) that
 * needs the caller's own heartbeat, which a third-party caller does not have.
 */
export function isSessionLive(sessionId: string): boolean {
  if (!sessionId) return false;
  const map = readIdentityMap();
  if (!(sessionId in map)) return false;
  const beats = readHeartbeats(sessionId);
  if (beats.length === 0) return false;
  return Date.now() - beats[beats.length - 1] <= FRESHNESS_WINDOW_MS;
}

/**
 * Remove identity entries for instances whose latest heartbeat is older than
 * {@link IDENTITY_PRUNE_CUTOFF_MS} (1h). This reclaims orphaned entries left
 * by instances that crashed or were SIGKILLed without running unregister() —
 * without this, identity.json grows monotonically with one entry per dead
 * instance forever, bloating every readIdentityMap()/listIdentities() call.
 *
 * Safety: freshness alone is not proof of ownership release. A stale
 * heartbeat is pruned only when the recorded PID is dead or process-start
 * evidence proves that PID was recycled. Missing/conflicting PID evidence is
 * kept conservatively so a stalled-but-live peer remains discoverable and can
 * still receive a stop tombstone. A freshly-started entry with no heartbeat is
 * also preserved because it has had no chance to beat yet.
 *
 * Never removes the caller's own sessionId — guard against self-prune in case
 * the caller's heartbeat file is somehow stale during a re-register.
 *
 * @param map The identity map to prune in place.
 * @param selfSessionId The caller's own session id (always preserved).
 * @returns The number of entries removed (for logging/diagnostics).
 */
function pruneStaleEntries(map: Record<string, IdentityEntry>, selfSessionId: string): number {
  const now = Date.now();
  let removed = 0;
  for (const sid of Object.keys(map)) {
    if (sid === selfSessionId) continue; // never self-prune
    const entry = map[sid];
    const heartbeat = readHeartbeatData(sid);
    const latest = heartbeat.heartbeats;
    if (latest.length === 0) continue; // no heartbeat file yet → preserve (could be mid-startup)
    if (now - latest[latest.length - 1] <= IDENTITY_PRUNE_CUTOFF_MS) continue;

    // Heartbeat age proves that the peer is unhealthy, NOT that its process is
    // gone. Keep the entry unless the recorded holder is provably dead or the
    // PID is demonstrably recycled; otherwise a stalled live peer would become
    // undiscoverable and could no longer receive a stop tombstone.
    const heartbeatPid = typeof heartbeat.pid === 'number' ? heartbeat.pid : undefined;
    const entryPid = typeof entry?.pid === 'number' ? entry.pid : undefined;
    if (heartbeatPid !== undefined && entryPid !== undefined && heartbeatPid !== entryPid) {
      continue; // conflicting ownership evidence → preserve
    }
    const pid = heartbeatPid ?? entryPid;
    if (typeof pid !== 'number') continue; // no positive process evidence → preserve

    const evidenceTime = heartbeatPid !== undefined
      ? heartbeatMtimeMs(getHeartbeatFile(sid))
      : typeof entry?.startedAt === 'number'
        ? entry.startedAt
        : 0;
    if (isOriginalHolderAlive(pid, evidenceTime)) continue;

    delete map[sid];
    removed++;
  }
  return removed;
}

/**
 * Read the full heartbeat file (heartbeats + briefs). Accepts BOTH the
 * current schema `{ heartbeats: [...], briefs: [...] }` and the legacy
 * schema `{ timestamps: [...] }` (from older instances), migrating the
 * latter on read. Returns empty arrays if missing/malformed.
 */
function readHeartbeatData(sessionId: string): HeartbeatData {
  const hbFile = getHeartbeatFile(sessionId);
  if (!fs.existsSync(hbFile)) return { heartbeats: [], briefs: [] };
  try {
    const content = fs.readFileSync(hbFile, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    // pid: read from either schema (older files lack it → undefined).
    const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
    // tombstone: epoch-ms stop request, preserved across rewrites (§6.7).
    const tombstone = typeof parsed.tombstone === 'number' ? parsed.tombstone : undefined;
    // Legacy schema: { timestamps: number[] }
    const ts = parsed.timestamps;
    if (Array.isArray(ts)) {
      return {
        heartbeats: ts as number[],
        briefs: Array.isArray(parsed.briefs) ? (parsed.briefs as BriefEntry[]) : [],
        pid,
        ...(tombstone !== undefined ? { tombstone } : {}),
      };
    }
    // Current schema: { heartbeats: number[], briefs: BriefEntry[] }
    const hb = parsed.heartbeats;
    return {
      heartbeats: Array.isArray(hb) ? (hb as number[]) : [],
      briefs: Array.isArray(parsed.briefs) ? (parsed.briefs as BriefEntry[]) : [],
      pid,
      ...(tombstone !== undefined ? { tombstone } : {}),
    };
  } catch {
    return { heartbeats: [], briefs: [] };
  }
}

/**
 * Read a heartbeat file's heartbeat timestamps. Backward-compat: returns
 * the timestamps regardless of whether the file uses the legacy
 * `{timestamps}` or current `{heartbeats}` key. Returns [] if missing/malformed.
 */
function readHeartbeats(sessionId: string): number[] {
  return readHeartbeatData(sessionId).heartbeats;
}

/**
 * Read a heartbeat file's briefs array. Returns [] if missing/malformed.
 */
function readBriefs(sessionId: string): BriefEntry[] {
  return readHeartbeatData(sessionId).briefs;
}

/**
 * Write a heartbeat file atomically with the current schema
 * `{ heartbeats: [...], briefs: [...], pid, tombstone? }`. Preserves existing
 * briefs AND any existing tombstone (§6.7 — a rewrite that dropped the tombstone
 * would lose it on the very next beat).
 * `pid` is stamped by the caller ({@link IdentityManager} passes its own
 * `process.pid`), not read back — so a fresh beat always carries the live PID.
 */
function writeHeartbeats(sessionId: string, heartbeats: number[], pid: number): void {
  const existing = readHeartbeatData(sessionId);
  const data: HeartbeatData = {
    heartbeats,
    briefs: existing.briefs,
    pid,
    ...(existing.tombstone !== undefined ? { tombstone: existing.tombstone } : {}),
  };
  atomicWrite(getHeartbeatFile(sessionId), JSON.stringify(data, null, 2));
}

/**
 * Append a brief entry to a heartbeat file, preserving existing heartbeats AND
 * any existing tombstone. Truncates content to {@link MAX_BRIEF_TOKENS}
 * estimated tokens (via {@link truncateToTokens}) and trims to last
 * {@link MAX_BRIEFS} entries.
 */
function writeBrief(sessionId: string, entry: BriefEntry): void {
  const data = readHeartbeatData(sessionId);
  const truncated: BriefEntry = {
    time: entry.time,
    content: truncateToTokens(entry.content, MAX_BRIEF_TOKENS),
    confidence: entry.confidence,
  };
  data.briefs.push(truncated);
  data.briefs = data.briefs.slice(-MAX_BRIEFS);
  // `data` already carries the preserved tombstone from readHeartbeatData; the
  // explicit spread below documents the invariant and guards a future refactor.
  atomicWrite(
    getHeartbeatFile(sessionId),
    JSON.stringify({ ...data, ...(data.tombstone !== undefined ? { tombstone: data.tombstone } : {}) }, null, 2),
  );
}

/**
 * Read the tombstone (epoch-ms stop request) recorded in a session's heartbeat
 * file, or undefined when there is none. The stopper writes it; the peer's beat()
 * reads it to self-terminate (§6.7).
 */
export function readTombstone(sessionId: string): number | undefined {
  return readHeartbeatData(sessionId).tombstone;
}

/**
 * Stamp a tombstone (epoch-ms stop request) into a session's heartbeat file,
 * preserving its heartbeats/briefs/pid. Called by the stopper (`mycc-stop` /
 * `mycc-compose down`) — AFTER the peer's identity is PROVEN but BEFORE the
 * signal — so a peer the signal does NOT reach (or a `still-up` confirm
 * timeout) self-terminates on its next beat (§6.7). Best-effort: returns false
 * (never throws) when the file cannot be written — a tombstone is a courtesy,
 * not a guarantee; the signal path remains the primary mechanism.
 */
export function writeTombstone(sessionId: string, when: number = Date.now()): boolean {
  try {
    const existing = readHeartbeatData(sessionId);
    const data: HeartbeatData = {
      heartbeats: existing.heartbeats,
      briefs: existing.briefs,
      ...(existing.pid !== undefined ? { pid: existing.pid } : {}),
      tombstone: when,
    };
    atomicWrite(getHeartbeatFile(sessionId), JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * IdentityManager handles registration and heartbeat for the local mycc instance.
 */
export class IdentityManager {
  private sessionId: string;
  private workDir: string;
  private mailboxPath: string;
  private role?: string;
  private daemon?: boolean;
  /**
   * Stable peer handle (`<group>:<peer>`), read once at construction from the
   * `--name` launch flag. `undefined` when the instance was launched without
   * one (an ordinary interactive/daemon launch). This is the identity a
   * `mycc-compose` launcher matches on — it replaces the old pinned session id.
   */
  private name?: string;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  /**
   * Called when a tombstone is detected in this instance's own heartbeat file
   * (§6.7). Set by the owner (the Lead, via PeerManager) to run its graceful
   * teardown — IdentityManager only DETECTS; it never decides to exit the
   * process itself (that would bypass the owner's ordered cleanup: dismiss
   * team → kill bg tasks → peer.stop() → stop ServeHub → exit).
   *
   * Fires at most once even though beat() runs every 30 s. A tombstone seen by
   * a beat BEFORE a handler is registered is left PENDING (not consumed) and
   * dispatched by {@link setOnTombstone} — so a stop requested during startup
   * is not lost.
   */
  private onTombstone?: (when: number) => void;
  private tombstoneSeen = false;

  constructor(sessionId: string, workDir: string, mailboxPath: string, role?: string, daemon?: boolean) {
    this.sessionId = sessionId;
    this.workDir = workDir;
    this.mailboxPath = mailboxPath;
    this.role = role;
    this.daemon = daemon;
    // Read the peer name once (config parses argv once at module load). The
    // name is published into identity.json below so a mediator can match a live
    // peer to the requested topology by NAME, not by a churning session id.
    this.name = getPeerName() ?? undefined;
  }

  /**
   * Reject a second live registration for the same durable identity. This is
   * called INSIDE the identity-file lock immediately before register() writes,
   * so the duplicate check and claim are one atomic operation. Names are
   * globally unique, case-insensitive, and Unicode-normalized; workdir is not
   * part of uniqueness because the qualified name itself is the identity.
   */
  private assertNameNotLive(name: string): void {
    const normalizeName = (value: string): string => value.trim().normalize('NFC').toLowerCase();
    const normalizedName = normalizeName(name);
    for (const [sid, entry] of Object.entries(readIdentityMap())) {
      if (sid === this.sessionId) continue; // self (re-register) is fine
      if (typeof entry.name !== 'string' || normalizeName(entry.name) !== normalizedName) continue;

      const heartbeat = readHeartbeatData(sid);
      const beatPid = typeof heartbeat.pid === 'number' ? heartbeat.pid : undefined;
      const entryPid = typeof entry.pid === 'number' ? entry.pid : undefined;
      if (beatPid !== undefined && entryPid !== undefined && beatPid !== entryPid) {
        throw new Error(
          `[identity] refusing to guess process ownership for peer name "${name}" (session ${sid}: heartbeat PID and identity PID differ)`,
        );
      }
      const pid = beatPid ?? entryPid;
      // A stale beat means unhealthy, not unowned. Only positive evidence the
      // original process is gone frees its durable name. Missing PID evidence
      // fails closed, so launch/retry is an explicit operator decision.
      if (typeof pid === 'number' &&
          !isOriginalHolderAlive(pid, heartbeatMtimeMs(getHeartbeatFile(sid)))) {
        continue;
      }
      throw new Error(
        `[identity] refusing to start: peer name "${name}" is already held or its release cannot be proven ` +
        `(session ${sid}, pid ${pid ?? 'unknown'}). Inspect the holder, stop it, then retry.`,
      );
    }
  }

  /**
   * Register (upsert) this instance into identity.json.
   *
   * As a side effect, also prunes stale entries from other instances during
   * the read-merge-write: an entry is removed only when its latest heartbeat is
   * older than {@link IDENTITY_PRUNE_CUTOFF_MS} AND its recorded holder is
   * provably dead (see {@link pruneStaleEntries}). This reclaims orphans left
   * by instances that crashed without running unregister(), so identity.json
   * does not grow unbounded over time — without discarding a stalled-but-live
   * peer that must stay discoverable to receive a stop tombstone.
   *
   * Uses a read-merge-write loop with retries to avoid clobbering a concurrent
   * registration from another instance. Each iteration re-reads the current
   * map, prunes stale entries, merges this instance's entry, and atomically
   * writes. If another instance wrote between our read and write, our atomic
   * rename overwrites theirs — but the loop re-reads on the next iteration so
   * we eventually converge. The retry cap bounds worst-case contention.
   */
  register(): void {
    // Serialize the whole read-merge-write against every OTHER identity.json
    // writer (other instances' register/unregister, and mycc-compose's
    // repairIdentity) via a shared cross-process advisory lock. The retry loop
    // below is retained as a belt-and-suspenders convergence check (it also
    // covers a writer that ignored the lock), but the lock is what actually
    // closes the lost-update window the earlier read-verify loop only narrowed.
    withIdentityLock(() => {
      // Check uniqueness under the SAME lock as the identity write. A check in
      // the constructor would leave a TOCTOU race between simultaneous launches.
      if (this.name) this.assertNameNotLive(this.name);
      for (let attempt = 0; attempt < 5; attempt++) {
        const map = readIdentityMap();
        pruneStaleEntries(map, this.sessionId);
        map[this.sessionId] = {
          sessionId: this.sessionId,
          workDir: this.workDir,
          mailbox: this.mailboxPath,
          startedAt: Date.now(),
          // Publish the PID before the first heartbeat so another simultaneous
          // launch cannot claim this name during the startup window.
          pid: process.pid,
          // Publish the redacted launch flags so a mediator (mycc-compose) can
          // decide whether a live peer matches the requested topology, instead of
          // tearing down healthy instances on every sync.
          args: getLaunchArgs(),
          ...(this.name ? { name: this.name } : {}),
          ...(this.role ? { role: this.role } : {}),
          ...(this.daemon ? { daemon: true } : {}),
        };
        writeIdentityMap(map);
        // Re-read to verify our entry survived. Under the lock this always
        // holds on the first pass; the loop remains as defense against a
        // non-locking writer.
        const after = readIdentityMap();
        if (this.sessionId in after) {
          return; // our entry is present — done
        }
      }
      // After 5 attempts, give up (extreme contention). Last write still has our
      // entry; a concurrent writer may have lost theirs, but they will retry on
      // their own register() call.
    });
  }

  /**
   * Remove this instance from identity.json.
   */
  unregister(): void {
    withIdentityLock(() => {
      const map = readIdentityMap();
      if (this.sessionId in map) {
        delete map[this.sessionId];
        writeIdentityMap(map);
      }
    });
  }

  /**
   * List all registered identities.
   *
   * readIdentityMap() already normalizes corrupt values away at the parse
   * boundary, so no filtering is needed here.
   */
  listIdentities(): IdentityEntry[] {
    return Object.values(readIdentityMap());
  }

  /**
   * Start the heartbeat: fire once immediately, then every 30s.
   * Guard against double-start.
   */
  startHeartbeat(): void {
    if (this.intervalHandle !== null) return;
    this.beat();
    this.intervalHandle = setInterval(() => this.beat(), HEARTBEAT_INTERVAL_MS);
    // Don't keep the process alive just for heartbeats
    this.intervalHandle.unref?.();
  }

  /**
   * Stop the heartbeat. Guard against double-stop.
   */
  stopHeartbeat(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Write a single heartbeat: push Date.now(), trim to last 3, write atomically.
   * Stamps `process.pid` into the file so peers can discover a kill target
   * (primarily for daemon mode — the detached Lead has no terminal).
   *
   * TOMBSTONE CHECK (§6.7): before beating, read the file for a `tombstone`
   * stamped by a stopper (`mycc-stop` / `down`). If present, dispatch it via
   * {@link dispatchTombstone}, which fires {@link onTombstone} ONCE — but only
   * once a handler exists; a beat before registration leaves it pending. This
   * closes the case the OS signal path cannot: on Windows a signal maps to
   * TerminateProcess (no handler), and a missed signal would otherwise leave the
   * peer running — the tombstone lets it retire itself on its own timer.
   */
  private beat(): void {
    const existing = readHeartbeatData(this.sessionId);
    if (existing.tombstone !== undefined) {
      this.dispatchTombstone(existing.tombstone);
    }
    const timestamps = existing.heartbeats;
    timestamps.push(Date.now());
    const trimmed = timestamps.slice(-MAX_HEARTBEATS);
    writeHeartbeats(this.sessionId, trimmed, process.pid);
  }

  /**
   * Dispatch a pending tombstone only once a handler exists. A beat during
   * startup must not consume the request before graceful teardown is wired.
   * setOnTombstone() also checks the on-disk marker and dispatches it as soon
   * as the callback becomes available.
   */
  private dispatchTombstone(when: number): void {
    const callback = this.onTombstone;
    if (this.tombstoneSeen || !callback) return;
    this.tombstoneSeen = true;
    try {
      callback(when);
    } catch {
      // Swallow: the owner's handler is best-effort; a throw here must not
      // break the heartbeat loop.
    }
  }

  /**
   * Register the tombstone reaction (§6.7). Called by the owner (the Lead's
   * PeerManager) to run its graceful teardown when a stopper marks this
   * instance. Overwrites any previous handler.
   */
  setOnTombstone(callback: (when: number) => void): void {
    this.onTombstone = callback;
    const tombstone = readHeartbeatData(this.sessionId).tombstone;
    if (tombstone !== undefined) this.dispatchTombstone(tombstone);
  }

  /**
   * Get the tombstone (epoch-ms) recorded in this instance's own heartbeat
   * file, or undefined. Exposed mainly for tests and diagnostics.
   */
  getTombstone(): number | undefined {
    return readHeartbeatData(this.sessionId).tombstone;
  }

  /**
   * Get the local heartbeat timestamps array.
   */
  getOwnHeartbeat(): number[] {
    return readHeartbeats(this.sessionId);
  }

  /**
   * Record a brief (status update) into this instance's heartbeat file.
   * Used by the `brief` tool so the heartbeat surfaces what the instance is
   * doing — not just that it is alive. Truncates content to MAX_BRIEF_TOKENS
   * estimated tokens and keeps only the last MAX_BRIEFS entries. Preserves existing heartbeats.
   *
   * Best-effort: failures are swallowed (a brief must never break the agent
   * loop or the heartbeat subsystem).
   */
  recordBrief(message: string, confidence: number): void {
    try {
      writeBrief(this.sessionId, {
        time: Date.now(),
        content: message,
        confidence,
      });
    } catch {
      // Swallow — heartbeat/brief is best-effort.
    }
  }

  /**
   * Read a remote session's recent briefs (for the `peers` tool display).
   * Returns [] if the session has no heartbeat file or no briefs recorded.
   */
  getBriefs(sessionId: string): BriefEntry[] {
    return readBriefs(sessionId);
  }

  /**
   * Read a remote session's latest heartbeat timestamp (ms since epoch), or
   * null if it has no heartbeat file / no recorded beats. Used by the `peers`
   * tool to filter out long-stale peers (older than the listing cutoff) so the
   * listing doesn't grow unbounded with dead instances' briefs. Backward-compat:
   * reads both the legacy {timestamps} and current {heartbeats} shapes.
   */
  getLatestHeartbeat(sessionId: string): number | null {
    const ts = readHeartbeats(sessionId);
    return ts.length > 0 ? ts[ts.length - 1] : null;
  }

  /**
   * Read a remote session's OS PID from its heartbeat file, or null if the
   * session has no heartbeat file or the file predates the `pid` field.
   * Used by the `peers` tool to surface a kill target — primarily for daemon
   * mode, where the Lead is a detached background process with no terminal
   * and no PID recorded in identity.json. The cron timer croner runs lives
   * inside the Lead's event loop (and is `unref`'d), so killing this PID
   * stops the cron with no orphaned timer. Returns null on the child
   * (NoopPeerModule).
   */
  getPid(sessionId: string): number | null {
    const data = readHeartbeatData(sessionId);
    return typeof data.pid === 'number' ? data.pid : null;
  }

  /**
   * Check freshness of a remote session.
   *
   * fresh ⟺ (now - remoteLatest < FRESHNESS_WINDOW_MS) AND
   *          (remoteLatest > localOldest OR remoteLatest is recent)
   *
   * - localOldest = local.timestamps[0] || -Infinity
   *   (if local has 0 beats, no baseline → everything passes the relative check)
   * - remoteLatest = remote.timestamps[last]
   *   (a remote with ZERO heartbeats is NOT fresh — it is not provably live;
   *    it may have crashed between register() and its first beat(). The earlier
   *    synthetic `Date.now() - 30000` fallback matched the `recent` clause on
   *    the nose and judged never-beat instances fresh indefinitely.)
   * - Absolute window: a remote whose latest heartbeat is older than
   *   FRESHNESS_WINDOW_MS (90s) is NOT fresh. This prevents a dead/crashed
   *   instance from appearing fresh forever.
   * - Relative check: remoteLatest > localOldest catches a peer whose last
   *   beat predates the local instance's oldest beat (i.e. it died before
   *   the local instance started). BUT this race-fails at startup: a peer
   *   that started BEFORE the local instance has its (single) beat older
   *   than the local oldest beat, so it is wrongly marked stale until its
   *   next beat (~HEARTBEAT_INTERVAL_MS = 30s later). The `recent` clause
   *   closes that gap: a remote whose latest beat is within one heartbeat
   *   interval of now is treated as live regardless of the relative check,
   *   so a freshly-started peer is discovered instantly instead of after
   *   ~30s. The absolute window still bounds it, so a peer that just died
   *   (beat <30s ago but no longer beating) only appears fresh for up to
   *   FRESHNESS_WINDOW_MS — the same grace a relative-only check gives.
   */
  isFresh(sessionId: string): boolean {
    // 1. Check identity.json has an entry for sessionId
    const map = readIdentityMap();
    if (!(sessionId in map)) return false;

    // 2. Read remote heartbeat. A registered instance that has NEVER beaten
    //    (no heartbeat file / empty) is NOT provably live — it may have
    //    crashed/exited between register() and its first beat(). Treat it as
    //    not-fresh rather than synthesizing a fake "just started 30s ago"
    //    timestamp. (An earlier synthetic fallback `now - 30_000` was exactly
    //    HEARTBEAT_INTERVAL_MS, which the `recent` clause below matched on
    //    the nose → a never-beat instance was judged fresh indefinitely.)
    const remoteTimestamps = readHeartbeats(sessionId);
    if (remoteTimestamps.length === 0) {
      return false;
    }
    const now = Date.now();
    const remoteLatest = remoteTimestamps[remoteTimestamps.length - 1];

    // 3. Absolute freshness window: a remote whose latest heartbeat is older
    //    than FRESHNESS_WINDOW_MS is stale, regardless of the relative check.
    if (now - remoteLatest > FRESHNESS_WINDOW_MS) {
      return false;
    }

    // 4. Recent clause: a remote that has beaten within one heartbeat
    //    interval of now is live — skip the relative check. This fixes the
    //    startup race where a peer that started before the local instance
    //    has its oldest beat older than the local oldest beat and would
    //    otherwise be marked stale for ~HEARTBEAT_INTERVAL_MS (30s) until
    //    its next beat. A peer that just died stays "recent" only until
    //    its last beat ages past FRESHNESS_WINDOW_MS (handled above).
    if (now - remoteLatest <= HEARTBEAT_INTERVAL_MS) {
      return true;
    }

    // 5. Compute localOldest
    const localTimestamps = this.getOwnHeartbeat();
    const localOldest = localTimestamps.length > 0
      ? localTimestamps[0]
      : -Infinity;

    // 6. Relative check: remote's latest beat must be newer than the local
    //    oldest beat, so a peer that died before the local instance started
    //    (its last beat predates local oldest) is correctly marked stale.
    return remoteLatest > localOldest;
  }

  /**
   * Get the identity string for this instance (sessionId/lead).
   */
  getIdentityString(): string {
    return `${this.sessionId}/lead`;
  }

  /**
   * Get the local session id (so a tool can mark "self" in a peer listing).
   */
  getSelfSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the mailbox path for a remote session.
   * Returns null if session not found in identity.json.
   */
  getRemoteMailbox(sessionId: string): string | null {
    const map = readIdentityMap();
    const entry = map[sessionId];
    return entry ? entry.mailbox : null;
  }
}