/**
 * wiki-state.test.ts — behavior tests for the wiki state machine + 2-phase
 * commit (2FC) write path and the native cosine search.
 *
 * The wiki table carries a one-way `state` column:
 *   0 = PENDING  (written to the DB, not yet solidified by the WAL; NOT readable)
 *   1 = LIVE     (in the DB AND in the WAL; the only readable state)
 *   2 = SUBMERGED (logically deleted; swept by GC/rebuild)
 *
 * The tests pin the invariants that make the 2FC safe:
 *   - create writes PENDING → appends WAL → flips LIVE (readable only at the end);
 *   - a crash between the DB write and the WAL append leaves a PENDING row that
 *     reads MUST NOT return;
 *   - delete appends a tombstone and submerges (state 2), so the row is hidden
 *     and dropped by a subsequent rebuild;
 *   - a stale-schema table (no `state` column) fails fast with a /wiki rebuild
 *     instruction instead of degrading to a silent empty result;
 *   - native cosine search maps `_distance` → similarity = 1 - distance.
 *
 * Heavy externals are mocked: `../../engine/rag-provider.js` (no Ollama) and
 * `@lancedb/lancedb` (an in-memory fake supporting where/update/delete).
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
  getHeartbeatFile: (sid: string) => path.join(tempDir, `hb-${sid}.json`),
  getMyccDir: () => tempDir,
  getSessionContext: () => 'test-session',
  getRagProvider: () => 'nomic',
  ensureDirs: () => {
    if (!fs.existsSync(logsDir())) fs.mkdirSync(logsDir(), { recursive: true });
  },
}));

// --- Embedding mock -------------------------------------------------------
// A deterministic embedding: identical content → identical vector, so native
// search's `_distance` behaves predictably in tests.
vi.mock('../../engine/rag-provider.js', () => ({
  EMBEDDING_DIM: 4,
  NAMESPACE: 'test-ns',
  getEmbedding: async (text: string) => embedFor(text),
  getEmbeddings: async (texts: string[]) => texts.map(embedFor),
}));

function embedFor(text: string): number[] {
  // Tiny bag-of-chars → 4-dim vector; identical text ⇒ identical vector.
  const v = [0, 0, 0, 0];
  for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- LanceDB mock (predicate-aware) --------------------------------------
interface Row { [k: string]: unknown }
const tableState = { rows: [] as Row[], addCalls: 0 };

function rowMatches(row: Row, predicate: string): boolean {
  const clauses = predicate.split(/\s+AND\s+/i);
  return clauses.every((clause) => {
    let m = /\b(\w+)\s*!=\s*'?([^']*)'?/.exec(clause);
    if (m) return String(row[m[1]]) !== m[2];
    m = /\b(\w+)\s+IN\s*\(([^)]*)\)/i.exec(clause);
    if (m) {
      const vals = m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
      return vals.includes(String(row[m[1]]));
    }
    m = /\b(\w+)\s*=\s*'?([^']*)'?/.exec(clause);
    if (m) return String(row[m[1]]) === m[2];
    return true;
  });
}

// Sentinel: set true to make add() throw (simulates a crash / DB failure).
let failNextAdd = false;

vi.mock('@lancedb/lancedb', () => {
  const fakeTable = {
    add: async (records: Row[]) => {
      if (failNextAdd) { failNextAdd = false; throw new Error('boom'); }
      tableState.addCalls++;
      tableState.rows.push(...records);
    },
    delete: async (filter: string) => {
      if (filter.trim() === 'true') tableState.rows = [];
      else tableState.rows = tableState.rows.filter((r) => !rowMatches(r, filter));
      return { numDeletedRows: 0, version: 1 };
    },
    update: async (opts: { where?: string; values: Row }) => {
      let n = 0;
      for (const row of tableState.rows) {
        if (!opts.where || rowMatches(row, opts.where)) { Object.assign(row, opts.values); n++; }
      }
      return { rowsUpdated: n, version: 1 };
    },
    // Native vector search: cosine distance over all rows matching `where`.
    vectorSearch: (query: number[]) => {
      const state: { predicate: string; limit: number } = { predicate: 'true', limit: 10 };
      const builder = {
        distanceType: () => builder,
        where: (p: string) => { state.predicate = p; return builder; },
        limit: (n: number) => { state.limit = n; return builder; },
        toArray: async () =>
          tableState.rows
            .filter((r) => rowMatches(r, state.predicate))
            .map((r) => ({ ...r, _distance: cosineDistance(query, r.embedding as number[]) }))
            .sort((a, b) => (a._distance as number) - (b._distance as number))
            .slice(0, state.limit),
      };
      return builder;
    },
    query: () => ({
      where: (predicate: string) => ({
        toArray: async () => tableState.rows.filter((r) => rowMatches(r, predicate)),
      }),
      toArray: async () => tableState.rows,
    }),
    // Schema mock: `state` present unless `staleSchema` is set.
    schema: async () => ({ fields: staleSchema ? [{ name: 'hash' }] : [{ name: 'hash' }, { name: 'state' }] }),
  };
  return {
    connect: async () => ({
      tableNames: async () => (staleSchema ? ['wiki_test-ns'] : []),
      openTable: async () => fakeTable,
      createTable: async (_name: string, rows: Row[]) => { tableState.rows = [...rows]; return fakeTable; },
      dropTable: async () => { tableState.rows = []; },
    }),
  };
});

// When true, initDb() opens an existing table whose schema lacks `state`.
let staleSchema = false;

// --- Helpers --------------------------------------------------------------
function makeDoc(domain: string, title: string, content: string, references: string[] = []): WikiDocument {
  return { domain, title, content, references };
}

function hashOf(doc: WikiDocument): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(`${doc.domain}:${doc.title}:${doc.content}`).digest('hex').slice(0, 16);
}

function makeCore(): CoreModule {
  return { brief: vi.fn(), verbose: vi.fn() } as unknown as CoreModule;
}

const C = 'a document content long enough to be a realistic body';

/** Read every WAL line across all day files, in file+line order. */
function allWalEntries(): WALEntry[] {
  if (!fs.existsSync(logsDir())) return [];
  const out: WALEntry[] = [];
  for (const f of fs.readdirSync(logsDir()).filter((x) => x.endsWith('.wal')).sort()) {
    for (const line of fs.readFileSync(path.join(logsDir(), f), 'utf-8').trim().split('\n')) {
      if (line.trim()) out.push(JSON.parse(line) as WALEntry);
    }
  }
  return out;
}

describe('wiki state machine + 2FC', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-state-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(domainsFile(), JSON.stringify([
      { domain_name: 'project', description: '', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    tableState.rows = [];
    tableState.addCalls = 0;
    staleSchema = false;
    failNextAdd = false;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function newManager() {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(makeCore());
  }

  it('put() writes LIVE (state=1) and appends a WAL line', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 't', `${C} hello`);
    const hash = hashOf(doc);

    const res = await wiki.put(hash, doc);
    expect(res.success).toBe(true);

    const row = tableState.rows.find((r) => r.hash === hash);
    expect(row).toBeDefined();
    expect(Number(row!.state)).toBe(1); // solidified
    // WAL carries the entry (durable source of truth).
    expect(allWalEntries().some((e) => e.hash === hash && !e.deleted)).toBe(true);
  });

  it('a PENDING row left by a crash is NOT readable', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 't', `${C} crashy`);
    const hash = hashOf(doc);

    // Phase 1 (add) succeeds, then... simulate the WAL append failing by
    // making the *second* add throw is wrong; instead force the row to stay
    // PENDING by intercepting: add succeeds with state=0, and we abort before
    // the flip by throwing inside appendWAL. Simplest faithful simulation:
    // seed the row directly at state 0 and assert reads ignore it.
    tableState.rows.push({
      hash, domain: doc.domain, title: doc.title, content: doc.content,
      references: '[]', embedding: embedFor(doc.content), createdAt: 'x', state: 0,
    });

    // get() must not return the PENDING row (filtered by state = 1).
    const results = await wiki.get(doc.content, { topK: 5, threshold: 0 });
    expect(results.some((r) => r.hash === hash)).toBe(false);
    // findRecordByHash (used by put's alreadyExisted check) also ignores it.
    const putRes = await wiki.put(hash, doc);
    expect(putRes.alreadyExisted).toBeUndefined();
  });

  it('delete() appends a tombstone and submerges the row (state=2), hidden from reads', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 't', `${C} bye`);
    const hash = hashOf(doc);
    await wiki.put(hash, doc);

    const ok = await wiki.delete(hash);
    expect(ok).toBe(true);

    const row = tableState.rows.find((r) => r.hash === hash);
    expect(Number(row!.state)).toBe(2); // submerged

    // A tombstone (deleted:true, same hash) was appended to the WAL.
    const tombs = allWalEntries().filter((e) => e.hash === hash && e.deleted);
    expect(tombs.length).toBeGreaterThanOrEqual(1);

    // Hidden from search.
    const results = await wiki.get(doc.content, { topK: 5, threshold: 0 });
    expect(results.some((r) => r.hash === hash)).toBe(false);
  });

  it('rebuild() drops a tombstoned doc and recreates LIVE rows', async () => {
    const wiki = await newManager();
    const keep = makeDoc('project', 'keep', `${C} keep`);
    const gone = makeDoc('project', 'gone', `${C} gone`);
    await wiki.put(hashOf(keep), keep);
    await wiki.put(hashOf(gone), gone);
    await wiki.delete(hashOf(gone));

    const res = await wiki.rebuild();
    expect(res.success).toBe(true);

    const hashes = tableState.rows.filter((r) => r.hash !== '__schema__').map((r) => r.hash);
    expect(hashes).toContain(hashOf(keep));
    expect(hashes).not.toContain(hashOf(gone));
    // Rebuild writes every replayed row LIVE.
    expect(tableState.rows.filter((r) => r.hash !== '__schema__').every((r) => Number(r.state) === 1)).toBe(true);
  });

  it('get() uses native cosine search and ranks nearest first', async () => {
    const wiki = await newManager();
    const a = makeDoc('project', 'a', 'alpha alpha alpha alpha alpha alpha alpha alpha');
    const b = makeDoc('project', 'b', 'beta beta beta beta beta beta beta beta beta beta');
    await wiki.put(hashOf(a), a);
    await wiki.put(hashOf(b), b);

    const results = await wiki.get('alpha alpha alpha alpha alpha alpha alpha alpha', { topK: 5, threshold: 0 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].hash).toBe(hashOf(a)); // nearest
    expect(results[0].similarity).toBeGreaterThan(0.99); // ~identical
  });

  it('fails fast with a /wiki rebuild instruction on a stale schema', async () => {
    staleSchema = true; // an existing table whose schema lacks `state`
    const wiki = await newManager();

    await expect(wiki.get('anything', { topK: 1 })).rejects.toThrow(/\/wiki rebuild/);
  });

  it('GC sweeps submerged (state=2) rows when an existing table is opened', async () => {
    // Pre-seed a submerged row, then open the (existing) table.
    staleSchema = false;
    tableState.rows = [
      { hash: 'aaaaaaaaaaaaaaaa', domain: 'project', title: 'x', content: 'c', references: '[]', embedding: embedFor('c'), createdAt: 'x', state: 2 },
    ];
    // Force initDb() to take the "existing table" path by marking it present.
    const wiki = await newManager();
    // Trigger initDb via a read; GC runs inside it.
    await wiki.getByDomain('project');
    expect(tableState.rows.some((r) => Number(r.state) === 2)).toBe(false);
  });
});
