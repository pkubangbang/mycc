/**
 * wiki-export-import.test.ts - Integrity tests for /wiki export and /wiki import
 *
 * Covers the three integrity layers added to the wiki transfer path:
 *   Layer A — file-level manifest (sha256 over canonical {domains, entries})
 *   Layer B — per-entry hash verification (sha256 of domain:title:content)
 *   Layer C — honest put-result reporting (read PutResult instead of assuming)
 *
 * The export/import handlers read WAL from getWikiLogsDir() and write the
 * export file relative to process.cwd(). To isolate the filesystem we mock
 * ../config.js so getWikiLogsDir/getWikiDomainsFile point at a temp dir, and
 * chdir into that temp dir so the export file lands there too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import stripAnsi from 'strip-ansi';
import type { SlashCommandContext, WikiModule, WALEntry, WikiDocument, WikiDomain } from '../../types.js';
import { computeWikiHash, computeManifestHash, verifyEntryHash } from '../../slashes/wiki.js';

// --- Mock config so wiki paths point at a temp directory -----------------
// The temp dir is created in beforeEach; the mock reads the live value via
// a module-level variable so the mock returns the current temp dir per test.
let tempDir = '';
const walLogsDir = () => path.join(tempDir, 'logs');
const domainsFile = () => path.join(tempDir, 'domains.json');

vi.mock('../../config.js', () => ({
  getWikiLogsDir: () => walLogsDir(),
  getWikiDomainsFile: () => domainsFile(),
  ensureDirs: () => {
    if (!fs.existsSync(walLogsDir())) fs.mkdirSync(walLogsDir(), { recursive: true });
  },
}));

// Capture console.log output to assert on the import summary.
function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(stripAnsi(args.map((a) => String(a)).join(' ')));
  };
  return { logs, restore: () => { console.log = orig; } };
}

// --- Helpers --------------------------------------------------------------

function makeEntry(doc: WikiDocument, opts: Partial<WALEntry> = {}): WALEntry {
  return {
    timestamp: opts.timestamp || new Date().toISOString(),
    hash: opts.hash ?? computeWikiHash(doc),
    document: doc,
    approved: opts.approved ?? true,
    namespace: opts.namespace ?? 'nomic-embed-text',
  };
}

function makeDoc(domain: string, title: string, content: string): WikiDocument {
  return { domain, title, content, references: [] };
}

// Content >= 50 chars to satisfy wiki put()'s MIN_CONTENT_LENGTH when we
// exercise the full import path (the mock put still records calls regardless).
const LONG_CONTENT = 'This is a sufficiently long document content for testing wiki import integrity checks.';

function makeDomain(name: string): WikiDomain {
  return {
    domain_name: name,
    description: `test domain ${name}`,
    created_at: new Date().toISOString(),
    project_folder: '/test',
  };
}

/**
 * Build a v1.1 export file on disk and return its path. Optionally corrupt it
 * via the `corrupt` callback (which receives the parsed object to mutate
 * in-place before it is re-serialized with a FRESH manifest or a stale one).
 */
function writeExportFile(opts: {
  domains?: WikiDomain[];
  entries?: WALEntry[];
  version?: '1.0' | '1.1';
  includeManifest?: boolean;
  corrupt?: (data: any) => void;
  fileName?: string;
}): string {
  const fileName = opts.fileName || 'test-export.json';
  const filePath = path.join(tempDir, fileName);
  const domains = opts.domains ?? [];
  const entries = opts.entries ?? [];
  const data: any = {
    version: opts.version ?? '1.1',
    exported_at: new Date().toISOString(),
    project_dir: '/test',
    domains,
    entries,
  };
  if (opts.includeManifest !== false && (opts.version ?? '1.1') === '1.1') {
    data.manifest = {
      entry_count: entries.length,
      content_sha256: computeManifestHash(domains, entries),
    };
  }
  if (opts.corrupt) opts.corrupt(data);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

/**
 * Build a mock WikiModule that records put() calls and can be configured to
 * return success or failure per call. Default put() returns success.
 */
function makeMockWiki(opts: {
  existingDomains?: WikiDomain[];
  putResults?: Array<{ success: boolean; hash: string; error?: string; alreadyExisted?: boolean }>;
  putThrows?: boolean;
} = {}): WikiModule & { putCalls: Array<{ hash: string; document: WikiDocument }>; registeredDomains: string[] } {
  const putCalls: Array<{ hash: string; document: WikiDocument }> = [];
  const registeredDomains: string[] = [];
  const domains = new Map<string, WikiDomain>();
  for (const d of opts.existingDomains ?? []) domains.set(d.domain_name, d);
  let putResultIdx = 0;
  return {
    put: vi.fn(async (hash: string, document: WikiDocument) => {
      putCalls.push({ hash, document });
      if (opts.putThrows) throw new Error('boom');
      const preset = opts.putResults?.[putResultIdx++];
      if (preset) return { success: preset.success, hash: preset.hash, error: preset.error, alreadyExisted: preset.alreadyExisted };
      return { success: true, hash };
    }),
    prepare: vi.fn(async () => ({ accepted: true, hash: 'mock' })),
    get: vi.fn(async () => []),
    getByDomain: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    getWAL: vi.fn(async () => []),
    parseWAL: vi.fn(() => []),
    formatWAL: vi.fn(() => ''),
    appendWAL: vi.fn(async () => {}),
    rebuild: vi.fn(async () => ({ success: true, documentsProcessed: 0, errors: [] })),
    listDomains: vi.fn(async () => Array.from(domains.values())),
    getDomain: vi.fn(async (name: string) => domains.get(name)),
    registerDomain: vi.fn(async (name: string, description?: string) => {
      if (!domains.has(name)) {
        domains.set(name, { domain_name: name, description: description || '', created_at: new Date().toISOString(), project_folder: '/test' });
        registeredDomains.push(name);
      }
    }),
    // expose state via closure-bound references the test reads
    ...(({ putCalls, registeredDomains } as any)),
  } as any;
}

/**
 * Invoke the wiki slash command's handler with the given args and wiki mock.
 */
async function runCommand(args: string[], wiki: WikiModule): Promise<string[]> {
  const ctx: SlashCommandContext = {
    query: `/wiki ${args.join(' ')}`,
    args: ['/wiki', ...args],
    ctx: { core: {} as any, todo: {} as any, mail: {} as any, skill: {} as any, issue: {} as any, bg: {} as any, team: {} as any, wiki, peer: {} as any },
    triologue: {},
    sessionFilePath: '',
  };
  const { logs, restore } = captureConsole();
  try {
    // dynamic import after mock setup so config.js mock applies
    const { wikiCommand } = await import('../../slashes/wiki.js');
    await wikiCommand.handler(ctx);
  } finally {
    restore();
  }
  return logs;
}

// --- Tests ----------------------------------------------------------------

describe('wiki integrity helpers', () => {
  it('computeWikiHash matches WikiManager.generateHash scheme (sha256 of domain:title:content, 16 hex)', () => {
    const doc = makeDoc('project', 'title', 'content');
    // Reproduce the scheme independently to avoid coupling to wiki.ts internals.
    const crypto = require('node:crypto');
    const expected = crypto.createHash('sha256').update('project:title:content').digest('hex').slice(0, 16);
    expect(computeWikiHash(doc)).toBe(expected);
    expect(computeWikiHash(doc)).toMatch(/^[a-f0-9]{16}$/);
  });

  it('computeWikiHash is deterministic and content-addressed', () => {
    const a = makeDoc('d', 't', 'c1');
    const b = makeDoc('d', 't', 'c2');
    expect(computeWikiHash(a)).not.toBe(computeWikiHash(b));
    expect(computeWikiHash(a)).toBe(computeWikiHash({ ...a }));
  });

  it('computeManifestHash is deterministic over content (whitespace-insensitive to re-serialization)', () => {
    const domains = [makeDomain('a')];
    const entries = [makeEntry(makeDoc('a', 't', 'c'))];
    const h1 = computeManifestHash(domains, entries);
    // Same objects re-stringified must match — JSON.stringify is deterministic
    // for the same object shape, so a re-export produces the same manifest.
    const h2 = computeManifestHash(JSON.parse(JSON.stringify(domains)), JSON.parse(JSON.stringify(entries)));
    expect(h1).toBe(h2);
  });

  it('computeManifestHash changes when content changes', () => {
    const domains = [makeDomain('a')];
    const entries1 = [makeEntry(makeDoc('a', 't', 'c1'))];
    const entries2 = [makeEntry(makeDoc('a', 't', 'c2'))];
    expect(computeManifestHash(domains, entries1)).not.toBe(computeManifestHash(domains, entries2));
  });

  it('verifyEntryHash returns true for a well-formed entry, false for tampered content', () => {
    const doc = makeDoc('d', 't', 'c');
    const entry = makeEntry(doc);
    expect(verifyEntryHash(entry)).toBe(true);
    const tampered = makeEntry({ ...doc, content: 'tampered' }, { hash: entry.hash });
    expect(verifyEntryHash(tampered)).toBe(false);
  });

  it('verifyEntryHash returns false for malformed entries (missing fields)', () => {
    expect(verifyEntryHash({} as any)).toBe(false);
    expect(verifyEntryHash({ hash: 'abc', document: {} } as any)).toBe(false);
    expect(verifyEntryHash({ hash: '', document: makeDoc('d', 't', 'c') } as any)).toBe(false);
  });
});

describe('wiki export writes a v1.1 manifest', () => {
  let oldCwd: string;
  beforeEach(() => {
    oldCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-test-'));
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
  });
  afterEach(() => {
    process.chdir(oldCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('export file contains version 1.1 and a manifest whose sha256 matches the entries', async () => {
    const domain = makeDomain('project');
    const doc = makeDoc('project', 'A title', LONG_CONTENT);
    const entry = makeEntry(doc, { namespace: 'nomic-embed-text' });
    // Seed a WAL file the export will read.
    fs.writeFileSync(path.join(tempDir, 'logs', '2026-07-26.wal'), JSON.stringify(entry) + '\n', 'utf-8');
    fs.writeFileSync(domainsFile(), JSON.stringify([domain], null, 2), 'utf-8');

    const wiki = makeMockWiki({ existingDomains: [domain] });
    const exportPath = path.join(tempDir, 'out.json');
    await runCommand(['export', exportPath], wiki);

    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
    expect(exported.version).toBe('1.1');
    expect(exported.manifest).toBeDefined();
    expect(exported.manifest.entry_count).toBe(1);
    // The manifest hash must match a fresh recomputation over the exported arrays.
    expect(exported.manifest.content_sha256).toBe(computeManifestHash(exported.domains, exported.entries));
  });
});

describe('wiki import integrity (Layer A: manifest, Layer B: per-entry hash, Layer C: put results)', () => {
  let oldCwd: string;
  beforeEach(() => {
    oldCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wiki-test-'));
    process.chdir(tempDir);
  });
  afterEach(() => {
    process.chdir(oldCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('imports a clean v1.1 file: registers domains, calls put, reports "(integrity verified)"', async () => {
    const domain = makeDomain('project');
    const entry = makeEntry(makeDoc('project', 'A title', LONG_CONTENT));
    const exportPath = writeExportFile({ domains: [domain], entries: [entry] });

    const wiki = makeMockWiki();
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    expect(summary).toContain('1 entries imported');
    expect(summary).toContain('integrity verified');
    expect((wiki as any).putCalls).toHaveLength(1);
    expect((wiki as any).registeredDomains).toContain('project');
  });

  it('Layer A: aborts on manifest mismatch (tampered entries) without calling put', async () => {
    const domain = makeDomain('project');
    const entry = makeEntry(makeDoc('project', 'A title', LONG_CONTENT));
    // Corrupt the entry content AFTER the manifest was computed, so the
    // manifest no longer matches — simulating in-transit tampering.
    const exportPath = writeExportFile({
      domains: [domain],
      entries: [entry],
      corrupt: (data) => {
        data.entries[0].document.content = 'TAMPERED CONTENT THAT CHANGES THE MANIFEST HASH';
      },
    });

    const wiki = makeMockWiki();
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    expect(summary).toContain('Manifest mismatch');
    expect(summary).toContain('Refusing to import');
    // Critical: the DB must be untouched — no put, no domain registration.
    expect((wiki as any).putCalls).toHaveLength(0);
  });

  it('Layer A: aborts when a v1.1 file is missing the manifest field', async () => {
    const domain = makeDomain('project');
    const entry = makeEntry(makeDoc('project', 'A title', LONG_CONTENT));
    const exportPath = writeExportFile({
      domains: [domain],
      entries: [entry],
      version: '1.1',
      includeManifest: false,
    });

    const wiki = makeMockWiki();
    const logs = await runCommand(['import', exportPath], wiki);

    expect(logs.join('\n')).toContain('missing "manifest"');
    expect((wiki as any).putCalls).toHaveLength(0);
  });

  it('Layer A: aborts on entry_count mismatch', async () => {
    const domain = makeDomain('project');
    const entry = makeEntry(makeDoc('project', 'A title', LONG_CONTENT));
    const exportPath = writeExportFile({
      domains: [domain],
      entries: [entry],
      corrupt: (data) => {
        // Claim 5 entries but only ship 1 — content_sha256 still matches the
        // shipped arrays, but entry_count is inconsistent.
        data.manifest.entry_count = 5;
      },
    });

    const wiki = makeMockWiki();
    const logs = await runCommand(['import', exportPath], wiki);

    expect(logs.join('\n')).toContain('entry_count mismatch');
    expect((wiki as any).putCalls).toHaveLength(0);
  });

  it('Layer B: skips an entry whose hash does not match its content, counts it, does not call put for it', async () => {
    const domain = makeDomain('project');
    const good = makeEntry(makeDoc('project', 'Good', LONG_CONTENT));
    const tampered = makeEntry(makeDoc('project', 'Bad', LONG_CONTENT), {
      // give it a hash that does NOT match its content
      hash: '0000000000000000',
    });
    const exportPath = writeExportFile({ domains: [domain], entries: [good, tampered] });

    const wiki = makeMockWiki();
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    expect(summary).toContain('1 entries imported');
    expect(summary).toContain('1 hash mismatch (skipped)');
    expect(summary).toContain('0000000000000000'); // the offending hash is listed
    // Only the good entry reaches put.
    expect((wiki as any).putCalls).toHaveLength(1);
    expect((wiki as any).putCalls[0].hash).toBe(good.hash);
  });

  it('Layer C: a put() that returns {success:false} is counted as put failed, not imported', async () => {
    const domain = makeDomain('project');
    const entry = makeEntry(makeDoc('project', 'A title', LONG_CONTENT));
    const exportPath = writeExportFile({ domains: [domain], entries: [entry] });

    // put() returns success:false (e.g. unknown domain, length violation) —
    // it does NOT throw. The old loop would have counted this as imported++.
    const wiki = makeMockWiki({
      putResults: [{ success: false, hash: entry.hash, error: 'Unknown domain "project"' }],
    });
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    expect(summary).toContain('0 entries imported');
    expect(summary).toContain('1 put failed');
    expect(summary).toContain('Unknown domain "project"');
  });

  it('Layer C: a put() that throws is caught and counted as put failed (one bad entry does not abort import)', async () => {
    const domain = makeDomain('project');
    const e1 = makeEntry(makeDoc('project', 'One', LONG_CONTENT));
    const e2 = makeEntry(makeDoc('project', 'Two', LONG_CONTENT));
    const exportPath = writeExportFile({ domains: [domain], entries: [e1, e2] });

    const wiki = makeMockWiki({ putThrows: true });
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    expect(summary).toContain('0 entries imported');
    expect(summary).toContain('2 put failed');
    expect(summary).toContain('boom');
  });

  it('re-import: a put() that returns {success:true, alreadyExisted:true} is counted as "already present", not "imported"', async () => {
    const domain = makeDomain('project');
    const entry = makeEntry(makeDoc('project', 'A title', LONG_CONTENT));
    const exportPath = writeExportFile({ domains: [domain], entries: [entry] });

    // Simulate a re-import on the same machine: put() finds an exact copy and
    // short-circuits with alreadyExisted:true (no LanceDB/WAL write).
    const wiki = makeMockWiki({
      putResults: [{ success: true, hash: entry.hash, alreadyExisted: true }],
    });
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    expect(summary).toContain('0 entries imported');
    expect(summary).toContain('1 already present');
    // put() was still called (the import loop invokes it), but nothing was stored.
    expect((wiki as any).putCalls).toHaveLength(1);
  });

  it('re-import with a mix: one new, one already present, one put-failed — honest three-way breakdown', async () => {
    const domain = makeDomain('project');
    const eNew = makeEntry(makeDoc('project', 'New', LONG_CONTENT));
    const eExisting = makeEntry(makeDoc('project', 'Existing', LONG_CONTENT));
    const eFailing = makeEntry(makeDoc('project', 'Failing', LONG_CONTENT));
    const exportPath = writeExportFile({ domains: [domain], entries: [eNew, eExisting, eFailing] });

    const wiki = makeMockWiki({
      putResults: [
        { success: true, hash: eNew.hash },                                   // newly stored
        { success: true, hash: eExisting.hash, alreadyExisted: true },        // exact copy present
        { success: false, hash: eFailing.hash, error: 'Unknown domain "x"' }, // put rejected
      ],
    });
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    expect(summary).toContain('1 entries imported');
    expect(summary).toContain('1 already present');
    expect(summary).toContain('1 put failed');
  });

  it('skips deleted and unapproved entries (not revived, not written)', async () => {
    const domain = makeDomain('project');
    const live = makeEntry(makeDoc('project', 'Live', LONG_CONTENT));
    const deleted = { ...makeEntry(makeDoc('project', 'Deleted', LONG_CONTENT)), deleted: true };
    const unapproved = makeEntry(makeDoc('project', 'Unapproved', LONG_CONTENT), { approved: false });
    const exportPath = writeExportFile({ domains: [domain], entries: [live, deleted, unapproved] });

    const wiki = makeMockWiki();
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    expect(summary).toContain('1 entries imported');
    expect(summary).toContain('1 unapproved skipped');
    expect(summary).toContain('1 deleted entries ignored');
    expect((wiki as any).putCalls).toHaveLength(1);
  });

  it('backward compat: a v1.0 file (no manifest) imports with a warning and "(integrity UNVERIFIED)"', async () => {
    const domain = makeDomain('project');
    const entry = makeEntry(makeDoc('project', 'A title', LONG_CONTENT));
    const exportPath = writeExportFile({
      domains: [domain],
      entries: [entry],
      version: '1.0',
      includeManifest: false,
    });

    const wiki = makeMockWiki();
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    expect(summary).toContain('without manifest');
    expect(summary).toContain('integrity UNVERIFIED');
    expect(summary).toContain('1 entries imported');
    expect((wiki as any).putCalls).toHaveLength(1);
  });

  it('a v1.0 file with a tampered entry still skips it via Layer B (per-entry hash)', async () => {
    const domain = makeDomain('project');
    const good = makeEntry(makeDoc('project', 'Good', LONG_CONTENT));
    const tampered = makeEntry(makeDoc('project', 'Bad', LONG_CONTENT), { hash: 'ffffffffffffffff' });
    const exportPath = writeExportFile({
      domains: [domain],
      entries: [good, tampered],
      version: '1.0',
      includeManifest: false,
    });

    const wiki = makeMockWiki();
    const logs = await runCommand(['import', exportPath], wiki);

    const summary = logs.join('\n');
    // v1.0 has no manifest, but Layer B still catches the tampered entry.
    expect(summary).toContain('1 entries imported');
    expect(summary).toContain('1 hash mismatch (skipped)');
    expect((wiki as any).putCalls).toHaveLength(1);
  });

  it('refuses an invalid export file missing version/entries', async () => {
    const filePath = path.join(tempDir, 'bad.json');
    fs.writeFileSync(filePath, JSON.stringify({ foo: 'bar' }), 'utf-8');
    const wiki = makeMockWiki();
    const logs = await runCommand(['import', filePath], wiki);
    expect(logs.join('\n')).toContain('Invalid export file');
    expect((wiki as any).putCalls).toHaveLength(0);
  });

  it('refuses a missing file', async () => {
    const wiki = makeMockWiki();
    const logs = await runCommand(['import', path.join(tempDir, 'nope.json')], wiki);
    expect(logs.join('\n')).toContain('File not found');
  });
});