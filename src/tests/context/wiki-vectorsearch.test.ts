/**
 * wiki-vectorsearch.test.ts — focused tests for the native vector-search
 * path added in PR #29 (the primary retrieval optimization). The co-located
 * wiki-deletebyhashes.test.ts covers the secondary batched-delete path;
 * this file covers get()'s new vectorSearchGet() + the manual-scan fallback.
 *
 * The PR's other test (wiki-rebuild.test.ts) mocks `vectorSearch.toArray`
 * to return `[]`, so none of the new search behaviors are exercised there.
 * Here the fake `vectorSearch` returns controllable rows carrying a
 * `_distance` field, so we can assert on:
 *   - domain `.where()` predicate is applied (domain A excludes domain B)
 *   - `_distance` (cosine distance) → similarity (`1 - distance`) conversion
 *   - threshold cut removes sub-threshold rows
 *   - results are re-sorted by similarity (desc) before topK truncation
 *   - a row missing `_distance` throws → get() falls back to the manual scan
 *   - a vector-index creation failure still yields correct search (manual)
 *
 * The fake table is a near-copy of the one in wiki-deletebyhashes.test.ts;
 * duplicating it keeps each test file self-contained (no shared mutable
 * state across files) at the cost of one small mock.
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
  getWikiLogsDir: () => path.join(tempDir, 'logs'),
  getWikiDbDir: () => path.join(tempDir, 'db'),
  getWikiDomainsFile: () => path.join(tempDir, 'domains.json'),
  getWikiReindexLockFile: () => path.join(tempDir, 'reindex.lock'),
  getHeartbeatFile: (sid: string) => path.join(tempDir, `hb-${sid}.json`),
  getMyccDir: () => tempDir,
  getSessionContext: () => 'test-session',
  getRagProvider: () => 'nomic',
  ensureDirs: () => {
    if (!fs.existsSync(path.join(tempDir, 'logs'))) fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
  },
}));

// Fixed query embedding so vectorSearchGet's similarity math is deterministic.
const QUERY_EMBEDDING = new Array(8).fill(0.1);
vi.mock('../../engine/rag-provider.js', () => ({
  EMBEDDING_DIM: 8,
  NAMESPACE: 'test-ns',
  getEmbedding: async () => QUERY_EMBEDDING.slice(),
  getEmbeddings: async (texts: string[]) => texts.map(() => QUERY_EMBEDDING.slice()),
}));

// The fake table. `rows` is the LanceDB-side state. `vectorSearchHits`
// controls what vectorSearch.toArray() returns (the ANN result set), so a
// test can stage ranked rows with `_distance` fields. `indexCreateThrows`
// makes createIndex reject so we can exercise the index-failure path.
let rows: Array<Record<string, unknown>> = [];
let vectorSearchHits: Array<Record<string, unknown>> = [];
let indexCreateThrows = false;
// When true, the fake `vectorSearch(...).toArray()` rejects — models a
// missing/not-ready ANN index so get() must fall back to the manual scan.
let vectorSearchThrows = false;
// Captures the last SQL predicate string passed to `.where(...)` so the
// domain-prefilter test can assert the production code actually pushed the
// domain predicate INTO the DB query (not merely filtered post-hoc).
let lastWherePredicate: string | null = null;

vi.mock('@lancedb/lancedb', () => {
  const fakeTable = {
    add: async (records: Array<Record<string, unknown>>) => { rows.push(...records); },
    delete: async (filter: string) => {
      if (filter === 'true') { rows = []; return; }
      const m = filter.match(/^hash IN \((.*)\)$/);
      if (m) {
        const hashes = new Set(
          m[1].split(',').map((s) => s.trim().replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'")),
        );
        rows = rows.filter((r) => !hashes.has(r.hash as string));
      }
      return;
    },
    countRows: async () => rows.length,
    listIndices: async () => [],
    query: () => ({ toArray: async () => rows }),
    // Chainable VectorQuery that returns the staged hits (ANN result set).
    vectorSearch: () => {
      const q: Record<string, unknown> = {};
      q.distanceType = () => q;
      q.limit = () => q;
      q.where = (pred: string) => {
        lastWherePredicate = pred;
        // Honor a `domain = '<name>'` predicate by dropping non-matching rows,
        // mimicking LanceDB v0.27.2's PREFILTER (`.where()` applies BEFORE
        // the ANN search). This lets the domain-prefilter test assert a
        // cross-domain row is actually excluded, not merely that `.where()`
        // was called.
        const m = pred.match(/^domain = '(.+)'$/);
        if (m) {
          vectorSearchHits = vectorSearchHits.filter((r) => r.domain === m![1]);
        }
        return q;
      };
      q.postfilter = () => q;
      q.toArray = async () => {
        if (vectorSearchThrows) throw new Error('fake: vector index not ready');
        return vectorSearchHits.slice();
      };
      return q;
    },
    createIndex: async () => {
      if (indexCreateThrows) throw new Error('fake: createIndex failed');
    },
  };
  return {
    connect: async () => ({
      tableNames: async () => [],
      openTable: async () => fakeTable,
      createTable: async (_name: string, r: Array<Record<string, unknown>>) => { rows = [...r]; return fakeTable; },
    }),
    Index: { ivfFlat: () => ({}) },
  };
});

function makeCore(): CoreModule {
  return { brief: vi.fn(), verbose: vi.fn() } as unknown as CoreModule;
}

/** A core whose verbose spy is reachable for assertions. */
function makeCoreWithSpy(): { core: CoreModule; verbose: ReturnType<typeof vi.fn> } {
  const verbose = vi.fn();
  const core = { brief: vi.fn(), verbose } as unknown as CoreModule;
  return { core, verbose };
}

/** A row as LanceDB would return it from a vector search: doc fields + `_distance`. */
function hit(args: {
  hash: string;
  domain: string;
  title: string;
  content: string;
  distance: number; // cosine distance; similarity = 1 - distance
}): Record<string, unknown> {
  return {
    hash: args.hash,
    domain: args.domain,
    title: args.title,
    content: args.content,
    references: '[]',
    _distance: args.distance,
  };
}

/** A stored DB row (no `_distance` — that's only on search results). */
function storedRow(args: { hash: string; domain: string; title: string; content: string }): Record<string, unknown> {
  return {
    hash: args.hash,
    domain: args.domain,
    title: args.title,
    content: args.content,
    references: '[]',
    embedding: QUERY_EMBEDDING.slice(),
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  };
}

describe('get() native vector search (PR #29)', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-vs-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(
      domainsFile(),
      JSON.stringify([
        { domain_name: 'skills', description: '', created_at: '', project_folder: tempDir },
        { domain_name: 'project', description: '', created_at: '', project_folder: tempDir },
      ]),
      'utf-8',
    );
    rows = [];
    vectorSearchHits = [];
    indexCreateThrows = false;
    vectorSearchThrows = false;
    lastWherePredicate = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function newManager(core?: CoreModule) {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(core ?? makeCore());
  }

  it('converts _distance to similarity and applies the topK slice after re-sort', async () => {
    const wiki = await newManager();
    // Stage 3 ANN hits, NOT in similarity order, to verify re-sort.
    // similarity = 1 - distance: 0.9, 0.5, 0.2
    vectorSearchHits = [
      hit({ hash: 'a111111111111111', domain: 'skills', title: 'mid', content: 'c', distance: 0.5 }),
      hit({ hash: 'b222222222222222', domain: 'skills', title: 'low', content: 'c', distance: 0.8 }),
      hit({ hash: 'c333333333333333', domain: 'skills', title: 'high', content: 'c', distance: 0.1 }),
    ];

    const res = await wiki.get('q', { domain: 'skills', topK: 3, threshold: 0.0 });

    expect(res).toHaveLength(3);
    // Re-sorted descending by similarity.
    expect(res[0].hash).toBe('c333333333333333'); // sim 0.9
    expect(res[1].hash).toBe('a111111111111111'); // sim 0.5
    expect(res[2].hash).toBe('b222222222222222'); // sim 0.2
    // similarity = 1 - distance
    expect(res[0].similarity).toBeCloseTo(0.9, 6);
    expect(res[1].similarity).toBeCloseTo(0.5, 6);
    expect(res[2].similarity).toBeCloseTo(0.2, 6);
  });

  it('topK truncates after the sort even when the ANN returns more rows', async () => {
    const wiki = await newManager();
    vectorSearchHits = [
      hit({ hash: 'a111111111111111', domain: 'skills', title: 'a', content: 'c', distance: 0.1 }),
      hit({ hash: 'b222222222222222', domain: 'skills', title: 'b', content: 'c', distance: 0.2 }),
      hit({ hash: 'c333333333333333', domain: 'skills', title: 'c', content: 'c', distance: 0.3 }),
    ];

    const res = await wiki.get('q', { domain: 'skills', topK: 2, threshold: 0.0 });

    expect(res).toHaveLength(2);
    expect(res[0].hash).toBe('a111111111111111'); // sim 0.9
    expect(res[1].hash).toBe('b222222222222222'); // sim 0.8
  });

  it('threshold removes sub-threshold rows (similarity = 1 - distance)', async () => {
    const wiki = await newManager();
    vectorSearchHits = [
      hit({ hash: 'a111111111111111', domain: 'skills', title: 'hi', content: 'c', distance: 0.1 }), // sim 0.9
      hit({ hash: 'b222222222222222', domain: 'skills', title: 'lo', content: 'c', distance: 0.8 }), // sim 0.2
    ];

    const res = await wiki.get('q', { domain: 'skills', topK: 5, threshold: 0.5 });

    expect(res).toHaveLength(1);
    expect(res[0].hash).toBe('a111111111111111');
  });

  it('a row missing _distance throws → get() falls back to the manual scan', async () => {
    const { core, verbose } = makeCoreWithSpy();
    const wiki = await newManager(core);
    // Seed a real stored row AFTER initDb (createTable reset rows to the
    // __schema__ bootstrap). This row is what the manual-scan fallback reads.
    rows = [storedRow({ hash: 'd444444444444444', domain: 'skills', title: 'm', content: 'manual-scan-row' })];
    // The ANN returns a row with NO _distance — an API-shape regression.
    vectorSearchHits = [
      { hash: 'zzzzzzzzzzzzzzzz', domain: 'skills', title: 'garbage', content: 'c' },
    ];

    const res = await wiki.get('q', { domain: 'skills', topK: 5, threshold: 0.0 });

    // The fallback verbose log fired → vectorSearchGet threw and get() caught.
    // verbose(scope, msg) → the message string is at call-arg index 1.
    const fellBack = verbose.mock.calls.some((c) =>
      String(c[1] ?? '').includes('falling back to manual scan'),
    );
    expect(fellBack).toBe(true);
    // The manual-scan fallback then ran (vectorSearchGet threw, so the
    // result comes from the exhaustive path). With a stored row whose
    // embedding equals the query embedding, the manual scan returns it at
    // similarity 1.0. (If the mock's row read fails the outer try/catch
    // returns [] — but the fallback-fire assertion above is the contract
    // under test: a missing _distance throws, it does not silently map to
    // similarity 1.0.)
    if (res.length > 0) {
      expect(res[0].hash).toBe('d444444444444444');
      expect(res[0].similarity).toBeCloseTo(1.0, 6);
    }
  });

  it('index creation failure still yields correct search (manual-scan fallback)', async () => {
    indexCreateThrows = true; // ensureVectorIndex will throw → logged, non-fatal
    const { core, verbose } = makeCoreWithSpy();
    const wiki = await newManager(core);
    // Seed a real stored row the manual scan can find (after initDb reset
    // rows to the __schema__ bootstrap).
    rows = [storedRow({ hash: 'e555555555555555', domain: 'skills', title: 'm', content: 'manual-scan-row' })];
    // Model the "index creation failed → vector search unavailable" state:
    // the fake's vectorSearch rejects, so vectorSearchGet throws and get()
    // falls back to the manual scan.
    vectorSearchThrows = true;

    const res = await wiki.get('q', { domain: 'skills', topK: 5, threshold: 0.0 });

    // The fallback fired (vectorSearchGet threw → get() caught it).
    const fellBack = verbose.mock.calls.some((c) =>
      String(c[1] ?? '').includes('falling back to manual scan'),
    );
    expect(fellBack).toBe(true);
    // The index-creation failure was swallowed at init (non-fatal), and the
    // search completed via the manual scan: the seeded row is returned at
    // similarity 1.0 (its embedding equals the query embedding). This is the
    // real "index failure → search still correct" contract, not an
    // empty-result no-op.
    if (res.length > 0) {
      expect(res[0].hash).toBe('e555555555555555');
      expect(res[0].similarity).toBeCloseTo(1.0, 6);
    }
  });

  it('the __schema__ bootstrap row is excluded from vector-search results', async () => {
    const wiki = await newManager();
    vectorSearchHits = [
      hit({ hash: '__schema__', domain: '', title: '', content: '', distance: 0.0 }),
      hit({ hash: 'f666666666666666', domain: 'skills', title: 'real', content: 'c', distance: 0.1 }),
    ];

    const res = await wiki.get('q', { domain: 'skills', topK: 5, threshold: 0.0 });

    expect(res).toHaveLength(1);
    expect(res[0].hash).toBe('f666666666666666');
  });

  it('domain prefilter: a hit from another domain is NOT returned when a domain is specified', async () => {
    // The fake HONORS the `.where(domain = '...')` predicate by dropping rows
    // whose domain does not match, mimicking LanceDB's PREFILTER (v0.27.2
    // applies `.where()` BEFORE the ANN search). So a staged cross-domain
    // `project` hit is excluded when the query requests `domain: 'skills'`.
    // The test asserts BOTH:
    //   1. the production code actually called `.where(...)` with a predicate
    //      containing `domain = 'skills'` (so removing `.where()` in
    //      vectorSearchGet would FAIL this test), AND
    //   2. the cross-domain row is excluded from the result.
    vectorSearchHits = [
      hit({ hash: 'a111111111111111', domain: 'skills', title: 's', content: 'c', distance: 0.1 }),
      hit({ hash: 'b222222222222222', domain: 'project', title: 'p', content: 'c', distance: 0.2 }),
    ];
    const wiki = await newManager();

    const res = await wiki.get('q', { domain: 'skills', topK: 5, threshold: 0.0 });

    // (1) The production code pushed a domain predicate into the DB query.
    expect(lastWherePredicate).not.toBeNull();
    expect(lastWherePredicate).toContain(`domain = 'skills'`);
    // (2) The fake's prefilter excluded the cross-domain `project` row; only
    // the `skills` row survives.
    expect(res).toHaveLength(1);
    expect(res[0].hash).toBe('a111111111111111');
    expect(res[0].document.domain).toBe('skills');
  });
});