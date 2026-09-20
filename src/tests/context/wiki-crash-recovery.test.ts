/**
 * wiki-crash-recovery.test.ts — fault-injected crash → restart → rebuild tests.
 *
 * The wiki's durability model is WAL-as-source-of-truth:
 *
 *     WAL            = authoritative (survives a crash)
 *     LanceDB        = a materialized view (may lag / be inconsistent)
 *     rebuild(WAL)   = the convergence mechanism
 *
 * So the central property every test here pins is:
 *
 *     After ANY crash point, rebuilding from the (persisted) WAL produces the
 *     correct database view.
 *
 * DB and WAL are ALLOWED to disagree transiently (that is the whole point of
 * 2FC + a materialized view); we therefore never assert "DB and WAL match
 * immediately". We assert convergence AFTER a rebuild, using the WAL as the
 * oracle.
 *
 * Crash simulation is by FAULT INJECTION at real side-effect boundaries, not
 * by hand-writing a DB row (the older wiki-state test seeded `state: 0`
 * directly, which tests the read predicate but not the 2FC ordering). Here the
 * real put()/delete()/batchPut() code path executes and throws at a chosen
 * boundary, then we DISPOSE the manager and build a fresh one — so recovery is
 * proven from the persisted WAL + persisted DB, not the in-memory graph.
 *
 * Fault points exercised:
 *   put.afterDbAdd       — row added PENDING, then crash before WAL append
 *   put.afterWalAppend   — WAL appended, then crash before the LIVE flip
 *   delete.afterWalAppend— WAL tombstone appended, then crash before submerge
 *   batch.afterWalAppend — whole batch WAL-appended, then crash before flip
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
vi.mock('../../engine/rag-provider.js', () => ({
  EMBEDDING_DIM: 4,
  NAMESPACE: 'test-ns',
  getEmbedding: async (text: string) => embedFor(text),
  getEmbeddings: async (texts: string[]) => texts.map(embedFor),
}));

function embedFor(text: string): number[] {
  const v = [0, 0, 0, 0];
  for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

// --- Fault injection ------------------------------------------------------
// A single armed fault point. When set, the corresponding real boundary throws.
// `null` = no fault armed (normal execution).
type FaultPoint =
  | 'put.afterDbAdd'
  | 'put.afterWalAppend'
  | 'delete.afterWalAppend'
  | 'batch.afterWalAppend';

let armedFault: FaultPoint | null = null;
/** Which boundary just fired (so a test can assert the fault actually hit). */
let firedFault: FaultPoint | null = null;

function armFault(p: FaultPoint | null): void {
  armedFault = p;
  firedFault = null;
}

/**
 * Map a table operation to the "just after this side effect" fault point.
 * `add` corresponds to the DB write; the WAL boundary is handled by the
 * wiki-wal mock (`appendWALEntry`/`appendWALEntries`); a solidifying `update`
 * (values.state === 1) is the post-WAL flip.
 */
function faultAfterTableOp(op: 'add' | 'updateSolidify'): FaultPoint | null {
  if (op === 'add') return 'put.afterDbAdd';
  if (op === 'updateSolidify') return 'put.afterWalAppend';
  return null;
}

// --- LanceDB mock (persistent across manager restarts within a test) ------
// The in-memory table survives `newManager()` calls WITHIN a test; we reset it
// explicitly in beforeEach. This models the persistent on-disk DB.
interface Row { [k: string]: unknown }
const tableState = { rows: [] as Row[] };

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

function maybeThrowAfter(op: 'add' | 'updateSolidify'): void {
  const point = faultAfterTableOp(op);
  if (armedFault !== null && armedFault === point) {
    firedFault = armedFault;
    armedFault = null;
    throw new Error(`injected fault at ${point}`);
  }
}

let staleSchema = false;

vi.mock('@lancedb/lancedb', () => {
  const fakeTable = {
    add: async (records: Row[]) => {
      tableState.rows.push(...records);
      // Fault fires AFTER the rows are durably written (the boundary is
      // "the DB write completed, then we crash").
      maybeThrowAfter('add');
    },
    delete: async (filter: string) => {
      if (filter.trim() === 'true') tableState.rows = [];
      else tableState.rows = tableState.rows.filter((r) => !rowMatches(r, filter));
      return { numDeletedRows: 0, version: 1 };
    },
    update: async (opts: { where?: string; values: Row }) => {
      // A state→1 flip is the post-WAL solidify boundary. The fault must fire
      // BEFORE the flip is applied — the crash happens at the boundary "WAL is
      // durable, the solidify update has not taken effect".
      if (Number((opts.values as Row).state) === 1) maybeThrowAfter('updateSolidify');
      let n = 0;
      for (const row of tableState.rows) {
        if (!opts.where || rowMatches(row, opts.where)) { Object.assign(row, opts.values); n++; }
      }
      return { rowsUpdated: n, version: 1 };
    },
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
    schema: async () => ({ fields: staleSchema ? [{ name: 'hash' }] : [{ name: 'hash' }, { name: 'state' }] }),
  };
  return {
    connect: async () => ({
      tableNames: async () => (staleSchema ? ['wiki_test-ns'] : ['wiki_test-ns']),
      openTable: async () => fakeTable,
      createTable: async (_name: string, rows: Row[]) => { tableState.rows = [...rows]; return fakeTable; },
      dropTable: async () => { tableState.rows = []; },
    }),
  };
});

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- WAL module mock: REAL file writes + a fault at the append boundary ----
// We do NOT reimplement the WAL: we call through to the real implementation so
// the persisted file is genuine, then optionally throw to model a crash
// immediately after the append (i.e. before the caller's next step).
vi.mock('../../context/parent/wiki-wal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../context/parent/wiki-wal.js')>();
  return {
    ...actual,
    appendWALEntry: (entry: WALEntry) => {
      actual.appendWALEntry(entry); // real, durable write
      if (armedFault === 'delete.afterWalAppend' && entry.deleted) {
        firedFault = armedFault; armedFault = null;
        throw new Error('injected fault at delete.afterWalAppend');
      }
    },
    appendWALEntries: (entries: WALEntry[]) => {
      actual.appendWALEntries(entries); // real, durable write
      if (armedFault === 'batch.afterWalAppend') {
        firedFault = armedFault; armedFault = null;
        throw new Error('injected fault at batch.afterWalAppend');
      }
    },
  };
});

// --- Helpers --------------------------------------------------------------
function makeDoc(domain: string, title: string, content: string): WikiDocument {
  return { domain, title, content, references: [] };
}

function hashOf(doc: WikiDocument): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(`${doc.domain}:${doc.title}:${doc.content}`).digest('hex').slice(0, 16);
}

function makeCore(): CoreModule {
  return { brief: vi.fn(), verbose: vi.fn() } as unknown as CoreModule;
}

const C = 'a document content long enough to be a realistic wiki body';

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

/**
 * Reference model: fold WAL latest-wins by hash, then apply the rebuild
 * filters (deleted / unapproved / foreign namespace). This is the ORACLE —
 * the set of document hashes a correct rebuild must materialize.
 */
function materializeWal(wal: WALEntry[], namespace = 'test-ns'): string[] {
  const merged = new Map<string, WALEntry>();
  for (const e of wal) merged.set(e.hash, e); // latest wins
  const survivors: string[] = [];
  for (const e of merged.values()) {
    if (e.deleted) continue;
    if (!e.approved) continue;
    if (e.namespace && e.namespace !== namespace) continue;
    survivors.push(e.hash);
  }
  return survivors.sort();
}

/** The set of LIVE, non-sentinel document hashes physically in the DB. */
function liveDbHashes(): string[] {
  return tableState.rows
    .filter((r) => Number(r.state) === 1 && r.hash !== '__schema__')
    .map((r) => String(r.hash))
    .sort();
}

/** The set of PENDING (state=0) non-sentinel hashes physically in the DB. */
function pendingDbHashes(): string[] {
  return tableState.rows
    .filter((r) => Number(r.state) === 0 && r.hash !== '__schema__')
    .map((r) => String(r.hash))
    .sort();
}

describe('wiki crash recovery (WAL-as-truth, fault-injected)', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-crash-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(domainsFile(), JSON.stringify([
      { domain_name: 'project', description: '', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    tableState.rows = [];
    staleSchema = false;
    armFault(null);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function newManager() {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(makeCore());
  }

  /**
   * The canonical recovery assertion: a FRESH manager rebuilds from the
   * persisted WAL and its LIVE view must equal the WAL-derived oracle.
   */
  async function expectRebuildConvergesToWal(): Promise<void> {
    const recovered = await newManager(); // restart: fresh manager, persisted WAL+DB
    await recovered.rebuild();
    expect(liveDbHashes()).toEqual(materializeWal(allWalEntries()));
  }

  // --- PUT crash matrix ---------------------------------------------------

  it('PUT crash after DB add, before WAL append → rebuild drops the PENDING row', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 'p1', `${C} put-p1`);
    const hash = hashOf(doc);

    armFault('put.afterDbAdd');
    const res = await wiki.put(hash, doc);
    expect(res.success).toBe(false); // the injected fault surfaced as failure
    expect(firedFault).toBe('put.afterDbAdd');

    // Crash state: DB has a PENDING row, WAL is absent.
    expect(pendingDbHashes()).toEqual([hash]);
    expect(allWalEntries()).toEqual([]);

    // Rebuild converges: a PENDING row with no WAL entry is dropped.
    await expectRebuildConvergesToWal();
    expect(liveDbHashes()).toEqual([]);
  });

  it('PUT crash after WAL append, before LIVE flip → rebuild restores the document', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 'p2', `${C} put-p2`);
    const hash = hashOf(doc);

    armFault('put.afterWalAppend');
    const res = await wiki.put(hash, doc);
    expect(res.success).toBe(false);
    expect(firedFault).toBe('put.afterWalAppend');

    // Crash state: DB row still PENDING, WAL entry IS present. Not readable yet.
    expect(pendingDbHashes()).toEqual([hash]);
    expect(allWalEntries().some((e) => e.hash === hash && !e.deleted)).toBe(true);

    // WAL existence is exactly what makes the PENDING row recoverable.
    await expectRebuildConvergesToWal();
    expect(liveDbHashes()).toEqual([hash]);
  });

  it('PUT success → row is LIVE and rebuild preserves it', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 'p3', `${C} put-p3`);
    const hash = hashOf(doc);

    const res = await wiki.put(hash, doc);
    expect(res.success).toBe(true);
    expect(liveDbHashes()).toEqual([hash]);

    await expectRebuildConvergesToWal();
    expect(liveDbHashes()).toEqual([hash]);
  });

  // --- DELETE crash matrix ------------------------------------------------

  it('DELETE crash after WAL tombstone, before submerge → rebuild removes the zombie', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 'd1', `${C} del-d1`);
    const hash = hashOf(doc);
    await wiki.put(hash, doc);
    expect(liveDbHashes()).toEqual([hash]);

    armFault('delete.afterWalAppend');
    const ok = await wiki.delete(hash);
    expect(ok).toBe(false); // fault surfaced
    expect(firedFault).toBe('delete.afterWalAppend');

    // The canonical zombie window: WAL says deleted, DB row is still LIVE.
    expect(allWalEntries().some((e) => e.hash === hash && e.deleted)).toBe(true);
    expect(liveDbHashes()).toEqual([hash]); // stale materialized view — ALLOWED

    // Rebuild must map (DB LIVE + WAL tombstone) → absent.
    await expectRebuildConvergesToWal();
    expect(liveDbHashes()).toEqual([]);
  });

  it('successful DELETE → DB becomes SUBMERGED, reads hide it, rebuild removes it', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 'd2', `${C} del-d2`);
    const hash = hashOf(doc);
    await wiki.put(hash, doc);

    const ok = await wiki.delete(hash);
    expect(ok).toBe(true);
    const row = tableState.rows.find((r) => r.hash === hash);
    expect(Number(row!.state)).toBe(2); // submerged

    // Hidden from a live read.
    const results = await wiki.get(doc.content, { topK: 5, threshold: 0 });
    expect(results.some((r) => r.hash === hash)).toBe(false);

    await expectRebuildConvergesToWal();
    expect(liveDbHashes()).toEqual([]);
  });

  // --- batchPut crash -----------------------------------------------------

  it('batchPut crash after the batch WAL append, before the flip → rebuild restores the whole batch', async () => {
    const wiki = await newManager();
    const docs = [
      makeDoc('project', 'ba', `${C} batch-a`),
      makeDoc('project', 'bb', `${C} batch-b`),
      makeDoc('project', 'bc', `${C} batch-c`),
    ];
    const hashes = docs.map(hashOf).sort();

    armFault('batch.afterWalAppend');
    const results = await wiki.batchPut(docs.map((d) => ({ document: d, embedding: embedFor(d.content) })));
    expect(results.every((r) => r.success === false)).toBe(true);
    expect(firedFault).toBe('batch.afterWalAppend');

    // Crash state: all three rows PENDING, all three WAL entries present.
    expect(pendingDbHashes()).toEqual(hashes);
    for (const h of hashes) {
      expect(allWalEntries().some((e) => e.hash === h && !e.deleted)).toBe(true);
    }

    await expectRebuildConvergesToWal();
    expect(liveDbHashes()).toEqual(hashes);
  });

  // --- rebuild sequence tests (§7) ----------------------------------------

  it('rebuild: PUT → DELETE → deleted', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 'seq1', `${C} seq1`);
    await wiki.put(hashOf(doc), doc);
    await wiki.delete(hashOf(doc));
    await expectRebuildConvergesToWal();
    expect(liveDbHashes()).toEqual([]);
  });

  it('rebuild: PUT → DELETE → PUT → the latest PUT survives', async () => {
    const wiki = await newManager();
    const doc = makeDoc('project', 'seq2', `${C} seq2`);
    const hash = hashOf(doc);
    await wiki.put(hash, doc);
    await wiki.delete(hash);
    await wiki.put(hash, doc); // re-add the same content
    await expectRebuildConvergesToWal();
    expect(liveDbHashes()).toEqual([hash]);
  });

  it('rebuild is idempotent and does not append back to the WAL', async () => {
    const wiki = await newManager();
    await wiki.put(hashOf(makeDoc('project', 'i1', `${C} idem1`)), makeDoc('project', 'i1', `${C} idem1`));
    await wiki.put(hashOf(makeDoc('project', 'i2', `${C} idem2`)), makeDoc('project', 'i2', `${C} idem2`));

    await wiki.rebuild();
    const db1 = liveDbHashes();
    const wal1 = allWalEntries().length;

    await wiki.rebuild();
    expect(liveDbHashes()).toEqual(db1);
    expect(allWalEntries().length).toBe(wal1); // no self-amplification
  });

  // --- model-based oracle (§8/§23) ----------------------------------------

  it('arbitrary PUT/DELETE sequence → rebuild matches the WAL fold oracle', async () => {
    const wiki = await newManager();
    const A = makeDoc('project', 'A', `${C} oracle-A`);
    const B = makeDoc('project', 'B', `${C} oracle-B`);
    const Cdoc = makeDoc('project', 'C', `${C} oracle-C`);

    // PUT A, PUT B, DELETE A, PUT C, DELETE B, PUT A, DELETE C
    await wiki.put(hashOf(A), A);
    await wiki.put(hashOf(B), B);
    await wiki.delete(hashOf(A));
    await wiki.put(hashOf(Cdoc), Cdoc);
    await wiki.delete(hashOf(B));
    await wiki.put(hashOf(A), A);
    await wiki.delete(hashOf(Cdoc));

    // Expected survivors after the latest-wins fold: only A (last op for A is
    // a live PUT; B and C are last seen as deleted).
    await expectRebuildConvergesToWal();
    expect(liveDbHashes()).toEqual([hashOf(A)]);
  });
});
