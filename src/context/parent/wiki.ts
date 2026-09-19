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
    void this.ensureVectorIndex().catch(() => { /* logged inside */ });
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

      // Batch delete stale/orphaned records.
      //
      // SCALING (#29, peer-reviewed): the prior loop called `this.delete(hash)`
      // per hash, and EACH `delete()` did a full `table.query().toArray()`
      // scan to locate the row (for its WAL date) + a per-hash
      // `table.delete("hash = '...'")`. With C changed skills that was C
      // full table scans. Now we issue ONE batched `table.delete("hash IN
      // (...)")` for the DB side, and mark WAL deleted per-hash via the
      // lightweight `markWALDeletedByHash` helper (file I/O, no DB scan).
      // The WAL mark is best-effort: a missing WAL entry is already handled
      // gracefully by markWALDeleted (it logs and continues), and the DB
      // delete is the authoritative removal.
      if (toDelete.length > 0) {
        await this.deleteByHashes(toDelete);
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
   * ANN + prefilter caveat: with an IVF index, `.where()` is applied as a
   * POSTFILTER on the ANN's top-N candidates, so a highly selective domain
   * predicate can return fewer than `limit` rows. We over-fetch
   * (VECTOR_SEARCH_OVERFETCH × topK) to compensate, and the skills domain is
   * a large fraction of rows so this is not a practical problem. If the
   * vector search path throws (no index yet built, empty table, or an API
   * shape change), we fall back to the original manual scan so correctness
   * is never lost — only the optimization is.
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
   * Over-fetch multiplier for the native vector search. With an IVF index
   * the domain `.where()` runs as a postfilter on the ANN's candidates, so
   * we fetch `VECTOR_SEARCH_OVERFETCH × topK` rows and then apply the
   * threshold + slice client-side. 4× is a safe margin for the skills
   * domain (a large fraction of rows); tune up if a highly-selective
   * domain ever returns fewer than topK after the postfilter.
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
      const distance = typeof r._distance === 'number' ? r._distance : 0;
      const similarity = 1 - distance;
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
      if (hasVectorIndex && !replace) {
        this.vectorIndexEnsured = true;
        return;
      }
      // numPartitions heuristic: sqrt(N) is LanceDB's rule of thumb for
      // IVF. For very small tables (< 256 rows) a single partition avoids
      // a degenerate index. numPartitions must be >= 1.
      const rowCount = await this.table.countRows();
      const numPartitions = Math.max(1, Math.round(Math.sqrt(Math.max(rowCount, 1))));
      // IVF-Flat with cosine distance matches the vectorSearch distanceType.
      // The high-level API takes a single options object (not positional
      // args), and createIndex takes (column, options) — `config` carries
      // the Index, `replace` allows overwriting an existing/stale index.
      const index = lancedb.Index.ivfFlat({ distanceType: 'cosine', numPartitions });
      await this.table.createIndex('embedding', { config: index, replace });
      this.vectorIndexEnsured = true;
      this.core.verbose('wiki', `vector index ensured (ivfFlat cosine, ${numPartitions} partitions, ${rowCount} rows)`);
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
   * marks the WAL entry deleted (audit), then deletes the LanceDB row. This
   * is the per-hash path — for batched re-index deletes use
   * {@link deleteByHashes} which skips the per-hash WAL mark + scan.
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
   * Batched DB-only delete of multiple hashes in ONE `table.delete(...)`
   * call. Used by the skill re-index path ({@link indexSkills}) to remove
   * stale/orphaned records without C full table scans + C per-hash WAL
   * marks.
   *
   * Unlike {@link delete}, this does NOT mark WAL entries deleted: the
   * re-index path is a wholesale replacement of the skills domain's
   * records, not an audited user delete — consistent with the write side
   * ({@link batchPut} and {@link insertRebuildBatch} which also skip WAL
   * on the bulk paths). The DB row removal is authoritative; a missing WAL
   * mark is handled gracefully by {@link markWALDeleted} during a rebuild.
   *
   * Hashes are validated against {@link HASH_PATTERN} and single-quote
   * escaped before being interpolated into the SQL `IN (...)` predicate.
   */
  async deleteByHashes(hashes: string[]): Promise<void> {
    if (hashes.length === 0) return;
    await this.initDb();
    if (!this.table) return;

    // Validate + escape every hash. Reject the whole batch on any invalid
    // hash — a partial delete would leave the re-index diff inconsistent
    // (the caller expects all stale records gone).
    const escaped: string[] = [];
    for (const hash of hashes) {
      if (!HASH_PATTERN.test(hash)) {
        this.core.brief('error', 'wiki', `deleteByHashes: invalid hash format: ${hash}`);
        return;
      }
      escaped.push(hash.replace(/'/g, "''"));
    }

    try {
      const inList = escaped.map((h) => `'${h}'`).join(', ');
      await this.table.delete(`hash IN (${inList})`);
      this.core.brief('info', 'wiki', `Batch deleted ${hashes.length} records`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `deleteByHashes failed: ${error}`);
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
