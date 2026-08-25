/**
 * wiki.ts - WikiManager for persistent memory
 *
 * Manages knowledge storage using LanceDB for vector similarity search.
 * Uses WAL files for audit and rebuild capabilities.
 */

import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  WikiModule,
  WikiDocument,
  WikiDomain,
  PrepareResult,
  PutResult,
  GetOptions,
  SearchResult,
  WALEntry,
  RebuildResult,
  CoreModule,
  SkillIndexEntry,
} from '../../types.js';
import { getEmbedding, getEmbeddings, EMBEDDING_DIM, NAMESPACE } from '../../engine/rag-provider.js';
import { getWikiLogsDir, getWikiDbDir, getWikiDomainsFile, getWikiReindexLockFile, getHeartbeatFile, ensureDirs, getMyccDir, getSessionContext } from '../../config.js';

const DUPLICATE_THRESHOLD = 0.95;
const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 1000;

// Hash is first 16 chars of SHA-256 hex digest
const HASH_PATTERN = /^[a-f0-9]{16}$/;

/**
 * WikiManager - Manages persistent knowledge storage
 */
export class WikiManager implements WikiModule {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private core: CoreModule;
  private tableName = `wiki_${NAMESPACE}`;
  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Initialize the database connection
   */
  private async initDb(): Promise<void> {
    if (this.db && this.table) return;

    ensureDirs();
    const dbPath = getWikiDbDir();

    this.db = await lancedb.connect(dbPath);

    // Check if table exists
    const tables = await this.db.tableNames();
    if (tables.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);
    } else {
      // Create table with initial empty schema
      // LanceDB needs at least one record to create a table
      const initialRecord: Record<string, unknown> = {
        hash: '__schema__',
        domain: '',
        title: '',
        content: '',
        references: '[]',
        embedding: new Array(EMBEDDING_DIM).fill(0),
        createdAt: new Date().toISOString(),
      };
      this.table = await this.db.createTable(this.tableName, [initialRecord]);
    }
  }

  // ============================================================
  // Skill Re-index (wiki-DB-level) — moved here from loader.ts
  // ============================================================

  /**
   * Freshness window for the reindex lock — mirrors FRESHNESS_WINDOW_MS in
   * src/peer/identity.ts (90s). A lock holder whose latest heartbeat is
   * older than this is considered stale (crashed without releasing) and the
   * lock may be stolen.
   */
  private static readonly REINDEX_FRESHNESS_MS = 90_000;

  /**
   * One-shot crash handlers so a SIGINT/SIGTERM during a reindex still
   * releases the lock. Registered on first acquire. SIGKILL leaves a stale
   * lock, which the freshness check on the next acquire recovers from.
   */
  private reindexLockHandlersRegistered = false;

  /**
   * Re-index a set of skills into the wiki "skills" domain.
   *
   * The caller (loader) builds the {@link SkillIndexEntry} array — it owns
   * skill discovery and scoping (the scope-prefixed title + Scope/Name/
   * Description/Keywords content + content hash). This method owns the
   * wiki-DB re-index:
   *  1. Register the "skills" domain.
   *  2. Cache check — if every entry's content hash matches the on-disk
   *     snapshot (and the RAG namespace is unchanged), skip entirely.
   *  3. Acquire the wiki-DB-level reindex lock (see {@link acquireReindexLock}).
   *     If another live instance is re-indexing, skip — the caller's watcher
   *     will fire again or its next skill_load catches it up.
   *  4. Batch path (under the lock): one table scan (getByDomain, 0
   *     embeddings), an in-memory diff, ONE batched embedding call for
   *     changed/new skills, batch delete of stale records, ONE batchPut
   *     insert, then write the cache.
   *
   * The lock is acquired and released INSIDE this method (try/finally), so
   * no caller needs to know about the lock — all re-index entry points are
   * serialized by calling this single method.
   *
   * Optimized to avoid the per-skill Ollama round-trips that previously made
   * this step block startup.
   */
  async indexSkills(entries: SkillIndexEntry[], options?: { skipOrphanSweep?: boolean }): Promise<void> {
    const skipOrphanSweep = options?.skipOrphanSweep === true;

    // 1. Register 'skills' domain
    await this.registerDomain('skills', 'Skills indexed for semantic matching');

    // 2. Cache check — skip the whole pass if nothing changed.
    //    Only valid for a FULL re-index: the cache snapshots the complete
    //    skill set (title→hash), so a length mismatch with a PARTIAL entry
    //    list (skipOrphanSweep) is expected and must NOT short-circuit.
    if (!skipOrphanSweep && this.isSkillIndexCacheValid(entries)) {
      this.core.brief('info', 'wiki', `Indexed ${entries.length} skills (cached)`);
      return;
    }

    // 3. Acquire the reindex lock. If another live instance is re-indexing,
    //    skip — the cache check will still skip next time if that instance
    //    finished, and a missed fs.watch event is caught by the next
    //    skill_load (per-skill re-index, a lighter path that doesn't need
    //    this lock).
    if (!this.acquireReindexLock()) {
      this.core.brief('info', 'wiki', 'Reindex skipped: another instance is reindexing');
      return;
    }
    try {
      // 4. Batch path — one table scan for all existing 'skills' records.
      const existing = await this.getByDomain('skills');
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
        await this.delete(hash);
      }

      // Batch insert all new/changed documents in ONE table.add() call
      if (toAdd.length > 0) {
        const batchEntries = toAdd.map((document, i) => ({ document, embedding: embeddings[i] }));
        await this.batchPut(batchEntries);
      }

      // Write the cache so the next startup can skip if nothing changed.
      // Only a FULL re-index may rewrite the cache — the cache snapshots the
      // COMPLETE skill set, so a partial (skipOrphanSweep) call writing its
      // subset would corrupt the cache (next full startup would miss it,
      // forcing a needless re-embed, and worse, the length-only check could
      // false-pass on a coincidentally-sized subset).
      if (!skipOrphanSweep) {
        this.writeSkillIndexCache(entries);
      }

      this.core.brief('info', 'wiki', `Indexed ${entries.length} skills`);
    } finally {
      this.releaseReindexLock();
    }
  }

  /**
   * Path to the skill-index cache file (under project .mycc/, gitignored).
   * The cache stores a snapshot of every indexed skill's title→content hash
   * plus the RAG namespace, so unchanged skills can be skipped on restart.
   */
  private getSkillIndexCachePath(): string {
    return path.join(getMyccDir(), 'skill-index-cache.json');
  }

  /**
   * Read the on-disk skill-index cache and return whether it covers every
   * current skill with a matching content hash, under the same RAG namespace.
   */
  private isSkillIndexCacheValid(entries: SkillIndexEntry[]): boolean {
    const cachePath = this.getSkillIndexCachePath();
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
   * Persist the skill-index cache snapshot to disk.
   */
  private writeSkillIndexCache(entries: SkillIndexEntry[]): void {
    try {
      ensureDirs();
      const cachePath = this.getSkillIndexCachePath();
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
  // Reindex Lock (private — used only by indexSkills)
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
   */
  private acquireReindexLock(): boolean {
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
      this.registerReindexCrashHandlers();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Unexpected error (e.g. permission denied) — can't acquire. Skip
        // rather than risk concurrent writes.
        this.core.brief('warn', 'wiki', `Reindex lock acquire error: ${(err as Error).message}`);
        return false;
      }
    }

    // 2. Lock exists — inspect the holder.
    let holder: { sessionId?: string; pid?: number; startedAt?: number; namespace?: string };
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch {
      // Corrupt lock — steal it.
      this.stealReindexLock(lockPath, myInfo);
      return true;
    }

    // 2a. Namespace mismatch (embedding model swapped) → invalidate.
    if (holder.namespace !== NAMESPACE) {
      this.stealReindexLock(lockPath, myInfo);
      return true;
    }

    // 2b. Stale holder? Check heartbeat freshness + PID liveness.
    if (this.isReindexLockStale(holder)) {
      this.stealReindexLock(lockPath, myInfo);
      return true;
    }

    // 2c. Holder is fresh and same namespace — another live instance is
    // re-indexing. Skip.
    return false;
  }

  /**
   * Overwrite the lockfile with our info (steal a stale/corrupt/foreign lock).
   * Best-effort; a concurrent steal by another instance is harmless (last
   * writer wins, and the loser's freshness check will skip on its next tick).
   */
  private stealReindexLock(lockPath: string, myInfo: object): void {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(myInfo), 'utf-8');
      this.registerReindexCrashHandlers();
    } catch {
      this.core.brief('warn', 'wiki', 'Reindex lock steal write failed — will retry next tick');
    }
  }

  /**
   * Is a lock holder stale (its process is dead or its heartbeat is older
   * than the freshness window)? Mirrors the absolute-window check in
   * identity.ts's isFresh(), plus a PID-liveness probe.
   */
  private isReindexLockStale(holder: { sessionId?: string; pid?: number }): boolean {
    // PID-dead check: process.kill(pid, 0) throws if no such process.
    if (typeof holder.pid === 'number' && holder.pid > 0) {
      try {
        process.kill(holder.pid, 0);
        // PID is alive — NOT stale on this signal alone. Fall through to the
        // heartbeat check, which is the stronger signal (a zombie holding the
        // lock but no longer beating is stale).
      } catch {
        // PID is dead → stale.
        return true;
      }
    }

    // Heartbeat freshness check: mirror identity.ts's absolute window.
    if (holder.sessionId) {
      const hbFile = getHeartbeatFile(holder.sessionId);
      if (fs.existsSync(hbFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(hbFile, 'utf-8')) as Record<string, unknown>;
          const ts = Array.isArray(parsed.timestamps) ? parsed.timestamps
            : Array.isArray(parsed.heartbeats) ? parsed.heartbeats
            : [];
          if (ts.length > 0) {
            const latest = ts[ts.length - 1] as number;
            return Date.now() - latest > WikiManager.REINDEX_FRESHNESS_MS;
          }
        } catch {
          // Corrupt heartbeat — can't confirm freshness; treat as stale so
          // we don't block forever on a dead holder.
          return true;
        }
      }
      // No heartbeat file at all — the holder may be a non-mycc process or a
      // crashed instance that never beat. Treat as stale (PID check above is
      // the tiebreaker; if the PID is alive we already returned false there).
    }

    // No PID and no usable heartbeat — conservatively treat as stale so a
    // corrupt/ancient lock doesn't block reindexing forever.
    return true;
  }

  /**
   * Register one-shot SIGINT/SIGTERM handlers that release the reindex lock
   * on crash. Idempotent (registered once per process). Best-effort: SIGKILL
   * bypasses these, leaving a stale lock recovered by the next acquire's
   * freshness check.
   */
  private registerReindexCrashHandlers(): void {
    if (this.reindexLockHandlersRegistered) return;
    this.reindexLockHandlersRegistered = true;
    const release = () => {
      try { fs.unlinkSync(getWikiReindexLockFile()); } catch { /* best-effort */ }
    };
    process.once('SIGINT', () => { release(); process.exit(0); });
    process.once('SIGTERM', () => { release(); process.exit(0); });
  }

  /**
   * Release the reindex lock. Safe to call when not held (unlink is
   * best-effort). Always called in a `finally` by {@link indexSkills}.
   */
  private releaseReindexLock(): void {
    try {
      fs.unlinkSync(getWikiReindexLockFile());
    } catch {
      // Already gone or never acquired — best-effort.
    }
  }

  /**
   * Generate hash for document
   */
  private generateHash(document: WikiDocument): string {
    const content = `${document.domain}:${document.title}:${document.content}`;
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Check if similar document exists
   */
  private async checkDuplicate(embedding: number[], threshold = DUPLICATE_THRESHOLD): Promise<boolean> {
    await this.initDb();
    if (!this.table) return false;

    try {
      const records = await this.table.query().toArray();
      for (const record of records) {
        const r = record as Record<string, unknown>;
        // Skip schema record
        if (r.hash === '__schema__') continue;

        const embeddingArr = Array.isArray(r.embedding) ? r.embedding : Array.from(r.embedding as Iterable<number>);
        const similarity = this.cosineSimilarity(embedding, embeddingArr);
        if (similarity > threshold) {
          this.core.brief('warn', 'wiki', `Duplicate check hit: similarity=${similarity.toFixed(4)} > ${threshold}, colliding doc: domain=${r.domain}, title=${r.title}, hash=${r.hash}`);
          return true;
        }
      }
    } catch {
      // Table might be empty
    }
    return false;
  }

  /**
   * Fetch the stored record for a given hash, or null if absent.
   * Used by put() to decide whether an incoming document is an exact copy
   * (full document match: domain + title + content + references) of one
   * already in the store — only an exact copy is a true no-op eligible for
   * the alreadyExisted short-circuit. The hash is a fast lookup; the
   * full-document comparison (sameDocument) is what actually decides.
   */
  private async findRecordByHash(hash: string): Promise<Record<string, unknown> | null> {
    await this.initDb();
    if (!this.table) return null;

    try {
      const records = await this.table.query().toArray();
      for (const record of records) {
        const r = record as Record<string, unknown>;
        if (r.hash === hash) {
          return r;
        }
      }
    } catch {
      // Table might be empty
    }
    return null;
  }

  /**
   * Compare an incoming WikiDocument against a stored LanceDB record for full
   * equality across all fields: domain, title, content, AND references.
   *
   * Why full equality, not just the hash: the wiki hash is sha256 of
   * `${domain}:${title}:${content}` truncated to 16 hex chars. It does not
   * cover `references`, and a 64-bit truncated hash can in principle collide
   * between two genuinely different documents. Only a full-document match is
   * a true "already present" no-op; a hash collision between different
   * documents must NOT be falsely reported as already-existed (it would
   * silently drop a distinct document). References are compared
   * order-insensitively — they are a set, and the WAL/export round-trip may
   * reorder them.
   */
  private sameDocument(stored: Record<string, unknown>, incoming: WikiDocument): boolean {
    if ((stored.domain as string) !== incoming.domain) return false;
    if ((stored.title as string) !== incoming.title) return false;
    if ((stored.content as string) !== incoming.content) return false;
    // references: stored as a JSON string (or occasionally a native array)
    const parseStored = (): string[] => {
      const raw = stored.references;
      if (raw === null || raw === undefined) return [];
      if (Array.isArray(raw)) return raw as string[];
      if (typeof raw === 'string') {
        try { return JSON.parse(raw || '[]') as string[]; } catch { return []; }
      }
      return [];
    };
    const a = parseStored().slice().sort();
    const b = (incoming.references || []).slice().sort();
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }

  /**
   * Prepare document for storage - evaluate and return hash or rejection
   * @param document - The document to prepare
   * @param skipDuplicateCheck - If true, skip the embedding-based duplicate check (used for skill indexing where titles already de-duplicate)
   */
  async prepare(document: WikiDocument, skipDuplicateCheck: boolean = false): Promise<PrepareResult> {
    // Validate document structure
    if (!document.domain || !document.title || !document.content) {
      return { accepted: false, reason: 'Missing required fields: domain, title, or content' };
    }

    if (document.content.length < MIN_CONTENT_LENGTH) {
      return { accepted: false, reason: `Content too short (minimum ${MIN_CONTENT_LENGTH} characters)` };
    }

    if (document.content.length > MAX_CONTENT_LENGTH) {
      return { accepted: false, reason: `Content too long (maximum ${MAX_CONTENT_LENGTH} characters)` };
    }

    // Validate domain against registered domains
    const domains = this.loadDomains();
    if (domains.length === 0) {
      return { accepted: false, reason: 'No domains registered. Use /wiki domains add <name> to create a domain first.' };
    }
    const domainExists = domains.some(d => d.domain_name === document.domain);
    if (!domainExists) {
      return { accepted: false, reason: `Unknown domain "${document.domain}". Register it first with /wiki domains add ${document.domain} <description>.` };
    }

    // Generate hash
    const hash = this.generateHash(document);

    try {
      // Generate embedding for content
      const embedding = await getEmbedding(document.content, 'document');

      // Check for duplicates (skip for skill indexing where titles serve as primary keys)
      if (!skipDuplicateCheck) {
        const isDuplicate = await this.checkDuplicate(embedding);
        if (isDuplicate) {
          return { accepted: false, reason: 'Similar document already exists in knowledge base' };
        }
      }

      return { accepted: true, hash };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Prepare failed: ${error}`);
      return { accepted: false, reason: `Failed to generate embedding: ${error}` };
    }
  }

  /**
   * Store document in knowledge base
   */
  async put(hash: string, document: WikiDocument): Promise<PutResult> {
    // Validate hash
    const expectedHash = this.generateHash(document);
    if (hash !== expectedHash) {
      return { success: false, hash, error: 'Hash mismatch - document may have been modified' };
    }

    // Validate domain against registered domains
    const domains = this.loadDomains();
    if (domains.length === 0) {
      return { success: false, hash, error: 'No domains registered. Use /wiki domains add <name> to create a domain first.' };
    }
    const domainExists = domains.some(d => d.domain_name === document.domain);
    if (!domainExists) {
      return { success: false, hash, error: `Unknown domain "${document.domain}". Register it first with /wiki domains add ${document.domain} <description>.` };
    }

    // Short circuit: if an exact copy already exists, report it. "Exact" means
    // the full document matches — domain, title, content, AND references. The
    // hash (sha256 of domain:title:content, 16 hex) is only a fast lookup key;
    // it does not cover references and can in principle collide, so the
    // full-document comparison is what actually decides "already present". A
    // hash collision between two genuinely different documents falls through
    // to be stored as a new record (the store represents distinct documents
    // that collide on hash as separate LanceDB rows).
    const existing = await this.findRecordByHash(hash);
    if (existing) {
      if (this.sameDocument(existing, document)) {
        this.core.verbose('wiki', `Document already exists (exact match): ${hash}`);
        return { success: true, hash, alreadyExisted: true };
      }
      // Hash matches but the document differs (collision on the 16-hex
      // prefix, or references differ) — NOT an exact copy. Store as a new
      // record rather than silently dropping a distinct document.
      this.core.verbose('wiki', `Hash ${hash} exists but document differs — storing as new record`);
    }

    try {
      await this.initDb();
      if (!this.table) {
        return { success: false, hash, error: 'Database not initialized' };
      }

      // Generate embedding
      const embedding = await getEmbedding(document.content, 'document');

      // Create record
      const record: Record<string, unknown> = {
        hash,
        domain: document.domain,
        title: document.title,
        content: document.content,
        references: JSON.stringify(document.references || []),
        embedding,
        createdAt: new Date().toISOString(),
      };

      // Add to LanceDB
      await this.table.add([record]);

      // Append to WAL
      await this.appendWAL({
        timestamp: new Date().toISOString(),
        hash,
        document,
        approved: true,
        namespace: NAMESPACE,
      });

      this.core.brief('info', 'wiki', `Stored document: ${document.title}`);
      return { success: true, hash };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Put failed: ${error}`);
      return { success: false, hash, error };
    }
  }

  /**
   * Search for documents by similarity
   */
  async get(query: string, options?: GetOptions): Promise<SearchResult[]> {
    await this.initDb();
    if (!this.table) return [];

    const topK = options?.topK || 5;
    const threshold = options?.threshold || 0.0;

    try {
      // Generate embedding for query
      const queryEmbedding = await getEmbedding(query, 'query');

      // Get all records and filter manually (vector search requires embedding column)
      const records = await this.table.query().toArray();
      const results: SearchResult[] = [];

      for (const record of records) {
        const r = record as Record<string, unknown>;

        // Skip schema record
        if (r.hash === '__schema__') continue;

        // Apply domain filter if specified
        if (options?.domain && r.domain !== options.domain) {
          continue;
        }

        const embedding = Array.isArray(r.embedding) ? r.embedding as number[] : Array.from(r.embedding as Iterable<number>);
        const similarity = this.cosineSimilarity(queryEmbedding, embedding);

        if (similarity >= threshold) {
          results.push({
            document: {
              domain: r.domain as string,
              title: r.title as string,
              content: r.content as string,
              references: JSON.parse(r.references as string || '[]'),
            },
            similarity,
            hash: r.hash as string,
          });
        }
      }

      // Sort by similarity and take top-k
      results.sort((a, b) => b.similarity - a.similarity);
      return results.slice(0, topK);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Get failed: ${error}`);
      return [];
    }
  }

  /**
   * Retrieve all documents in a domain in a single table scan (no embedding).
   * Used for batch re-indexing where a full domain listing is needed without
   * the per-query embedding cost of get().
   */
  async getByDomain(domain: string): Promise<SearchResult[]> {
    await this.initDb();
    if (!this.table) return [];

    try {
      const records = await this.table.query().toArray();
      const results: SearchResult[] = [];

      for (const record of records) {
        const r = record as Record<string, unknown>;

        // Skip schema record
        if (r.hash === '__schema__') continue;

        // Domain filter
        if (r.domain !== domain) continue;

        results.push({
          document: {
            domain: r.domain as string,
            title: r.title as string,
            content: r.content as string,
            references: JSON.parse(r.references as string || '[]'),
          },
          similarity: 1, // Not a similarity search; placeholder
          hash: r.hash as string,
        });
      }

      return results;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `getByDomain failed: ${error}`);
      return [];
    }
  }

  /**
   * Batch-insert pre-embedded documents in a single table.add() call.
   * Skips the per-record findRecordByHash scan and embedding generation that put()
   * performs. Callers must compute hashes via generateHash() (same scheme as
   * prepare()/put()). WAL entries are appended in a single write.
   *
   * Returns one PutResult per input entry (same order). Entries whose hash
   * already exists in the table are skipped (success: true) to preserve the
   * idempotency guarantee of put(). Note: batchPut skips on hash match only
   * (it does not compare references, unlike put()'s exact-match check).
   */
  async batchPut(entries: Array<{ document: WikiDocument; embedding: number[] }>): Promise<PutResult[]> {
    if (entries.length === 0) return [];

    try {
      await this.initDb();
      if (!this.table) {
        return entries.map(() => ({ success: false, hash: '', error: 'Database not initialized' }));
      }

      // Validate domains once (all entries share the domain set)
      const domains = this.loadDomains();
      if (domains.length === 0) {
        const reason = 'No domains registered. Use /wiki domains add <name> to create a domain first.';
        return entries.map((e) => ({ success: false, hash: this.generateHash(e.document), error: reason }));
      }
      const domainSet = new Set(domains.map((d) => d.domain_name));

      // Build records, collecting hashes for a single existence scan
      const hashes = new Set<string>();
      const validEntries: Array<{ document: WikiDocument; embedding: number[]; hash: string; record: Record<string, unknown>; walEntry: WALEntry }> = [];

      for (const { document, embedding } of entries) {
        const hash = this.generateHash(document);

        // Validate required fields + domain
        if (!document.domain || !document.title || !document.content) {
          return [{ success: false, hash, error: 'Missing required fields: domain, title, or content' }];
        }
        if (!domainSet.has(document.domain)) {
          return [{ success: false, hash, error: `Unknown domain "${document.domain}"` }];
        }

        hashes.add(hash);
        validEntries.push({
          document,
          embedding,
          hash,
          record: {
            hash,
            domain: document.domain,
            title: document.title,
            content: document.content,
            references: JSON.stringify(document.references || []),
            embedding,
            createdAt: new Date().toISOString(),
          },
          walEntry: {
            timestamp: new Date().toISOString(),
            hash,
            document,
            approved: true,
            namespace: NAMESPACE,
          },
        });
      }

      // Single table scan to find which hashes already exist (skip them)
      const records = await this.table.query().toArray();
      const existingHashes = new Set<string>();
      for (const record of records) {
        const r = record as Record<string, unknown>;
        if (hashes.has(r.hash as string)) {
          existingHashes.add(r.hash as string);
        }
      }

      const toInsert = validEntries.filter((e) => !existingHashes.has(e.hash));

      // Single batch insert
      if (toInsert.length > 0) {
        await this.table.add(toInsert.map((e) => e.record));

        // Single batched WAL append
        const walLines = toInsert.map((e) => JSON.stringify(e.walEntry)).join('\n');
        ensureDirs();
        const walDir = getWikiLogsDir();
        const today = this.formatDate(new Date());
        const walPath = path.join(walDir, `${today}.wal`);
        fs.appendFileSync(walPath, `${walLines}\n`, 'utf-8');

        this.core.brief('info', 'wiki', `Batch stored ${toInsert.length} documents`);
      }

      // Build results in original order
      return validEntries.map((e) => {
        if (existingHashes.has(e.hash)) {
          return { success: true, hash: e.hash };
        }
        return { success: true, hash: e.hash };
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `batchPut failed: ${error}`);
      return entries.map((e) => ({ success: false, hash: this.generateHash(e.document), error }));
    }
  }

  /**
   * Delete a document by hash
   */
  async delete(hash: string): Promise<boolean> {
    // Validate hash format
    if (!HASH_PATTERN.test(hash)) {
      this.core.brief('error', 'wiki', `Invalid hash format: ${hash}. Expected 16 hex characters.`);
      return false;
    }

    await this.initDb();
    if (!this.table) {
      this.core.brief('error', 'wiki', 'Database not initialized');
      return false;
    }

    try {
      // Find the document and its createdAt date
      const records = await this.table.query().toArray();
      let foundRecord: Record<string, unknown> | null = null;

      for (const record of records) {
        const r = record as Record<string, unknown>;
        if (r.hash === hash) {
          foundRecord = r;
          break;
        }
      }

      if (!foundRecord) {
        this.core.brief('warn', 'wiki', `Document not found: ${hash}`);
        return false;
      }

      // Get the date from createdAt to find the WAL file
      const createdAt = foundRecord.createdAt as string;
      const walDate = this.formatDate(new Date(createdAt));

      // Mark as deleted in WAL first (before LanceDB deletion for consistency)
      await this.markWALDeleted(hash, walDate);

      // Delete from LanceDB
      await this.table.delete(`hash = '${hash}'`);

      this.core.brief('info', 'wiki', `Deleted document: ${hash}`);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Delete failed: ${error}`);
      return false;
    }
  }

  /**
   * Mark a WAL entry as deleted
   */
  private async markWALDeleted(hash: string, date: string): Promise<void> {
    ensureDirs();
    const walPath = path.join(getWikiLogsDir(), `${date}.wal`);

    if (!fs.existsSync(walPath)) {
      // WAL file no longer exists - this is OK, just log it
      this.core.brief('warn', 'wiki', `WAL file not found for date ${date}`);
      return;
    }

    // Read and parse WAL entries
    const content = fs.readFileSync(walPath, 'utf-8');
    const entries = this.parseWALFile(content);

    // Find and mark the entry as deleted
    let found = false;
    for (const entry of entries) {
      if (entry.hash === hash) {
        entry.deleted = true;
        found = true;
        break;
      }
    }

    if (!found) {
      this.core.brief('warn', 'wiki', `Entry ${hash} not found in WAL ${date}`);
      return;
    }

    // Write back as JSON lines
    const lines = entries.map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(walPath, `${lines  }\n`, 'utf-8');
  }

  /**
   * Get WAL entries for a specific date (default: today)
   */
  async getWAL(date?: string): Promise<WALEntry[]> {
    const targetDate = date || this.formatDate(new Date());
    const walPath = path.join(getWikiLogsDir(), `${targetDate}.wal`);

    if (!fs.existsSync(walPath)) {
      return [];
    }

    const content = fs.readFileSync(walPath, 'utf-8');
    return this.parseWALFile(content);
  }

  /**
   * Parse WAL file content (JSON lines format)
   */
  private parseWALFile(content: string): WALEntry[] {
    const entries: WALEntry[] = [];
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as WALEntry;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Parse ASCII WAL format to JSON entries
   */
  parseWAL(asciiContent: string): WALEntry[] {
    const entries: WALEntry[] = [];
    const blocks = asciiContent.split(/\n(?=#)/);

    for (const block of blocks) {
      if (!block.trim()) continue;

      const entry = this.parseASCIIBlock(block);
      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Parse a single ASCII block
   */
  private parseASCIIBlock(block: string): WALEntry | null {
    const lines = block.trim().split('\n');
    if (lines.length < 2) return null;

    let hash = '';
    let persistent = false;
    let approved = false;
    let timestamp = '';
    let domain = '';
    let title = '';
    const contentLines: string[] = [];
    const references: string[] = [];
    let section = '';

    for (const line of lines) {
      if (line.startsWith('# ')) {
        hash = line.slice(2);
      } else if (line === '!persistent') {
        persistent = true;
      } else if (line === '!approved') {
        approved = true;
      } else if (line.startsWith('[created_at]')) {
        timestamp = line.slice(12);
      } else if (line.startsWith('[domain]')) {
        domain = line.slice(8);
      } else if (line.startsWith('[title]')) {
        title = line.slice(7);
      } else if (line === '[content]') {
        section = 'content';
      } else if (line === '[references]') {
        section = 'references';
      } else if (section === 'content') {
        contentLines.push(line);
      } else if (section === 'references' && line.startsWith('- ')) {
        references.push(line.slice(2));
      }
    }

    return {
      timestamp,
      hash,
      document: {
        domain,
        title,
        content: contentLines.join('\n'),
        references,
      },
      approved,
      persistent,
    };
  }

  /**
   * Format WAL entries to ASCII format
   */
  formatWAL(entries: WALEntry[]): string {
    const blocks: string[] = [];

    for (const entry of entries) {
      const lines: string[] = [];
      lines.push(`# ${entry.hash}`);
      if (entry.deleted) lines.push('!deleted');
      if (entry.persistent) lines.push('!persistent');
      if (entry.approved) lines.push('!approved');
      lines.push(`[created_at]${entry.timestamp}`);
      lines.push(`[domain]${entry.document.domain}`);
      lines.push(`[title]${entry.document.title}`);
      lines.push('[content]');
      lines.push(entry.document.content);
      lines.push('[references]');
      for (const ref of entry.document.references) {
        lines.push(`- ${ref}`);
      }
      blocks.push(lines.join('\n'));
    }

    return blocks.join('\n\n');
  }

  /**
   * Append entry to today's WAL
   */
  async appendWAL(entry: WALEntry): Promise<void> {
    ensureDirs();
    const walDir = getWikiLogsDir();
    const today = this.formatDate(new Date());
    const walPath = path.join(walDir, `${today}.wal`);

    // Append as JSON line
    const line = `${JSON.stringify(entry)  }\n`;
    fs.appendFileSync(walPath, line, 'utf-8');

    this.core.brief('info', 'wiki', `Appended to WAL: ${entry.hash}`);
  }

  /**
   * Rebuild vector store from all WAL files
   */
  async rebuild(): Promise<RebuildResult> {
    this.core.brief('info', 'wiki', 'Starting rebuild...');

    try {
      await this.initDb();
      if (!this.table) {
        return { success: false, documentsProcessed: 0, errors: ['Database not initialized'] };
      }

      // Clear existing data
      await this.table.delete('true');

      // Get all WAL files
      const walDir = getWikiLogsDir();
      if (!fs.existsSync(walDir)) {
        return { success: true, documentsProcessed: 0, errors: [] };
      }

      const walFiles = fs.readdirSync(walDir)
        .filter(f => f.endsWith('.wal'))
        .sort();

      let documentsProcessed = 0;
      const errors: string[] = [];

      // Process each WAL file
      for (const walFile of walFiles) {
        const walPath = path.join(walDir, walFile);
        const content = fs.readFileSync(walPath, 'utf-8');
        const entries = this.parseWALFile(content);

        for (const entry of entries) {
          // Skip deleted and unapproved entries
          if (entry.deleted) continue;
          if (!entry.approved) continue;

          // Only rebuild entries belonging to the current namespace.
          // Entries without a namespace field are legacy (pre-rag-provider)
          // and are re-embedded with the current model on first rebuild.
          if (entry.namespace && entry.namespace !== NAMESPACE) continue;

          try {
            // Generate embedding
            const embedding = await getEmbedding(entry.document.content, 'document');

            // Create record
            const record: Record<string, unknown> = {
              hash: entry.hash,
              domain: entry.document.domain,
              title: entry.document.title,
              content: entry.document.content,
              references: JSON.stringify(entry.document.references || []),
              embedding,
              createdAt: entry.timestamp,
            };

            // Add to LanceDB
            await this.table.add([record]);
            documentsProcessed++;
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            errors.push(`${walFile}:${entry.hash} - ${error}`);
          }
        }
      }

      this.core.brief('info', 'wiki', `Rebuild complete: ${documentsProcessed} documents processed`);
      return { success: true, documentsProcessed, errors };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Rebuild failed: ${error}`);
      return { success: false, documentsProcessed: 0, errors: [error] };
    }
  }

  /**
   * Format date as YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  // ============================================================
  // Domain Management
  // ============================================================

  /**
   * Load domains from domains.json
   */
  private loadDomains(): WikiDomain[] {
    ensureDirs();
    const domainsFile = getWikiDomainsFile();

    if (!fs.existsSync(domainsFile)) {
      return [];
    }

    try {
      const content = fs.readFileSync(domainsFile, 'utf-8');
      return JSON.parse(content) as WikiDomain[];
    } catch {
      return [];
    }
  }

  /**
   * Save domains to domains.json
   */
  private saveDomains(domains: WikiDomain[]): void {
    ensureDirs();
    const domainsFile = getWikiDomainsFile();
    fs.writeFileSync(domainsFile, JSON.stringify(domains, null, 2), 'utf-8');
  }

  /**
   * List all registered domains
   */
  async listDomains(): Promise<WikiDomain[]> {
    return this.loadDomains();
  }

  /**
   * Get a specific domain by name
   */
  async getDomain(name: string): Promise<WikiDomain | undefined> {
    const domains = this.loadDomains();
    return domains.find(d => d.domain_name === name);
  }

  /**
   * Register a new domain (if it doesn't exist)
   */
  async registerDomain(name: string, description?: string): Promise<void> {
    const domains = this.loadDomains();
    const existing = domains.find(d => d.domain_name === name);

    if (existing) {
      return; // Domain already exists
    }

    // Add new domain
    domains.push({
      domain_name: name,
      description: description || '',
      created_at: new Date().toISOString(),
      project_folder: process.cwd(),
    });

    this.saveDomains(domains);
    this.core.brief('info', 'wiki', `Registered domain: ${name}`);
  }
}