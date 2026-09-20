/**
 * wiki-skill-index.ts - Skill-reindex concern for the wiki module.
 *
 * Extracted from src/context/parent/wiki.ts. Three concerns live here, all
 * dealing with re-indexing SKILLS into the wiki "skills" domain — none of them
 * is about general document storage, so they are separated from the
 * WikiManager class:
 *   - the skill-index cache (a title→content-hash snapshot under project
 *     `.mycc/` that lets an unchanged skill set skip re-embedding),
 *   - the wiki-DB-level reindex lock (an atomic lockfile that serializes
 *     re-indexing across instances, with staleness recovery and crash-time
 *     release handlers), and
 *   - {@link SkillIndexer}, which owns the batch re-index orchestration
 *     (domain registration, cache check, table diff, orphan sweep, batched
 *     embed/insert/delete, cache write) and drives the lock.
 *
 * The orchestration talks to the wiki store through the narrow
 * {@link SkillIndexBackend} surface — just the storage operations a re-index
 * needs — so this module never imports WikiManager (no cycle) and can be unit
 * tested against a fake backend. The lock keeps a single instance-scoped bit
 * (`handlersRegistered`) inside {@link ReindexLock} so the class, not the
 * caller, owns that lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SkillIndexEntry, WikiDocument, SearchResult, PutResult } from '../../types.js';
import { NAMESPACE, getEmbeddings } from '../../engine/rag-provider.js';
import {
  getWikiReindexLockFile,
  getMyccDir,
  getSessionContext,
  ensureDirs,
} from '../../config.js';
import { isReindexLockStale, releaseReindexLock } from './wiki-utils.js';

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

// ============================================================
// Skill re-index orchestration
// ============================================================

/**
 * The narrow storage surface {@link SkillIndexer} needs from the wiki store.
 * WikiManager (which implements WikiModule) satisfies this structurally, so
 * the indexer can be handed `this` without importing the class.
 */
export interface SkillIndexBackend {
  registerDomain(name: string, description?: string): Promise<void>;
  getByDomain(domain: string): Promise<SearchResult[]>;
  delete(hash: string): Promise<boolean>;
  batchPut(entries: Array<{ document: WikiDocument; embedding: number[] }>): Promise<PutResult[]>;
}

/**
 * SkillIndexer - owns the wiki-DB-level re-index of skills.
 *
 * Re-index a set of skills into the wiki "skills" domain. The caller
 * (loader) builds the {@link SkillIndexEntry} array — it owns skill discovery
 * and scoping (the scope-prefixed title + Scope/Name/Description/Keywords
 * content + content hash). This class owns the wiki-DB re-index:
 *  1. Register the "skills" domain.
 *  2. Cache check — if every entry's content hash matches the on-disk
 *     snapshot (and the RAG namespace is unchanged), skip entirely.
 *  3. Acquire the wiki-DB-level reindex lock. If another live instance is
 *     re-indexing, skip — the caller's watcher will fire again or its next
 *     skill_load catches it up.
 *  4. Batch path (under the lock): one table scan (getByDomain, 0
 *     embeddings), an in-memory diff, ONE batched embedding call for
 *     changed/new skills, batch delete of stale records, ONE batchPut
 *     insert, then write the cache.
 *
 * The lock is acquired and released INSIDE {@link index} (try/finally), so no
 * caller needs to know about the lock — all re-index entry points are
 * serialized by calling this single method.
 *
 * Optimized to avoid the per-skill Ollama round-trips that previously made
 * this step block startup.
 */
export class SkillIndexer {
  /** Serializes skill re-indexing across instances (see ReindexLock). */
  private readonly reindexLock: ReindexLock;

  constructor(
    private readonly backend: SkillIndexBackend,
    private readonly log: (message: string) => void,
  ) {
    this.reindexLock = new ReindexLock(log);
  }

  async index(entries: SkillIndexEntry[], options?: { skipOrphanSweep?: boolean }): Promise<void> {
    const skipOrphanSweep = options?.skipOrphanSweep === true;

    // 1. Register 'skills' domain
    await this.backend.registerDomain('skills', 'Skills indexed for semantic matching');

    // 2. Cache check — skip the whole pass if nothing changed.
    //    Only valid for a FULL re-index: the cache snapshots the complete
    //    skill set (title→hash), so a length mismatch with a PARTIAL entry
    //    list (skipOrphanSweep) is expected and must NOT short-circuit.
    if (!skipOrphanSweep && isSkillIndexCacheValid(entries)) {
      this.log(`Indexed ${entries.length} skills (cached)`);
      return;
    }

    // 3. Acquire the reindex lock. If another live instance is re-indexing,
    //    skip — the cache check will still skip next time if that instance
    //    finished, and a missed fs.watch event is caught by the next
    //    skill_load (per-skill re-index, a lighter path that doesn't need
    //    this lock).
    if (!this.reindexLock.acquire()) {
      this.log('Reindex skipped: another instance is reindexing');
      return;
    }
    try {
      // 4. Batch path — one table scan for all existing 'skills' records.
      const existing = await this.backend.getByDomain('skills');
      const existingByTitle = new Map<string, { hash: string; content: string }>();
      for (const r of existing) {
        existingByTitle.set(r.document.title, { hash: r.hash, content: r.document.content });
      }

      // In-memory diff: partition into unchanged / stale / new
      const toDelete: string[] = [];
      const toAdd: WikiDocument[] = [];
      for (const { document } of entries) {
        const found = existingByTitle.get(document.title);
        if (found && found.content === document.content) {
          continue; // unchanged
        }
        if (found) {
          toDelete.push(found.hash); // content changed → delete old before re-add
        }
        toAdd.push(document);
      }
      // Detect orphaned existing records (titles no longer present) and delete them.
      //
      // IMPORTANT: the wiki DB is shared across ALL projects (it lives in
      // ~/.mycc-store/wiki, not under the project). Skill record titles are
      // prefixed with their scope — `[user]:`, `[built-in]:`, or
      // `<project-basename>:`. A record written by project A therefore has a
      // title prefix project B cannot match, so it must NOT be treated as an
      // orphan by project B — otherwise two projects would mutually wipe each
      // other's project-scoped skill records on every startup.
      //
      // Only records whose title prefix is in THIS project's own scope set
      // ([user], [built-in], and the current project basename) are eligible
      // for orphan deletion. Records from other projects are left untouched.
      //
      // SKIPPED on a PARTIAL re-index (skipOrphanSweep): `entries` may be a
      // subset of all loaded skills (e.g. skill_load re-indexes just the one
      // skill it loaded). Sweeping orphans against a subset would delete
      // every unmentioned own-scope sibling. Only a FULL re-index (startup,
      // /skills build, the skill_reindex IPC handler) runs the sweep, since
      // only then is `entries` the complete current set and an absent title a
      // genuine orphan (the skill was actually deleted). The changed/new
      // upsert above always runs regardless.
      if (!skipOrphanSweep) {
        const projectName = path.basename(process.cwd());
        const ownScopePrefixes = new Set(['[user]:', '[built-in]:', `${projectName}:`]);
        const isOwnScope = (title: string): boolean => {
          for (const prefix of ownScopePrefixes) {
            if (title.startsWith(prefix)) return true;
          }
          return false;
        };
        const currentTitles = new Set(entries.map((e) => e.document.title));
        for (const [title, rec] of existingByTitle) {
          if (currentTitles.has(title)) continue; // still present
          if (!isOwnScope(title)) continue; // belongs to another project — leave it
          toDelete.push(rec.hash);
        }
      }

      // Batch embed all new/changed documents in ONE Ollama call
      let embeddings: number[][] = [];
      if (toAdd.length > 0) {
        embeddings = await getEmbeddings(
          toAdd.map((d) => d.content),
          'document',
        );
      }

      // Batch delete stale/orphaned records
      for (const hash of toDelete) {
        await this.backend.delete(hash);
      }

      // Batch insert all new/changed documents in ONE table.add() call
      if (toAdd.length > 0) {
        const batchEntries = toAdd.map((document, i) => ({ document, embedding: embeddings[i] }));
        await this.backend.batchPut(batchEntries);
      }

      // Write the cache so the next startup can skip if nothing changed.
      // Only a FULL re-index may rewrite the cache — the cache snapshots the
      // COMPLETE skill set, so a partial (skipOrphanSweep) call writing its
      // subset would corrupt the cache (next full startup would miss it,
      // forcing a needless re-embed, and worse, the length-only check could
      // false-pass on a coincidentally-sized subset).
      if (!skipOrphanSweep) {
        writeSkillIndexCache(entries);
      }

      // Partial re-index (skill_load): the diff already ran against the
      // existing record. If nothing changed (no add, no delete), there was
      // no embedding call and no DB mutation — the generic "Indexed N
      // skills" log would be misleading (it implies work was done). Stay
      // silent in that case; only log when the skill was actually added or
      // updated.
      if (skipOrphanSweep && toAdd.length === 0 && toDelete.length === 0) {
        return;
      }

      this.log(`Indexed ${entries.length} skills`);
    } finally {
      releaseReindexLock();
    }
  }
}
