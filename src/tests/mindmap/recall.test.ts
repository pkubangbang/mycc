/**
 * recall.test.ts - Node path resolution for the mindmap (the `/recall` tool's lookup)
 *
 * Binds to the REAL src/mindmap/get-node.ts. The previous revision defined a
 * local `get_node` that matched children by their literal `id`, which is NOT
 * the production contract: get-node.ts resolves each segment through
 * `safeNodeId(child.title)` so a path segment "code-cleanup" finds the node
 * titled "Code Cleanup". Deleting the normalisation left the old suite green.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  get_node,
  get_node_result,
  get_ancestors,
  get_descendants,
  get_descendants_at_depth,
} from '../../mindmap/get-node.js';
import { safeNodeId } from '../../utils/sanitize.js';
import type { Link, Mindmap, Node } from '../../mindmap/types.js';

function node(
  id: string,
  title: string,
  level: number,
  children: Node[] = [],
  links: Link[] = [],
): Node {
  return { id, text: `${'#'.repeat(level + 1)} ${title}`, title, summary: `${title} summary`, level, children, links };
}

function createTestMindmap(): Mindmap {
  return {
    dir: '/test/dir',
    source_file: 'MYCC.md',
    hash: 'test-hash',
    compiled_at: new Date(),
    updated_at: new Date(),
    root: node('/', 'Root', 0, [
      node('/architecture', 'Architecture', 1, [
        node('/architecture/core', 'Core', 2),
        node('/architecture/utils', 'Utils', 2),
      ]),
      node('/development', 'Development', 1, [
        node('/development/testing', 'Testing', 2, [
          node('/development/testing/unit', 'Unit Tests', 3),
          node('/development/testing/integration', 'Integration Tests', 3),
        ]),
      ]),
    ]),
  };
}

describe('get_node', () => {
  let mindmap: Mindmap;

  beforeEach(() => {
    mindmap = createTestMindmap();
  });

  it('returns the root for "/" and for the empty string', () => {
    expect(get_node(mindmap, '/')).toBe(mindmap.root);
    expect(get_node(mindmap, '')).toBe(mindmap.root);
  });

  it('resolves every existing path, level by level', () => {
    expect(get_node(mindmap, '/architecture')?.title).toBe('Architecture');
    expect(get_node(mindmap, '/development')?.title).toBe('Development');
    expect(get_node(mindmap, '/architecture/core')?.title).toBe('Core');
    expect(get_node(mindmap, '/architecture/utils')?.title).toBe('Utils');
    expect(get_node(mindmap, '/development/testing')?.title).toBe('Testing');
    // Depth-3 segments must be addressed by the NORMALISED TITLE (safeNodeId),
    // never by the literal id — the ids in this fixture deliberately differ.
    expect(get_node(mindmap, '/development/testing/unit-tests')?.title).toBe('Unit Tests');
    expect(get_node(mindmap, '/development/testing/integration-tests')?.title).toBe('Integration Tests');
  });

  it('returns null for missing paths without throwing', () => {
    expect(get_node(mindmap, '/nope')).toBeNull();
    expect(get_node(mindmap, '/architecture/nope')).toBeNull();
    expect(get_node(mindmap, '/a/b/c/d/e')).toBeNull();
    expect(get_node(mindmap, '/arch')).toBeNull();          // partial segment, not a prefix match
    expect(get_node(mindmap, '/Architecture')).toBeNull();  // case-sensitive
  });

  it('resolves a segment through safeNodeId(title), not the literal id', () => {
    // The production addressing scheme normalises the TITLE. A compile that
    // produced a differently-cased / spaced id must still be reachable.
    const mm = createTestMindmap();
    mm.root.children.push(node('/whatever-id', 'Code Cleanup', 1));
    const segment = safeNodeId('Code Cleanup');
    expect(segment).toBe('code-cleanup');
    const found = get_node(mm, `/${segment}`);
    expect(found).not.toBeNull();
    expect(found?.title).toBe('Code Cleanup');
  });

  it('is tolerant of repeated / trailing separators (production splits + filters)', () => {
    // The old local copy REJECTED these; the real one normalises them. This is
    // the behavioural difference that makes the old test suite misleading.
    expect(get_node(mindmap, '//architecture')?.title).toBe('Architecture');
    expect(get_node(mindmap, '/architecture/')?.title).toBe('Architecture');
    // A missing leading separator is NOT special-cased: 'architecture' is still
    // a valid first segment, so the real implementation resolves it.
    expect(get_node(mindmap, 'architecture/core')?.title).toBe('Core');
  });
});

describe('get_node_result', () => {
  it('returns node + path for a hit', () => {
    const r = get_node_result(createTestMindmap(), '/architecture/core');
    expect(r.node?.title).toBe('Core');
    expect(r.path).toEqual(['/', '/architecture', '/architecture/core']);
    expect(r.error).toBeUndefined();
  });

  it('returns the root for "/" with a single-element path', () => {
    const r = get_node_result(createTestMindmap(), '/');
    expect(r.node?.id).toBe('/');
    expect(r.path).toEqual(['/']);
  });

  it('names the missing segment on a miss', () => {
    const r = get_node_result(createTestMindmap(), '/architecture/nope/deeper');
    expect(r.node).toBeNull();
    expect(r.error).toContain('missing: nope');
  });
});

describe('get_ancestors', () => {
  it('returns [] for the root (no ancestors)', () => {
    expect(get_ancestors(createTestMindmap(), '/')).toEqual([]);
    expect(get_ancestors(createTestMindmap(), '')).toEqual([]);
  });

  it('returns root→parent for a leaf, excluding the node itself', () => {
    const ancestors = get_ancestors(createTestMindmap(), '/development/testing/unit');
    expect(ancestors.map((n) => n.id)).toEqual(['/', '/development', '/development/testing']);
  });

  it('returns [] for a missing path', () => {
    expect(get_ancestors(createTestMindmap(), '/nope/deeper')).toEqual([]);
  });
});

describe('get_descendants / get_descendants_at_depth', () => {
  it('flattens the whole subtree in DFS order', () => {
    const d = get_descendants(createTestMindmap().root.children[1]); // /development
    expect(d.map((n) => n.id)).toEqual([
      '/development/testing',
      '/development/testing/unit',
      '/development/testing/integration',
    ]);
  });

  it('returns [] for a leaf', () => {
    expect(get_descendants(createTestMindmap().root.children[0].children[1])).toEqual([]);
  });

  it('depth <= 0 returns the node itself; depth 1 returns direct children', () => {
    const root = createTestMindmap().root;
    expect(get_descendants_at_depth(root, 0)).toEqual([root]);
    expect(get_descendants_at_depth(root, -1)).toEqual([root]);
    expect(get_descendants_at_depth(root, 1).map((n) => n.id)).toEqual(['/architecture', '/development']);
  });

  it('depth 2 returns grandchildren across every branch', () => {
    expect(get_descendants_at_depth(createTestMindmap().root, 2).map((n) => n.id)).toEqual([
      '/architecture/core',
      '/architecture/utils',
      '/development/testing',
    ]);
  });

  it('returns [] when the depth exceeds the tree height', () => {
    expect(get_descendants_at_depth(createTestMindmap().root, 9)).toEqual([]);
  });

  it('nodes carry the full required property set', () => {
    const n = get_node(createTestMindmap(), '/architecture/core')!;
    expect(n).toEqual({
      id: '/architecture/core',
      text: '### Core',
      title: 'Core',
      summary: 'Core summary',
      level: 2,
      children: [],
      links: [],
    });
    // In-memory flags are set by load_mindmap(), NOT by traversal — get_node on
    // a plain fixture must not invent them (that would hide a loader regression).
    expect('is_mycc' in n).toBe(false);
  });
});
