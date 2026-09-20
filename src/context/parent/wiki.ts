/**
 * wiki.ts - WikiManager for persistent memory
 *
 * Manages knowledge storage using LanceDB for vector similarity search.
 * Uses WAL files for audit and rebuild capabilities.
 */

import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs';
import * as path from 'path';
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
  RebuildProgress,
  CoreModule,
  SkillIndexEntry,
} from '../../types.js';
import { getEmbedding, getEmbeddings, EMBEDDING_DIM, NAMESPACE } from '../../engine/rag-provider.js';
import { getWikiLogsDir, getWikiDbDir, ensureDirs } from '../../config.js';
import {
  HASH_PATTERN,
  generateHash,
  cosineSimilarity,
  sameDocument,
  parseWALFile,
  parseWAL,
  formatWAL,
  formatDate,
  loadDomains,
  saveDomains,
  releaseReindexLock,
  walLiveHashes,
} from './wiki-utils.js';
import {
  ReindexLock,
  isSkillIndexCacheValid,
  writeSkillIndexCache,
} from './wiki-skill-index.js';

const DUPLICATE_THRESHOLD = 0.95;
const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 1000;

/**
 * Rebuild batching. `rebuild()` embeds documents in chunks of
 * EMBED_BATCH_SIZE (one Ollama /api/embed call per chunk) and inserts in
 * chunks of INSERT_BATCH_SIZE (one LanceDB table.add per chunk).
 *
 * Embedding is the conservative knob: EMBED_BATCH_SIZE=16 caps the Ollama
 * /api/embed HTTP body (16 × 768 floats ≈ 48 KB per request) so a large
 * rebuild never builds an oversized embed payload. Insertion is cheap and
 * local, so INSERT_BATCH_SIZE=128 lets one table.add absorb up to 128 rows.
 * Note INSERT_BATCH_SIZE >= EMBED_BATCH_SIZE, so the inner insert loop
 * currently runs once per outer embed batch; the split keeps the two
 * concerns independent for future tuning.
 */
const EMBED_BATCH_SIZE = 16;
const INSERT_BATCH_SIZE = 128;

/**
 * Native ANN search (PR #18 lineage).
 *
 * `get()` uses LanceDB `vectorSearch()` over an IVF-Flat index instead of an
 * O(rows) full-table scan. Three knobs:
 *  - VECTOR_SEARCH_OVERFETCH — over-fetch factor. `.where()` is a PREFILTER in
 *    LanceDB v0.27.2 (applied BEFORE the ANN search), so this is NOT a
 *    correctness crutch against postfilter shrinkage; it is a margin for the
 *    client-side similarity-threshold cut + ANN ranking jitter, so a domain
 *    with many sub-threshold rows still yields a full topK.
 *  - MIN_INDEX_ROWS — below this many real rows the table is too small for a
 *    useful IVF index (training kmeans on a handful of vectors is noise);
 *    `ensureVectorIndex` skips building and `vectorSearch` falls back to its
 *    internal flat scan, which is correct just not sublinear.
 */
const VECTOR_SEARCH_OVERFETCH = 4;
const MIN_INDEX_ROWS = 16;

/**
 * Reverse two-phase-commit sentinel for the `createdAt` column.
 *
 * WRITE ORDER: `add(createdAt: null)` → `appendWAL(timestamp: T)` → `update(createdAt: T)`.
 * A row with `createdAt === PREMATURE` is INVISIBLE to every read (the read
 * filter is `createdAt IS NOT NULL`). The flip to a real ISO timestamp is the
 * COMMIT MARKER, and it is written only AFTER the WAL entry is durable, so:
 *
 *   INVARIANT: a committed row (createdAt not null) ⟹ its hash has a live WAL entry.
 *
 * The forbidden state (visible row, no live WAL entry) would require the flip
 * to run before the append — unreachable by construction.
 *
 * The sentinel is SQL `NULL` (native predicate `IS NULL` / `IS NOT NULL`, no
 * magic string literal). A crash between append and flip leaves the document
 * committed-in-truth but invisible-in-cache; `rebuild()` heals it (it clears
 * the table and re-inserts from the folded WAL with the entry's real
 * timestamp). Guard every `new Date(row.createdAt)` read: `new Date(null)` is
 * the epoch (1970), silently the wrong day-file.
 */
const PREMATURE: string | null = null;

/**
 * WikiManager - Manages persistent knowledge storage
 */
export class WikiManager implements WikiModule {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private core: CoreModule;
  private tableName = `wiki_${NAMESPACE}`;
  /** True once an IVF-Flat vector index exists on this table (this process). */
  private vectorIndexEnsured = false;
  /** Serializes skill re-indexing across instances (see wiki-skill-index). */
  private reindexLock = new ReindexLock((msg) => this.core.brief('warn', 'wiki', msg));
  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Initialize the database connection (and, best-effort, the vector index).
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

    // Ensure the ANN index exists so get()'s vectorSearch is sublinear.
    // Fire-and-forget: a missing/failed index is non-fatal (get() falls back
    // to the manual scan), so it must not block startup.
    void this.ensureVectorIndex().catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.core.verbose('wiki', `ensureVectorIndex on init failed: ${reason}`);
    });
  }

  // ============================================================
  // Native ANN vector index (PR #18 lineage)
  // ============================================================

  /**
   * Build (or refresh) the IVF-Flat cosine index on the `embedding` column.
   *
   * IVF-Flat (not IVF-PQ): the wiki/skill store is modest (hundreds to low
   * thousands of rows), so PQ compression buys nothing and costs recall.
   *
   * `waitTimeoutSeconds` is REQUIRED for correctness of the "ensured" flag:
   * without it `createIndex` resolves once creation is STARTED, not once the
   * index is TRAINED (indices.d.ts). Awaiting the timeout means a subsequent
   * vectorSearch actually uses a trained index.
   *
   * Small-table gate: below MIN_INDEX_ROWS real rows, skip training — a
   * kmeans over a handful of vectors is noise, and vectorSearch still works
   * (internal flat scan). Non-fatal: any failure is logged + swallowed, and
   * get() falls back to the manual scan.
   */
  private async ensureVectorIndex(replace = false): Promise<void> {
    await this.initDb();
    if (!this.table) return;
    if (this.vectorIndexEnsured && !replace) return;

    try {
      // Count real rows (exclude the __schema__ sentinel and premature rows;
      // premature rows are invisible to reads but still occupy the table).
      const rows = await this.table.query().toArray();
      const realRows = rows.filter(
        (r) => (r as Record<string, unknown>).hash !== '__schema__',
      ).length;

      if (realRows < MIN_INDEX_ROWS) {
        this.core.verbose(
          'wiki',
          `vector index skipped: ${realRows} rows < ${MIN_INDEX_ROWS} (flat search is fine)`,
        );
        return;
      }

      // ~sqrt(n) partitions is the IVF rule of thumb; clamp to a sane floor.
      const numPartitions = Math.max(2, Math.min(256, Math.floor(Math.sqrt(realRows))));
      const index = lancedb.Index.ivfFlat({ distanceType: 'cosine', numPartitions });
      await this.table.createIndex('embedding', {
        config: index,
        replace,
        waitTimeoutSeconds: 30,
      });
      this.vectorIndexEnsured = true;
      this.core.verbose(
        'wiki',
        `vector index ensured (ivfFlat cosine, ${numPartitions} partitions, ${realRows} rows)`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.core.verbose('wiki', `ensureVectorIndex skipped: ${reason}`);
    }
  }

  /**
   * Build the native vector-search query shared by get() / checkDuplicate():
   * cosine distance over the ANN index, a server-side `.where()` prefilter
   * that (a) drops the __schema__ sentinel and (b) drops PREMATURE rows
   * (reverse-2FC: uncommitted rows must be invisible), plus an optional
   * domain predicate, and an over-fetched `.limit()`.
   *
   * The caller receives LanceDB cosine DISTANCE rows (`_distance`, lower =
   * closer); convert with `1 - _distance` for a similarity in [0, 1].
   */
  private buildVectorQuery(
    queryEmbedding: number[],
    topK: number,
    domain?: string,
  ): lancedb.VectorQuery {
    if (!this.table) throw new Error('Database not initialized');
    let vq = this.table
      .vectorSearch(Float32Array.from(queryEmbedding))
      .distanceType('cosine')
      .limit(Math.max(topK * VECTOR_SEARCH_OVERFETCH, topK));
    // ESCAPE single quotes in the domain so a value with an apostrophe cannot
    // break out of the predicate.
    let predicate = `hash != '__schema__' AND createdAt IS NOT NULL`;
    if (domain) {
      predicate += ` AND domain = '${domain.replace(/'/g, "''")}'`;
    }
    vq = vq.where(predicate);
    return vq;
  }

  // ============================================================
  // Skill Re-index (wiki-DB-level) — moved here from loader.ts
  // ============================================================

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
    if (!skipOrphanSweep && isSkillIndexCacheValid(entries)) {
      this.core.brief('info', 'wiki', `Indexed ${entries.length} skills (cached)`);
      return;
    }

    // 3. Acquire the reindex lock. If another live instance is re-indexing,
    //    skip — the cache check will still skip next time if that instance
    //    finished, and a missed fs.watch event is caught by the next
    //    skill_load (per-skill re-index, a lighter path that doesn't need
    //    this lock).
    if (!this.reindexLock.acquire()) {
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

      this.core.brief('info', 'wiki', `Indexed ${entries.length} skills`);

      // Refresh the ANN index after a bulk re-index so subsequent vectorSearch
      // calls see the new/updated skill rows. Non-fatal, best-effort.
      await this.ensureVectorIndex(true);
    } finally {
      releaseReindexLock();
    }
  }

  /**
   * Check if a similar document exists, using the native ANN index.
   *
   * Only COMMITTED rows are considered (the vector query's `.where()` drops
   * `createdAt IS NULL` premature rows), so a half-written document mid-put
   * cannot be mistaken for an existing one.
   *
   * Falls back to the O(rows) manual scan if vectorSearch is unavailable
   * (index missing on a tiny table still returns results; a thrown API error
   * is the fallback trigger), preserving the pre-ANN semantics exactly.
   */
  private async checkDuplicate(embedding: number[], threshold = DUPLICATE_THRESHOLD): Promise<boolean> {
    await this.initDb();
    if (!this.table) return false;

    try {
      const vq = this.buildVectorQuery(embedding, 1);
      const rows = await vq.toArray();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const distance = Number(r._distance);
        if (!Number.isFinite(distance)) continue;
        const similarity = 1 - distance; // cosine distance → similarity
        if (similarity > threshold) {
          this.core.brief('warn', 'wiki', `Duplicate check hit: similarity=${similarity.toFixed(4)} > ${threshold}, colliding doc: domain=${r.domain}, title=${r.title}, hash=${r.hash}`);
          return true;
        }
      }
      return false;
    } catch (vecErr) {
      this.core.verbose('wiki', `checkDuplicate vectorSearch failed, falling back to scan: ${vecErr instanceof Error ? vecErr.message : String(vecErr)}`);
    }

    // Fallback: manual scan (committed rows only).
    try {
      const records = await this.table.query().toArray();
      for (const record of records) {
        const r = record as Record<string, unknown>;
        if (r.hash === '__schema__') continue;
        if (r.createdAt === null || r.createdAt === undefined) continue; // premature

        const embeddingArr = Array.isArray(r.embedding) ? r.embedding : Array.from(r.embedding as Iterable<number>);
        const similarity = cosineSimilarity(embedding, embeddingArr);
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
   * Fetch the COMMITTED stored record for a given hash, or null if absent.
   *
   * Premature rows (`createdAt === null`) are ignored — they are half-written
   * and are not yet part of the store's truth. Used by put() ONLY to recover
   * the `references` for a WAL-live hash (the full-document sameDocument()
   * comparison); WAL liveness itself is the existence gate, see put().
   */
  private async findRecordByHash(hash: string): Promise<Record<string, unknown> | null> {
    await this.initDb();
    if (!this.table) return null;

    try {
      const records = await this.table.query().toArray();
      for (const record of records) {
        const r = record as Record<string, unknown>;
        if (r.hash === hash && r.createdAt !== null && r.createdAt !== undefined) {
          return r;
        }
      }
    } catch {
      // Table might be empty
    }
    return null;
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
    const domains = loadDomains();
    if (domains.length === 0) {
      return { accepted: false, reason: 'No domains registered. Use /wiki domains add <name> to create a domain first.' };
    }
    const domainExists = domains.some(d => d.domain_name === document.domain);
    if (!domainExists) {
      return { accepted: false, reason: `Unknown domain "${document.domain}". Register it first with /wiki domains add ${document.domain} <description>.` };
    }

    // Generate hash
    const hash = generateHash(document);

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
    const expectedHash = generateHash(document);
    if (hash !== expectedHash) {
      return { success: false, hash, error: 'Hash mismatch - document may have been modified' };
    }

    // Validate domain against registered domains
    const domains = loadDomains();
    if (domains.length === 0) {
      return { success: false, hash, error: 'No domains registered. Use /wiki domains add <name> to create a domain first.' };
    }
    const domainExists = domains.some(d => d.domain_name === document.domain);
    if (!domainExists) {
      return { success: false, hash, error: `Unknown domain "${document.domain}". Register it first with /wiki domains add ${document.domain} <description>.` };
    }

    // Reverse-2FC existence gate: the WAL is the truth. If a live WAL entry
    // exists for this hash, the document is already stored (even if the cache
    // still lags at premature). Compare the full document for the honest
    // "already present" report — an exact copy is a true no-op, while a hash
    // collision between different documents (or differing references) falls
    // through to be stored as a new row.
    const liveWal = walLiveHashes(getWikiLogsDir(), NAMESPACE);
    if (liveWal.has(hash)) {
      const stored = await this.findRecordByHash(hash);
      if (stored && sameDocument(stored, document)) {
        this.core.verbose('wiki', `Document already exists (exact match, WAL-live): ${hash}`);
        return { success: true, hash, alreadyExisted: true };
      }
      // WAL-live but not an exact document copy (references differ, or the
      // cache row is absent/premature). Do NOT re-append a duplicate WAL line
      // — the truth is already durable. Report as already present.
      this.core.verbose('wiki', `Hash ${hash} already WAL-live but not an exact row match — reporting alreadyExisted`);
      return { success: true, hash, alreadyExisted: true };
    }

    try {
      await this.initDb();
      if (!this.table) {
        return { success: false, hash, error: 'Database not initialized' };
      }

      // Generate embedding
      const embedding = await getEmbedding(document.content, 'document');

      // ONE clock read: the WAL day-file and the committed createdAt MUST
      // agree, so that delete()'s day-file derivation (which reads the row's
      // createdAt) finds the entry in the file it was actually written to.
      const now = new Date();
      const committedAt = now.toISOString();

      // ── Phase 0: clear any (necessarily premature) prior row for this hash.
      // After the WAL check above, a row for this hash can only be premature,
      // so this deletes garbage and guarantees one row per hash.
      await this.table.delete(`hash = '${hash}'`);

      // ── Phase 1: insert the row PREMATURE (createdAt null) — invisible to
      // every read (the read filter is `createdAt IS NOT NULL`).
      const record: Record<string, unknown> = {
        hash,
        domain: document.domain,
        title: document.title,
        content: document.content,
        references: JSON.stringify(document.references || []),
        embedding,
        createdAt: PREMATURE,
      };
      await this.table.add([record]);

      // ── Phase 2: append the WAL entry — the durable source of truth.
      await this.appendWAL({
        timestamp: committedAt,
        hash,
        document,
        approved: true,
        namespace: NAMESPACE,
      });

      // ── Phase 3: COMMIT — flip createdAt to a real timestamp. Only now is
      // the row visible to reads (INVARIANT: committed ⟹ WAL-live).
      await this.table.update({
        where: `hash = '${hash}'`,
        values: { createdAt: committedAt },
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
   * Search for documents by similarity.
   *
   * Primary path: LanceDB native `vectorSearch` (ANN) over an IVF-Flat cosine
   * index, with a server-side `.where()` PREFILTER that drops the __schema__
   * sentinel, drops PREMATURE rows (reverse-2FC: `createdAt IS NOT NULL`), and
   * applies the optional domain predicate. Sublinear instead of O(rows).
   *
   * Fallback: if vectorSearch throws (index unavailable / API regression), the
   * original full-table manual scan runs with identical semantics, still
   * excluding premature rows.
   */
  async get(query: string, options?: GetOptions): Promise<SearchResult[]> {
    await this.initDb();
    if (!this.table) return [];

    const topK = options?.topK || 5;
    const threshold = options?.threshold || 0.0;

    // Generate embedding for query
    let queryEmbedding: number[];
    try {
      queryEmbedding = await getEmbedding(query, 'query');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Get failed: ${error}`);
      return [];
    }

    try {
      // ANN path: over-fetch, then apply the threshold + topK client-side.
      const rows = await this.buildVectorQuery(queryEmbedding, topK, options?.domain).toArray();
      const results: SearchResult[] = [];
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const distance = Number(r._distance);
        if (!Number.isFinite(distance)) continue;
        const similarity = 1 - distance; // cosine distance → similarity in [0,1]
        if (similarity >= threshold) {
          results.push({
            document: {
              domain: r.domain as string,
              title: r.title as string,
              content: r.content as string,
              references: JSON.parse((r.references as string) || '[]'),
            },
            similarity,
            hash: r.hash as string,
          });
        }
      }
      results.sort((a, b) => b.similarity - a.similarity);
      return results.slice(0, topK);
    } catch (vecErr) {
      this.core.verbose('wiki', `vectorSearch failed, falling back to manual scan: ${vecErr instanceof Error ? vecErr.message : String(vecErr)}`);
    }

    // Fallback: manual full-table scan (committed rows only). Identical
    // semantics to the pre-ANN implementation.
    try {
      const records = await this.table.query().toArray();
      const results: SearchResult[] = [];

      for (const record of records) {
        const r = record as Record<string, unknown>;

        // Skip schema record
        if (r.hash === '__schema__') continue;
        // Skip premature (reverse-2FC uncommitted) rows
        if (r.createdAt === null || r.createdAt === undefined) continue;

        // Apply domain filter if specified
        if (options?.domain && r.domain !== options.domain) {
          continue;
        }

        const embedding = Array.isArray(r.embedding) ? r.embedding as number[] : Array.from(r.embedding as Iterable<number>);
        const similarity = cosineSimilarity(queryEmbedding, embedding);

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

      results.sort((a, b) => b.similarity - a.similarity);
      return results.slice(0, topK);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Get failed: ${error}`);
      return [];
    }
  }

  /**
   * Retrieve all COMMITTED documents in a domain in a single table scan (no
   * embedding). Used for batch re-indexing where a full domain listing is
   * needed without the per-query embedding cost of get().
   *
   * Premature (reverse-2FC uncommitted) rows are excluded.
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
        // Skip premature (reverse-2FC uncommitted) rows
        if (r.createdAt === null || r.createdAt === undefined) continue;

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
   * Returns one PutResult per input entry (same order). Entries whose hash is
   * already WAL-live are not re-inserted and are reported with
   * alreadyExisted:true (success: true), mirroring put()'s idempotency
   * reporting. Existence is WAL-sourced (the truth), not a table scan.
   *
   * Reverse-2FC: all rows are inserted PREMATURE (createdAt null), the WAL is
   * appended in ONE write, then ONE `update(... IN ...)` commits them. The
   * invariant "committed ⟹ WAL-live" holds because the commit UPDATE runs only
   * after the WAL append.
   */
  async batchPut(entries: Array<{ document: WikiDocument; embedding: number[] }>): Promise<PutResult[]> {
    if (entries.length === 0) return [];

    try {
      await this.initDb();
      if (!this.table) {
        return entries.map(() => ({ success: false, hash: '', error: 'Database not initialized' }));
      }

      // Validate domains once (all entries share the domain set)
      const domains = loadDomains();
      if (domains.length === 0) {
        const reason = 'No domains registered. Use /wiki domains add <name> to create a domain first.';
        return entries.map((e) => ({ success: false, hash: generateHash(e.document), error: reason }));
      }
      const domainSet = new Set(domains.map((d) => d.domain_name));

      // WAL-sourced existence: only hashes with NO live WAL entry are inserted.
      const liveWal = walLiveHashes(getWikiLogsDir(), NAMESPACE);

      const hashes = new Set<string>();
      const validEntries: Array<{ document: WikiDocument; embedding: number[]; hash: string; record: Record<string, unknown>; walEntry: WALEntry }> = [];

      // ONE clock read shared by every row's commit timestamp and every WAL
      // entry's timestamp + day-file (so delete()'s day-file derivation agrees).
      const now = new Date();
      const committedAt = now.toISOString();

      for (const { document, embedding } of entries) {
        const hash = generateHash(document);

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
            createdAt: PREMATURE, // committed in Phase 3
          },
          walEntry: {
            timestamp: committedAt,
            hash,
            document,
            approved: true,
            namespace: NAMESPACE,
          },
        });
      }

      const toInsert = validEntries.filter((e) => !liveWal.has(e.hash));

      // Phase 0: clear any prior (necessarily premature) rows for these hashes
      // so a hash maps to exactly one row.
      if (toInsert.length > 0) {
        const hashList = toInsert.map((e) => `'${e.hash}'`).join(', ');
        await this.table.delete(`hash IN (${hashList})`);
      }

      if (toInsert.length > 0) {
        // Phase 1: insert all PREMATURE (invisible to reads).
        await this.table.add(toInsert.map((e) => e.record));

        // Phase 2: single batched WAL append (the durable truth).
        const walLines = toInsert.map((e) => JSON.stringify(e.walEntry)).join('\n');
        ensureDirs();
        const walDir = getWikiLogsDir();
        const today = formatDate(now);
        const walPath = path.join(walDir, `${today}.wal`);
        fs.appendFileSync(walPath, `${walLines}\n`, 'utf-8');

        // Phase 3: COMMIT — one UPDATE flips every just-inserted row to live.
        const hashList = toInsert.map((e) => `'${e.hash}'`).join(', ');
        await this.table.update({
          where: `hash IN (${hashList})`,
          values: { createdAt: committedAt },
        });

        this.core.brief('info', 'wiki', `Batch stored ${toInsert.length} documents`);
      }

      // Build results in original order. A hash that was already WAL-live is
      // flagged alreadyExisted:true rather than indistinguishable from insert.
      return validEntries.map((e) =>
        liveWal.has(e.hash)
          ? { success: true, hash: e.hash, alreadyExisted: true }
          : { success: true, hash: e.hash },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `batchPut failed: ${error}`);
      return entries.map((e) => ({ success: false, hash: generateHash(e.document), error }));
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
      // Find the document's committed createdAt date.
      const records = await this.table.query().toArray();
      let foundRecord: Record<string, unknown> | null = null;

      for (const record of records) {
        const r = record as Record<string, unknown>;
        if (r.hash === hash) {
          foundRecord = r;
          break;
        }
      }

      // Two cases:
      //  (a) A PREMATURE row (createdAt null) — a half-written document whose
      //      WAL append did not complete. Nothing was committed, so there is no
      //      tombstone to write: roll the garbage row back with a bare delete
      //      and skip WAL marking.
      //  (b) A COMMITTED row — derive its WAL day-file from createdAt (which
      //      the commit path stamped with the SAME timestamp the entry was
      //      written under, so this lookup is exact) and mark the tombstone
      //      BEFORE the DB delete, so a DB failure leaves both stores intact.
      if (!foundRecord) {
        this.core.brief('warn', 'wiki', `Document not found: ${hash}`);
        return false;
      }

      if (foundRecord.createdAt === null || foundRecord.createdAt === undefined) {
        this.core.verbose('wiki', `Deleting premature (uncommitted) row ${hash} — no WAL tombstone needed`);
        await this.table.delete(`hash = '${hash}'`);
        return true;
      }

      const createdAt = foundRecord.createdAt as string;
      const walDate = formatDate(new Date(createdAt));

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
    const entries = parseWALFile(content);

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
    const targetDate = date || formatDate(new Date());
    const walPath = path.join(getWikiLogsDir(), `${targetDate}.wal`);

    if (!fs.existsSync(walPath)) {
      return [];
    }

    const content = fs.readFileSync(walPath, 'utf-8');
    return parseWALFile(content);
  }

  /**
   * Parse ASCII WAL format to JSON entries (WikiModule contract — delegates
   * to the pure helper in wiki-utils).
   */
  parseWAL(asciiContent: string): WALEntry[] {
    return parseWAL(asciiContent);
  }

  /**
   * Format WAL entries to ASCII format (WikiModule contract — delegates to
   * the pure helper in wiki-utils).
   */
  formatWAL(entries: WALEntry[]): string {
    return formatWAL(entries);
  }

  /**
   * Append entry to today's WAL
   */
  async appendWAL(entry: WALEntry): Promise<void> {
    ensureDirs();
    const walDir = getWikiLogsDir();
    const today = formatDate(new Date());
    const walPath = path.join(walDir, `${today}.wal`);

    // Append as JSON line
    const line = `${JSON.stringify(entry)  }\n`;
    fs.appendFileSync(walPath, line, 'utf-8');

    this.core.brief('info', 'wiki', `Appended to WAL: ${entry.hash}`);
  }

  /**
   * Raw batched insert for the REBUILD path only.
   *
   * Unlike {@link batchPut}, this:
   *  - does NOT append to the WAL — rebuild READS the WAL, so writing back
   *    would self-amplify (every rebuild would duplicate all entries into
   *    today's WAL, doubling the work of the next rebuild);
   *  - does NOT scan the table for existing hashes — the rebuild just
   *    cleared the table, so every hash is by construction absent;
   *  - preserves each entry's original `createdAt` timestamp (from the WAL
   *    entry) rather than stamping the rebuild time.
   *
   * Returns the number of records added. Callers must have already
   * generated embeddings with the current NAMESPACE model.
   */
  private async insertRebuildBatch(
    entries: Array<{ hash: string; document: WikiDocument; embedding: number[]; createdAt: string }>,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    await this.initDb();
    if (!this.table) throw new Error('Database not initialized');

    const records = entries.map(({ hash, document, embedding, createdAt }) => ({
      hash,
      domain: document.domain,
      title: document.title,
      content: document.content,
      references: JSON.stringify(document.references || []),
      embedding,
      createdAt,
    }));

    await this.table.add(records);
    return records.length;
  }

  /**
   * Rebuild vector store from all WAL files.
   *
   * Performance: the WAL is replayed in bulk, not entry-by-entry.
   *  1. Fold all WAL files into one `hash → entry` map (latest wins, so an
   *     entry re-written on a later date/line supersedes its earlier form),
   *     then filter out deleted / unapproved / foreign-namespace entries.
   *  2. Embed every surviving document in batched calls via `getEmbeddings`
   *     (one Ollama /api/embed round-trip per batch instead of one per doc).
   *  3. Insert via `insertRebuildBatch` (a single table.add per batch) with
   *     no WAL write — rebuild must not feed its own input.
   *
   * Repair: because it clears the table and re-inserts every live WAL entry
   * with `createdAt = entry.timestamp` (a COMMITTED value), rebuild also
   * heals reverse-2FC leftovers by construction:
   *   - a PREMATURE row with NO live WAL entry → cleared, never re-inserted;
   *   - a PREMATURE row WITH a live WAL entry → cleared, re-inserted committed.
   * The ANN index is refreshed at the end.
   *
   * This changes O(N) network round-trips + O(N) DB writes into O(N/batch)
   * of each. Semantics are unchanged: the namespace filter, deleted/approved
   * filters, and last-write-wins ordering all still hold.
   *
   * Batching knobs live in EMBED_BATCH_SIZE / INSERT_BATCH_SIZE. Embedding
   * is batched more conservatively than insertion because 768-dim vectors
   * make large embed payloads heavy on the Ollama side.
   */
  async rebuild(onProgress?: (progress: RebuildProgress) => void): Promise<RebuildResult> {
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

      // 1. Merge all WAL entries into one latest-wins map, applying filters.
      //    Later files (sorted ascending) and later lines within a file win,
      //    matching the previous sequential last-write-wins replay.
      const merged = new Map<string, WALEntry>();
      for (const walFile of walFiles) {
        const walPath = path.join(walDir, walFile);
        const content = fs.readFileSync(walPath, 'utf-8');
        for (const entry of parseWALFile(content)) {
          // Skip deleted and unapproved entries
          if (entry.deleted) continue;
          if (!entry.approved) continue;

          // Only rebuild entries belonging to the current namespace.
          // Entries without a namespace field are legacy (pre-rag-provider)
          // and are re-embedded with the current model on first rebuild.
          if (entry.namespace && entry.namespace !== NAMESPACE) continue;

          merged.set(entry.hash, entry); // latest wins
        }
      }

      const entries = [...merged.values()];
      if (entries.length === 0) {
        this.core.brief('info', 'wiki', 'Rebuild complete: 0 documents processed');
        return { success: true, documentsProcessed: 0, errors: [] };
      }

      const errors: string[] = [];
      let documentsProcessed = 0;

      const batchCount = Math.ceil(entries.length / EMBED_BATCH_SIZE);
      let batchIndex = 0;

      // 2 + 3. Embed and insert in batches.
      for (let i = 0; i < entries.length; i += EMBED_BATCH_SIZE) {
        batchIndex++;
        const batch = entries.slice(i, i + EMBED_BATCH_SIZE);
        try {
          const embeddings = await getEmbeddings(
            batch.map((e) => e.document.content),
            'document',
          );

          // Insert in chunks to bound the in-flight vector payload size.
          // Raw insert (no WAL write) — rebuild must not feed its own input.
          for (let j = 0; j < batch.length; j += INSERT_BATCH_SIZE) {
            const slice = batch.slice(j, j + INSERT_BATCH_SIZE);
            const putEntries = slice.map((entry, k) => ({
              hash: entry.hash,
              document: entry.document,
              embedding: embeddings[j + k],
              createdAt: entry.timestamp,
            }));
            documentsProcessed += await this.insertRebuildBatch(putEntries);
          }
        } catch (err) {
          // A failed embed batch fails all of its entries — record one error
          // per hash so the result stays informative, then continue with the
          // next batch rather than aborting the whole rebuild.
          const error = err instanceof Error ? err.message : String(err);
          for (const entry of batch) {
            errors.push(`${entry.hash} - ${error}`);
          }
          // A failed batch still advances the bar — its entries were attempted.
          documentsProcessed += batch.length;
        }

        // Report after each batch so the caller's bar advances monotonically.
        onProgress?.({
          processed: documentsProcessed,
          total: entries.length,
          batchSize: batch.length,
          batchIndex,
          batchCount,
        });
      }

      this.core.brief('info', 'wiki', `Rebuild complete: ${documentsProcessed} documents processed`);

      // Refresh the ANN index over the rebuilt corpus. Non-fatal (get() falls
      // back to the manual scan on a missing index). `replace` because the
      // table was just cleared + repopulated, so any prior index is stale.
      await this.ensureVectorIndex(true);

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
  // (moved to wiki-utils: formatDate)

  // ============================================================
  // Domain Management
  // ============================================================

  /**
   * List all registered domains
   */
  async listDomains(): Promise<WikiDomain[]> {
    return loadDomains();
  }

  /**
   * Get a specific domain by name
   */
  async getDomain(name: string): Promise<WikiDomain | undefined> {
    const domains = loadDomains();
    return domains.find(d => d.domain_name === name);
  }

  /**
   * Register a new domain (if it doesn't exist)
   */
  async registerDomain(name: string, description?: string): Promise<void> {
    const domains = loadDomains();
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

    saveDomains(domains);
    this.core.brief('info', 'wiki', `Registered domain: ${name}`);
  }
}
