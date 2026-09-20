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
 * Minimum real (non-`__schema__`) rows before `ensureVectorIndex` will build
 * an IVF index on its own (non-forced) path. Below this the table is too
 * small for a useful index — `get()` uses the manual scan until the corpus
 * grows, at which point a forced retrain (indexSkills/rebuild) builds a
 * properly-sized index. See the `ensureVectorIndex` small-table gate.
 */
const MIN_INDEX_ROWS = 16;

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
 * WikiManager - Manages persistent knowledge storage
 */
export class WikiManager implements WikiModule {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private core: CoreModule;
  private tableName = `wiki_${NAMESPACE}`;
  /** Serializes skill re-indexing across instances (see wiki-skill-index). */
  private reindexLock = new ReindexLock((msg) => this.core.brief('warn', 'wiki', msg));
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
    // Ensure a vector ANN index exists on the embedding column so get()'s
    // native vectorSearch is sublinear (#29). Idempotent — no-op if the
    // index already exists. Non-fatal on failure (get() falls back to the
    // manual scan). Not awaited-blocking on the critical path: a missing
    // index just means the first search uses the manual fallback until the
    // index finishes building.
    void this.ensureVectorIndex().catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.core.verbose('wiki', `ensureVectorIndex on init failed: ${reason}`);
    });
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
      //    We scan directly (NOT via getByDomain) because the re-index delete
      //    needs each stale record's `createdAt` to locate its WAL day-file
      //    (see deleteByHashes). getByDomain returns SearchResult which
      //    discards createdAt, so it cannot supply the WAL date. This scan
      //    also filters to the 'skills' domain server-side-in-JS, same cost
      //    as getByDomain's single full scan.
      await this.initDb();
      const existingByTitle = new Map<string, { hash: string; content: string; createdAt: string }>();
      if (this.table) {
        const records = await this.table.query().toArray();
        for (const record of records) {
          const r = record as Record<string, unknown>;
          if (r.hash === '__schema__') continue; // schema bootstrap row
          if (r.domain !== 'skills') continue;
          existingByTitle.set(r.title as string, {
            hash: r.hash as string,
            content: r.content as string,
            createdAt: r.createdAt as string,
          });
        }
      }

      // In-memory diff: partition into unchanged / stale / new
      const toDelete: Array<{ hash: string; createdAt: string }> = [];
      const toAdd: WikiDocument[] = [];
      for (const { document } of entries) {
        const found = existingByTitle.get(document.title);
        if (found && found.content === document.content) {
          continue; // unchanged
        }
        if (found) {
          toDelete.push({ hash: found.hash, createdAt: found.createdAt }); // content changed → delete old before re-add
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
          toDelete.push({ hash: rec.hash, createdAt: rec.createdAt });
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

      // Batch delete stale/orphaned records.
      //
      // SCALING (#29, peer-reviewed): the prior loop called `this.delete(hash)`
      // per hash, and EACH `delete()` did a full `table.query().toArray()`
      // scan to locate the row (for its WAL date) + a per-hash
      // `table.delete("hash = '...'")`. With C changed skills that was C
      // full table scans. Now we issue ONE batched `table.delete("hash IN
      // (...)")` for the DB side, and mark the WAL entries deleted in ONE
      // pass per day-file via deleteByHashes (grouped by createdAt date).
      //
      // WAL consistency: deleteByHashes DOES mark the WAL, like the
      // single-hash delete() — rebuild() replays every WAL file (no domain
      // filter) skipping only `deleted` entries, so an unmarked WAL entry
      // would resurrect a stale skill record on the next rebuild, colliding
      // with the re-indexed new record. Marking the WAL keeps the skills
      // domain's rebuild behavior identical to every other domain. The
      // mark is best-effort: a missing WAL file/entry is already handled
      // gracefully by markWALDeleted (it logs and continues), and the DB
      // delete is the authoritative removal.
      if (toDelete.length > 0) {
        // deleteByHashes THROWS on DB-delete failure (it does not swallow).
        // Letting the throw propagate is deliberate: if the old rows survive
        // the batched DB delete, proceeding to batchPut would insert the new
        // rows ALONGSIDE the un-deleted old ones (duplicate titles → stale +
        // new skill matches from skill_search), and writeSkillIndexCache
        // would pin the inconsistency until a later rebuild. Aborting here
        // leaves the WAL already marked (harmless — a marked entry whose row
        // still exists is a no-op until rebuild drops it) and skips the
        // cache write, so the NEXT full re-index retries from a clean slate.
        // The outer try/finally releases the reindex lock on the way out.
        await this.deleteByHashes(toDelete);
      }

      // Batch insert all new/changed documents in ONE table.add() call
      if (toAdd.length > 0) {
        const batchEntries = toAdd.map((document, i) => ({ document, embedding: embeddings[i] }));
        await this.batchPut(batchEntries);
      }

      // Retrain the ANN vector index after a mutation that changed the row
      // set (PR #18 round-4 P1 #2). initDb() builds the index fire-and-forget
      // over whatever rows exist at startup — on a FRESH install that is
      // just the `__schema__` row (countRows=1 → numPartitions=1), and the
      // `hasVectorIndex && !replace` early-return in ensureVectorIndex then
      // never retrains as the real skill corpus is inserted. LanceDB does
      // NOT auto-incorporate new rows into an existing IVF index, so without
      // this retrain the sublinear-search promise of the PR never
      // materializes on a fresh install (new rows sit unindexed). Retraining
      // here (replace:true) rebuilds the index over the now-populated table
      // with a numPartitions sized to the real row count. Fire-and-forget is
      // safe: get()'s manual-scan fallback keeps search correct while the
      // retrain runs, and a failure is logged + swallowed (non-fatal). Only
      // retrain when rows actually changed — a no-op re-index skips it.
      if (toAdd.length > 0 || toDelete.length > 0) {
        void this.ensureVectorIndex(true).catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.core.verbose('wiki', `ensureVectorIndex retrain after indexSkills failed: ${reason}`);
        });
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
    } finally {
      releaseReindexLock();
    }
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
      if (sameDocument(existing, document)) {
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
   * Search for documents by similarity.
   *
   * SCALING (#29, peer-reviewed): the prior implementation did
   * `table.query().toArray()` — a FULL TABLE SCAN that materialized EVERY
   * row across ALL domains (the wiki DB is shared across projects) into JS,
   * then a manual `cosineSimilarity` loop, then a sort + slice. That is
   * O(total_rows × dim) per search and grows without bound as the store
   * accumulates skills + wiki docs. The stale comment below it claimed
   * "vector search requires embedding column" — but the table schema
   * (initDb) DOES carry an `embedding` column, and LanceDB v0.27 exposes
   * `Table.vectorSearch(Float32Array)` which uses a native ANN index.
   *
   * This rewrite uses the native vector search:
   *   - `vectorSearch(queryEmbedding).distanceType('cosine')` ranks rows by
   *     cosine DISTANCE (lower = closer) via the ANN index — sublinear
   *     instead of O(rows).
   *   - `.where("domain = '...'")` pushes the domain predicate INTO the DB
   *     (server-side filter) instead of filtering post-materialization.
   *   - `.limit(overFetch)` caps the rows returned.
   * The distance is converted back to similarity (`1 - distance`) so the
   * threshold cut + sort + topK slice behave as before.
   *
   * RETRIEVAL CONTRACT CHANGE (approximate, not exact): once the IVF index
   * exists, `vectorSearch` is APPROXIMATE nearest-neighbor — it routes the
   * query to a subset of IVF partitions and searches only those, so a
   * semantically relevant row that falls outside the probed partitions can
   * be missed. The old exhaustive scan returned the EXACT topK; this path
   * returns an APPROXIMATE topK. For the skill/wiki store (hundreds to
   * low-thousands of rows, modest `numPartitions` via sqrt(N)) the recall
   * loss is small in practice, but it is NOT zero — callers must not treat
   * this as a transparent, result-identical optimization.
   *
   * Prefilter semantics (LanceDB v0.27.2): `.where()` defaults to a
   * PREFILTER — the domain predicate is applied BEFORE the ANN search, so
   * the search runs over the domain-filtered row set and returns up to
   * `limit` rows that ALL match the domain. (Postfiltering requires an
   * explicit `.postfilter()` call, which we do NOT make.) The over-fetch
   * (VECTOR_SEARCH_OVERFETCH × topK) is therefore not a correctness crutch
   * against postfilter shrinkage; it is a heuristic margin for the
   * client-side threshold cut + ANN ranking jitter, so a domain with many
   * sub-threshold rows still yields a full topK. It is NOT mathematically
   * guaranteed sufficient: even with a perfect ANN candidate set, the
   * threshold cut can in principle drop enough rows that a relevant row
   * just past `limit` is excluded. 4× is comfortable headroom for the
   * current corpus; tune up if a domain is dominated by sub-threshold rows.
   * If the vector search path THROWS (no index yet built, empty table, or
   * an API shape change), we fall back to the original exhaustive manual
   * scan. The fallback protects against EXCEPTIONS only — it does NOT
   * protect against an ANN query that succeeds but returns lower-recall
   * neighbors. When it fires, results revert to exact topK.
   */
  async get(query: string, options?: GetOptions): Promise<SearchResult[]> {
    await this.initDb();
    if (!this.table) return [];

    const topK = options?.topK || 5;
    const threshold = options?.threshold || 0.0;

    try {
      // Generate embedding for query
      const queryEmbedding = await getEmbedding(query, 'query');

      // Try the native vector search first (the scaling fix). On any failure
      // (no index, empty table, API change), fall back to the manual scan so
      // search results are never silently lost.
      try {
        return await this.vectorSearchGet(queryEmbedding, options, topK, threshold);
      } catch (vecErr) {
        // Vector search unavailable — fall through to the manual scan. Log at
        // verbose (not warn) so a transient index-not-ready state doesn't
        // spam; the manual path is correct, just slower.
        const reason = vecErr instanceof Error ? vecErr.message : String(vecErr);
        this.core.verbose('wiki', `vector search unavailable, falling back to manual scan: ${reason}`);
      }

      // Manual-scan fallback — the original O(rows) path. Kept for
      // correctness when the ANN index is absent (fresh table before
      // ensureVectorIndex runs, or a LanceDB API regression). Identical
      // semantics to the pre-#29 implementation.
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
   * Over-fetch multiplier for the native vector search. LanceDB v0.27.2
   * applies `.where()` as a PREFILTER (not a postfilter), so the domain
   * predicate shrinks the candidate set BEFORE the ANN search and there is
   * no postfilter topK-starvation risk. The over-fetch is therefore a
   * HEURISTIC margin for the client-side threshold cut (rows above `limit`
   * may still fall below the similarity threshold) + any ANN ranking
   * jitter, so a domain with many sub-threshold rows still yields a full
   * topK. It is NOT a mathematical guarantee — even with a perfect ANN
   * candidate set, the threshold cut can in principle drop enough rows that
   * a relevant row just past `limit` is excluded. 4× is comfortable headroom
   * for the current corpus (hundreds to low-thousands of rows); tune down
   * if the threshold cut rarely trims, up if a domain is dominated by
   * sub-threshold rows. Combined with the IVF approximate search (see the
   * get() docblock), the overall contract is APPROXIMATE topK, not exact.
   */
  private static readonly VECTOR_SEARCH_OVERFETCH = 4;

  /**
   * Native LanceDB vector-search implementation of get().
   *
   * Builds a `vectorSearch` query with a cosine distance type + a server-side
   * domain `.where()` predicate + an over-fetched `.limit()`, executes it,
   * and converts each returned row's `_distance` (LanceDB cosine distance,
   * lower = closer) back to a similarity in [0, 1] (`1 - distance`) so the
   * caller's threshold cut + sort + topK slice are unchanged. Excludes the
   * `__schema__` bootstrap row defensively (it carries a zero vector).
   *
   * Throws if the vector search is unavailable (no index, API regression) —
   * the caller (get) catches and falls back to the manual scan.
   */
  private async vectorSearchGet(
    queryEmbedding: number[],
    options: GetOptions | undefined,
    topK: number,
    threshold: number,
  ): Promise<SearchResult[]> {
    if (!this.table) return [];
    const limit = Math.max(topK * WikiManager.VECTOR_SEARCH_OVERFETCH, topK);
    // LanceDB vectorSearch takes a Float32Array; getEmbedding returns number[].
    // The high-level VectorQuery wrapper is chainable (each method returns
    // `this` / VectorQuery), so we build the query in one fluent chain.
    let vq = this.table
      .vectorSearch(Float32Array.from(queryEmbedding))
      .distanceType('cosine')
      .limit(limit);
    if (options?.domain) {
      // Server-side domain predicate — rows are filtered in the DB, not
      // materialized into JS. `where` is the high-level filter (the native
      // `onlyIf` is the low-level equivalent; the wrapper exposes `where`).
      // Single-quote-escape the domain value to keep the SQL predicate safe
      // (domain names are operator-controlled and simple, but defend in depth).
      const escaped = options.domain.replace(/'/g, "''");
      vq = vq.where(`domain = '${escaped}'`);
    }
    const rows = await vq.toArray();
    const results: SearchResult[] = [];
    for (const record of rows) {
      const r = record as Record<string, unknown>;
      // Skip the schema bootstrap row (zero vector, meaningless match).
      if (r.hash === '__schema__') continue;
      // LanceDB emits the ranked distance as `_distance` (cosine distance,
      // 0 = identical). Convert to similarity to match the manual path.
      // A MISSING _distance signals an API-shape regression — treat it as
      // unusable and throw so get()'s caller falls back to the manual scan,
      // rather than silently mapping it to similarity 1.0 (which would
      // promote a garbage row to the top of the results).
      if (typeof r._distance !== 'number') {
        throw new Error(`vector search returned a row with no _distance (hash=${r.hash}) — API shape changed`);
      }
      const similarity = 1 - r._distance;
      if (similarity < threshold) continue;
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
    // The ANN already returns distance-ordered rows, but re-sort by similarity
    // (descending) for a stable contract with the manual path + apply topK.
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Ensure a vector ANN index exists on the `embedding` column, creating it
   * (idempotently) if absent. Called after table init so subsequent
   * `vectorSearch` calls are sublinear.
   *
   * Uses IVF-Flat (not IVF-PQ): the wiki/skill store is modest (hundreds to
   * low-thousands of rows), so Flat's exact scan within IVF partitions
   * preserves cosine ranking fidelity that PQ's quantization would distort.
   * `numPartitions` scales with row count via sqrt(N) heuristic. The index
   * is rebuilt with `replace: true` only when explicitly requested (e.g.
   * after a rebuild that cleared the table); on normal startup this is a
   * no-op once the index exists (checked via listIndices).
   */
  private vectorIndexEnsured = false;
  private async ensureVectorIndex(replace = false): Promise<void> {
    if (!this.table) return;
    if (this.vectorIndexEnsured && !replace) return;
    try {
      const indices = await this.table.listIndices();
      const hasVectorIndex = indices.some(
        (idx) => idx.columns.includes('embedding') && idx.indexType !== 'BTree' && idx.indexType !== 'Scalar',
      );
      const rowCount = await this.table.countRows();
      // Don't build an IVF index over a near-empty table (PR #18 round-4
      // P1 #2). On a FRESH install initDb() creates the table with only the
      // `__schema__` bootstrap row, then fire-and-forgets this method. With
      // rowCount=1, numPartitions would be 1, and the resulting 1-partition
      // index built over a single zero-vector row would then block the
      // `hasVectorIndex && !replace` early-return from ever retraining as
      // the real skill corpus is inserted — LanceDB does not auto-add new
      // rows to an existing IVF index. So skip the build until the table
      // has at least MIN_INDEX_ROWS real rows. The gate applies even when
      // replace=true (a rebuild that wiped the table leaves only the
      // __schema__ row — nothing useful to index; get() uses the manual
      // scan, and the next indexSkills/rebuild with a real corpus builds
      // the index). The __schema__ row counts as 0 real rows, so subtract it.
      const realRows = Math.max(0, rowCount - 1);
      if (hasVectorIndex && !replace) {
        this.vectorIndexEnsured = true;
        return;
      }
      if (realRows < MIN_INDEX_ROWS) {
        // Too few rows to build a useful index; get() uses the manual scan
        // until the corpus grows. The next mutation that retrains with a
        // real corpus (indexSkills/rebuild) builds a properly-sized index.
        return;
      }
      // numPartitions heuristic: sqrt(N) is LanceDB's rule of thumb for
      // IVF. For very small tables (< 256 rows) a single partition avoids
      // a degenerate index. numPartitions must be >= 1.
      const numPartitions = Math.max(1, Math.round(Math.sqrt(Math.max(realRows, 1))));
      // IVF-Flat with cosine distance matches the vectorSearch distanceType.
      // The high-level API takes a single options object (not positional
      // args), and createIndex takes (column, options) — `config` carries
      // the Index, `replace` allows overwriting an existing/stale index.
      const index = lancedb.Index.ivfFlat({ distanceType: 'cosine', numPartitions });
      await this.table.createIndex('embedding', { config: index, replace });
      this.vectorIndexEnsured = true;
      this.core.verbose('wiki', `vector index ensured (ivfFlat cosine, ${numPartitions} partitions, ${realRows} rows)`);
    } catch (err) {
      // Index creation failure is non-fatal — vectorSearch will throw and
      // get() falls back to the manual scan. Log so it's diagnosable.
      const reason = err instanceof Error ? err.message : String(err);
      this.core.verbose('wiki', `ensureVectorIndex skipped: ${reason}`);
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
   * already exists in the table are not re-inserted and are reported with
   * alreadyExisted:true (success: true), mirroring put()'s idempotency
   * reporting. Note: batchPut skips on hash match only (it does not compare
   * references, unlike put()'s exact-match check).
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

      // Build records, collecting hashes for a single existence scan
      const hashes = new Set<string>();
      const validEntries: Array<{ document: WikiDocument; embedding: number[]; hash: string; record: Record<string, unknown>; walEntry: WALEntry }> = [];

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
        const today = formatDate(new Date());
        const walPath = path.join(walDir, `${today}.wal`);
        fs.appendFileSync(walPath, `${walLines}\n`, 'utf-8');

        this.core.brief('info', 'wiki', `Batch stored ${toInsert.length} documents`);
      }

      // Build results in original order. Mirror put()'s honest reporting:
      // a hash that was already present is flagged alreadyExisted:true rather
      // than being indistinguishable from a fresh insert.
      return validEntries.map((e) =>
        existingHashes.has(e.hash)
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
   * Delete a document by hash.
   *
   * The single-hash public delete path (the `delete` tool). Locates the row
   * via a full scan to read its `createdAt` (needed to find the WAL file),
   * deletes the LanceDB row, then marks the WAL entry deleted (audit). The
   * DB-before-WAL ordering matches {@link deleteByHashes} (PR #18): a failed
   * DB delete leaves the WAL unmarked so the row survives in both the table
   * and the WAL and rebuild() re-inserts it — no tombstone-then-fail data
   * loss. For the batched re-index path use {@link deleteByHashes}, which
   * marks the WAL too (grouped by date, one pass per day-file) but batches
   * the DB delete into a single `hash IN (...)` and reuses the caller's
   * existing scan for the `createdAt` dates — avoiding this method's
   * per-hash full scan.
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
      const walDate = formatDate(new Date(createdAt));

      // Delete from LanceDB FIRST, then mark the WAL entry deleted. This
      // matches deleteByHashes' invariant (PR #18): the WAL mark runs AFTER
      // the DB delete succeeds. The previous "mark WAL first, then delete"
      // ordering was a tombstone-then-fail data-loss window — if table.delete
      // threw here, the catch below swallowed the error and returned false,
      // leaving the WAL tombstoned while the row SURVIVED. The next rebuild()
      // (wipes the table, replays the WAL skipping `deleted` entries) would
      // then permanently drop a record the caller was told was NOT deleted.
      // With the DB delete first, a throw leaves the WAL unmarked too — the
      // row survives in BOTH the table and the WAL, so the next rebuild
      // re-inserts it and the caller can retry the delete. (The catch still
      // returns false, so a failed DB delete correctly reports failure; only
      // the WAL-mark ordering changed.)
      await this.table.delete(`hash = '${hash}'`);

      // Mark as deleted in WAL only after the DB delete succeeded (best-effort
      // audit mark; a missing WAL file/entry is logged by markWALDeleted and
      // is non-fatal — the DB delete is the authoritative removal).
      await this.markWALDeleted(hash, walDate);

      this.core.brief('info', 'wiki', `Deleted document: ${hash}`);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Delete failed: ${error}`);
      return false;
    }
  }

  /**
   * Batched delete of multiple records: ONE `table.delete("hash IN (...)")`
   * for the DB side + ONE WAL day-file pass per distinct date for the audit
   * marks. Used by the skill re-index path ({@link indexSkills}) to remove
   * stale/orphaned records without C full table scans + C per-hash WAL
   * writes.
   *
   * WAL consistency (the reason this honors the WAL unlike a naive bulk
   * delete): {@link rebuild} wipes the whole table and replays every WAL
   * file with NO domain filter, skipping only entries flagged `deleted`. An
   * unmarked WAL entry therefore resurrects its row on the next rebuild. For
   * the skills domain that means a content-changed skill's OLD record would
   * come back alongside the re-indexed NEW record → duplicate / stale
   * matches from skill_search. So deleteByHashes marks the WAL exactly like
   * the single-hash {@link delete} does — the skills domain is treated no
   * differently from any other domain.
   *
   * The WAL mark is grouped by the record's `createdAt` date (one
   * `YYYY-MM-DD.wal` file per day): all hashes sharing a date are marked in a
   * single read-parse-mark-write of that day-file, so the cost is O(distinct
   * dates) file passes, NOT O(C) per-hash. The mark runs AFTER the DB delete
   * succeeds — see the inline ordering note for the data-loss window this
   * closes. A hash whose WAL file/entry is already gone is handled gracefully
   * by {@link markWALDeletedBatch} (it logs and continues).
   *
   * Hashes are validated against {@link HASH_PATTERN} and single-quote
   * escaped before being interpolated into the SQL `IN (...)` predicate.
   * Rejects the whole batch on any invalid hash (a partial delete would
   * leave the re-index diff inconsistent). THROWS on DB-delete failure (it
   * does NOT swallow the error) — the caller (indexSkills) relies on this
   * to abort before inserting new rows or writing the skill-index cache, so
   * a failed delete cannot leave the store with old+new duplicate rows
   * pinned by a stale cache.
   *
   * @param records - `{ hash, createdAt }` pairs. `createdAt` is the stored
   *   ISO timestamp used to locate the WAL day-file; supplied by the caller
   *   (indexSkills) from its existing table scan, so this method adds NO
   *   extra DB scan.
   */
  async deleteByHashes(records: Array<{ hash: string; createdAt: string }>): Promise<void> {
    if (records.length === 0) return;

    // Validate every hash up front. Reject the whole batch on any invalid
    // hash by THROWING (not silently returning) — a partial delete would
    // leave the re-index diff inconsistent, and a silent return lets the
    // caller (indexSkills) proceed to batchPut + writeSkillIndexCache,
    // pinning the very old+new duplicate-rows state the throw-on-DB-failure
    // contract below exists to prevent. indexSkills' try/finally releases
    // the reindex lock on the throw.
    for (const { hash } of records) {
      if (!HASH_PATTERN.test(hash)) {
        throw new Error(`deleteByHashes: invalid hash format: ${hash}`);
      }
    }

    await this.initDb();
    if (!this.table) {
      // THROW (not return) so indexSkills aborts before batchPut/cache write
      // — mirroring the invalid-hash throw above and the DB-delete throw
      // below. A silent return here would let the re-index proceed as if
      // the delete succeeded.
      throw new Error('deleteByHashes: database not initialized');
    }

    // Order matters for the data-loss window (PR #18 round-4 P1):
    // mark the WAL AFTER the DB delete succeeds. rebuild() wipes the whole
    // table (table.delete('true')) then replays the WAL, skipping entries
    // flagged `deleted`. If we tombstoned the WAL BEFORE the DB delete and
    // the DB delete then FAILED, the row would survive in the table while
    // the WAL says it's deleted — a later rebuild would wipe the table and
    // skip the (tombstoned) WAL entry, so the row would be PERMANENTLY LOST
    // with no re-insert (A gone, A' never inserted). Doing the WAL mark
    // AFTER the DB delete closes that window: on a throw, the WAL is still
    // un-deleted, so the row survives in BOTH the table and the WAL → the
    // next rebuild re-inserts it, and the next re-index retries the
    // replace from a consistent-old state. The single-hash delete() uses
    // the SAME DB-before-WAL ordering (PR #18 round-4): on a failed DB
    // delete it returns false without tombstoning the WAL, so the row
    // survives in both the table and the WAL and rebuild() re-inserts it —
    // same invariant, same reason, for both paths.
    const inList = records
      .map(({ hash }) => `'${hash.replace(/'/g, "''")}'`)
      .join(', ');
    // THROWS on DB failure (does NOT swallow): the caller (indexSkills) must
    // NOT proceed to batchPut + writeSkillIndexCache if the old rows survive
    // — otherwise the new rows are inserted alongside the un-deleted old
    // ones (duplicate titles) and the cache is written as valid, pinning the
    // inconsistency until a later rebuild. Because the WAL mark is performed
    // AFTER this succeeds (below), a throw here leaves the WAL un-deleted too
    // — the row survives in BOTH the table and the WAL, so the next rebuild
    // re-inserts it (no permanent data loss) and the next re-index retries.
    await this.table.delete(`hash IN (${inList})`);
    this.core.brief('info', 'wiki', `Batch deleted ${records.length} records`);

    // Mark the WAL entries deleted, grouped by date so each day-file is
    // read+written at most once (one pass per distinct date, not O(C)).
    // Done AFTER the DB delete succeeds (see the ordering note above) so a
    // failed DB delete cannot tombstone a row that still survives in the
    // table — closing the rebuild→data-loss window. Best-effort: a missing
    // WAL file/entry is logged and skipped, never fatal.
    await this.markWALDeletedBatch(records);
  }

  /**
   * Mark multiple WAL entries as deleted, grouping by date so each WAL
   * day-file (`YYYY-MM-DD.wal`) is read + written at most once. Batched
   * counterpart to {@link markWALDeleted}. Best-effort: a missing WAL file
   * or a hash with no matching entry in its day-file is logged and skipped
   * (the entry may already have aged out, or the record predated the WAL).
   *
   * @param records - `{ hash, createdAt }` pairs. `createdAt` selects the
   *   day-file; hashes sharing a date are marked together in one pass.
   */
  private async markWALDeletedBatch(records: Array<{ hash: string; createdAt: string }>): Promise<void> {
    if (records.length === 0) return;
    ensureDirs();
    const walDir = getWikiLogsDir();

    // Group hashes by their WAL date (derived from createdAt).
    const byDate = new Map<string, Set<string>>();
    for (const { hash, createdAt } of records) {
      let date: string;
      try {
        date = formatDate(new Date(createdAt));
      } catch {
        // Unparseable createdAt — skip the WAL mark for this hash (the DB
        // delete is authoritative). Log so it's diagnosable.
        this.core.brief('warn', 'wiki', `markWALDeletedBatch: unparseable createdAt for ${hash}: ${createdAt}`);
        continue;
      }
      let set = byDate.get(date);
      if (!set) {
        set = new Set();
        byDate.set(date, set);
      }
      set.add(hash);
    }

    for (const [date, hashSet] of byDate) {
      const walPath = path.join(walDir, `${date}.wal`);
      if (!fs.existsSync(walPath)) {
        this.core.brief('warn', 'wiki', `WAL file not found for date ${date} (${hashSet.size} hashes)`);
        continue;
      }
      const content = fs.readFileSync(walPath, 'utf-8');
      const entries = parseWALFile(content);

      // Mark every matching entry deleted. A WAL day-file may legally hold
      // multiple entries for the same hash (re-puts); mark them all.
      let marked = 0;
      for (const entry of entries) {
        if (entry.deleted) continue;
        if (hashSet.has(entry.hash)) {
          entry.deleted = true;
          marked++;
        }
      }
      if (marked === 0) {
        // None of the hashes were in this day-file — already aged out or
        // never WAL-written. Skip the rewrite (no-op) but log for diagnosis.
        this.core.brief('warn', 'wiki', `markWALDeletedBatch: 0/${hashSet.size} hashes found in WAL ${date}`);
        continue;
      }
      const lines = entries.map((e) => JSON.stringify(e)).join('\n');
      fs.writeFileSync(walPath, `${lines}\n`, 'utf-8');
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
        // The table was just wiped (table.delete('true') above). Refresh
        // the ANN index (replace:true) so the next get() uses a live index
        // instead of a dead one pointing at deleted row IDs. AWAITED (not
        // fire-and-forget) so "rebuild succeeded" means the index refresh
        // was kicked off (PR #18 round-4 P1 #3). CAVEAT: LanceDB
        // createIndex returns once creation is STARTED, not once the index
        // is fully trained — the await resolves at "index registered", not
        // "index trained" (indices.d.ts:670-673). So the next get() may still
        // take the manual-scan fallback path briefly while training
        // completes in the background; that path is correct, just slower.
        // Passing waitTimeoutSeconds would block until trained, but that
        // would make rebuild wait on a background task — the manual-scan
        // fallback is the cheaper correctness bridge. ensureVectorIndex is
        // non-fatal: it logs + swallows index failures (get() falls back to
        // the manual scan), so awaiting it never makes rebuild throw on
        // index issues. Note: with the table empty (only __schema__ after
        // the wipe) the small-table gate skips the build — nothing useful
        // to index; the next indexSkills with a real corpus builds it.
        await this.ensureVectorIndex(true);
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

      // F3: the table was wiped at the start of this rebuild
      // (table.delete('true')), so the ANN vector index built over the OLD
      // rows is stale — it points at row IDs that no longer exist. Refresh
      // it now over the freshly re-inserted rows so the next get() uses a
      // live index instead of searching a dead one (which would throw and
      // fall back to the slow manual scan on every query until some other
      // path rebuilt the index). `replace: true` forces a rebuild over the
      // freshly re-inserted rows. AWAITED (not fire-and-forget) so "rebuild
      // succeeded" means the index refresh was kicked off (PR #18 round-4
      // P1 #3). CAVEAT: LanceDB createIndex returns once creation is
      // STARTED, not once trained — the await resolves at "index
      // registered", not "index trained" (indices.d.ts:670-673). The next
      // get() may therefore still take the manual-scan fallback briefly
      // while training completes in the background; that path is correct,
      // just slower (see the matching caveat in the zero-doc branch above).
      // ensureVectorIndex is non-fatal: it logs + swallows index failures
      // (get() falls back to the manual scan), so awaiting it never makes
      // rebuild throw on index issues.
      await this.ensureVectorIndex(true);

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
