/**
 * wiki.ts - WikiManager for persistent memory
 *
 * Manages knowledge storage using LanceDB for vector similarity search.
 * Uses WAL files for audit and rebuild capabilities.
 */

import * as lancedb from '@lancedb/lancedb';
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
import { getWikiDbDir, ensureDirs } from '../../config.js';
import {
  HASH_PATTERN,
  generateHash,
  sameDocument,
  loadDomains,
  saveDomains,
} from './wiki-utils.js';
import { SkillIndexer } from './wiki-skill-index.js';
import {
  readWAL,
  appendWALEntry,
  appendWALEntries,
  mergeWALEntries,
} from './wiki-wal.js';

const DUPLICATE_THRESHOLD = 0.95;
const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 1000;

/**
 * Column name of the one-way lifecycle state carried by every row.
 *
 * Values (never compared in JS — always filtered in SQL, because LanceDB may
 * hand `state` back as a BigInt after schema inference):
 *  - {@link WIKI_STATE_PENDING} 0: written to the DB but NOT yet solidified by
 *    the WAL (in-flight phase 1 of the 2-phase commit). Not readable.
 *  - {@link WIKI_STATE_LIVE}    1: in the DB AND in the WAL. The ONLY readable
 *    state — every read predicates on `state = 1`.
 *  - {@link WIKI_STATE_SUBMERGED} 2: logically deleted (tombstoned in the WAL);
 *    hidden from reads and swept by {@link WikiManager.gc}.
 */
const STATE_COLUMN = 'state';
const WIKI_STATE_PENDING = 0;
const WIKI_STATE_LIVE = 1;
const WIKI_STATE_SUBMERGED = 2;

/**
 * The sentinel row that seeds a fresh table's schema. LanceDB infers the
 * column set (including the `state` column) from the first record, so every
 * freshly created table carries `state` from birth. The row itself is never a
 * document: reads exclude it via `hash != '__schema__'`.
 */
function schemaSentinelRow(): Record<string, unknown> {
  return {
    hash: '__schema__',
    domain: '',
    title: '',
    content: '',
    references: '[]',
    embedding: new Array(EMBEDDING_DIM).fill(0),
    createdAt: new Date().toISOString(),
    [STATE_COLUMN]: WIKI_STATE_PENDING,
  };
}

/**
 * Thrown when an existing wiki table predates the `state` column. There is no
 * migration path: the recovery is `/wiki rebuild`, which drops and recreates
 * the table from the WAL. The error message tells the user exactly that.
 *
 * This is deliberately thrown (not swallowed) so it propagates out of every
 * public method's catch and the user sees a loud, actionable error instead of
 * a silent "no documents found".
 */
export class WikiSchemaError extends Error {
  constructor() {
    super('Wiki database schema is outdated (missing the "state" column). Run /wiki rebuild to recreate the database.');
    this.name = 'WikiSchemaError';
  }
}

/** Escape a value for use inside a single-quoted SQL string literal. */
function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * The predicate every read applies: only LIVE rows, excluding the schema
 * sentinel. Centralised so no read path forgets the `state = 1` gate.
 */
const SEARCHABLE_PREDICATE = `${STATE_COLUMN} = ${WIKI_STATE_LIVE} AND hash != '__schema__'`;

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
  /** Owns skill re-indexing (cache, batch diff, orphan sweep, cross-instance lock). */
  private skillIndexer = new SkillIndexer(
    this,
    (message) => this.core.brief('info', 'wiki', message),
  );
  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Initialize the database connection.
   *
   * Opens the existing table (validating the `state` column, then sweeping
   * submerged rows) or creates a fresh one seeded with the `state` schema.
   *
   * A table whose schema predates the `state` column is NOT migrated: we fail
   * fast with {@link WikiSchemaError} so the user runs `/wiki rebuild` (which
   * goes through {@link recreateTable}) to regenerate the DB from the WAL.
   */
  private async initDb(): Promise<void> {
    if (this.db && this.table) return;

    ensureDirs();
    const dbPath = getWikiDbDir();

    this.db = await lancedb.connect(dbPath);

    const tables = await this.db.tableNames();
    if (tables.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);
      await this.assertStateSchema(this.table);
      await this.gc();
    } else {
      this.table = await this.db.createTable(this.tableName, [schemaSentinelRow()]);
    }
  }

  /**
   * Fail fast if the opened table lacks the `state` column. Loud by design —
   * the thrown error carries the `/wiki rebuild` instruction and is rethrown
   * (not swallowed) by every caller's catch.
   */
  private async assertStateSchema(table: lancedb.Table): Promise<void> {
    const schema = await table.schema();
    const hasState = schema.fields.some((f) => f.name === STATE_COLUMN);
    if (!hasState) {
      this.core.brief('error', 'wiki', 'Wiki DB schema is outdated — run /wiki rebuild to recreate it.');
      throw new WikiSchemaError();
    }
  }

  /**
   * Sweep submerged rows (`state = 2`). Submerged rows are logically deleted
   * documents awaiting physical collection; they accumulate between rebuilds,
   * so we collect them once whenever an existing table is opened. Best-effort:
   * a GC failure must never block the DB from being used.
   */
  private async gc(): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.delete(`${STATE_COLUMN} = ${WIKI_STATE_SUBMERGED}`);
    } catch {
      // GC is opportunistic — a failure here is not fatal.
    }
  }

  /**
   * Rethrow a {@link WikiSchemaError} so the stale-schema fail-fast is never
   * swallowed by a method's catch (which would otherwise degrade it to a
   * silent empty result). Any other error keeps its existing handling — the
   * caller decides; this helper only guarantees the schema error escapes.
   */
  private rethrowSchema(err: unknown): Error {
    if (err instanceof WikiSchemaError) throw err;
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * Drop and recreate the table with the current schema. Used ONLY by
   * {@link rebuild}: it deliberately bypasses {@link initDb} so a stale-schema
   * table can be regenerated from the WAL instead of failing fast.
   */
  private async recreateTable(): Promise<void> {
    ensureDirs();
    const dbPath = getWikiDbDir();
    this.db = await lancedb.connect(dbPath);

    const tables = await this.db.tableNames();
    if (tables.includes(this.tableName)) {
      await this.db.dropTable(this.tableName);
    }
    this.table = await this.db.createTable(this.tableName, [schemaSentinelRow()]);
  }

  // ============================================================
  // Skill Re-index (wiki-DB-level) — orchestration lives in
  // wiki-skill-index.ts (see SkillIndexer); this is the thin delegate that
  // satisfies the WikiModule contract.
  // ============================================================

  /**
   * Re-index a set of skills into the wiki "skills" domain.
   *
   * The caller (loader) builds the {@link SkillIndexEntry} array — it owns
   * skill discovery and scoping. The batch re-index (cache check, table diff,
   * orphan sweep, batched embed/insert/delete, cache write) and its
   * cross-instance lock live in {@link SkillIndexer}; this method only wires
   * the wiki store and the brief sink into it, keeping the WikiManager class
   * focused on LanceDB lifecycle and the document-storage contract.
   */
  async indexSkills(entries: SkillIndexEntry[], options?: { skipOrphanSweep?: boolean }): Promise<void> {
    await this.skillIndexer.index(entries, options);
  }

  /**
   * Check if a similar document exists, using LanceDB's native cosine search.
   * A single nearest-neighbour probe: a hit above the threshold is a duplicate.
   */
  private async checkDuplicate(embedding: number[], threshold = DUPLICATE_THRESHOLD): Promise<boolean> {
    await this.initDb();
    if (!this.table) return false;

    const rows = await this.table
      .vectorSearch(embedding)
      .distanceType('cosine')
      .where(SEARCHABLE_PREDICATE)
      .limit(1)
      .toArray();

    if (rows.length === 0) return false;
    const similarity = 1 - Number((rows[0] as Record<string, unknown>)._distance);
    if (similarity > threshold) {
      const r = rows[0] as Record<string, unknown>;
      this.core.brief('warn', 'wiki', `Duplicate check hit: similarity=${similarity.toFixed(4)} > ${threshold}, colliding doc: domain=${r.domain}, title=${r.title}, hash=${r.hash}`);
      return true;
    }
    return false;
  }

  /**
   * Fetch the stored LIVE record for a given hash, or null if absent.
   * Used by put() to decide whether an incoming document is an exact copy
   * (full document match: domain + title + content + references) of one
   * already in the store — only an exact copy is a true no-op eligible for
   * the alreadyExisted short-circuit. The hash is a fast lookup; the
   * full-document comparison (sameDocument) is what actually decides.
   */
  private async findRecordByHash(hash: string): Promise<Record<string, unknown> | null> {
    await this.initDb();
    if (!this.table) return null;

    const rows = await this.table
      .query()
      .where(`${STATE_COLUMN} = ${WIKI_STATE_LIVE} AND hash = '${escapeSqlLiteral(hash)}'`)
      .toArray();
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
  }

  /**
   * Map a raw LanceDB row to a {@link SearchResult}. `similarity` is passed in
   * (native search derives it from `_distance`; non-search listings pass 1).
   */
  private rowToSearchResult(r: Record<string, unknown>, similarity: number): SearchResult {
    return {
      document: {
        domain: r.domain as string,
        title: r.title as string,
        content: r.content as string,
        references: JSON.parse((r.references as string) || '[]'),
      },
      similarity,
      hash: r.hash as string,
    };
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

      const timestamp = new Date().toISOString();

      // --- 2-phase commit ---------------------------------------------------
      // Phase 1: write the row PENDING (state = 0) — durable in the DB but
      // NOT readable, so a concurrent reader can never see a doc that has not
      // been recorded in the WAL.
      const record: Record<string, unknown> = {
        hash,
        domain: document.domain,
        title: document.title,
        content: document.content,
        references: JSON.stringify(document.references || []),
        embedding,
        createdAt: timestamp,
        [STATE_COLUMN]: WIKI_STATE_PENDING,
      };
      await this.table.add([record]);

      // Phase 2: append the WAL entry — the durable source of truth a rebuild
      // replays. If this throws, the PENDING row is left behind (invisible to
      // reads) and will be reconciled by the next rebuild.
      await this.appendWAL({
        timestamp,
        hash,
        document,
        approved: true,
        namespace: NAMESPACE,
      });

      // Phase 3: solidify — flip PENDING → LIVE. Only now is the row readable.
      await this.table.update({
        where: `${STATE_COLUMN} = ${WIKI_STATE_PENDING} AND hash = '${escapeSqlLiteral(hash)}'`,
        values: { [STATE_COLUMN]: WIKI_STATE_LIVE },
      });

      this.core.brief('info', 'wiki', `Stored document: ${document.title}`);
      return { success: true, hash };
    } catch (err) {
      if (err instanceof WikiSchemaError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Put failed: ${error}`);
      return { success: false, hash, error };
    }
  }

  /**
   * Search for documents by similarity, using LanceDB's native cosine vector
   * search (nearest neighbours by `_distance`), restricted to LIVE rows.
   */
  async get(query: string, options?: GetOptions): Promise<SearchResult[]> {
    await this.initDb();
    if (!this.table) return [];

    const topK = options?.topK || 5;
    const threshold = options?.threshold || 0.0;

    try {
      // Generate embedding for query
      const queryEmbedding = await getEmbedding(query, 'query');

      // Native cosine search. `_distance` = cosine distance = 1 - similarity.
      // Filter by state and (optionally) domain BEFORE the search.
      const predicate = options?.domain
        ? `${SEARCHABLE_PREDICATE} AND domain = '${escapeSqlLiteral(options.domain)}'`
        : SEARCHABLE_PREDICATE;

      const rows = await this.table
        .vectorSearch(queryEmbedding)
        .distanceType('cosine')
        .where(predicate)
        .limit(topK)
        .toArray();

      const results: SearchResult[] = [];
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const similarity = 1 - Number(r._distance);
        if (similarity >= threshold) {
          results.push(this.rowToSearchResult(r, similarity));
        }
      }

      // Native search already returns nearest-first; keep that order.
      return results;
    } catch (err) {
      throw this.rethrowSchema(err);
    }
  }

  /**
   * Retrieve all LIVE documents in a domain via a scalar filter (no
   * embedding). Used for batch re-indexing where a full domain listing is
   * needed without the per-query embedding cost of get().
   */
  async getByDomain(domain: string): Promise<SearchResult[]> {
    await this.initDb();
    if (!this.table) return [];

    try {
      const rows = await this.table
        .query()
        .where(`${STATE_COLUMN} = ${WIKI_STATE_LIVE} AND domain = '${escapeSqlLiteral(domain)}'`)
        .toArray();

      return rows.map((row) => this.rowToSearchResult(row as Record<string, unknown>, 1));
    } catch (err) {
      throw this.rethrowSchema(err);
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
            [STATE_COLUMN]: WIKI_STATE_PENDING,
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

      // Single filtered scan to find which hashes are already LIVE (skip them).
      // Only LIVE rows count as "present" — a PENDING leftover must be treated
      // as absent so it gets (re-)written and solidified.
      const hashList = [...hashes].map((h) => `'${escapeSqlLiteral(h)}'`).join(', ');
      const existingHashes = new Set<string>();
      if (hashes.size > 0) {
        const records = await this.table
          .query()
          .where(`${STATE_COLUMN} = ${WIKI_STATE_LIVE} AND hash IN (${hashList})`)
          .toArray();
        for (const record of records) {
          existingHashes.add((record as Record<string, unknown>).hash as string);
        }
      }

      const toInsert = validEntries.filter((e) => !existingHashes.has(e.hash));

      // Single batch insert
      if (toInsert.length > 0) {
        // Phase 1: write PENDING rows.
        await this.table.add(toInsert.map((e) => e.record));

        // Phase 2: single batched WAL append.
        appendWALEntries(toInsert.map((e) => e.walEntry));

        // Phase 3: solidify all inserted rows in one update.
        const insertedList = toInsert.map((e) => `'${escapeSqlLiteral(e.hash)}'`).join(', ');
        await this.table.update({
          where: `${STATE_COLUMN} = ${WIKI_STATE_PENDING} AND hash IN (${insertedList})`,
          values: { [STATE_COLUMN]: WIKI_STATE_LIVE },
        });

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
      if (err instanceof WikiSchemaError) throw err;
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
      // Look up the LIVE row for this hash.
      const existing = await this.findRecordByHash(hash);
      if (!existing) {
        this.core.brief('warn', 'wiki', `Document not found: ${hash}`);
        return false;
      }

      // Reconstruct the document from the stored row so the WAL tombstone
      // carries the full entry (a rebuild folds tombstones by hash, and the
      // exported WAL stays self-describing).
      const document: WikiDocument = {
        domain: existing.domain as string,
        title: existing.title as string,
        content: existing.content as string,
        references: JSON.parse((existing.references as string) || '[]'),
      };
      const timestamp = new Date().toISOString();

      // --- Remove = tombstone (WAL) + submerge (DB) -------------------------
      // Phase 1: append a deleted:true tombstone. Because the fold is
      // last-write-wins, this supersedes the live entry on any rebuild.
      appendWALEntry({
        timestamp,
        hash,
        document,
        approved: true,
        deleted: true,
        namespace: NAMESPACE,
      });

      // Phase 2: submerge — flip the row to state 2. It becomes invisible to
      // reads and is swept by the next GC/rebuild (never physically deleted
      // here, keeping the DB write-once-read-many).
      await this.table.update({
        where: `hash = '${escapeSqlLiteral(hash)}'`,
        values: { [STATE_COLUMN]: WIKI_STATE_SUBMERGED },
      });

      this.core.brief('info', 'wiki', `Deleted document: ${hash}`);
      return true;
    } catch (err) {
      if (err instanceof WikiSchemaError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Delete failed: ${error}`);
      return false;
    }
  }

  /**
   * Get WAL entries for a specific date (default: today).
   * Delegates to wiki-wal.
   */
  async getWAL(date?: string): Promise<WALEntry[]> {
    return readWAL(date);
  }

  /**
   * Append entry to today's WAL (delegates to wiki-wal).
   */
  async appendWAL(entry: WALEntry): Promise<void> {
    appendWALEntry(entry);
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
      [STATE_COLUMN]: WIKI_STATE_LIVE,
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
      // Rebuild recreates the table from scratch (dropping a stale-schema table
      // in the process) — it deliberately does NOT go through initDb(), whose
      // fail-fast would reject exactly the outdated schema a rebuild exists to
      // fix. Every replayed row is written LIVE (state = 1) directly.
      await this.recreateTable();
      if (!this.table) {
        return { success: false, documentsProcessed: 0, errors: ['Database not initialized'] };
      }

      // 1. Merge all WAL entries into one latest-wins map, applying filters
      //    (deleted / unapproved / foreign-namespace). Delegates to wiki-wal.
      const entries = mergeWALEntries(NAMESPACE);
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
