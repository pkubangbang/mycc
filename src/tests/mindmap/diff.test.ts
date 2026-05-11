/**
 * Tests for incremental mindmap compilation via diff
 */

import { describe, it, expect } from 'vitest';
import { diff_nodes } from '../../mindmap/diff-mindmap.js';
import type { Node } from '../../mindmap/types.js';

describe('diff_nodes', () => {
  // Helper to create a simple node
  const createNode = (
    id: string,
    text: string,
    children: Node[] = [],
    title?: string
  ): Node => ({
    id,
    text,
    title: title || id.split('/').pop() || '',
    summary: '',
    level: id.split('/').length - 1,
    children,
    links: [],
  });

  it('should detect no changes when trees are identical', () => {
    const oldRoot = createNode('/', 'root text', [
      createNode('/child1', 'child1 text'),
      createNode('/child2', 'child2 text'),
    ]);

    const newRoot = createNode('/', 'root text', [
      createNode('/child1', 'child1 text'),
      createNode('/child2', 'child2 text'),
    ]);

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.added.size).toBe(0);
    expect(result.removed.size).toBe(0);
    expect(result.textChanged.size).toBe(0);
  });

  it('should detect text changes', () => {
    const oldRoot = createNode('/', 'root text', [
      createNode('/child1', 'old text'),
    ]);

    const newRoot = createNode('/', 'root text', [
      createNode('/child1', 'new text'),
    ]);

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.added.size).toBe(0);
    expect(result.removed.size).toBe(0);
    expect(result.textChanged.size).toBe(1);
    expect(result.textChanged.has('/child1')).toBe(true);
  });

  it('should detect added nodes', () => {
    const oldRoot = createNode('/', 'root text', [
      createNode('/child1', 'child1 text'),
    ]);

    const newRoot = createNode('/', 'root text', [
      createNode('/child1', 'child1 text'),
      createNode('/child2', 'child2 text'),
    ]);

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.added.size).toBe(1);
    expect(result.added.has('/child2')).toBe(true);
    expect(result.removed.size).toBe(0);
    expect(result.textChanged.size).toBe(0);
  });

  it('should detect removed nodes', () => {
    const oldRoot = createNode('/', 'root text', [
      createNode('/child1', 'child1 text'),
      createNode('/child2', 'child2 text'),
    ]);

    const newRoot = createNode('/', 'root text', [
      createNode('/child1', 'child1 text'),
    ]);

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.added.size).toBe(0);
    expect(result.removed.size).toBe(1);
    expect(result.removed.has('/child2')).toBe(true);
    expect(result.textChanged.size).toBe(0);
  });

  it('should detect combined changes (add, remove, change)', () => {
    const oldRoot = createNode('/', 'root text', [
      createNode('/child1', 'old child1 text'),
      createNode('/child2', 'child2 text'),
    ]);

    const newRoot = createNode('/', 'root text', [
      createNode('/child1', 'new child1 text'), // changed
      createNode('/child3', 'child3 text'), // added
    ]);

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.textChanged.size).toBe(1);
    expect(result.textChanged.has('/child1')).toBe(true);
    expect(result.added.size).toBe(1);
    expect(result.added.has('/child3')).toBe(true);
    expect(result.removed.size).toBe(1);
    expect(result.removed.has('/child2')).toBe(true);
  });

  it('should detect changes in nested nodes', () => {
    const oldRoot = createNode('/', 'root', [
      createNode('/parent', 'parent text', [
        createNode('/parent/child', 'old child text'),
      ]),
    ]);

    const newRoot = createNode('/', 'root', [
      createNode('/parent', 'parent text', [
        createNode('/parent/child', 'new child text'),
      ]),
    ]);

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.textChanged.size).toBe(1);
    expect(result.textChanged.has('/parent/child')).toBe(true);
  });

  it('should detect added nested nodes', () => {
    const oldRoot = createNode('/', 'root', [
      createNode('/parent', 'parent text'),
    ]);

    const newRoot = createNode('/', 'root', [
      createNode('/parent', 'parent text', [
        createNode('/parent/newchild', 'new child text'),
      ]),
    ]);

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.added.size).toBe(1);
    expect(result.added.has('/parent/newchild')).toBe(true);
  });

  it('should detect removed nested nodes', () => {
    const oldRoot = createNode('/', 'root', [
      createNode('/parent', 'parent text', [
        createNode('/parent/child', 'child text'),
      ]),
    ]);

    const newRoot = createNode('/', 'root', [
      createNode('/parent', 'parent text'),
    ]);

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.removed.size).toBe(1);
    expect(result.removed.has('/parent/child')).toBe(true);
  });

  it('should handle deep nesting', () => {
    const oldRoot = createNode('/', 'root', [
      createNode('/a', 'a', [
        createNode('/a/b', 'b', [
          createNode('/a/b/c', 'old c'),
        ]),
      ]),
    ]);

    const newRoot = createNode('/', 'root', [
      createNode('/a', 'a', [
        createNode('/a/b', 'b', [
          createNode('/a/b/c', 'new c'),
        ]),
      ]),
    ]);

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.textChanged.size).toBe(1);
    expect(result.textChanged.has('/a/b/c')).toBe(true);
  });

  it('should detect root text changes', () => {
    const oldRoot = createNode('/', 'old root text');
    const newRoot = createNode('/', 'new root text');

    const result = diff_nodes(oldRoot, newRoot);

    expect(result.textChanged.size).toBe(1);
    expect(result.textChanged.has('/')).toBe(true);
  });

  it('should return empty result for identical single node', () => {
    const node = createNode('/', 'text');
    const result = diff_nodes(node, node);

    expect(result.added.size).toBe(0);
    expect(result.removed.size).toBe(0);
    expect(result.textChanged.size).toBe(0);
  });
});