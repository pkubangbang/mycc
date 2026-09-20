/**
 * wiki-vectorsearch.test.ts — the native ANN read path.
 *
 * Two things are asserted:
 *  1. CORRECTNESS — `get()` ranks by cosine similarity, honors the domain
 *     prefilter and the similarity threshold, and EXCLUDES premature
 *     (`createdAt IS NULL`) rows. The mock table implements the two `.where()`
 *     predicates the code actually emits and returns `_distance` rows like the
 *     real engine (cosine distance, lower = closer).
 *  2. FALLBACK — when `vectorSearch` throws, `get()` falls back to the manual
 *     scan with identical semantics (so an unavailable index degrades rather
 *     than fails).
 *
 * The mock also records the predicate string so we can assert the read filter
 * really carries `createdAt IS NOT NULL` and the escaped domain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CoreModule } from '../../types.js';

let tempDir = '';
const logsDir = () => path.join(tempDir, 'logs');
const domainsFile = () => path.join(tempDir, 'domains.json');

vi.mock('../../config.js', () => ({
  getWikiLogsDir: () => logsDir(),
  getWikiDbDir: () => path.join(tempDir, 'db'),
  getWikiDomainsFile: () => domainsFile(),
  getWikiReindexLockFile: () => path.join(tempDir, 'reindex.lock'),
  getHeartbeatFile: (sid: string) => path.join(tempDir, `hb-${sid}.json`),
  getMyccDir: () => tempDir,
  getSessionContext: () => 'test-session',
  getRagProvider: () => 'nomic',
  ensureDirs: () => { if (!fs.existsSync(logsDir())) fs.mkdirSync(logsDir(), { recursive: true }); },
}));

// Query embedding is a fixed vector; stored row embeddings vary so cosine
// ranking is deterministic and controllable per test.
const QUERY_VEC = [1, 0, 0, 0];
vi.mock('../../engine/rag-provider.js', () => ({
  EMBEDDING_DIM: 4,
  NAMESPACE: 'test-ns',
  getEmbedding: async () => QUERY_VEC,
  getEmbeddings: async (texts: string[]) => texts.map(() => QUERY_VEC),
}));

interface Row { hash: string; domain: string; title: string; content: string; references: string; embedding: number[]; createdAt: string | null }

const tableState = {
  rows: [] as Row[],
  /** Whether the fake table already exists (so initDb opens rather than creates). */
  tableExists: false,
  /** Set true to make vectorSearch throw (exercise the fallback). */
  failVectorSearch: false,
  /** Records the last predicate passed to `.where()`. */
  lastPredicate: '',
  /** Records the last limit passed to `.limit()`. */
  lastLimit: 0,
};

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

vi.mock('@lancedb/lancedb', () => {
  const matchesPredicate = (predicate: string, row: Row): boolean => {
    // Predicates emitted by buildVectorQuery: `hash != '__schema__'` AND
    // `createdAt IS NOT NULL` [AND `domain = '...'`].
    if (/hash != '__schema__'/.test(predicate) && row.hash === '__schema__') return false;
    if (/createdAt IS NOT NULL/.test(predicate) && (row.createdAt === null || row.createdAt === undefined)) return false;
    const dom = predicate.match(/domain = '([^']*)'/);
    if (dom && row.domain !== dom[1].replace(/''/g, "'")) return false;
    return true;
  };

  const makeVectorQuery = () => {
    // Per-call state so concurrent/repeated builder chains do not clobber each
    // other's predicate/limit (mirrors the real immutable-ish builder).
    let predicate = '';
    let limit = 10;
    const q = {
      distanceType: (_t: string) => q,
      limit: (n: number) => { tableState.lastLimit = n; limit = n; return q; },
      where: (p: string) => { tableState.lastPredicate = p; predicate = p; return q; },
      toArray: async () => {
        if (tableState.failVectorSearch) throw new Error('vectorSearch unavailable (test)');
        return tableState.rows
          .filter((r) => matchesPredicate(predicate, r))
          .map((r) => ({ ...r, _distance: 1 - cosineSim(QUERY_VEC, r.embedding) }))
          .sort((a, b) => a._distance - b._distance)
          .slice(0, limit || 10);
      },
    };
    return q;
  };

  const fakeTable = {
    add: async (records: Array<Record<string, unknown>>) => { tableState.rows.push(...(records as unknown as Row[])); },
    delete: async () => { tableState.rows = []; },
    update: async () => ({ rowsUpdated: 0, version: 1 }),
    query: () => ({ where: (_f: string) => ({ toArray: async () => tableState.rows }), toArray: async () => tableState.rows }),
    vectorSearch: () => makeVectorQuery(),
    createIndex: async () => { /* no-op */ },
  };
  return {
    connect: async () => ({
      tableNames: async () => tableState.tableExists ? ['wiki_test-ns'] : [],
      openTable: async () => fakeTable,
      createTable: async (_n: string, rows: Array<Record<string, unknown>>) => {
        // Append the sentinel rather than clobbering: tests seed real rows
        // BEFORE the manager connects, and those rows must survive initDb.
        tableState.rows.push(...(rows as unknown as Row[]));
        tableState.tableExists = true;
        return fakeTable;
      },
    }),
    Index: { ivfFlat: () => ({}) },
  };
});

function makeCore(): CoreModule {
  return { brief: vi.fn(), verbose: vi.fn() } as unknown as CoreModule;
}
function row(hash: string, domain: string, title: string, emb: number[], committed = true): Row {
  return { hash, domain, title, content: `${title} content`, references: '[]', embedding: emb, createdAt: committed ? '2026-01-01T00:00:00.000Z' : null };
}

describe('WikiManager.get() — native ANN read path', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-ann-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(domainsFile(), JSON.stringify([
      { domain_name: 'project', description: '', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    tableState.rows = [];
    tableState.tableExists = false;
    tableState.failVectorSearch = false;
    tableState.lastPredicate = '';
    tableState.lastLimit = 0;
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function newManager() {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(makeCore());
  }

  it('ranks by cosine similarity and returns the top-K', async () => {
    // QUERY_VEC = [1,0,0,0]. similarity: exact = 1, orthogonal = 0, opposite = -1.
    tableState.rows.push(
      row('aaaaaaaaaaaaaaaa', 'project', 'exact', [1, 0, 0, 0]),
      row('bbbbbbbbbbbbbbbb', 'project', 'orthogonal', [0, 1, 0, 0]),
      row('cccccccccccccccc', 'project', 'opposite', [-1, 0, 0, 0]),
    );
    const wiki = await newManager();
    const res = await wiki.get('anything', { topK: 2 });

    expect(res.length).toBe(2);
    expect(res[0].document.title).toBe('exact');
    expect(res[0].similarity).toBeCloseTo(1, 5);
    expect(res[1].document.title).toBe('orthogonal');
  });

  it('excludes PREMATURE rows (createdAt IS NULL)', async () => {
    tableState.rows.push(
      row('aaaaaaaaaaaaaaaa', 'project', 'committed', [1, 0, 0, 0], true),
      row('bbbbbbbbbbbbbbbb', 'project', 'premature', [1, 0, 0, 0], false),
    );
    const wiki = await newManager();
    const res = await wiki.get('anything', { topK: 5 });

    expect(res.map((r) => r.document.title)).toEqual(['committed']);
    expect(tableState.lastPredicate).toContain('createdAt IS NOT NULL');
  });

  it('applies the domain prefilter server-side', async () => {
    tableState.rows.push(
      row('aaaaaaaaaaaaaaaa', 'project', 'p', [1, 0, 0, 0]),
      row('bbbbbbbbbbbbbbbb', 'other', 'o', [1, 0, 0, 0]),
    );
    const wiki = await newManager();
    const res = await wiki.get('anything', { topK: 5, domain: 'other' });

    expect(res.map((r) => r.document.title)).toEqual(['o']);
    expect(tableState.lastPredicate).toContain("domain = 'other'");
  });

  it('drops rows below the similarity threshold', async () => {
    tableState.rows.push(
      row('aaaaaaaaaaaaaaaa', 'project', 'exact', [1, 0, 0, 0]),
      row('bbbbbbbbbbbbbbbb', 'project', 'orthogonal', [0, 1, 0, 0]), // sim 0
    );
    const wiki = await newManager();
    const res = await wiki.get('anything', { topK: 5, threshold: 0.5 });

    expect(res.map((r) => r.document.title)).toEqual(['exact']);
  });

  it('falls back to the manual scan when vectorSearch throws (identical semantics)', async () => {
    tableState.rows.push(
      row('aaaaaaaaaaaaaaaa', 'project', 'exact', [1, 0, 0, 0]),
      row('bbbbbbbbbbbbbbbb', 'project', 'orthogonal', [0, 1, 0, 0]),
      row('cccccccccccccccc', 'project', 'premature', [1, 0, 0, 0], false),
    );
    tableState.failVectorSearch = true;
    const wiki = await newManager();
    const res = await wiki.get('anything', { topK: 5 });

    // Same ranking, premature still excluded, by the fallback scan.
    expect(res.map((r) => r.document.title)).toEqual(['exact', 'orthogonal']);
  });

  it('getByDomain excludes premature rows', async () => {
    tableState.rows.push(
      row('aaaaaaaaaaaaaaaa', 'project', 'committed', [1, 0, 0, 0], true),
      row('bbbbbbbbbbbbbbbb', 'project', 'premature', [1, 0, 0, 0], false),
    );
    const wiki = await newManager();
    const res = await wiki.getByDomain('project');

    expect(res.map((r) => r.document.title)).toEqual(['committed']);
  });
});
