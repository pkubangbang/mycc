/**
 * validate.test.ts - Hash + structure validation tests for mindmap
 *
 * Binds to the REAL src/mindmap/validate.ts. The previous revision re-implemented
 * `validate_mindmap` (returning `{valid, error}`) and `computeHash`, and never
 * imported the module — so the production hash gate could be deleted with the
 * suite still green.
 *
 * Production contracts exercised here (they differ from the old local copy):
 *   - `validate_mindmap(json, mdPath) -> boolean`  (throwing internally == false)
 *   - `validate_mindmap_structure(json)` also requires `source_file`
 *   - link `target_type` includes `'term'`
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  compute_hash,
  compute_file_hash,
  validate_mindmap,
  validate_mindmap_structure,
  parse_mindmap_json,
} from '../../mindmap/validate.js';
import type { MindmapJSON } from '../../mindmap/types.js';

function jsonFixture(overrides: Partial<MindmapJSON> = {}): MindmapJSON {
  return {
    dir: '/test/dir',
    source_file: 'MYCC.md',
    hash: 'abc123',
    compiled_at: '2024-01-15T10:00:00Z',
    updated_at: '2024-01-15T10:00:00Z',
    root: {
      id: '/',
      text: '# Root',
      title: 'Root',
      summary: 'Root summary',
      level: 0,
      children: [],
      links: [],
    },
    ...overrides,
  } as MindmapJSON;
}

describe('compute_hash / compute_file_hash', () => {
  it('is a 64-char sha256 hex digest', () => {
    expect(compute_hash('anything')).toHaveLength(64);
    expect(compute_hash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for identical content and differs otherwise', () => {
    expect(compute_hash('x')).toBe(compute_hash('x'));
    expect(compute_hash('x')).not.toBe(compute_hash('y'));
  });

  it('honours an explicit algorithm', () => {
    expect(compute_hash('x', 'sha1')).toHaveLength(40);
    expect(compute_hash('x', 'md5')).toHaveLength(32);
  });

  it('compute_file_hash equals compute_hash of the same bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-hash-'));
    try {
      const p = path.join(dir, 'a.md');
      fs.writeFileSync(p, '# A');
      expect(compute_file_hash(p)).toBe(compute_hash('# A'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validate_mindmap_structure (real module)', () => {
  it('accepts a structurally valid JSON', () => {
    expect(validate_mindmap_structure(jsonFixture())).toBe(true);
  });

  it('rejects non-objects (null, array, primitives)', () => {
    expect(validate_mindmap_structure(null)).toBe(false);
    expect(validate_mindmap_structure([])).toBe(false);
    expect(validate_mindmap_structure('x')).toBe(false);
    expect(validate_mindmap_structure(42)).toBe(false);
    expect(validate_mindmap_structure(undefined)).toBe(false);
  });

  it.each(['dir', 'hash', 'compiled_at', 'updated_at'] as const)(
    'rejects a missing/ill-typed %s',
    (field) => {
      const j = jsonFixture() as unknown as Record<string, unknown>;
      delete j[field];
      expect(validate_mindmap_structure(j)).toBe(false);
      expect(validate_mindmap_structure({ ...jsonFixture(), [field]: 42 })).toBe(false);
    },
  );

  it('rejects a missing source_file (the old local copy accepted it)', () => {
    const j = jsonFixture() as unknown as Record<string, unknown>;
    delete j.source_file;
    expect(validate_mindmap_structure(j)).toBe(false);
  });

  it('rejects a root with missing node fields', () => {
    expect(validate_mindmap_structure({ ...jsonFixture(), root: { id: '/' } })).toBe(false);
    expect(validate_mindmap_structure({ ...jsonFixture(), root: undefined })).toBe(false);
  });

  it('rejects a malformed child node', () => {
    const j = jsonFixture();
    (j.root.children as unknown[]).push({ id: '/c', level: 1, children: [], links: [] });
    expect(validate_mindmap_structure(j)).toBe(false);
  });

  it('accepts deep valid nesting', () => {
    const j = jsonFixture();
    j.root.children = [
      {
        id: '/a',
        text: 'a',
        title: 'A',
        summary: '',
        level: 1,
        children: [
          { id: '/a/b', text: 'b', title: 'AB', summary: '', level: 2, children: [], links: [] },
        ],
        links: [],
      },
    ];
    expect(validate_mindmap_structure(j)).toBe(true);
  });

  it.each(['node', 'file', 'url', 'term'] as const)('accepts a %s link with its target field', (t) => {
    const j = jsonFixture();
    const link: Record<string, unknown> = { target_type: t, comment: 'c' };
    if (t === 'node') link.node_id = '/x';
    if (t === 'file') link.file_path = './a.ts';
    if (t === 'url') link.url = 'https://e.x';
    if (t === 'term') link.term_name = 'glossary';
    j.root.links = [link as never];
    expect(validate_mindmap_structure(j)).toBe(true);
  });

  it('rejects an unknown target_type and a missing target field', () => {
    const bad = jsonFixture();
    bad.root.links = [{ target_type: 'nope', comment: 'c' } as never];
    expect(validate_mindmap_structure(bad)).toBe(false);

    const noId = jsonFixture();
    noId.root.links = [{ target_type: 'node', comment: 'c' } as never];
    expect(validate_mindmap_structure(noId)).toBe(false);
  });
});

describe('validate_mindmap (hash gate)', () => {
  let tempDir: string;
  let mdPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-validate-'));
    mdPath = path.join(tempDir, 'test.md');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const mm = (mdContent: string, hash = compute_hash(mdContent)): MindmapJSON =>
    jsonFixture({ dir: tempDir, source_file: path.basename(mdPath), hash });

  it('returns true when the stored hash matches the markdown', () => {
    const md = '# Test\n\nTest content';
    fs.writeFileSync(mdPath, md);
    expect(validate_mindmap(mm(md), mdPath)).toBe(true);
  });

  it('returns false when the markdown changed after compilation', () => {
    fs.writeFileSync(mdPath, '# Test');
    const stale = mm('# Test');          // hash of the OLD content
    fs.writeFileSync(mdPath, '# Test CHANGED');
    expect(validate_mindmap(stale, mdPath)).toBe(false);
  });

  it('returns false when the stored hash is wrong', () => {
    const md = '# Test';
    fs.writeFileSync(mdPath, md);
    expect(validate_mindmap(mm(md, 'deadbeef'.repeat(8)), mdPath)).toBe(false);
  });

  it('returns false when the markdown file is missing', () => {
    expect(validate_mindmap(jsonFixture({ dir: tempDir }), path.join(tempDir, 'nope.md'))).toBe(false);
  });

  it('resolves a relative mdPath against json.dir', () => {
    const md = '# Rel';
    fs.writeFileSync(mdPath, md);
    const j = mm(md);
    expect(validate_mindmap(j, path.basename(mdPath))).toBe(true);
  });

  it('does not throw on a malformed json (returns false)', () => {
    expect(validate_mindmap(null as never, mdPath)).toBe(false);
    expect(validate_mindmap({} as never, mdPath)).toBe(false);
  });
});

describe('parse_mindmap_json', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-parse-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the parsed JSON for a valid file', () => {
    const p = path.join(dir, 'mindmap.json');
    fs.writeFileSync(p, JSON.stringify(jsonFixture()));
    expect(parse_mindmap_json(p)?.hash).toBe('abc123');
  });

  it('returns null for a missing file, bad JSON, or invalid structure', () => {
    expect(parse_mindmap_json(path.join(dir, 'absent.json'))).toBeNull();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ nope }');
    expect(parse_mindmap_json(bad)).toBeNull();
    const invalid = path.join(dir, 'invalid.json');
    fs.writeFileSync(invalid, JSON.stringify({ dir: '/' }));
    expect(parse_mindmap_json(invalid)).toBeNull();
  });
});
