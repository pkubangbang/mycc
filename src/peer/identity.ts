/**
 * identity.ts - Identity registration + heartbeat freshness
 *
 * Each mycc instance registers itself in a centralized identity.json file at
 * ~/.mycc-store/discovery/identity.json and maintains a rolling heartbeat at
 * ~/.mycc-store/discovery/heartbeat/[session-id].json.
 *
 * Freshness rule: fresh ⟺ remoteLatest > localOldest
 * - localOldest = local.timestamps[0] || -Infinity
 * - remoteLatest = remote.timestamps[last] || (Date.now() - 30000)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IdentityEntry } from '../types.js';
import { getIdentityFile, getHeartbeatFile } from '../config.js';
import { truncateToTokens } from '../utils/token.js';

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
 * Atomic file write: write to temp file then rename.
 * Matches the WAL-safe pattern used elsewhere in the codebase.
 */
function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

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
 */
function readIdentityMap(): Record<string, IdentityEntry> {
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
    for (let attempt = 0; attempt < 5; attempt++) {
      const map = readIdentityMap();
      pruneStaleEntries(map, this.sessionId);
      map[this.sessionId] = {
        sessionId: this.sessionId,
        workDir: this.workDir,
        mailbox: this.mailboxPath,
        startedAt: Date.now(),
        ...(this.role ? { role: this.role } : {}),
        ...(this.daemon ? { daemon: true } : {}),
      };
      writeIdentityMap(map);
      // Re-read to verify our entry survived (no clobber by a concurrent write).
      // If another instance wrote after us but before this verify, their entry
      // is missing from what we just wrote — re-loop to merge both.
      const after = readIdentityMap();
      if (this.sessionId in after) {
        return; // our entry is present — done
      }
    }
    // After 5 attempts, give up (extreme contention). Last write still has our
    // entry; a concurrent writer may have lost theirs, but they will retry on
    // their own register() call.
  }

  /**
   * Remove this instance from identity.json.
   */
  unregister(): void {
    const map = readIdentityMap();
    if (this.sessionId in map) {
      delete map[this.sessionId];
      writeIdentityMap(map);
    }
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
   * fresh ⟺ (remoteLatest > localOldest) AND (now - remoteLatest < FRESHNESS_WINDOW_MS)
   *
   * - localOldest = local.timestamps[0] || -Infinity
   *   (if local has 0 beats, no baseline → everything passes the relative check)
   * - remoteLatest = remote.timestamps[last] || (Date.now() - 30_000)
   *   (if remote has 0 beats but is registered, assume it just started 30s ago)
   * - Absolute window: even if the relative check passes, a remote whose
   *   latest heartbeat is older than FRESHNESS_WINDOW_MS (90s) is NOT fresh.
   *   This prevents a dead/crashed instance from appearing fresh forever
   *   (its last beat stays "after local oldest" indefinitely).
   */
  isFresh(sessionId: string): boolean {
    // 1. Check identity.json has an entry for sessionId
    const map = readIdentityMap();
    if (!(sessionId in map)) return false;

    // 2. Read remote heartbeat
    const remoteTimestamps = readHeartbeats(sessionId);
    const remoteLatest = remoteTimestamps.length > 0
      ? remoteTimestamps[remoteTimestamps.length - 1]
      : Date.now() - 30_000;

    // 3. Absolute freshness window: a remote whose latest heartbeat is older
    //    than FRESHNESS_WINDOW_MS is stale, regardless of the relative check.
    if (Date.now() - remoteLatest > FRESHNESS_WINDOW_MS) {
      return false;
    }

    // 4. Compute localOldest
    const localTimestamps = this.getOwnHeartbeat();
    const localOldest = localTimestamps.length > 0
      ? localTimestamps[0]
      : -Infinity;

    // 5. Relative check
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