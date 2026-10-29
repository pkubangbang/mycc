/**
 * types.test.ts - The mindmap TYPE CONTRACT, checked against production code.
 *
 * `src/mindmap/types.ts` is a types-only module: every interface is erased at
 * runtime, so there is nothing in it to execute. The previous revision worked
 * around that by re-declaring the interfaces AND a set of `isValid*` helpers
 * locally and asserting on its own helpers — a pure tautology over test-owned
 * code that would pass with `src/mindmap/types.ts` deleted.
 *
 * The meaningful, executable contract is the one the runtime validators
 * enforce, so this file asserts that contract against the REAL
 * `validate_mindmap_structure`, and pins the documented optionality of the
 * in-memory flags that `load_mindmap` sets.
 */

import { describe, it, expect } from 'vitest';
import { validate_mindmap_structure } from '../../mindmap/validate.js';
import type { MindmapJSON, Node } from '../../mindmap/types.js';

function baseNode(overrides: Partial<Node> = {}): Node {
  return {
    id: '/',
    text: '# Root',
    title: 'Root',
    summary: 'Root summary',
    level: 0,
    children: [],
    links: [],
    ...overrides,
  };
}

function base(overrides: Partial<MindmapJSON> = {}): MindmapJSON {
  return {
    dir: '/d',
    source_file: 'MYCC.md',
    hash: 'h',
    compiled_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    root: baseNode(),
    ...overrides,
  } as MindmapJSON;
}

describe('Node required fields (enforced by the real validator)', () => {
  it.each(['id', 'text', 'title', 'summary', 'level', 'children', 'links'] as const)(
    'rejects a node missing %s',
    (field) => {
      const n = baseNode() as unknown as Record<string, unknown>;
      delete n[field];
      expect(validate_mindmap_structure(base({ root: n as unknown as Node }))).toBe(false);
    },
  );

  it('rejects a children entry that is not an array, and a non-numeric level', () => {
    expect(validate_mindmap_structure(base({ root: baseNode({ children: 'x' as never }) }))).toBe(false);
    expect(validate_mindmap_structure(base({ root: baseNode({ level: '2' as never }) }))).toBe(false);
  });

  it('accepts the full required set', () => {
    expect(validate_mindmap_structure(base())).toBe(true);
  });
});

describe('in-memory flags are OPTIONAL in the on-disk shape', () => {
  // is_mycc/is_patch are runtime-only (load_mindmap sets them; serialization
  // strips them). The validator must therefore accept a record without them —
  // if it ever required them, every write-then-read cycle would fail.
  it('a record with no is_mycc/is_patch still validates', () => {
    const j = base();
    expect(j.root.is_mycc).toBeUndefined();
    expect(validate_mindmap_structure(j)).toBe(true);
  });

  it('a record that DOES carry them also validates (mid-session in-memory shape)', () => {
    expect(validate_mindmap_structure(base({ root: baseNode({ is_mycc: true, is_patch: false }) }))).toBe(true);
  });
});

describe('Link union is closed at four variants', () => {
  it.each(['node', 'file', 'url', 'term'] as const)('accepts target_type=%s with its payload', (t) => {
    const link: Record<string, unknown> = { target_type: t, comment: 'c' };
    if (t === 'node') link.node_id = '/n';
    if (t === 'file') link.file_path = './f.ts';
    if (t === 'url') link.url = 'https://e.x';
    if (t === 'term') link.term_name = 'letter-box';
    expect(validate_mindmap_structure(base({ root: baseNode({ links: [link as never] }) }))).toBe(true);
  });

  it('rejects any fifth variant and a missing payload on a known variant', () => {
    expect(validate_mindmap_structure(base({ root: baseNode({ links: [{ target_type: 'x', comment: '' } as never] }) }))).toBe(false);
    expect(validate_mindmap_structure(base({ root: baseNode({ links: [{ target_type: 'term', comment: 'c' } as never] }) }))).toBe(false);
  });
});

describe('MindmapJSON requires source_file (the compile provenance field)', () => {
  it('rejects a record without it', () => {
    const j = base() as unknown as Record<string, unknown>;
    delete j.source_file;
    expect(validate_mindmap_structure(j)).toBe(false);
  });
});
