/**
 * load.test.ts - Loading tests for mindmap
 *
 * Binds to the REAL src/mindmap/load.ts. The previous revision re-implemented
 * `load_mindmap` locally and never imported the production module, so deleting
 * src/mindmap/load.ts (or its throw-on-invalid branch, or set_in_memory_flags /
 * strip_in_memory_flags) left this suite green.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  load_mindmap,
  load_mindmap_from_json,
  try_load_mindmap,
  serialize_mindmap,
  save_mindmap,
  get_default_mindmap_path,
  mindmap_exists,
} from '../../mindmap/load.js';
import { parse_mindmap_json } from '../../mindmap/validate.js';
import { compute_hash } from '../../mindmap/validate.js';
import type { MindmapJSON } from '../../mindmap/types.js';

/** A structurally valid MindmapJSON fixture (validate_mindmap_structure requires source_file). */
function validJson(overrides: Partial<MindmapJSON> = {}): MindmapJSON {
  return {
    dir: '/test/dir',
    source_file: 'MYCC.md',
    hash: 'abc123',
    compiled_at: '2024-01-15T10:00:00Z',
    updated_at: '2024-01-15T10:00:00Z',
    root: {
      id: '/',
      text: '# Root\n\nRoot content',
      title: 'Root',
      summary: 'Root summary',
      level: 0,
      children: [],
      links: [],
    },
    ...overrides,
  } as MindmapJSON;
}

describe('load_mindmap_from_json (real implementation)', () => {
  it('loads a valid mindmap JSON', () => {
    const result = load_mindmap_from_json(validJson());
    expect(result.dir).toBe('/test/dir');
    expect(result.hash).toBe('abc123');
    expect(result.root.id).toBe('/');
  });

  it('keeps nested children intact', () => {
    const json = validJson();
    json.root.children = [
      {
        id: '/child',
        text: '## Child',
        title: 'Child',
        summary: 'Child summary',
        level: 1,
        children: [
          {
            id: '/child/grandchild',
            text: '### Grandchild',
            title: 'Grandchild',
            summary: 'Grandchild summary',
            level: 2,
            children: [],
            links: [],
          },
        ],
        links: [],
      },
    ];

    const result = load_mindmap_from_json(json);
    expect(result.root.children).toHaveLength(1);
    expect(result.root.children[0].children).toHaveLength(1);
    expect(result.root.children[0].children[0].id).toBe('/child/grandchild');
  });

  it('keeps links intact', () => {
    const json = validJson();
    json.root.links = [
      { target_type: 'url', url: 'https://example.com', comment: 'External link' },
    ];

    const result = load_mindmap_from_json(json);
    expect(result.root.links).toHaveLength(1);
    expect(result.root.links[0].target_type).toBe('url');
  });

  it('THROWS on an invalid structure (not `return null`)', () => {
    // The production contract is a throw; the local copy this file used to
    // carry returned null instead, so this branch was never verified.
    expect(() => load_mindmap_from_json(null)).toThrow(/Invalid mindmap JSON structure/);
    expect(() => load_mindmap_from_json([])).toThrow(/Invalid mindmap JSON structure/);
    expect(() => load_mindmap_from_json({ ...validJson(), dir: 42 })).toThrow();
    expect(() => load_mindmap_from_json({ ...validJson(), source_file: undefined })).toThrow();
    expect(() => load_mindmap_from_json({ ...validJson(), root: { id: '/' } })).toThrow();
  });

  it('THROWS on an invalid child node', () => {
    const json = validJson();
    (json.root.children as unknown[]).push({ id: '/child', level: 1, children: [], links: [] });
    expect(() => load_mindmap_from_json(json)).toThrow(/Invalid mindmap JSON structure/);
  });

  it('THROWS on an invalid link type', () => {
    const json = validJson();
    (json.root.links as unknown[]).push({ target_type: 'invalid', comment: 'nope' });
    expect(() => load_mindmap_from_json(json)).toThrow();
  });

  it('accepts a `term` link (production supports it; the local copy did not)', () => {
    const json = validJson();
    json.root.links = [{ target_type: 'term', term_name: 'letter-box', comment: 'glossary' } as never];
    expect(load_mindmap_from_json(json).root.links[0].target_type).toBe('term');
  });

  it('sets in-memory flags on every node (is_mycc=true, is_patch=false)', () => {
    const json = validJson();
    json.root.children = [
      { id: '/a', text: 'a', title: 'A', summary: '', level: 1, children: [], links: [] },
    ];
    const mm = load_mindmap_from_json(json);
    expect(mm.root.is_mycc).toBe(true);
    expect(mm.root.is_patch).toBe(false);
    expect(mm.root.children[0].is_mycc).toBe(true);
  });
});

describe('serialize_mindmap / save_mindmap strip in-memory flags', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-load-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serialize_mindmap never emits is_mycc/is_patch', () => {
    // If stripping regressed, these flags would be written into the live
    // .mycc/mindmap.json — the hazard the old local-copy suite could not see.
    const json = validJson();
    json.root.children = [
      { id: '/a', text: 'a', title: 'A', summary: '', level: 1, children: [], links: [] },
    ];
    const out = serialize_mindmap(load_mindmap_from_json(json));
    expect(out).not.toContain('is_mycc');
    expect(out).not.toContain('is_patch');
    expect(JSON.parse(out).root.children[0].id).toBe('/a');
  });

  it('save_mindmap writes to an explicit path and the file round-trips', () => {
    const target = path.join(tempDir, 'mindmap.json');
    save_mindmap(load_mindmap_from_json(validJson()), target);
    const raw = fs.readFileSync(target, 'utf-8');
    expect(raw).not.toContain('is_mycc');
    expect(load_mindmap(target).root.title).toBe('Root');
  });
});

describe('load_mindmap (file path)', () => {
  let tempDir: string;
  let jsonPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-load-'));
    jsonPath = path.join(tempDir, 'mindmap.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('THROWS for a non-existent file', () => {
    expect(() => load_mindmap('/nonexistent/path/mindmap.json')).toThrow(/not found/);
    expect(() => load_mindmap(path.join(tempDir, 'nonexistent.json'))).toThrow(/not found/);
  });

  it('THROWS for invalid JSON syntax', () => {
    fs.writeFileSync(jsonPath, '{ invalid json }');
    expect(() => load_mindmap(jsonPath)).toThrow(SyntaxError);
  });

  it('THROWS for a non-object / null / array JSON payload', () => {
    for (const payload of ['"just a string"', 'null', '[]']) {
      fs.writeFileSync(jsonPath, payload);
      expect(() => load_mindmap(jsonPath)).toThrow(/Invalid mindmap JSON structure/);
    }
  });

  it('loads a valid file from disk', () => {
    fs.writeFileSync(jsonPath, JSON.stringify(validJson()));
    const mm = load_mindmap(jsonPath);
    expect(mm.dir).toBe('/test/dir');
    expect(mm.root.is_mycc).toBe(true);
  });
});

describe('try_load_mindmap returns null instead of throwing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-load-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null for a missing file', () => {
    expect(try_load_mindmap(path.join(tempDir, 'nope.json'))).toBeNull();
  });

  it('returns null for an invalid file', () => {
    const bad = path.join(tempDir, 'bad.json');
    fs.writeFileSync(bad, '{ nope }');
    expect(try_load_mindmap(bad)).toBeNull();
  });

  it('returns the mindmap for a valid file', () => {
    const good = path.join(tempDir, 'good.json');
    fs.writeFileSync(good, JSON.stringify(validJson()));
    expect(try_load_mindmap(good)?.hash).toBe('abc123');
  });
});

describe('default path helpers', () => {
  it('get_default_mindmap_path joins <projectDir>/.mycc/mindmap.json', () => {
    expect(get_default_mindmap_path('/proj')).toBe(path.join('/proj', '.mycc', 'mindmap.json'));
  });

  it('mindmap_exists reflects the filesystem', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-exists-'));
    try {
      expect(mindmap_exists(dir)).toBe(false);
      fs.mkdirSync(path.join(dir, '.mycc'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.mycc', 'mindmap.json'), JSON.stringify(validJson()));
      expect(mindmap_exists(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parse_mindmap_json (real validate.ts)', () => {
  it('returns null when the file is absent', () => {
    expect(parse_mindmap_json('/nonexistent/mindmap.json')).toBeNull();
  });

  it('agrees with compute_hash on the same bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-parse-'));
    try {
      const json = validJson();
      const p = path.join(dir, 'mindmap.json');
      fs.writeFileSync(p, JSON.stringify(json));
      expect(parse_mindmap_json(p)?.hash).toBe(json.hash);
      expect(compute_hash(JSON.stringify(json))).toHaveLength(64);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('serialize_mindmap is PURE — it must not mutate the live tree', () => {
  it('keeps is_mycc/is_patch on the in-memory nodes after serializing', () => {
    // Regression guard: strip_in_memory_flags used to be a shallow-ish rebuild
    // that was fine to share… but if it mutated the source nodes, every later
    // patch would be applied to a node that had lost its provenance flags.
    const mm = load_mindmap_from_json(validJson());
    expect(mm.root.is_mycc).toBe(true);
    serialize_mindmap(mm);
    expect(mm.root.is_mycc).toBe(true);
    expect(mm.root.is_patch).toBe(false);
  });

  it('save_mindmap likewise leaves the in-memory flags intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-pure-'));
    try {
      const mm = load_mindmap_from_json(validJson());
      save_mindmap(mm, path.join(dir, 'm.json'));
      expect(mm.root.is_mycc).toBe(true);
      expect(mm.root.is_patch).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'm.json'), 'utf-8')).not.toContain('is_mycc');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
