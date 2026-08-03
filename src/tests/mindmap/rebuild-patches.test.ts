/**
 * Tests for rebuildPatches — patch JSONL rebuild from in-memory merged tree.
 *
 * Key behavior verified:
 * - Patch-added nodes (is_mycc=false) → emit 'add'
 * - MYCC.md nodes modified by patch (is_mycc=true, is_patch=true) → emit 'update'
 * - Pure MYCC.md nodes (is_mycc=true, is_patch=false, in base) → no action
 * - MYCC.md-DELETED nodes (is_mycc=true, NOT in fresh base) → preserved as 'add'
 *   (so content survives even though MYCC.md no longer has it)
 */

import { describe, it, expect } from 'vitest';
import { rebuildPatches } from '../../mindmap/patch-jsonl.js';
import type { Node } from '../../mindmap/types.js';

// Helper to create a node with explicit in-memory flags
function makeNode(
  id: string,
  text: string,
  children: Node[] = [],
  opts: { is_mycc?: boolean; is_patch?: boolean; title?: string } = {},
): Node {
  const segments = id.split('/').filter((s) => s.length > 0);
  return {
    id,
    text,
    title: opts.title ?? segments[segments.length - 1] ?? '',
    summary: '',
    level: segments.length,
    children,
    links: [],
    is_mycc: opts.is_mycc ?? true,
    is_patch: opts.is_patch ?? false,
  };
}

const HASH = 'newhash123';

describe('rebuildPatches', () => {
  it('emits no actions when merged tree == base tree (all pure MYCC.md)', () => {
    const base = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
      makeNode('/B', 'b text'),
    ]);
    // merged is identical (same structure, all is_mycc=true, is_patch=false)
    const merged = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
      makeNode('/B', 'b text'),
    ]);

    const actions = rebuildPatches(merged, base, HASH);
    expect(actions).toHaveLength(0);
  });

  it('emits add for patch-added nodes (is_mycc=false)', () => {
    const base = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
    ]);
    const merged = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
      makeNode('/P1', 'patch text', [], { is_mycc: false, is_patch: true }),
    ]);

    const actions = rebuildPatches(merged, base, HASH);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('add');
    expect(actions[0].path).toBe('/');
    expect(actions[0].title).toBe('P1');
    expect(actions[0].text).toBe('patch text');
    expect(actions[0].mindmap_hash).toBe(HASH);
  });

  it('emits update for MYCC.md nodes modified by patch (is_mycc=true, is_patch=true)', () => {
    const base = makeNode('/', 'root', [
      makeNode('/A', 'original a'),
    ]);
    const merged = makeNode('/', 'root', [
      makeNode('/A', 'patched a', [], { is_mycc: true, is_patch: true }),
    ]);

    const actions = rebuildPatches(merged, base, HASH);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('update');
    expect(actions[0].path).toBe('/A');
    expect(actions[0].text).toBe('patched a');
  });

  it('PRESERVES MYCC.md-deleted nodes as add patches (is_mycc=true, absent from base)', () => {
    // base (fresh compile, MYCC.md no longer has /B): only /A
    const base = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
    ]);
    // merged (old in-memory): /A and /B, where /B is is_mycc=true (was in MYCC.md)
    const merged = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
      makeNode('/B', 'b text that should be preserved', [], { is_mycc: true, is_patch: false }),
    ]);

    const actions = rebuildPatches(merged, base, HASH);
    // /A is pure MYCC.md (in base) → no action
    // /B is is_mycc=true but NOT in base → preserved as 'add'
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('add');
    expect(actions[0].path).toBe('/');
    expect(actions[0].title).toBe('B');
    expect(actions[0].text).toBe('b text that should be preserved');
    expect(actions[0].reason).toContain('Preserved');
  });

  it('preserves an entire deleted subtree (parent + children) as add patches', () => {
    // base: only /A (MYCC.md deleted /B and its child /B/C)
    const base = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
    ]);
    // merged: /A, /B (is_mycc), /B/C (is_mycc)
    const merged = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
      makeNode('/B', 'b text', [
        makeNode('/B/C', 'c text', [], { is_mycc: true }),
      ], { is_mycc: true }),
    ]);

    const actions = rebuildPatches(merged, base, HASH);
    // Both /B and /B/C should be preserved as 'add'
    expect(actions).toHaveLength(2);
    const adds = actions.filter((a) => a.action === 'add');
    expect(adds).toHaveLength(2);

    const bAdd = adds.find((a) => a.title === 'B');
    const cAdd = adds.find((a) => a.title === 'C');
    expect(bAdd).toBeDefined();
    expect(bAdd!.path).toBe('/');
    expect(cAdd).toBeDefined();
    expect(cAdd!.path).toBe('/B');
  });

  it('handles mixed scenario: add + update + preserved-deletion', () => {
    // base (fresh): /A, /C
    const base = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
      makeNode('/C', 'c text'),
    ]);
    // merged (old in-memory):
    //   /A — is_mycc=true, is_patch=true (was updated by patch)
    //   /B — is_mycc=true, NOT in base (deleted from MYCC.md) → preserve as add
    //   /C — is_mycc=true, is_patch=false (pure, in base) → no action
    //   /P1 — is_mycc=false (patch-added) → add
    const merged = makeNode('/', 'root', [
      makeNode('/A', 'patched a', [], { is_mycc: true, is_patch: true }),
      makeNode('/B', 'deleted from mycc', [], { is_mycc: true, is_patch: false }),
      makeNode('/C', 'c text'),
      makeNode('/P1', 'patch added', [], { is_mycc: false, is_patch: true }),
    ]);

    const actions = rebuildPatches(merged, base, HASH);
    // Expect: update /A, add /B, add /P1 (3 actions); /C produces nothing
    expect(actions).toHaveLength(3);

    const updateAction = actions.find((a) => a.action === 'update');
    expect(updateAction).toBeDefined();
    expect(updateAction!.path).toBe('/A');

    const addActions = actions.filter((a) => a.action === 'add');
    expect(addActions).toHaveLength(2);
    const titles = addActions.map((a) => a.title).sort();
    expect(titles).toEqual(['B', 'P1']);
  });

  it('never emits delete actions (deleted nodes are preserved, not removed)', () => {
    const base = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
    ]);
    const merged = makeNode('/', 'root', [
      makeNode('/A', 'a text'),
      makeNode('/B', 'deleted', [], { is_mycc: true }),
    ]);

    const actions = rebuildPatches(merged, base, HASH);
    expect(actions.some((a) => a.action === 'delete')).toBe(false);
  });

  it('does not emit add for root node even if absent from base (degenerate case)', () => {
    // root is always present — should never be emitted as add
    const base = makeNode('/', 'root', []);
    const merged = makeNode('/', 'root', [], { is_mycc: true });

    const actions = rebuildPatches(merged, base, HASH);
    expect(actions).toHaveLength(0);
  });
});