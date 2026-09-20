/**
 * wiki-rebuild.test.ts — behavior + performance-shape tests for
 * WikiManager.rebuild().
 *
 * rebuild() is a bulk operation over the WAL, so the failure modes that
 * matter are:
 *   - it must NOT append back to the WAL it reads (else every rebuild
 *     duplicates all entries into today's WAL and the next rebuild does 2x
 *     the work, then 4x, ... — self-amplification);
 *   - it must collapse entries that share a hash (latest wins), matching the
 *     old sequential last-write-wins replay;
 *   - it must honor the deleted / unapproved / foreign-namespace filters;
 *   - it must batch embeddings (getEmbeddings, NOT per-entry getEmbedding)
 *     so N docs cost O(N/batch) Ollama round-trips instead of O(N).
 *
 * We mock the two heavy externals:
 *   - `../../engine/rag-provider.js` → a fake getEmbeddings that records the
 *     texts it was called with (and never hits Ollama);
 *   - `@lancedb/lancedb` → a fake connection/table that records add()/delete()
 *     calls in memory (and never touches a real DB).
 * `../../config.js` is mocked to point wiki paths at a temp dir.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { WikiDocument, WALEntry, CoreModule } from '../../types.js';

// --- Temp dir + config mock ----------------------------------------------
let tempDir = '';
const logsDir = () => path.join(tempDir, 'logs');
const domainsFile = () => path.join(tempDir, 'domains.json');

vi.mock('../../config.js', () => ({
  getWikiLogsDir: () => logsDir(),
  getWikiDbDir: () => path.join(tempDir, 'db'),
  getWikiDomainsFile: () => domainsFile(),
  getWikiReindexLockFile: () => path.join(tempDir, 'reindex.lock'),
  // WAL-as-truth paths — co-located with the wiki dir for the sequence
  // allocator, flush lock, and flushed-through watermark.
  getWikiFlushLockFile: () => path.join(tempDir, 'flush.lock'),
  getWikiSequenceFile: () => path.join(tempDir, 'sequence.json'),
  getWikiSequenceLockFile: () => path.join(tempDir, 'sequence.lock'),
  getWikiWatermarkFile: () => path.join(tempDir, 'watermark.json'),
  getHeartbeatFile: (sid: string) => path.join(tempDir, `hb-${sid}.json`),
  getMyccDir: () => tempDir,
  getSessionContext: () => 'test-session',
  getRagProvider: () => 'nomic',
  ensureDirs: () => {
    if (!fs.existsSync(logsDir())) fs.mkdirSync(logsDir(), { recursive: true });
  },
}));

// --- Embedding mock -------------------------------------------------------
// Records every call's input array so tests can assert the BATCH call shape.
const embedCalls: string[][] = [];
vi.mock('../../engine/rag-provider.js', () => ({
  EMBEDDING_DIM: 8,
  NAMESPACE: 'test-ns',
  getEmbedding: async (text: string) => {
    embedCalls.push([text]);
    return new Array(8).fill(0.1);
  },
  // The batched entry point — one call per chunk, order preserved.
  getEmbeddings: async (texts: string[]) => {
    embedCalls.push(texts);
    return texts.map(() => new Array(8).fill(0.1));
  },
}));

// --- LanceDB mock ---------------------------------------------------------
// A single shared in-memory table state so add()/delete() reflect the real
// sequence (delete('true') clears, then adds accumulate).
interface FakeTableState { rows: Array<Record<string, unknown>>; addCalls: number; deleteCalls: number; }
const tableState: FakeTableState = { rows: [], addCalls: 0, deleteCalls: 0 };

vi.mock('@lancedb/lancedb', () => {
  const fakeTable = {
    add: async (records: Array<Record<string, unknown>>) => {
      tableState.addCalls++;
      tableState.rows.push(...records);
    },
    delete: async (_filter: string) => {
      tableState.deleteCalls++;
      tableState.rows = []; // 'true' clears everything
    },
    query: () => ({ toArray: async () => tableState.rows }),
  };
  return {
    connect: async () => ({
      tableNames: async () => [],
      openTable: async () => fakeTable,
      createTable: async (_name: string, rows: Array<Record<string, unknown>>) => {
        tableState.rows = [...rows];
        return fakeTable;
      },
    }),
  };
});

// --- Helpers --------------------------------------------------------------
function makeDoc(domain: string, title: string, content: string): WikiDocument {
  return { domain, title, content, references: [] };
}

function makeEntry(doc: WikiDocument, opts: Partial<WALEntry> = {}): WALEntry {
  return {
    timestamp: opts.timestamp || '2026-01-01T00:00:00.000Z',
    hash: opts.hash ?? hashOf(doc),
    document: doc,
    approved: opts.approved ?? true,
    ...(opts.deleted !== undefined ? { deleted: opts.deleted } : {}),
    ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
  } as WALEntry;
}

function hashOf(doc: WikiDocument): string {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(`${doc.domain}:${doc.title}:${doc.content}`).digest('hex').slice(0, 16);
}

function writeWal(fileName: string, entries: WALEntry[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(logsDir(), fileName), `${lines}\n`, 'utf-8');
}

function walBytes(): number {
  if (!fs.existsSync(logsDir())) return 0;
  return fs.readdirSync(logsDir())
    .filter((f) => f.endsWith('.wal'))
    .reduce((sum, f) => sum + fs.statSync(path.join(logsDir(), f)).size, 0);
}

function makeCore(): CoreModule {
  return { brief: vi.fn(), verbose: vi.fn() } as unknown as CoreModule;
}

// Content >= 1 char is fine here — rebuild does NOT run put()'s length checks.
const C = 'a document content long enough to be realistic';

// --- Tests ----------------------------------------------------------------
describe('WikiManager.rebuild()', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-rebuild-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(domainsFile(), JSON.stringify([
      { domain_name: 'project', description: '', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    embedCalls.length = 0;
    tableState.rows = [];
    tableState.addCalls = 0;
    tableState.deleteCalls = 0;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function newManager() {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(makeCore());
  }

  it('embeds in BATCHES (getEmbeddings), not one call per entry', async () => {
    // 5 docs → expect a single batched getEmbeddings call with 5 inputs,
    // never 5 separate getEmbedding calls.
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry(makeDoc('project', `t${i}`, `${C} ${i}`), { hash: `000000000000000${i}` }),
    );
    writeWal('2026-01-01.wal', entries);

    const wiki = await newManager();
    const result = await wiki.rebuild();

    expect(result.success).toBe(true);
    expect(result.documentsProcessed).toBe(5);
    // One batched call carrying all 5 texts (single chunk at this size).
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(5);
  });

  it('folds duplicate hashes across WAL files (latest wins), embedding each once', async () => {
    const doc1 = makeDoc('project', 'title', `${C} v1`);
    const doc2 = makeDoc('project', 'title', `${C} v2`);
    const hash = 'abcdef0123456789'; // same hash, different content (simulates an update replay)
    writeWal('2026-01-01.wal', [makeEntry(doc1, { hash })]);
    writeWal('2026-01-02.wal', [makeEntry(doc2, { hash })]); // later file wins

    const wiki = await newManager();
    const result = await wiki.rebuild();

    expect(result.documentsProcessed).toBe(1);
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toEqual([`${C} v2`]); // the later version

    // Exactly one row landed, carrying the winning content.
    const rows = tableState.rows.filter((r) => r.hash === hash);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(`${C} v2`);
  });

  it('does NOT append back to the WAL (no self-amplification)', async () => {
    // The cardinal sin: rebuild reads the WAL; if it also wrote back, the
    // dir would grow after each rebuild. Assert the WAL bytes are unchanged.
    writeWal('2026-01-01.wal', [
      makeEntry(makeDoc('project', 'a', `${C} a`), { hash: '1111111111111111' }),
      makeEntry(makeDoc('project', 'b', `${C} b`), { hash: '2222222222222222' }),
    ]);
    const before = walBytes();

    const wiki = await newManager();
    await wiki.rebuild();

    expect(walBytes()).toBe(before);
    // And no NEW wal file was created for "today".
    const files = fs.readdirSync(logsDir()).filter((f) => f.endsWith('.wal'));
    expect(files).toEqual(['2026-01-01.wal']);
  });

  it('filters deleted / unapproved / foreign-namespace entries', async () => {
    writeWal('2026-01-01.wal', [
      makeEntry(makeDoc('project', 'keep', `${C} keep`), { hash: 'aaaaaaaaaaaaaaaa' }),
      makeEntry(makeDoc('project', 'del', `${C} del`), { hash: 'bbbbbbbbbbbbbbbb', deleted: true }),
      makeEntry(makeDoc('project', 'unap', `${C} unap`), { hash: 'cccccccccccccccc', approved: false }),
      makeEntry(makeDoc('project', 'foreign', `${C} foreign`), { hash: 'dddddddddddddddd', namespace: 'other-model' }),
    ]);

    const wiki = await newManager();
    const result = await wiki.rebuild();

    expect(result.documentsProcessed).toBe(1);
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(1);
    const hashes = tableState.rows.map((r) => r.hash);
    expect(hashes).toContain('aaaaaaaaaaaaaaaa');
    expect(hashes).not.toContain('bbbbbbbbbbbbbbbb');
    expect(hashes).not.toContain('cccccccccccccccc');
    expect(hashes).not.toContain('dddddddddddddddd');
  });

  it('accepts legacy entries with no namespace (re-embedded with the current model)', async () => {
    writeWal('2026-01-01.wal', [
      makeEntry(makeDoc('project', 'legacy', `${C} legacy`), { hash: 'eeeeeeeeeeeeeeee' }), // no namespace field
    ]);

    const wiki = await newManager();
    const result = await wiki.rebuild();

    expect(result.documentsProcessed).toBe(1);
    expect(tableState.rows.map((r) => r.hash)).toContain('eeeeeeeeeeeeeeee');
  });

  it('preserves each entry\'s original createdAt from the WAL', async () => {
    writeWal('2026-01-01.wal', [
      makeEntry(makeDoc('project', 'old', `${C} old`), {
        hash: 'ffffffffffffffff',
        timestamp: '2025-12-31T23:59:59.000Z',
      }),
    ]);

    const wiki = await newManager();
    await wiki.rebuild();

    expect(tableState.rows.find((r) => r.hash === 'ffffffffffffffff')?.createdAt)
      .toBe('2025-12-31T23:59:59.000Z');
  });

  it('clears the table once, then inserts (single delete + batched adds)', async () => {
    writeWal('2026-01-01.wal', [
      makeEntry(makeDoc('project', 'a', `${C} a`), { hash: '1111111111111111' }),
      makeEntry(makeDoc('project', 'b', `${C} b`), { hash: '2222222222222222' }),
    ]);

    const wiki = await newManager();
    await wiki.rebuild();

    expect(tableState.deleteCalls).toBe(1);
    // Two docs fit in a single insert batch → one add() call.
    expect(tableState.addCalls).toBe(1);
  });

  it('reports monotonic progress once per batch (processed/total/batchIndex)', async () => {
    // 3 docs → single batch (EMBED_BATCH_SIZE=16 >> 3). Callback fires once
    // with processed === total and batchIndex/batchCount === 1/1.
    writeWal('2026-01-01.wal', [
      makeEntry(makeDoc('project', 'a', `${C} a`), { hash: '1111111111111111' }),
      makeEntry(makeDoc('project', 'b', `${C} b`), { hash: '2222222222222222' }),
      makeEntry(makeDoc('project', 'c', `${C} c`), { hash: '3333333333333333' }),
    ]);

    const wiki = await newManager();
    const events: Array<{ processed: number; total: number; batchIndex: number; batchCount: number }> = [];
    await wiki.rebuild((p) => events.push({ processed: p.processed, total: p.total, batchIndex: p.batchIndex, batchCount: p.batchCount }));

    expect(events).toEqual([
      { processed: 3, total: 3, batchIndex: 1, batchCount: 1 },
    ]);
  });

  it('emits NO progress events when there are no entries to rebuild', async () => {
    // Empty WAL dir → early return before the batch loop; callback never fires.
    const wiki = await newManager();
    const events: unknown[] = [];
    const result = await wiki.rebuild((p) => events.push(p));

    expect(result.success).toBe(true);
    expect(result.documentsProcessed).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('spans multiple batches: last event reaches processed === total', async () => {
    // EMBED_BATCH_SIZE is 16 (module-private), so 129 entries span 9 batches:
    // floor(129/16) = 8 full batches of 16 + 1 final batch of 1.
    const entries = Array.from({ length: 129 }, (_, i) =>
      makeEntry(makeDoc('project', `t${i}`, `${C} ${i}`), {
        hash: i.toString(16).padStart(16, '0'),
      }),
    );
    writeWal('2026-01-01.wal', entries);

    const wiki = await newManager();
    const events: Array<{ processed: number; batchIndex: number; batchCount: number }> = [];
    await wiki.rebuild((p) => events.push({ processed: p.processed, batchIndex: p.batchIndex, batchCount: p.batchCount }));

    expect(events).toHaveLength(9);
    expect(events[0]).toEqual({ processed: 16, batchIndex: 1, batchCount: 9 });
    expect(events[7]).toEqual({ processed: 128, batchIndex: 8, batchCount: 9 });
    // Last batch carries only the 129th entry and reaches processed === total.
    expect(events[8]).toEqual({ processed: 129, batchIndex: 9, batchCount: 9 });
  });
});

/**
 * batchPut reports per-entry whether the document was freshly WAL-appended
 * or was already present in the WAL (the source of truth). This pins the
 * PUBLIC contract (PutResult.alreadyExisted) under WAL-as-truth: the write
 * path appends to the WAL ONLY and never touches LanceDB, so alreadyExisted
 * is sourced from the WAL (via walHasLiveHash), not a LanceDB table scan.
 * Both branches are exercised in ONE batch call.
 */
describe('WikiManager.batchPut() — alreadyExisted reporting (WAL-sourced)', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-batchput-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(domainsFile(), JSON.stringify([
      { domain_name: 'project', description: '', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    embedCalls.length = 0;
    tableState.rows = [];
    tableState.addCalls = 0;
    tableState.deleteCalls = 0;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function newManager() {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(makeCore());
  }

  it('flags a pre-existing (WAL-live) hash alreadyExisted:true and a fresh one as a plain append — in one batch', async () => {
    const existingDoc = makeDoc('project', 'existing', `${C} existing`);
    const freshDoc = makeDoc('project', 'fresh', `${C} fresh`);
    const existingHash = hashOf(existingDoc);
    const freshHash = hashOf(freshDoc);

    const wiki = await newManager();

    // Seed the source of truth: write a LIVE WAL entry for existingDoc so
    // batchPut's WAL-sourced alreadyExisted check sees it. Under WAL-as-truth
    // the write path never touches LanceDB, so we seed the WAL (not the
    // table). Use a sequence so the entry is well-formed (legacy 0 works too,
    // but be explicit). walHasLiveHash folds the whole WAL.
    writeWal('2026-01-01.wal', [
      makeEntry(existingDoc, { hash: existingHash, sequence: 1 }),
    ]);
    // The fold reads ALL *.wal files; today's file may also exist from a
    // prior step — writeWal overwrites the dated file cleanly here.

    const addCallsBefore = tableState.addCalls;

    // One batch: existingDoc (already live in WAL) + freshDoc (new).
    const results = await wiki.batchPut([
      { document: existingDoc, embedding: new Array(8).fill(0.1) },
      { document: freshDoc, embedding: new Array(8).fill(0.1) },
    ]);

    // Order preserved, per-entry flagging correct.
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ success: true, hash: existingHash, alreadyExisted: true });
    expect(results[1]).toEqual({ success: true, hash: freshHash });
    expect(results[1].alreadyExisted).toBeUndefined();

    // WAL-only write path: batchPut must NOT touch LanceDB at all. No add().
    expect(tableState.addCalls).toBe(addCallsBefore);
    // The fresh entry was appended to today's WAL (a new dated file for today
    // appears; the seeded 2026-01-01.wal remains). The existing entry was NOT
    // re-appended (idempotent).
    const files = fs.readdirSync(logsDir()).filter((f) => f.endsWith('.wal'));
    expect(files).toContain('2026-01-01.wal');
  });

  it('reports all-present batch as alreadyExisted:true with no WAL append and no table.add()', async () => {
    const doc = makeDoc('project', 'only', `${C} only`);
    const hash = hashOf(doc);

    const wiki = await newManager();

    // Seed a LIVE WAL entry so the hash is "already in the store".
    writeWal('2026-01-01.wal', [makeEntry(doc, { hash, sequence: 1 })]);
    const filesBefore = fs.readdirSync(logsDir()).filter((f) => f.endsWith('.wal'));

    const addCallsBefore = tableState.addCalls;
    const results = await wiki.batchPut([{ document: doc, embedding: new Array(8).fill(0.1) }]);

    expect(results).toEqual([{ success: true, hash, alreadyExisted: true }]);
    // Nothing to append and no LanceDB mutation on the write path.
    expect(tableState.addCalls).toBe(addCallsBefore);
    // No new WAL file was created (nothing was appended).
    expect(fs.readdirSync(logsDir()).filter((f) => f.endsWith('.wal'))).toEqual(filesBefore);
  });
});
