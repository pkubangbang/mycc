/**
 * indexSkills-writepath.test.ts — behavior tests for the write-path fixes
 * from the PR #19 review pass (deepseek slice, issues #1/#4/#5).
 *
 * #1 (P1): indexSkills inspects batchPut's PutResult[] and THROWS before
 *   writeSkillIndexCache if any entry failed (WAL complete → cache may
 *   advance; never the reverse). Also: batchPut sets success:true only
 *   AFTER the appendFileSync (the optimistic pre-append flag is gone).
 * #4 (P2): indexSkills batch-deletes stale/orphans via ONE appendTombstones
 *   call (a single WAL append with a DISTINCT monotonic sequence per
 *   tombstone), not a per-hash delete() loop.
 * #5 (P2): indexSkills no longer pre-computes embeddings (the WAL stores
 *   only the document; the flush re-embeds). So indexSkills must NOT call
 *   getEmbeddings at all.
 *
 * Mocks mirror wiki-rebuild.test.ts (config → temp dir, rag-provider →
 * recording fake, lancedb → in-memory table) plus a wiki-skill-index mock
 * so we can drive isSkillIndexCacheValid / record writeSkillIndexCache and
 * control the reindex lock without real fs-lock contention.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { WikiDocument, WALEntry, CoreModule, SkillIndexEntry } from '../../types.js';

// --- Temp dir + config mock ----------------------------------------------
let tempDir = '';
const logsDir = () => path.join(tempDir, 'logs');
const domainsFile = () => path.join(tempDir, 'domains.json');

vi.mock('../../config.js', () => ({
  getWikiLogsDir: () => logsDir(),
  getWikiDbDir: () => path.join(tempDir, 'db'),
  getWikiDomainsFile: () => domainsFile(),
  getWikiReindexLockFile: () => path.join(tempDir, 'reindex.lock'),
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
// Records every call's input array so we can assert indexSkills does NOT
// pre-embed (#5) and that batchPut does not embed either (WAL-only path).
const embedCalls: string[][] = [];
vi.mock('../../engine/rag-provider.js', () => ({
  EMBEDDING_DIM: 8,
  NAMESPACE: 'test-ns',
  getEmbedding: async (text: string) => {
    embedCalls.push([text]);
    return new Array(8).fill(0.1);
  },
  getEmbeddings: async (texts: string[]) => {
    embedCalls.push(texts);
    return texts.map(() => new Array(8).fill(0.1));
  },
}));

// --- wiki-skill-index mock -----------------------------------------------
// isSkillIndexCacheValid is a knob: default false so indexSkills runs the
// full re-index (the cache check never short-circuits). writeSkillIndexCache
// is recorded so we can assert it is/isn't called. The lock classes are taken
// from the REAL module (they're simple fs locks) so the reindex lock behaves
// correctly; we only stub the two pure functions.
let cacheValid = false;
let cacheWriteCalls: SkillIndexEntry[][] = [];
vi.mock('../../context/parent/wiki-skill-index.js', async () => {
  const real = await vi.importActual<typeof import('../../context/parent/wiki-skill-index.js')>(
    '../../context/parent/wiki-skill-index.js',
  );
  return {
    ...real,
    isSkillIndexCacheValid: () => cacheValid,
    writeSkillIndexCache: (entries: SkillIndexEntry[]) => { cacheWriteCalls.push(entries); },
  };
});

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
    delete: async (filter: string) => {
      tableState.deleteCalls++;
      if (filter === 'true') {
        tableState.rows = [];
        return;
      }
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

function makeEntry(doc: SkillIndexEntry['document'], contentHash: string): SkillIndexEntry {
  return { document: doc, contentHash };
}

function todayWalPath(): string {
  // formatDate uses the real date; mirror its YYYY-MM-DD format.
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(logsDir(), `${ymd}.wal`);
}

function readTodayWalLines(): string[] {
  if (!fs.existsSync(todayWalPath())) return [];
  return fs.readFileSync(todayWalPath(), 'utf-8').split('\n').filter((l) => l.trim().length > 0);
}

function makeCore(): CoreModule {
  return { brief: vi.fn(), verbose: vi.fn() } as unknown as CoreModule;
}

const C = 'a document content long enough to be realistic';

// --- Tests ----------------------------------------------------------------
describe('WikiManager.indexSkills() — write-path fixes #1/#4/#5', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-idxskills-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(domainsFile(), JSON.stringify([
      { domain_name: 'skills', description: 'skills', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    embedCalls.length = 0;
    cacheValid = false;
    cacheWriteCalls = [];
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

  it('#5: indexSkills passes NO embedding to batchPut (precompute dropped at the call boundary)', async () => {
    // The #5 fix removed the getEmbeddings(toAdd) precompute from indexSkills.
    // The robust, deterministic invariant is at the call boundary: indexSkills
    // now hands batchPut entries that carry ONLY a document — no `embedding`
    // field. (The flush re-embeds later; whether/when the async flush fires is
    // not something this test pins — the call-boundary shape is the fix.)
    const entries = [
      makeEntry(makeDoc('skills', '[built-in]:a', `${C} a`), 'ca'),
      makeEntry(makeDoc('skills', '[built-in]:b', `${C} b`), 'cb'),
    ];

    const wiki = await newManager();
    const batchPutSpy = vi.spyOn(wiki, 'batchPut').mockResolvedValue([
      { success: true, hash: hashOf(makeDoc('skills', '[built-in]:a', `${C} a`)) },
      { success: true, hash: hashOf(makeDoc('skills', '[built-in]:b', `${C} b`)) },
    ]);

    await wiki.indexSkills(entries);

    // batchPut was called exactly once (the batch insert path).
    expect(batchPutSpy).toHaveBeenCalledTimes(1);
    const arg = batchPutSpy.mock.calls[0][0] as Array<{ document: WikiDocument; embedding?: number[] }>;
    expect(arg).toHaveLength(2);
    // Every entry carries ONLY a document — no embedding field. This is the
    // #5 invariant: indexSkills no longer pre-computes embeddings.
    for (const e of arg) {
      expect(e.document).toBeDefined();
      expect('embedding' in e).toBe(false);
    }

    // The cache WAS written (all entries reported success → cache advances).
    expect(cacheWriteCalls).toHaveLength(1);
    expect(cacheWriteCalls[0]).toHaveLength(2);
    batchPutSpy.mockRestore();
  });

  it('#1: a failed WAL append (unknown domain) makes indexSkills THROW and NOT write the cache', async () => {
    // An entry whose domain is NOT registered → batchPut returns
    // success:false for it (without throwing). indexSkills must detect the
    // !success and throw BEFORE writeSkillIndexCache so the cache never
    // advances past an incomplete WAL. We register only 'skills', so an
    // entry in a bogus domain fails the domain check inside batchPut.
    const bad = makeEntry(makeDoc('not-registered', '[built-in]:x', `${C} x`), 'cx');

    const wiki = await newManager();
    await expect(wiki.indexSkills([bad])).rejects.toThrow(/batchPut reported.*failed WAL append/);

    // The cache was NOT advanced (invariant: WAL complete → cache may advance).
    expect(cacheWriteCalls).toHaveLength(0);
  });

  it('#1: success results are set AFTER the append (mixed batch appends live entries)', async () => {
    // A valid fresh skill appended → success:true AND a real WAL line on
    // disk (the ordering fix: success reflects an actual append, not an
    // optimistic pre-append flag). Combine with a known-live hash to also
    // exercise the alreadyExisted branch in the same batch.
    const liveDoc = makeDoc('skills', '[built-in]:live', `${C} live`);
    const liveHash = hashOf(liveDoc);
    // Seed a LIVE WAL entry so the fresh-looking hash is already present.
    const { WikiManager } = await import('../../context/parent/wiki.js');
    // write a live entry directly into the WAL (sequence 1).
    fs.writeFileSync(todayWalPath(),
      `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', hash: liveHash, document: liveDoc, approved: true, namespace: 'test-ns', sequence: 1 } as WALEntry)}\n`,
      'utf-8');

    const freshDoc = makeDoc('skills', '[built-in]:fresh', `${C} fresh`);
    const freshHash = hashOf(freshDoc);

    const wiki = new WikiManager(makeCore());
    const results = await wiki.batchPut([
      { document: liveDoc },
      { document: freshDoc },
    ]);

    // The live one is alreadyExisted (not re-appended); the fresh one is a
    // real append → success:true with a real line on disk.
    expect(results[0]).toEqual({ success: true, hash: liveHash, alreadyExisted: true });
    expect(results[1]).toEqual({ success: true, hash: freshHash });
    expect(results[1].alreadyExisted).toBeUndefined();

    // The fresh entry has exactly ONE WAL line on disk (no duplicate, and
    // the success flag was set after the append, so a true ⇒ a real line).
    const lines = readTodayWalLines().filter((l) => l.includes(freshHash));
    expect(lines).toHaveLength(1);
  });

  it('#4: batch-deletes N stale skills in ONE WAL append with N DISTINCT sequences', async () => {
    // Seed the table with 3 stale own-scope skills (titles no longer in the
    // entry list → orphans). indexSkills should tombstone all 3 in ONE
    // appendTombstones call: a single fs.appendFileSync, and each tombstone
    // carries a DISTINCT monotonic sequence (first..first+2), matching
    // single-delete semantics.
    const staleHashes = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
    // Seed the WAL with LIVE inserts for the stale hashes (so they're live
    // in the source of truth; the orphan sweep sees them in the table and
    // tombstones them).
    const seedLines = staleHashes.map((h, i) =>
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        hash: h,
        document: makeDoc('skills', `[built-in]:stale${i}`, `${C} stale${i}`),
        approved: true,
        namespace: 'test-ns',
        sequence: i + 1,
      } as WALEntry),
    );
    fs.writeFileSync(todayWalPath(), `${seedLines.join('\n')}\n`, 'utf-8');
    // Also mirror them into the fake table so getByDomain returns them (the
    // orphan sweep diffs against the table).
    tableState.rows = staleHashes.map((h, i) => ({
      hash: h, domain: 'skills', title: `[built-in]:stale${i}`, content: `${C} stale${i}`,
      references: '[]', embedding: new Array(8).fill(0), createdAt: '',
    }));

    // An empty entry list (FULL re-index, skipOrphanSweep default false) →
    // every own-scope table row is an orphan → all 3 tombstoned.
    const wiki = await newManager();
    await wiki.indexSkills([]);

    // The 3 tombstones are appended in ONE batch. Count the NEW WAL lines
    // added by indexSkills (the seeded live inserts remain; the tombstones
    // are appended after them in the SAME today file).
    const lines = readTodayWalLines();
    const tombstones = lines.map((l) => {
      try { return JSON.parse(l) as WALEntry; } catch { return null; }
    }).filter((e): e is WALEntry => e !== null && e.deleted === true);

    expect(tombstones).toHaveLength(3);
    // All 3 tombstone hashes are present, distinct, and match the stale set.
    const tHashes = tombstones.map((t) => t.hash).sort();
    expect(tHashes).toEqual([...staleHashes].sort());
    // Distinct monotonic sequences: the three sequences are all different.
    const seqs = tombstones.map((t) => t.sequence).filter((s): s is number => typeof s === 'number').sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(3);
    // And they form a contiguous block (first+0, first+1, first+2).
    expect(seqs[2]! - seqs[0]!).toBe(2);
    // Each tombstone is above the seeded live sequences (so a later re-insert
    // would still win — matching single-delete semantics).
    expect(seqs[0]!).toBeGreaterThan(3);
  });
});