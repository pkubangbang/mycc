/**
 * wiki-reverse-2fc.test.ts — the reverse two-phase-commit invariant for the
 * wiki write path.
 *
 * Protocol: add(createdAt: null) → appendWAL(timestamp: T) → update(createdAt: T).
 *
 * The single safety invariant under test:
 *
 *   INVARIANT (I1): a COMMITTED row (createdAt not null) ⟹ its hash has a
 *   live WAL entry. The forbidden state — a visible row with no live WAL
 *   entry — must be UNREACHABLE by construction.
 *
 * Strategy: rather than observing a real crash, we INTERCEPT each phase via
 * the mocked LanceDB table and assert the invariant holds at every
 * intermediate state. A phase that throws simulates the crash at that point;
 * the test then asserts the invariant still holds and no data was lost.
 *
 * Externals mocked: rag-provider (no Ollama), @lancedb/lancedb (in-memory
 * table that models add/update/delete/query with where-predicates), config
 * (temp wiki paths).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { WikiDocument, CoreModule } from '../../types.js';

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
  EMBEDDING_DIM: 8,
  NAMESPACE: 'test-ns',
  getEmbedding: async () => new Array(8).fill(0.1),
  getEmbeddings: async (texts: string[]) => texts.map(() => new Array(8).fill(0.1)),
}));

// --- LanceDB mock: a single shared table with a where-aware update/delete ---
interface Row { hash: string; createdAt: string | null; [k: string]: unknown }
const tableState = {
  rows: [] as Row[],
  /** Hook fired BEFORE the commit update; set to a fn to inject a failure. */
  beforeUpdate: null as null | (() => void),
  /** Hook fired BEFORE add; inject a failure to simulate a crash at phase 1. */
  beforeAdd: null as null | (() => void),
};

function matchWhere(filter: string, hash: string): boolean {
  const eq = filter.match(/^hash = '([^']*)'$/);
  if (eq) return hash === eq[1];
  const inMatch = filter.match(/^hash IN \(([^)]*)\)$/);
  if (inMatch) {
    const set = inMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    return set.includes(hash);
  }
  return false;
}

vi.mock('@lancedb/lancedb', () => {
  const fakeTable = {
    add: async (records: Array<Record<string, unknown>>) => {
      if (tableState.beforeAdd) tableState.beforeAdd();
      tableState.rows.push(...(records as Row[]));
    },
    delete: async (filter: string) => {
      if (filter === 'true') { tableState.rows = []; return; }
      tableState.rows = tableState.rows.filter((r) => !matchWhere(filter, r.hash));
    },
    update: async (opts: { where: string; values: Record<string, unknown> }) => {
      if (tableState.beforeUpdate) tableState.beforeUpdate();
      let count = 0;
      for (const row of tableState.rows) {
        if (matchWhere(opts.where, row.hash)) { Object.assign(row, opts.values); count++; }
      }
      return { rowsUpdated: count, version: 1 };
    },
    query: () => ({
      where: (_f: string) => ({ toArray: async () => tableState.rows }),
      toArray: async () => tableState.rows,
    }),
    vectorSearch: () => ({
      distanceType: () => ({
        limit: () => ({
          where: () => ({ toArray: async () => tableState.rows.map((r) => ({ ...r, _distance: 0 })) }),
        }),
      }),
    }),
    createIndex: async () => { /* no-op */ },
  };
  return {
    connect: async () => ({
      tableNames: async () => [],
      openTable: async () => fakeTable,
      createTable: async (_n: string, rows: Array<Record<string, unknown>>) => {
        tableState.rows = [...(rows as Row[])];
        return fakeTable;
      },
    }),
    Index: { ivfFlat: () => ({}) },
  };
});

// --- Helpers --------------------------------------------------------------
function makeDoc(title: string, content: string): WikiDocument {
  return { domain: 'project', title, content, references: [] };
}
function hashOf(doc: WikiDocument): string {
  return crypto.createHash('sha256').update(`${doc.domain}:${doc.title}:${doc.content}`).digest('hex').slice(0, 16);
}
/** Live hashes from the WAL on disk (independent of the code under test). */
function liveWalHashes(): Set<string> {
  const live = new Map<string, number>();
  if (!fs.existsSync(logsDir())) return new Set();
  let files: string[];
  try {
    files = fs.readdirSync(logsDir()).filter((x) => x.endsWith('.wal')).sort();
  } catch {
    return new Set();
  }
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(logsDir(), f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        live.set(e.hash, e.deleted || !e.approved ? -1 : 1);
      } catch { /* skip */ }
    }
  }
  return new Set([...live.entries()].filter(([, v]) => v > 0).map(([k]) => k));
}
/** The core invariant: every committed row has a live WAL entry. */
function assertInvariantI1(): void {
  const live = liveWalHashes();
  for (const row of tableState.rows) {
    if (row.hash === '__schema__') continue;
    const committed = row.createdAt !== null && row.createdAt !== undefined;
    if (committed) {
      expect(live.has(row.hash), `committed row ${row.hash} has NO live WAL entry`).toBe(true);
    }
  }
}

function makeCore(): CoreModule {
  return { brief: vi.fn(), verbose: vi.fn() } as unknown as CoreModule;
}
const C = 'a document content long enough to be realistic for the wiki store';

// --- Tests ----------------------------------------------------------------
describe('wiki reverse-2FC invariant (committed ⟹ WAL-live)', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-2fc-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(domainsFile(), JSON.stringify([
      { domain_name: 'project', description: '', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    tableState.rows = [];
    tableState.beforeUpdate = null;
    tableState.beforeAdd = null;
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function newManager() {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(makeCore());
  }

  it('put(): row is PREMATURE (invisible) until the WAL entry is durable', async () => {
    const doc = makeDoc('t1', `${C} 1`);
    const hash = hashOf(doc);

    // Intercept the commit UPDATE: at that instant the row must still be
    // premature AND the WAL must already be live.
    let sawPrematureWithLiveWal = false;
    tableState.beforeUpdate = () => {
      const row = tableState.rows.find((r) => r.hash === hash);
      sawPrematureWithLiveWal = !!row && row.createdAt === null && liveWalHashes().has(hash);
    };

    const wiki = await newManager();
    const result = await wiki.put(hash, doc);

    expect(result.success).toBe(true);
    expect(sawPrematureWithLiveWal).toBe(true);
    assertInvariantI1();
  });

  it('put(): a crash BEFORE appendWAL leaves NO committed row (invariant intact)', async () => {
    const wiki = await newManager();

    // A normal put first: proves the path works and gives us one committed row.
    const doc = makeDoc('t2', `${C} 2`);
    const hash = hashOf(doc);
    expect((await wiki.put(hash, doc)).success).toBe(true);
    assertInvariantI1();

    // Now force the WAL append to fail for a SECOND document by replacing the
    // logs dir with a regular file (appendFileSync then throws ENOTDIR). This
    // simulates a crash at phase 2 (after add, before/at appendWAL).
    const doc2 = makeDoc('t3', `${C} 3`);
    const hash2 = hashOf(doc2);
    const logs = logsDir();
    fs.rmSync(logs, { recursive: true, force: true });
    fs.writeFileSync(logs, 'not a directory', 'utf-8');

    const res2 = await wiki.put(hash2, doc2);
    expect(res2.success).toBe(false);

    // The added row for hash2 must NOT be committed (createdAt still null):
    // visibility requires the WAL append to have succeeded.
    const row2 = tableState.rows.find((r) => r.hash === hash2);
    if (row2) {
      expect(row2.createdAt).toBeNull();
    }
    // And the pre-existing committed row is untouched — invariant intact.
    const row1 = tableState.rows.find((r) => r.hash === hash);
    expect(row1!.createdAt).not.toBeNull();
  });

  it('put(): crash at the COMMIT update leaves truth durable (rebuild heals)', async () => {
    const doc = makeDoc('t4', `${C} 4`);
    const hash = hashOf(doc);

    tableState.beforeUpdate = () => { throw new Error('simulated crash at commit'); };

    const wiki = await newManager();
    const res = await wiki.put(hash, doc);
    expect(res.success).toBe(false); // put reports failure
    // But the WAL is durable — the document is committed in TRUTH.
    expect(liveWalHashes().has(hash)).toBe(true);
    assertInvariantI1();

    // Healing: rebuild re-materializes it as COMMITTED (createdAt from WAL).
    tableState.beforeUpdate = null;
    await wiki.rebuild();
    const healed = tableState.rows.find((r) => r.hash === hash);
    expect(healed).toBeTruthy();
    expect(healed!.createdAt).not.toBeNull();
    assertInvariantI1();
  });

  it('re-put does not duplicate a row for one hash', async () => {
    const doc = makeDoc('t5', `${C} 5`);
    const hash = hashOf(doc);
    const wiki = await newManager();

    await wiki.put(hash, doc);
    const second = await wiki.put(hash, doc);

    expect(second.alreadyExisted).toBe(true);
    expect(tableState.rows.filter((r) => r.hash === hash).length).toBe(1);
    assertInvariantI1();
  });

  it('alreadyExisted is WAL-sourced: a premature row is NOT an existing doc', async () => {
    const doc = makeDoc('t6', `${C} 6`);
    const hash = hashOf(doc);

    // Plant a PREMATURE row with NO WAL entry (a crash leftover).
    tableState.rows.push({
      hash, domain: 'project', title: doc.title, content: doc.content,
      references: '[]', embedding: new Array(8).fill(0.1), createdAt: null,
    });

    const wiki = await newManager();
    const res = await wiki.put(hash, doc);

    expect(res.success).toBe(true);
    expect(res.alreadyExisted).toBeUndefined();
    expect(tableState.rows.filter((r) => r.hash === hash).length).toBe(1);
    assertInvariantI1();
  });
});
