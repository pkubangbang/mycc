/**
 * wiki-deletebyhashes-throw.test.ts — PR #29/#18 round-3 P1 regression test.
 *
 * round-3 made deleteByHashes THROW on DB-delete failure (instead of
 * swallowing) so indexSkills aborts BEFORE batchPut + writeSkillIndexCache,
 * avoiding old+new duplicate rows pinned by a stale cache. No existing test
 * exercised the throw path, so this pins it:
 *   - deleteByHashes propagates the DB error,
 *   - indexSkills aborts (no insert, no cache write) and releases the lock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'node:crypto';
import type { WikiDocument, CoreModule, SkillIndexEntry } from '../../types.js';

let tempDir = '';
const logsDir = () => path.join(tempDir, 'logs');

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

// Fake table with a controllable DB-delete failure.
let rows: Array<Record<string, unknown>> = [];
let deleteThrows = false;
let cacheWrites = 0;

vi.mock('../../context/parent/wiki-skill-index.js', () => ({
  ReindexLock: class {
    acquire() { return true; }
    release() { /* no-op */ }
  },
  isSkillIndexCacheValid: () => false, // force a full re-index every call
  writeSkillIndexCache: () => { cacheWrites++; },
}));

vi.mock('@lancedb/lancedb', () => {
  const fakeTable = {
    add: async (records: Array<Record<string, unknown>>) => { rows.push(...records); },
    delete: async (filter: string) => {
      if (deleteThrows && /^hash IN \(/.test(filter)) throw new Error('fake: DB delete failed');
      if (filter === 'true') { rows = []; return; }
      const m = filter.match(/^hash IN \((.*)\)$/);
      if (m) {
        const hashes = new Set(
          m[1].split(',').map((s) => s.trim().replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'")),
        );
        rows = rows.filter((r) => !hashes.has(r.hash as string));
      }
    },
    countRows: async () => rows.length,
    listIndices: async () => [],
    query: () => ({ toArray: async () => rows }),
    vectorSearch: () => {
      const q: Record<string, unknown> = {};
      q.distanceType = () => q; q.limit = () => q; q.where = () => q; q.toArray = async () => [];
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

describe('deleteByHashes throws on DB failure (PR #29/#18 round-3 P1)', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-dbh-throw-'));
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'domains.json'), JSON.stringify([
      { domain_name: 'skills', description: '', created_at: '', project_folder: tempDir },
    ]), 'utf-8');
    rows = [];
    deleteThrows = false;
    cacheWrites = 0;
  });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  async function newManager() {
    const { WikiManager } = await import('../../context/parent/wiki.js');
    return new WikiManager(makeCore());
  }

  it('deleteByHashes propagates the DB-delete error (no swallow)', async () => {
    const wiki = await newManager();
    const doc: WikiDocument = { domain: 'skills', title: '[user]:x', content: 'content long enough', references: [] };
    const hash = hashOf(doc);
    await wiki.batchPut([{ document: doc, embedding: new Array(8).fill(0.1) }]);
    const seeded = rows.find((r) => r.hash === hash) as Record<string, unknown>;

    deleteThrows = true;
    await expect(
      wiki.deleteByHashes([{ hash, createdAt: seeded.createdAt as string }]),
    ).rejects.toThrow(/DB delete failed/);
  });

  it('indexSkills aborts on delete failure: no new insert, no cache write, row survives', async () => {
    const wiki = await newManager();
    // Seed an EXISTING skills row whose content will change (→ toDelete).
    const oldDoc: WikiDocument = { domain: 'skills', title: '[user]:s', content: 'OLD content long enough', references: [] };
    await wiki.batchPut([{ document: oldDoc, embedding: new Array(8).fill(0.1) }]);
    const oldHash = hashOf(oldDoc);
    const rowsBefore = rows.length;

    // The re-index supplies a CHANGED document (same title, new content).
    const entry: SkillIndexEntry = {
      document: { domain: 'skills', title: '[user]:s', content: 'NEW content long enough', references: [] },
      embedding: new Array(8).fill(0.1),
      contentHash: 'deadbeef',
    } as unknown as SkillIndexEntry;

    deleteThrows = true;
    await expect(wiki.indexSkills([entry])).rejects.toThrow(/DB delete failed/);

    // Old row still present (delete failed) — that's the truth on the ground.
    expect(rows.some((r) => r.hash === oldHash)).toBe(true);
    // No NEW row inserted (batchPut skipped).
    expect(rows.length).toBe(rowsBefore);
    // Cache NOT written (writeSkillIndexCache skipped).
    expect(cacheWrites).toBe(0);
  });
});
