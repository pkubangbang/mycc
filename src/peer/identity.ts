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

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_HEARTBEATS = 3;

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
 * Read a heartbeat file. Returns [] if missing or malformed.
 */
function readHeartbeats(sessionId: string): number[] {
  const hbFile = getHeartbeatFile(sessionId);
  if (!fs.existsSync(hbFile)) return [];
  try {
    const content = fs.readFileSync(hbFile, 'utf-8');
    const parsed = JSON.parse(content) as { timestamps: number[] };
    return Array.isArray(parsed.timestamps) ? parsed.timestamps : [];
  } catch {
    return [];
  }
}

/**
 * Write a heartbeat file atomically.
 */
function writeHeartbeats(sessionId: string, timestamps: number[]): void {
  atomicWrite(getHeartbeatFile(sessionId), JSON.stringify({ timestamps }, null, 2));
}

/**
 * IdentityManager handles registration and heartbeat for the local mycc instance.
 */
export class IdentityManager {
  private sessionId: string;
  private workDir: string;
  private mailboxPath: string;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(sessionId: string, workDir: string, mailboxPath: string) {
    this.sessionId = sessionId;
    this.workDir = workDir;
    this.mailboxPath = mailboxPath;
  }

  /**
   * Register (upsert) this instance into identity.json.
   */
  register(): void {
    const map = readIdentityMap();
    map[this.sessionId] = {
      sessionId: this.sessionId,
      workDir: this.workDir,
      mailbox: this.mailboxPath,
      startedAt: Date.now(),
    };
    writeIdentityMap(map);
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
   */
  private beat(): void {
    const timestamps = readHeartbeats(this.sessionId);
    timestamps.push(Date.now());
    const trimmed = timestamps.slice(-MAX_HEARTBEATS);
    writeHeartbeats(this.sessionId, trimmed);
  }

  /**
   * Get the local heartbeat timestamps array.
   */
  getOwnHeartbeat(): number[] {
    return readHeartbeats(this.sessionId);
  }

  /**
   * Check freshness of a remote session.
   *
   * fresh ⟺ remoteLatest > localOldest
   *
   * - localOldest = local.timestamps[0] || -Infinity
   *   (if local has 0 beats, no baseline → everything is fresh)
   * - remoteLatest = remote.timestamps[last] || (Date.now() - 30000)
   *   (if remote has 0 beats but is registered, assume it just started 30s ago)
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

    // 3. Compute localOldest
    const localTimestamps = this.getOwnHeartbeat();
    const localOldest = localTimestamps.length > 0
      ? localTimestamps[0]
      : -Infinity;

    // 4. Compare
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