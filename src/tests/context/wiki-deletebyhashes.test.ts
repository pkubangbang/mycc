/**
 * wiki-deletebyhashes.test.ts — peer-review regression test for PR #29
 * round-2: deleteByHashes must mark the WAL before the DB delete so
 * rebuild() does NOT resurrect a deleted skill record.
 *
 * The round-1 defect: deleteByHashes removed the LanceDB row but left the
 * record's WAL entry unmarked. rebuild() wipes the table and replays every
 * WAL file (no domain filter), skipping only `deleted` entries — so the
 * stale record came back. This test wires a fake LanceDB table that HONORS
 * the `hash IN (...)` delete predicate (unlike the coarser fake in
 * wiki-rebuild.test.ts, which clears all rows on any delete), so we can
 * exercise the targeted-batch path end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'node:crypto';
import type { WikiDocument, CoreModule } from '../../types.js';

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

vi.mock('../../engine/rag-provider.js', () => ({
  EMBEDDING_DIM: 8,
  NAMESPACE: 'test-ns',
  getEmbedding: async () => new Array(8).fill(0.1),
  getEmbeddings: async (texts: string[]) => texts.map(() => new Array(8).fill(0.1)),
}));

// Fake table that HONORS `hash IN (...)` and `true`.
let rows: Array<Record<string, unknown>> = [];

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
    vectorSearch: () => {
      const q: Record<string, unknown> = {};
      q.distanceType = () => q;
      q.limit = () => q;
      q.where = () => q;
      q.toArray = async () => [];
      return q;
    },
    createIndex: async () => {},
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

function hashOf(doc: WikiDocument): string {
  return crypto.createHash('sha256').update(`${doc.domain}:${doc.title}:${doc.content}`).digest('hex').slice(0, 16);
}
function makeCore(): CoreModule {
  return { brief: vi.fn(), verbose: vi.fn() } as unknown as CoreModule;
}
function readWalDate(date: string) {
  const p = path.join(logsDir(), `${date}.wal`);
  return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/** Today's WAL date — batchPut appends to formatDate(new Date()), and stamps
 * each record's createdAt with the same now, so the two agree in production. */
function todayWalDate(): string {
  return new Date().toISOString().split('T')[0];
}

describe('deleteByHashes marks the WAL (PR #29 round-2 regression)', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-dbh-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(domainsFile(), JSON.stringify([
      { domain_name: 'skills', description: '', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    rows = [];
  });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  async function newManager() {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(makeCore());
  }

  it('marks the matching WAL entry deleted AND removes the DB row', async () => {
    const wiki = await newManager();
    const doc: WikiDocument = { domain: 'skills', title: '[user]:x', content: 'content long enough', references: [] };
    const hash = hashOf(doc);

    // Seed a DB row + a WAL entry for it (as batchPut would). batchPut writes
    // to TODAY's WAL and stamps the row's createdAt with now — the two agree.
    await wiki.batchPut([{ document: doc, embedding: new Array(8).fill(0.1) }]);
    expect(rows.some((r) => r.hash === hash)).toBe(true);
    const seeded = rows.find((r) => r.hash === hash) as Record<string, unknown>;
    const createdAt = seeded.createdAt as string;

    // Now batch-delete it.
    await wiki.deleteByHashes([{ hash, createdAt }]);

    // DB row gone…
    expect(rows.some((r) => r.hash === hash)).toBe(false);
    // …AND the WAL entry is marked deleted (this is the round-1 fix).
    const wal = readWalDate(todayWalDate());
    const entry = wal.find((e) => e.hash === hash);
    expect(entry).toBeDefined();
    expect(entry.deleted).toBe(true);
  });

  it('REBUILD does not resurrect a deleteByHashes-deleted skill (the round-1 bug)', async () => {
    const wiki = await newManager();
    const doc: WikiDocument = { domain: 'skills', title: '[user]:gone', content: 'content long enough', references: [] };
    const hash = hashOf(doc);

    await wiki.batchPut([{ document: doc, embedding: new Array(8).fill(0.1) }]);
    const seeded = rows.find((r) => r.hash === hash) as Record<string, unknown>;
    await wiki.deleteByHashes([{ hash, createdAt: seeded.createdAt as string }]);
    expect(rows.some((r) => r.hash === hash)).toBe(false);

    // Rebuild replays the WAL. Because deleteByHashes marked the entry
    // deleted, rebuild must NOT re-add it (before the fix it WOULD).
    await wiki.rebuild();
    expect(rows.some((r) => r.hash === hash)).toBe(false);
  });
});
