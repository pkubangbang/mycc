/**
 * wiki-skill-index.ts - Skill-index cache + wiki-DB reindex lock.
 *
 * Extracted from src/context/parent/wiki.ts. Two concerns live here:
 *   - the skill-index cache (a title→content-hash snapshot under project
 *     `.mycc/` that lets an unchanged skill set skip re-embedding), and
 *   - the wiki-DB-level reindex lock (an atomic lockfile that serializes
 *     re-indexing across instances, with staleness recovery and crash-time
 *     release handlers).
 *
 * Both are stateless w.r.t. the wiki table, so they are separated from the
 * WikiManager class. The lock keeps a single instance-scoped bit
 * (`handlersRegistered`) inside {@link ReindexLock} so the class, not the
 * caller, owns that lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SkillIndexEntry } from '../../types.js';
import { NAMESPACE } from '../../engine/rag-provider.js';
import {
  getWikiReindexLockFile,
  getMyccDir,
  getSessionContext,
  ensureDirs,
} from '../../config.js';
import { isReindexLockStale } from './wiki-utils.js';

// ============================================================
// Skill-index cache
// ============================================================

/**
 * Path to the skill-index cache file (under project .mycc/, gitignored).
 * The cache stores a snapshot of every indexed skill's title→content hash
 * plus the RAG namespace, so unchanged skills can be skipped on restart.
 */
export function getSkillIndexCachePath(): string {
  return path.join(getMyccDir(), 'skill-index-cache.json');
}

/**
 * Read the on-disk skill-index cache and return whether it covers every
 * current skill with a matching content hash, under the same RAG namespace.
 */
export function isSkillIndexCacheValid(entries: SkillIndexEntry[]): boolean {
  const cachePath = getSkillIndexCachePath();
  if (!fs.existsSync(cachePath)) return false;

  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(raw) as {
      namespace?: string;
      skills?: Record<string, string>;
    };

    // Namespace change (embedding model swap) invalidates the cache —
    // vectors live in a different LanceDB table.
    if (cache.namespace !== NAMESPACE) return false;
    if (!cache.skills) return false;

    // Every current skill must be present with a matching content hash
    const cached = cache.skills;
    if (Object.keys(cached).length !== entries.length) return false;
    for (const { document, contentHash } of entries) {
      if (cached[document.title] !== contentHash) return false;
    }
    return true;
  } catch {
    return false; // corrupt cache → treat as miss
  }
}

/**
 * Persist the skill-index cache snapshot to disk. Failure is non-fatal.
 */
export function writeSkillIndexCache(entries: SkillIndexEntry[]): void {
  try {
    ensureDirs();
    const cachePath = getSkillIndexCachePath();
    const skills: Record<string, string> = {};
    for (const { document, contentHash } of entries) {
      skills[document.title] = contentHash;
    }
    const cache = { namespace: NAMESPACE, skills };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // Cache write failure is non-fatal — indexing already succeeded.
  }
}

// ============================================================
// Reindex lock
// ============================================================

/**
 * Try to acquire the wiki-DB-level reindex lock
 * (`~/.mycc-store/wiki/reindex.lock`).
 *
 * Acquire logic:
 *  1. `fs.openSync(lockPath, 'wx')` — atomic create-if-not-exists. On
 *     success, write my `{sessionId, pid, startedAt, namespace}` and
 *     return true.
 *  2. On EEXIST: read the file.
 *     - namespace mismatch (embedding model changed) → steal (overwrite).
 *     - holder's session is stale (no fresh heartbeat, or PID is dead)
 *       → steal.
 *     - holder is fresh (alive, same namespace) → skip (return false).
 *  3. On any read/parse error → treat as stale (steal) — a corrupt lock
 *     is useless.
 *
 * Returns true if this instance now holds the lock, false if another live
 * instance is re-indexing.
 *
 * `onWarn` receives best-effort diagnostics (acquire/steal errors) so the
 * caller can route them to its own logger without the lock importing Core.
 */
export class ReindexLock {
  /** One-shot crash handlers registered once per instance. SIGKILL leaves a
   *  stale lock, recovered by the freshness check on the next acquire. */
  private handlersRegistered = false;

  constructor(private readonly onWarn?: (message: string) => void) {}

  /**
   * Register one-shot SIGINT/SIGTERM handlers that release the lock on
   * crash. Idempotent (registered once per process). Best-effort: SIGKILL
   * bypasses these, leaving a stale lock recovered by the next acquire's
   * freshness check.
   */
  private registerCrashHandlers(): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;
    const release = () => {
      try { fs.unlinkSync(getWikiReindexLockFile()); } catch { /* best-effort */ }
    };
    process.once('SIGINT', () => { release(); process.exit(0); });
    process.once('SIGTERM', () => { release(); process.exit(0); });
  }

  /**
   * Overwrite the lockfile with our info (steal a stale/corrupt/foreign
   * lock). Best-effort; a concurrent steal by another instance is harmless
   * (last writer wins, and the loser's freshness check will skip next tick).
   */
  private steal(lockPath: string, myInfo: object): void {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(myInfo), 'utf-8');
      this.registerCrashHandlers();
    } catch {
      this.onWarn?.('Reindex lock steal write failed — will retry next tick');
    }
  }

  acquire(): boolean {
    const lockPath = getWikiReindexLockFile();
    const myInfo = {
      sessionId: getSessionContext(),
      pid: process.pid,
      startedAt: Date.now(),
      namespace: NAMESPACE,
    };

    // 1. Atomic create-if-not-exists.
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify(myInfo));
      fs.closeSync(fd);
      this.registerCrashHandlers();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Unexpected error (e.g. permission denied) — can't acquire. Skip
        // rather than risk concurrent writes.
        this.onWarn?.(`Reindex lock acquire error: ${(err as Error).message}`);
        return false;
      }
    }

    // 2. Lock exists — inspect the holder.
    let holder: { sessionId?: string; pid?: number; startedAt?: number; namespace?: string };
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch {
      // Corrupt lock — steal it.
      this.steal(lockPath, myInfo);
      return true;
    }

    // 2a. Namespace mismatch (embedding model swapped) → invalidate.
    if (holder.namespace !== NAMESPACE) {
      this.steal(lockPath, myInfo);
      return true;
    }

    // 2b. Stale holder? Check heartbeat freshness + PID liveness.
    if (isReindexLockStale(holder)) {
      this.steal(lockPath, myInfo);
      return true;
    }

    // 2c. Holder is fresh and same namespace — another live instance is
    // re-indexing. Skip.
    return false;
  }
}
