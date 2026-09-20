/**
 * flushAhead.test.ts — behavior tests for WikiManager.flushAhead(), the
 * WAL→LanceDB flush primitive that is the ONLY path mutating LanceDB under
 * WAL-as-truth.
 *
 * The failure modes that matter (surfaced by the two-model peer review):
 *   - P1-2 (cross-day tombstone): a per-day watermark means a late-flushed
 *     INSERT in day D can apply AFTER tombstone day D+1 was watermarked →
 *     the insert re-adds a row whose GLOBAL-latest is a tombstone, resurrecting
 *     it in the cache permanently. flushAhead must consult the GLOBAL fold
 *     (foldWAL across ALL day-files) and suppress any insert whose
 *     global-latest is a tombstone.
 *   - per-day fold + tombstone winner → the LanceDB row is deleted.
 *   - the watermark is advanced AFTER a day's apply completes (fail-LOW); a
 *     thrown embed mid-day must NOT advance the watermark (so the next flush
 *     re-attempts the day, not skip it).
 *   - a corrupt/missing watermark means "re-flush everything" (fail-LOW),
 *     never "skip".
 *   - P2-1 (batch embed): a day's inserts are embedded in ONE getEmbeddings
 *     call, not one getEmbedding per winner.
 *
 * Mocks mirror wiki-rebuild.test.ts (config → temp dir, rag-provider →
 * recording fake, lancedb → in-memory table).
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
const watermarkFile = () => path.join(tempDir, 'watermark.json');

vi.mock('../../config.js', () => ({
  getWikiLogsDir: () => logsDir(),
  getWikiDbDir: () => path.join(tempDir, 'db'),
  getWikiDomainsFile: () => domainsFile(),
  getWikiReindexLockFile: () => path.join(tempDir, 'reindex.lock'),
  getWikiFlushLockFile: () => path.join(tempDir, 'flush.lock'),
  getWikiSequenceFile: () => path.join(tempDir, 'sequence.json'),
  getWikiWatermarkFile: () => watermarkFile(),
  getHeartbeatFile: (sid: string) => path.join(tempDir, `hb-${sid}.json`),
  getMyccDir: () => tempDir,
  getSessionContext: () => 'test-session',
  getRagProvider: () => 'nomic',
  ensureDirs: () => {
    if (!fs.existsSync(logsDir())) fs.mkdirSync(logsDir(), { recursive: true });
  },
}));

// --- Embedding mock -------------------------------------------------------
// Records every call's input array so we can assert batched-call shape.
const embedCalls: string[][] = [];
// A knob tests can flip to simulate an Ollama failure mid-day (so the flush
// throws and we can assert the watermark is NOT advanced). Reset per test.
let embedShouldThrow = false;
vi.mock('../../engine/rag-provider.js', () => ({
  EMBEDDING_DIM: 8,
  NAMESPACE: 'test-ns',
  getEmbedding: async (text: string) => {
    embedCalls.push([text]);
    return new Array(8).fill(0.1);
  },
  getEmbeddings: async (texts: string[]) => {
    embedCalls.push(texts);
    if (embedShouldThrow) throw new Error('embed-failure-injected');
    return texts.map(() => new Array(8).fill(0.1));
  },
}));

// --- LanceDB mock ---------------------------------------------------------
interface FakeTableState {
  rows: Array<Record<string, unknown>>;
  addCalls: number;
  deleteCalls: number;
  deletedHashes: string[];
}
const tableState: FakeTableState = { rows: [], addCalls: 0, deleteCalls: 0, deletedHashes: [] };

vi.mock('@lancedb/lancedb', () => {
  const fakeTable = {
    add: async (records: Array<Record<string, unknown>>) => {
      tableState.addCalls++;
      tableState.rows.push(...records);
    },
    // 'true' clears all; 'hash = '<h>'' deletes one by hash. We model both.
    delete: async (filter: string) => {
      tableState.deleteCalls++;
      if (filter === 'true') {
        tableState.rows = [];
        return;
      }
      // Parse "hash = '<h>'"
      const m = filter.match(/^hash = '([a-f0-9]{16})'$/);
      if (m) {
        tableState.deletedHashes.push(m[1]);
        tableState.rows = tableState.rows.filter((r) => r.hash !== m[1]);
      }
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

function hashOf(doc: WikiDocument): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(`${doc.domain}:${doc.title}:${doc.content}`).digest('hex').slice(0, 16);
}

function makeEntry(doc: WikiDocument, opts: Partial<WALEntry> = {}): WALEntry {
  return {
    timestamp: opts.timestamp || '2026-01-01T00:00:00.000Z',
    hash: opts.hash ?? hashOf(doc),
    document: doc,
    approved: opts.approved ?? true,
    namespace: opts.namespace ?? 'test-ns',
    ...(opts.deleted !== undefined ? { deleted: opts.deleted } : {}),
    ...(opts.sequence !== undefined ? { sequence: opts.sequence } : {}),
  } as WALEntry;
}

function writeWal(fileName: string, entries: WALEntry[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(logsDir(), fileName), `${lines}\n`, 'utf-8');
}

function writeWatermark(days: Record<string, number>): void {
  fs.writeFileSync(watermarkFile(), JSON.stringify({ days }), 'utf-8');
}

function readWatermark(): Record<string, number> {
  if (!fs.existsSync(watermarkFile())) return {};
  try {
    return (JSON.parse(fs.readFileSync(watermarkFile(), 'utf-8')) as { days?: Record<string, number> }).days ?? {};
  } catch {
    return {};
  }
}

function makeCore(): CoreModule {
  return { brief: vi.fn(), verbose: vi.fn() } as unknown as CoreModule;
}

const C = 'a document content long enough to be realistic';

// --- Tests ----------------------------------------------------------------
describe('WikiManager.flushAhead()', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-flush-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(domainsFile(), JSON.stringify([
      { domain_name: 'project', description: '', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    embedCalls.length = 0;
    embedShouldThrow = false;
    tableState.rows = [];
    tableState.addCalls = 0;
    tableState.deleteCalls = 0;
    tableState.deletedHashes = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function newManager() {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(makeCore());
  }

  it('per-day fold: a tombstone winner with a higher sequence deletes the LanceDB row', async () => {
    const doc = makeDoc('project', 'title', `${C} v1`);
    const hash = hashOf(doc);
    // insert at seq 1, tombstone at seq 2 (same day) → tombstone wins the fold.
    writeWal('2026-01-01.wal', [
      makeEntry(doc, { hash, sequence: 1 }),
      makeEntry(doc, { hash, deleted: true, sequence: 2 }),
    ]);

    const wiki = await newManager();
    const res = await wiki.flushAhead();

    expect(res.applied).toBeGreaterThanOrEqual(1);
    // The row was deleted by hash (tombstone winner).
    expect(tableState.deletedHashes).toContain(hash);
    // No insert landed for the tombstoned hash.
    expect(tableState.rows.find((r) => r.hash === hash)).toBeUndefined();
    // Watermark advanced to seq 2 for the day.
    expect(readWatermark()['2026-01-01']).toBe(2);
  });

  it('P1-2 regression: a late-flushed INSERT after a tombstone in a LATER day stays deleted', async () => {
    // Day D (2026-01-01): a live INSERT at seq 1.
    // Day D+1 (2026-01-02): a TOMBSTONE at seq 2 for the SAME hash.
    // The tombstone's day (D+1) flushes FIRST and is watermarked; then the
    // insert's day (D) flushes. Without the global-fold consult, the insert
    // would re-add the row whose global-latest is a tombstone → resurrection.
    const doc = makeDoc('project', 'title', `${C} v1`);
    const hash = hashOf(doc);
    writeWal('2026-01-01.wal', [makeEntry(doc, { hash, sequence: 1 })]);
    writeWal('2026-01-02.wal', [makeEntry(doc, { hash, deleted: true, sequence: 2 })]);

    const wiki = await newManager();

    // Simulate "D+1 already flushed and watermarked" by pre-writing the
    // watermark for D+1 only, leaving D unflushed. The day-files are iterated
    // in sorted order, so D is flushed first here — but the global fold still
    // sees D+1's tombstone and must suppress D's insert. (The watermark for
    // D+1 is already at 2, so D+1 is skipped; only D is applied.)
    writeWatermark({ '2026-01-02': 2 });

    const res = await wiki.flushAhead();

    // D was applied (flushedDays >= 1). But the insert MUST have been
    // suppressed by the global fold → the row is deleted, not added.
    expect(res.flushedDays).toBeGreaterThanOrEqual(1);
    expect(tableState.rows.find((r) => r.hash === hash)).toBeUndefined();
    expect(tableState.deletedHashes).toContain(hash);
    // The insert's content was NEVER embedded (suppressed before embed).
    expect(embedCalls.length).toBe(0);
    // D's watermark advanced to 1 (its only entry).
    expect(readWatermark()['2026-01-01']).toBe(1);
  });

  it('P1-2 same-day regression: insert flushed AFTER a cross-day tombstone (sorted iteration) still suppressed', async () => {
    // Same as above but WITHOUT a pre-watermark, so BOTH days are unflushed.
    // Files are iterated sorted (01 then 02). Day 01 (insert) flushes first;
    // the global fold sees 02's tombstone (higher seq) → insert suppressed.
    // Then 02 flushes → row deleted (already absent — idempotent).
    const doc = makeDoc('project', 'title', `${C} v1`);
    const hash = hashOf(doc);
    writeWal('2026-01-01.wal', [makeEntry(doc, { hash, sequence: 1 })]);
    writeWal('2026-01-02.wal', [makeEntry(doc, { hash, deleted: true, sequence: 2 })]);

    const wiki = await newManager();
    await wiki.flushAhead();

    expect(tableState.rows.find((r) => r.hash === hash)).toBeUndefined();
    expect(tableState.deletedHashes).toContain(hash);
    expect(readWatermark()['2026-01-01']).toBe(1);
    expect(readWatermark()['2026-01-02']).toBe(2);
  });

  it('does NOT advance the watermark when the day embed throws mid-day (fail-LOW)', async () => {
    const doc = makeDoc('project', 'title', `${C} v1`);
    const hash = hashOf(doc);
    writeWal('2026-01-01.wal', [makeEntry(doc, { hash, sequence: 1 })]);

    embedShouldThrow = true; // the day's getEmbeddings will throw

    const wiki = await newManager();
    // flushAhead does NOT swallow throws (only scheduleFlush does); the throw
    // propagates and the lock is released in finally.
    await expect(wiki.flushAhead()).rejects.toThrow('embed-failure-injected');

    // The watermark for the day was NOT advanced → the next flush re-attempts.
    expect(readWatermark()['2026-01-01']).toBeUndefined();
  });

  it('a corrupt/missing watermark means "re-flush everything" (fail-LOW)', async () => {
    const doc = makeDoc('project', 'title', `${C} v1`);
    const hash = hashOf(doc);
    writeWal('2026-01-01.wal', [makeEntry(doc, { hash, sequence: 5 })]);
    // Corrupt watermark file → readWatermark returns {} → day treated as
    // unflushed (watermarked = 0), so seq 5 > 0 is applied.
    fs.writeFileSync(watermarkFile(), '{ not valid json', 'utf-8');

    const wiki = await newManager();
    const res = await wiki.flushAhead();

    expect(res.flushedDays).toBe(1);
    expect(tableState.rows.find((r) => r.hash === hash)).toBeDefined();
    // A clean watermark was written back.
    expect(readWatermark()['2026-01-01']).toBe(5);
  });

  it('P2-1 batch embed: a day\'s inserts are embedded in ONE getEmbeddings call', async () => {
    // 3 distinct live inserts in one day → one batched getEmbeddings.
    const docs = Array.from({ length: 3 }, (_, i) =>
      makeDoc('project', `t${i}`, `${C} ${i}`),
    );
    writeWal('2026-01-01.wal', docs.map((d, i) =>
      makeEntry(d, { sequence: i + 1 }),
    ));

    const wiki = await newManager();
    await wiki.flushAhead();

    // Exactly one batched call carrying all 3 texts.
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(3);
    expect(tableState.addCalls).toBe(1);
    expect(tableState.rows.filter((r) => r.hash && r.hash !== '__schema__')).toHaveLength(3);
  });

  it('idempotent re-flush: a second flush after watermarking is a no-op', async () => {
    const doc = makeDoc('project', 'title', `${C} v1`);
    const hash = hashOf(doc);
    writeWal('2026-01-01.wal', [makeEntry(doc, { hash, sequence: 1 })]);

    const wiki = await newManager();
    await wiki.flushAhead();
    const addCallsAfterFirst = tableState.addCalls;
    const rowsAfterFirst = tableState.rows.length;

    // Second flush: the day is now watermarked at seq 1 → no unflushed entries
    // → no embed, no add, watermark unchanged.
    const res = await wiki.flushAhead();
    expect(res.flushedDays).toBe(0);
    expect(res.applied).toBe(0);
    expect(tableState.addCalls).toBe(addCallsAfterFirst);
    expect(tableState.rows.length).toBe(rowsAfterFirst);
    expect(readWatermark()['2026-01-01']).toBe(1);
  });
});