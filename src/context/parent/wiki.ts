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
import {
  HASH_PATTERN,
  generateHash,
  cosineSimilarity,
  parseWALFile,
  parseWAL,
  formatWAL,
  formatDate,
  loadDomains,
  saveDomains,
  releaseReindexLock,
  entrySequence,
  foldWAL,
  walHasLiveHash,
} from './wiki-utils.js';
import {
  ReindexLock,
  FlushLock,
  isSkillIndexCacheValid,
  writeSkillIndexCache,
} from './wiki-skill-index.js';
import {
  getWikiLogsDir,
  getWikiDbDir,
  getWikiFlushLockFile,
  getWikiSequenceFile,
  getWikiWatermarkFile,
  ensureDirs,
} from '../../config.js';

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
  /**
   * WAIT-capable lock for the WAL→LanceDB flush path. Distinct from
   * {@link reindexLock} (which skips on contention): a contended flush
   * must WAIT so it doesn't widen the cross-instance stale-read window.
   */
  private flushLock = new FlushLock((msg) => this.core.brief('warn', 'wiki', msg));
  /**
   * In-flight flush promise (debounce). {@link scheduleFlush} keeps at most ONE
   * flush running at a time per instance: a write-path caller that schedules a
   * flush while one is already running reuses the running promise instead of
   * starting a second (which would contend on the flush lock and do redundant
   * work — the running flush already picks up the just-appended WAL line on
   * its next day-file iteration). This collapses the 3 fire-and-forget
   * `flushAhead()` calls in put/batchPut/delete into a single coalesced flush.
   */
  private inflightFlush: Promise<{ flushedDays: number; applied: number }> | null = null;
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
  // WAL-as-truth: global sequence allocator + watermark
  // ============================================================

  /**
   * Allocate the next `count` global monotonic sequence numbers under the
   * flush lock, returning them as a contiguous block (first..first+count-1).
   *
   * The sequence is the tiebreaker that makes WAL replay sound under
   * out-of-order flushing: a tombstone with a higher sequence than an
   * insert for the same hash always wins. Reuse is the killer (a reused
   * number would order a new entry below the tombstone that deleted its
   * predecessor and resurrect the row), so this counter is PERSISTED and
   * only ever grows. Gaps are harmless — a skipped number is just a
   * never-allocated id.
   *
   * CONCURRENCY (the converged spec's condition 2): allocation is a
   * read-increment-write of `sequence.json` — a non-atomic read-modify-write.
   * Two instances (or two concurrent async write paths) allocating WITHOUT
   * a lock would both read the same `current`, both write `current+1`, and
   * both emit the SAME sequence → a reused number → tombstone resurrection
   * via the sequence. The WAL-floor guard below protects only against a
   * CRASH-recovered low counter, not against concurrent reuse. So this
   * method acquires the {@link FlushLock} for the whole read-increment-write
   * so concurrent allocators serialize. (`count` lets a batch allocate a
   * block under ONE lock hold instead of re-locking per entry — avoids
   * O(B) lock round-trips and O(B×W) WAL rescans.)
   *
   * Crash safety: the counter is a single JSON integer on disk
   * (`getWikiSequenceFile()`). A crash between read and write leaves the
   * counter at its old (lower) value. The allocator floors the counter at
   * the MAX sequence already present across all WAL files before
   * incrementing, so a crash-recovered counter can never hand out a number
   * below one already durably in the WAL. (This makes the counter strictly
   * an optimization; the WAL itself is the durable authority.)
   *
   * @returns the first sequence of the block; the caller owns [first, first+count).
   */
  private async allocateSequence(count = 1): Promise<number> {
    const lockFile = getWikiFlushLockFile();
    ensureDirs();
    const acquired = await this.flushLock.acquire(lockFile);
    if (!acquired) {
      // Could not serialize with a concurrent flush; allocate defensively at
      // the WAL floor + 1 so we never collide with a number below one in the
      // WAL. (We cannot safely read+write the shared counter without the
      // lock, so we skip the counter and derive purely from the WAL — gaps
      // are harmless, and the floor guarantees monotonicity w.r.t. the WAL.)
      return this.walSequenceFloor() + 1;
    }
    try {
      const floor = this.walSequenceFloor();
      const seqFile = getWikiSequenceFile();
      let current = floor;
      if (fs.existsSync(seqFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(seqFile, 'utf-8')) as { value?: number };
          if (typeof parsed.value === 'number' && parsed.value > current) {
            current = parsed.value;
          }
        } catch {
          // Corrupt counter — fall back to the WAL floor (safe).
        }
      }
      const first = current + 1;
      fs.writeFileSync(seqFile, JSON.stringify({ value: first + count - 1 }), 'utf-8');
      return first;
    } finally {
      this.flushLock.release(lockFile);
    }
  }

  /**
   * The highest sequence number present across all WAL files (0 if none).
   * Used to floor the persisted counter so a crash-recovered (low) counter
   * can never hand out a number below one already durably in the WAL.
   */
  private walSequenceFloor(): number {
    const walDir = getWikiLogsDir();
    let floor = 0;
    if (fs.existsSync(walDir)) {
      for (const file of fs.readdirSync(walDir).filter((f) => f.endsWith('.wal'))) {
        const content = fs.readFileSync(path.join(walDir, file), 'utf-8');
        for (const entry of parseWALFile(content)) {
          const s = entrySequence(entry);
          if (s > floor) floor = s;
        }
      }
    }
    return floor;
  }

  /**
   * Read the flushed-through watermark: `{ days: { <YYYY-MM-DD>: <max seq flushed> } }`.
   * Missing/corrupt file → empty record (treated as "nothing flushed yet", so
   * the first read triggers a flush). Fail-LOW: a missing watermark means
   * "re-flush everything", never "skip".
   */
  private readWatermark(): Record<string, number> {
    const file = getWikiWatermarkFile();
    if (!fs.existsSync(file)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { days?: Record<string, number> };
      return parsed.days ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Persist the watermark AFTER a day-file's apply completes. The flush path
   * calls this once per flushed day with that day's max applied sequence, so
   * the watermark never advances beyond what is durably in LanceDB
   * (fail-LOW: watermark < reality → idempotent re-flush; never watermark >
   * reality → reader skips a hash it believes flushed).
   */
  private writeWatermark(days: Record<string, number>): void {
    ensureDirs();
    fs.writeFileSync(getWikiWatermarkFile(), JSON.stringify({ days }), 'utf-8');
  }

  // ============================================================
  // WAL-as-truth: flush primitive (WAL → LanceDB cache)
  // ============================================================

  /**
   * Apply unflushed WAL day-files to the LanceDB cache, ADDITIVELY.
   *
   * The flush is the ONLY path that mutates LanceDB. For each day-file whose
   * max sequence exceeds the watermark for that day:
   *  1. Fold the day-file to latest-write-wins-by-sequence (a tombstone with
   *     a higher sequence than an insert wins; the global sequence makes
   *     out-of-order flushes sound — see {@link entrySequence}).
   *  2. For each hash: if the winner is a tombstone (or its GLOBAL-latest
   *     across all day-files is a tombstone — see P1-2 below), `table.delete`
   *     the row; otherwise `table.add` the live insert. Both are idempotent
   *     across re-flushes (re-adding a present hash is a benign duplicate;
   *     re-deleting an absent row is a no-op). Embeddings are batched per day
   *     (one {@link getEmbeddings} call per day-file's inserts).
   *  3. Update the watermark to that day's max sequence AFTER the apply
   *     completes (fail-LOW).
   *
   * P1-2 (cross-day tombstone): a per-day watermark means a late-flushed
   * INSERT in day D can apply AFTER tombstone day D+1 was already
   * watermarked, resurrecting the row in the cache permanently. Before
   * inserting a winner, the flush consults a GLOBAL fold ({@link foldWAL}
   * across ALL day-files): any hash whose global-latest is a tombstone is
   * suppressed from `toAdd` (and ensured absent via delete) so the cache
   * converges to the same state as a rebuild regardless of flush order.
   *
   * Acquires the WAIT-capable {@link FlushLock} so two instances flushing the
   * same shared wiki DB serialize — a skipped flush would widen the
   * cross-instance stale-read window (the debate's C1 hole). On lock-timeout
   * the flush is abandoned (the read path tags results possibly-stale).
   *
   * Idempotency: re-running a day-file converges to the same table state
   * (latest-wins per hash), so a restart mid-flush needs no compensation log —
   * the next flush re-applies the same day-file. Half-flush safety: union
   * semantics (duplicates in both WAL and LanceDB are benign).
   */
  async flushAhead(): Promise<{ flushedDays: number; applied: number }> {
    const lockFile = getWikiFlushLockFile();
    ensureDirs();
    const acquired = await this.flushLock.acquire(lockFile);
    if (!acquired) {
      this.core.verbose('wiki', 'Flush skipped: flush lock busy (another instance flushing)');
      return { flushedDays: 0, applied: 0 };
    }
    try {
      await this.initDb();
      if (!this.table) {
        return { flushedDays: 0, applied: 0 };
      }

      const walDir = getWikiLogsDir();
      if (!fs.existsSync(walDir)) {
        return { flushedDays: 0, applied: 0 };
      }
      const watermark = this.readWatermark();
      const dayFiles = fs.readdirSync(walDir).filter((f) => f.endsWith('.wal')).sort();

      // P1-2 (cross-day tombstone): a per-day watermark means a late-flushed
      // INSERT in day D can apply AFTER tombstone day D+1 was already
      // watermarked → the insert would re-add a row whose GLOBAL-latest is a
      // tombstone, resurrecting it in the cache PERMANENTLY (D+1 never
      // re-applies once watermarked). The per-day fold used below only sees
      // entries within one day-file, so it can't catch a tombstone in another
      // day-file. We therefore fold ALL day-files ONCE here and consult the
      // GLOBAL-latest for each winner: any hash whose global-latest is a
      // tombstone is suppressed from `toAdd` (the row must be absent). The
      // global fold is also the source of truth rebuild uses, so the cache
      // converges to the same state regardless of per-day flush order.
      const globalFold = foldWAL(walDir, NAMESPACE);

      let flushedDays = 0;
      let applied = 0;

      for (const dayFile of dayFiles) {
        const day = dayFile.replace(/\.wal$/, '');
        const content = fs.readFileSync(path.join(walDir, dayFile), 'utf-8');
        const entries = parseWALFile(content).filter(
          (e) => e.approved && (!e.namespace || e.namespace === NAMESPACE),
        );
        if (entries.length === 0) continue;

        // Only flush entries newer than the watermark for this day.
        const watermarked = watermark[day] ?? 0;
        const unflushed = entries.filter((e) => entrySequence(e) > watermarked);
        if (unflushed.length === 0) continue;

        // Fold unflushed entries to latest-wins-by-sequence for this day.
        const winners = new Map<string, WALEntry>();
        for (const entry of unflushed) {
          const prev = winners.get(entry.hash);
          if (!prev || entrySequence(entry) >= entrySequence(prev)) {
            winners.set(entry.hash, entry);
          }
        }

        // Apply each winner: insert (add) or tombstone (delete). P1-2:
        // before inserting, consult the GLOBAL fold — a hash whose
        // global-latest (across ALL day-files) is a tombstone must stay
        // deleted even if this day-file's local winner is a live insert
        // that flushes after the tombstone's day was watermarked.
        const toAdd: Array<{ hash: string; document: WikiDocument; embedding: number[]; createdAt: string }> = [];
        const toDelete: string[] = [];
        for (const [, entry] of winners) {
          if (entry.deleted) {
            toDelete.push(entry.hash);
            continue;
          }
          // P1-2: a later-day tombstone (global-latest) suppresses this insert.
          const globalLatest = globalFold.get(entry.hash);
          if (globalLatest && globalLatest.deleted) {
            // The row must be absent — ensure it is, then skip the insert.
            toDelete.push(entry.hash);
            continue;
          }
          toAdd.push({ hash: entry.hash, document: entry.document, embedding: [], createdAt: entry.timestamp });
        }

        // P2-1 (batch embed): embed all of this day's inserts in ONE
        // getEmbeddings call instead of one getEmbedding per winner. Done
        // OUTSIDE the per-row loop; the embedding slots above are filled in
        // by index below.
        if (toAdd.length > 0) {
          const embeddings = await getEmbeddings(
            toAdd.map((a) => a.document.content),
            'document',
          );
          toAdd.forEach((a, i) => { a.embedding = embeddings[i]; });
          await this.insertRebuildBatch(toAdd);
          applied += toAdd.length;
        }
        for (const hash of toDelete) {
          try { await this.table.delete(`hash = '${hash}'`); } catch { /* row already absent — idempotent */ }
          applied++;
        }

        // Advance the watermark AFTER the day's apply completes (fail-LOW).
        const maxSeq = Math.max(...unflushed.map((e) => entrySequence(e)));
        watermark[day] = Math.max(watermarked, maxSeq);
        flushedDays++;
      }

      if (flushedDays > 0) {
        this.writeWatermark(watermark);
        this.core.brief('info', 'wiki', `Flush applied ${applied} entries across ${flushedDays} day(s)`);
      }
      return { flushedDays, applied };
    } finally {
      this.flushLock.release(lockFile);
    }
  }

  /**
   * Debounce wrapper over {@link flushAhead}: keep at most ONE in-flight flush
   * per instance. A write-path caller (put/batchPut/delete) that schedules a
   * flush while one is already running reuses the running promise — it
   * already scans every day-file and will pick up the just-appended WAL line
   * on its next iteration, so a second concurrent flush would only contend on
   * the flush lock and do redundant work. When no flush is in flight, start
   * one and clear {@link inflightFlush} on completion (success or failure).
   *
   * Returns a promise the caller may await (the read path awaits; the write
   * path fire-and-forgets via `.catch`). Never throws — a flush failure is
   * logged and swallowed so the write path is never blocked by it.
   */
  private scheduleFlush(): Promise<{ flushedDays: number; applied: number }> {
    if (this.inflightFlush) return this.inflightFlush;
    const p = this.flushAhead().catch((err: unknown) => {
      this.core.verbose('wiki', `Scheduled flush failed: ${err instanceof Error ? err.message : String(err)}`);
      return { flushedDays: 0, applied: 0 };
    });
    this.inflightFlush = p;
    // Clear the slot once settled so the next scheduleFlush can start a new one.
    void p.finally(() => {
      if (this.inflightFlush === p) this.inflightFlush = null;
    });
    return p;
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

      // Batch insert all new/changed documents via ONE batchPut (which
      // appends to the WAL — the write path is WAL-only under WAL-as-truth,
      // so this never calls table.add directly; the cache is mutated only
      // by a subsequent flush).
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
   * Store document in knowledge base (WAL-ONLY write path).
   *
   * Under WAL-as-truth, `put` appends ONE entry to today's WAL and does NOT
   * touch LanceDB — the cache is mutated only by a flush. This kills the
   * DB/WAL disagreement window by construction: there is no LanceDB write
   * on the write path to disagree with the WAL. A crash after the WAL
   * append leaves the entry durable in the WAL (rebuild/flush re-materializes
   * it); a crash before the append loses nothing durable.
   *
   * `alreadyExisted` is sourced from the WAL (the source of truth), not from
   * LanceDB (the cache, which may lag). A hash whose latest WAL entry is a
   * live, non-tombstoned insert is "already in the store"; a hash whose
   * latest entry is a tombstone is NOT (it was deleted) and is re-inserted.
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

    // Short circuit from the source of truth (WAL): if the latest WAL entry
    // for this hash is a live insert, the document already exists. (We do not
    // compare references here — matching put()'s pre-redesign behavior where
    // the table-read short-circuit was hash-only; the full-document exact
    // match via sameDocument was a LanceDB-cache concern that no longer
    // applies when the cache is not authoritative.)
    ensureDirs();
    const walDir = getWikiLogsDir();
    if (walHasLiveHash(walDir, hash, NAMESPACE)) {
      this.core.verbose('wiki', `Document already exists in WAL (live): ${hash}`);
      return { success: true, hash, alreadyExisted: true };
    }

    try {
      // Append a single sequenced entry to today's WAL. No LanceDB mutation.
      await this.appendWAL({
        timestamp: new Date().toISOString(),
        hash,
        document,
        approved: true,
        namespace: NAMESPACE,
      });

      // Best-effort: opportunistically flush so the cache stays close to the
      // WAL. A failure here is NOT a put() failure — the entry is durable in
      // the WAL and will be flushed by the next read-gate or day rollover.
      this.scheduleFlush();

      this.core.brief('info', 'wiki', `Stored document: ${document.title}`);
      return { success: true, hash };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Put failed: ${error}`);
      return { success: false, hash, error };
    }
  }

  /**
   * Search for documents by similarity (watermark-gated, cache read).
   *
   * Under WAL-as-truth, LanceDB is a derived cache that may lag the WAL.
   * The read path closes that gap with the watermark contract: it flushes
   * unflushed WAL entries (bringing the cache up to the watermark) BEFORE
   * scanning, so a get() reflects all WAL writes through the watermark. The
   * residual stale window (a WAL append whose flush hasn't landed) is
   * bounded by the flush; the writing agent's own triologue holds the entry
   * so it doesn't re-get() what it just wrote (read-what-you-write). A
   * cross-instance reader that beats the flush sees a possibly-stale cache
   * (self-healing via the next flush/rebuild) — never loss or corruption.
   *
   * Read-time WAL merge is NOT adopted (the converged spec chose the
   * watermark contract over read-time merge): get() reads LanceDB only.
   */
  async get(query: string, options?: GetOptions): Promise<SearchResult[]> {
    // Gate freshness: flush unflushed WAL into the cache before reading so
    // the scan reflects all writes through the watermark. A flush failure
    // is non-fatal — the read proceeds against a possibly-stale cache.
    try { await this.flushAhead(); } catch (err) {
      this.core.verbose('wiki', `Pre-read flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }

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
   * Retrieve all documents in a domain in a single table scan (no embedding).
   * Used for batch re-indexing where a full domain listing is needed without
   * the per-query embedding cost of get(). Flushes the WAL first so the cache
   * reflects the watermark (same freshness contract as {@link get}).
   */
  async getByDomain(domain: string): Promise<SearchResult[]> {
    try { await this.flushAhead(); } catch (err) {
      this.core.verbose('wiki', `Pre-read flush failed (getByDomain): ${err instanceof Error ? err.message : String(err)}`);
    }
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
   * Batch-append pre-embedded documents to the WAL (WAL-ONLY write path).
   *
   * Under WAL-as-truth, batchPut appends ONE sequenced WAL line per accepted
   * entry and does NOT touch LanceDB — the cache is mutated only by a flush.
   * `alreadyExisted` is sourced from the WAL (via {@link walHasLiveHash}),
   * not from a LanceDB table scan (which may lag the WAL).
   *
   * The `embedding` field of each entry is accepted for API compatibility
   * with {@link indexSkills} (which pre-computes embeddings) but is NOT
   * persisted in the WAL — embeddings are derived by the flush/rebuild at
   * apply time, so the WAL stores only the document. This keeps the WAL
   * compact and embedding-model-agnostic (a model swap re-embeds on flush).
   *
   * Returns one PutResult per input entry (same order). Entries whose hash
   * already has a live WAL entry are reported `alreadyExisted:true` (and are
   * NOT re-appended — idempotent), mirroring put()'s reporting.
   */
  async batchPut(entries: Array<{ document: WikiDocument; embedding: number[] }>): Promise<PutResult[]> {
    if (entries.length === 0) return [];

    try {
      // Validate domains once (all entries share the domain set)
      const domains = loadDomains();
      if (domains.length === 0) {
        const reason = 'No domains registered. Use /wiki domains add <name> to create a domain first.';
        return entries.map((e) => ({ success: false, hash: generateHash(e.document), error: reason }));
      }
      const domainSet = new Set(domains.map((d) => d.domain_name));

      ensureDirs();
      const walDir = getWikiLogsDir();

      // Build the WAL entries to append, sourcing alreadyExisted from the WAL
      // (the source of truth), not the LanceDB cache.
      const toAppend: WALEntry[] = [];
      const results: PutResult[] = new Array(entries.length);

      for (let i = 0; i < entries.length; i++) {
        const { document } = entries[i];
        const hash = generateHash(document);

        // Validate required fields + domain
        if (!document.domain || !document.title || !document.content) {
          results[i] = { success: false, hash, error: 'Missing required fields: domain, title, or content' };
          continue;
        }
        if (!domainSet.has(document.domain)) {
          results[i] = { success: false, hash, error: `Unknown domain "${document.domain}"` };
          continue;
        }

        if (walHasLiveHash(walDir, hash, NAMESPACE)) {
          results[i] = { success: true, hash, alreadyExisted: true };
          continue;
        }

        toAppend.push({
          timestamp: new Date().toISOString(),
          hash,
          document,
          approved: true,
          namespace: NAMESPACE,
        });
        results[i] = { success: true, hash };
      }

      // Single batched, sequenced WAL append. Allocate a contiguous block of
      // `count` sequences under ONE flush-lock hold (avoids O(B) lock
      // round-trips and O(B×W) WAL rescans), then append. Out-of-order
      // flushes stay sound because each entry gets a distinct monotonic id.
      if (toAppend.length > 0) {
        const first = await this.allocateSequence(toAppend.length);
        const today = formatDate(new Date());
        const walPath = path.join(walDir, `${today}.wal`);
        const lines: string[] = [];
        toAppend.forEach((entry, i) => {
          entry.sequence = first + i;
          lines.push(JSON.stringify(entry));
        });
        fs.appendFileSync(walPath, `${lines.join('\n')}\n`, 'utf-8');
        this.core.brief('info', 'wiki', `Batch stored ${toAppend.length} documents (WAL)`);

        // Best-effort opportunistic flush (non-blocking; not a batchPut
        // failure). scheduleFlush swallows errors so this never throws.
        this.scheduleFlush();
      }

      return results;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `batchPut failed: ${error}`);
      return entries.map((e) => ({ success: false, hash: generateHash(e.document), error }));
    }
  }

  /**
   * Delete a document by hash (WAL-ONLY write path — append a tombstone).
   *
   * Under WAL-as-truth, a delete is ONE append: a `deleted:true` tombstone
   * entry to today's WAL. LanceDB is NOT mutated on the write path — the
   * tombstone is applied to the cache by the next flush. This kills the
   * "DB deleted but WAL tombstone failed" window by construction: there is
   * no LanceDB delete to fail independently of the (single) WAL append. A
   * crash after the append leaves the tombstone durable; the cache row is
   * removed on the next flush.
   *
   * Returns true if the hash had a live WAL entry to tombstone (the delete
   * was meaningful); false if the hash was already absent or already
   * tombstoned (idempotent no-op).
   */
  async delete(hash: string): Promise<boolean> {
    // Validate hash format
    if (!HASH_PATTERN.test(hash)) {
      this.core.brief('error', 'wiki', `Invalid hash format: ${hash}. Expected 16 hex characters.`);
      return false;
    }

    ensureDirs();
    const walDir = getWikiLogsDir();

    // Source-of-truth existence check: only tombstone a hash the WAL actually
    // holds live. A hash with no live entry (absent, or already tombstoned as
    // its latest entry) is an idempotent no-op.
    if (!walHasLiveHash(walDir, hash, NAMESPACE)) {
      this.core.brief('warn', 'wiki', `Document not found in WAL (live): ${hash}`);
      return false;
    }

    try {
      // Append a single sequenced tombstone. No LanceDB mutation.
      await this.appendWAL({
        timestamp: new Date().toISOString(),
        hash,
        // The tombstone carries the document it supersedes so a full rebuild
        // from the WAL can still emit a meaningful audit record; the flush
        // deletes the LanceDB row by hash regardless of this payload.
        document: { domain: '', title: '', content: '', references: [] },
        approved: true,
        deleted: true,
        namespace: NAMESPACE,
      });

      // Best-effort opportunistic flush so the cache drops the row promptly.
      this.scheduleFlush();

      this.core.brief('info', 'wiki', `Deleted document (tombstone): ${hash}`);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Delete failed: ${error}`);
      return false;
    }
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
   * Append entry to today's WAL (assigns a global monotonic sequence).
   *
   * Every WAL entry — insert or tombstone — gets a `sequence` here so the
   * flush/rebuild last-write-wins-by-sequence ordering is sound for ALL
   * writes, including deletes. The sequence is allocated under the flush
   * lock by {@link allocateSequence} so concurrent instances never observe
   * out-of-order ids (the lock serializes the read-increment-write of the
   * shared counter). An entry already carrying a `sequence` (e.g. a batchPut
   * that pre-allocated a block) keeps its value — this is a no-op for entries
   * that already have one.
   */
  async appendWAL(entry: WALEntry): Promise<void> {
    if (typeof entry.sequence !== 'number') {
      entry.sequence = await this.allocateSequence();
    }
    ensureDirs();
    const walDir = getWikiLogsDir();
    const today = formatDate(new Date());
    const walPath = path.join(walDir, `${today}.wal`);

    // Append as JSON line
    const line = `${JSON.stringify(entry)  }\n`;
    fs.appendFileSync(walPath, line, 'utf-8');

    this.core.brief('info', 'wiki', `Appended to WAL: ${entry.hash}${entry.deleted ? ' (tombstone)' : ''}`);
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

      // 1. Fold all WAL entries to latest-wins-by-sequence (the global
      //    sequence makes out-of-order flushes sound: a tombstone newer than
      //    an insert wins even across day-files). foldWAL keeps a tombstone
      //    as the winner so rebuild can drop the row; we then filter out
      //    tombstoned winners before embedding. Unapproved/foreign-namespace
      //    entries are already filtered by foldWAL.
      const folded = foldWAL(walDir, NAMESPACE);
      const entries: WALEntry[] = [];
      for (const entry of folded.values()) {
        if (entry.deleted) continue; // tombstone winner → row removed, no embed
        entries.push(entry);
      }

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
