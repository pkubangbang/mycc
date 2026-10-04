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
import * as path from 'path';
import type { IdentityEntry } from '../types.js';
import { getDiscoveryDir, getIdentityFile, getHeartbeatFile, getLaunchArgs } from '../config.js';
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
 * Pruning cutoff: on register(), identity entries whose latest heartbeat is
 * older than this are removed from identity.json. This reclaims orphans left
 * by instances that crashed/were SIGKILLed without running peer.stop() →
 * unregister(). Set to the same 1h the `peers` tool uses to hide dead peers,
 * so an entry is pruned exactly when it stops appearing in the listing.
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
}

/**
 * Read identity.json and parse into a session-keyed map.
 * Returns {} if file does not exist or is malformed.
 * (Exported for the remote-wire locality check, wire-client.ts: the dialer
 * refuses same-store targets — a sid present here is a LOCAL peer already
 * reachable via discovery + channel files, docs/remote-peer-protocol.md §2
 * step 1.5. Reading the same map the IdentityManager uses keeps the check
 * consistent with listIdentities.)
 */
export function readIdentityMap(): Record<string, IdentityEntry> {
  const identityFile = getIdentityFile();
  if (!fs.existsSync(identityFile)) return {};
  try {
    const content = fs.readFileSync(identityFile, 'utf-8');
    return JSON.parse(content) as Record<string, IdentityEntry>;
  } catch {
    return {};
  }
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
// Session ownership lease (atomic pinned-sid claim)
// ============================================================================

/**
 * Path of the per-session ownership LEASE (a lock file). Lives beside the other
 * discovery state so it shares a volume with identity.json/heartbeats and is
 * visible to every instance on the machine:
 *   ~/.mycc-store/discovery/sessions/<sid>.owner
 *
 * CONTENT: JSON `{ pid, sid, time }` — written by the claimant so a later
 * acquirer can tell a live owner from a crashed one.
 */
export function getSessionOwnerLeaseFile(sessionId: string): string {
  return path.join(getDiscoveryDir(), 'sessions', `${sessionId}.owner`);
}

/** Lease payload — the claimant's identity, for liveness-based reclaim. */
interface SessionOwnerLease {
  pid?: number;
  sid?: string;
  time?: number;
}

/**
 * Try to atomically CLAIM ownership of a pinned session id.
 *
 * WHY THIS EXISTS (the TOCTOU it closes): `initializeSession()` used to ask
 * "is this sid held?" and then create the session files — two SEPARATE steps.
 * Two `mycc-compose up` runs (or two `mycc --session-id <sid>`) racing the same
 * sid could both pass the check before either registered, then both boot under
 * one sid: same session dir, same heartbeat file, same mailbox, same channel
 * identity — and the last `register()` would win the identity record, so
 * `stopPeer()` could later target only one of the two live processes.
 *
 * The fix is to make CHECK AND CLAIM ONE ATOMIC OPERATION. `open(..., 'wx')`
 * is that operation: the OS guarantees exactly one creator of the lease file.
 * The liveness decision therefore happens AFTER winning the create — we are the
 * creator, so we may inspect the PREVIOUS owner's lease (carried forward by the
 * caller as `previousOwner` is NOT needed: on EEXIST we lost, on success we won
 * and any prior lease was already removed by a dead-owner reclaimer).
 *
 * Flow:
 *   1. `openSync(lease, 'wx')` — the atomic claim.
 *   2. Success → we own it. Write `{pid, sid, time}`. Return 'claimed'.
 *      (Best-effort content write: even if it fails, the file's mere existence
 *      is the claim; a later acquirer treats a content-less lease as stale
 *      after a grace window.)
 *   3. EEXIST → someone holds the lease. Read it:
 *        - owner pid ALIVE  → 'held'   (refuse to start a second instance).
 *        - owner pid DEAD / lease older than the stale window / unreadable →
 *          the holder crashed without releasing; remove the lease and retry
 *          the atomic create ONCE (the retry's `open('wx')` re-races any
 *          concurrent reclaimer, so still exactly one winner).
 *
 * @param sessionId The pinned session id being claimed.
 * @returns 'claimed' when this process now owns the sid; 'held' when a live
 *          process already does. Never throws for ordinary contention; on an
 *          unexpected fs error it returns 'held' (fail closed — refusing to
 *          start is always safer than double-booting a sid).
 */
export function claimSessionOwnership(sessionId: string): 'claimed' | 'held' {
  if (!sessionId) return 'held';
  const lease = getSessionOwnerLeaseFile(sessionId);
  try {
    fs.mkdirSync(path.dirname(lease), { recursive: true });
  } catch {
    // Directory creation failure → the open below will surface it; fail closed.
    return 'held';
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lease, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return 'held';
      // Lease exists — decide live vs stale.
      if (!isLeaseStale(lease)) return 'held';
      // Stale (crashed owner): remove and retry the atomic create once.
      try {
        fs.unlinkSync(lease);
      } catch {
        // Someone else may have reclaimed it in the same instant — retry.
      }
      continue;
    }
    // We created the lease → we are the owner.
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, sid: sessionId, time: Date.now() }));
    } catch {
      // Content is advisory only; the file's existence is the claim.
    } finally {
      fs.closeSync(fd);
    }
    return 'claimed';
  }
  return 'held';
}

/**
 * True when a session-lease file names no live owner — its recorded pid is
 * dead, or the lease is older than {@link SESSION_LEASE_STALE_MS} (covers a
 * crash between the atomic create and the content write), or it cannot be read
 * at all.
 */
function isLeaseStale(lease: string): boolean {
  try {
    const raw = fs.readFileSync(lease, 'utf-8');
    let parsed: SessionOwnerLease = {};
    try {
      parsed = JSON.parse(raw) as SessionOwnerLease;
    } catch {
      // Unparsable (partial write) — fall through to the mtime check.
    }
    if (typeof parsed.pid === 'number') {
      return !isPidAlive(parsed.pid);
    }
    // No pid recorded: use the file's mtime against the stale window.
    const st = fs.statSync(lease);
    return Date.now() - st.mtimeMs > SESSION_LEASE_STALE_MS;
  } catch {
    // Vanished between exists and read → treat as free (the retry will race it).
    return true;
  }
}

/** Grace before a pid-less lease is considered abandoned. */
const SESSION_LEASE_STALE_MS = 10_000;

/**
 * Release a session ownership lease (called on clean shutdown). Best-effort:
 * a failure leaves the lease for the stale-reclaim path, never throws.
 */
export function releaseSessionOwnership(sessionId: string): void {
  if (!sessionId) return;
  try {
    fs.unlinkSync(getSessionOwnerLeaseFile(sessionId));
  } catch {
    // Already gone / never held — nothing to do.
  }
}

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
 * True when a session id is HELD by a still-running process — the stricter
 * sibling of {@link isSessionLive}.
 *
 * {@link isSessionLive} answers "has this sid beaten recently?", which is
 * necessary but NOT sufficient: a process killed within the freshness window
 * (e.g. `mycc-compose sync` restarting a crashed peer) leaves a heartbeat file
 * that is still "fresh" for up to {@link FRESHNESS_WINDOW_MS}. Using that
 * predicate to gate a re-pin would make a just-killed peer refuse its own
 * restart — the exact dead-lock `mycc-compose` hit.
 *
 * Held ⟺ registered AND fresh heartbeat AND the recorded heartbeat `pid` is
 * actually alive. When no pid is recorded (legacy writers, or a beat that
 * predates the field) we fall back to the fresh-heartbeat verdict: we cannot
 * disprove liveness, and must not let two instances share one session dir.
 *
 * Used by the session bootstrap's `--session-id` guard, and mirrored by
 * `mycc-compose`'s `isPeerRunning()`.
 */
export function isSessionHeld(sessionId: string): boolean {
  if (!sessionId) return false;
  if (!isSessionLive(sessionId)) return false;
  const { pid } = readHeartbeatData(sessionId);
  if (typeof pid !== 'number') return true; // no pid recorded → trust freshness
  return isPidAlive(pid);
}

/**
 * Best-effort "is this OS pid alive?" check. `process.kill(pid, 0)` sends no
 * signal but throws ESRCH when the pid does not exist; EPERM means it exists
 * but is owned by another user (treat as alive).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Remove identity entries for instances whose latest heartbeat is older than
 * {@link IDENTITY_PRUNE_CUTOFF_MS} (1h). This reclaims orphaned entries left
 * by instances that crashed or were SIGKILLed without running unregister() —
 * without this, identity.json grows monotonically with one entry per dead
 * instance forever, bloating every readIdentityMap()/listIdentities() call.
 *
 * Safety: a live instance beats every 30s (HEARTBEAT_INTERVAL_MS), so its
 * latest heartbeat is always within the cutoff and it is never pruned. A
 * freshly-started instance whose heartbeat file does not exist yet (but which
 * is registered in the map) is also preserved — it has had no chance to beat
 * yet, and pruning it would race its own register(). Only entries with a
 * heartbeat file showing a beat older than the cutoff are removed.
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
    const latest = readHeartbeats(sid);
    if (latest.length === 0) continue; // no heartbeat file yet → preserve (could be mid-startup)
    if (now - latest[latest.length - 1] > IDENTITY_PRUNE_CUTOFF_MS) {
      delete map[sid];
      removed++;
    }
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
    // Legacy schema: { timestamps: number[] }
    const ts = parsed.timestamps;
    if (Array.isArray(ts)) {
      return {
        heartbeats: ts as number[],
        briefs: Array.isArray(parsed.briefs) ? (parsed.briefs as BriefEntry[]) : [],
        pid,
      };
    }
    // Current schema: { heartbeats: number[], briefs: BriefEntry[] }
    const hb = parsed.heartbeats;
    return {
      heartbeats: Array.isArray(hb) ? (hb as number[]) : [],
      briefs: Array.isArray(parsed.briefs) ? (parsed.briefs as BriefEntry[]) : [],
      pid,
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
 * `{ heartbeats: [...], briefs: [...], pid }`. Preserves existing briefs.
 * `pid` is stamped by the caller ({@link IdentityManager} passes its own
 * `process.pid`), not read back — so a fresh beat always carries the live PID.
 */
function writeHeartbeats(sessionId: string, heartbeats: number[], pid: number): void {
  const data: HeartbeatData = {
    heartbeats,
    briefs: readBriefs(sessionId),
    pid,
  };
  atomicWrite(getHeartbeatFile(sessionId), JSON.stringify(data, null, 2));
}

/**
 * Append a brief entry to a heartbeat file, preserving existing heartbeats.
 * Truncates content to {@link MAX_BRIEF_TOKENS} estimated tokens (via
 * {@link truncateToTokens}) and trims to last {@link MAX_BRIEFS} entries.
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
  atomicWrite(getHeartbeatFile(sessionId), JSON.stringify(data, null, 2));
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
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(sessionId: string, workDir: string, mailboxPath: string, role?: string, daemon?: boolean) {
    this.sessionId = sessionId;
    this.workDir = workDir;
    this.mailboxPath = mailboxPath;
    this.role = role;
    this.daemon = daemon;
  }

  /**
   * Register (upsert) this instance into identity.json.
   *
   * As a side effect, also prunes stale entries from other instances: any
   * identity whose latest heartbeat is older than {@link IDENTITY_PRUNE_CUTOFF_MS}
   * is removed during the read-merge-write. This reclaims orphans left by
   * instances that crashed without running unregister(), so identity.json does
   * not grow unbounded over time.
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
      for (let attempt = 0; attempt < 5; attempt++) {
        const map = readIdentityMap();
        pruneStaleEntries(map, this.sessionId);
        map[this.sessionId] = {
          sessionId: this.sessionId,
          workDir: this.workDir,
          mailbox: this.mailboxPath,
          startedAt: Date.now(),
          // Publish the redacted launch flags so a mediator (mycc-compose) can
          // decide whether a live peer matches the requested topology, instead of
          // tearing down healthy instances on every sync.
          args: getLaunchArgs(),
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
   */
  listIdentities(): IdentityEntry[] {
    const map = readIdentityMap();
    return Object.values(map);
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
   */
  private beat(): void {
    const timestamps = readHeartbeats(this.sessionId);
    timestamps.push(Date.now());
    const trimmed = timestamps.slice(-MAX_HEARTBEATS);
    writeHeartbeats(this.sessionId, trimmed, process.pid);
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