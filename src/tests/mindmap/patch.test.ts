/**
 * patch.test.ts - Patch application + A-N-C-E cascade tests for mindmap
 *
 * Binds to the REAL src/mindmap/patch.ts and src/mindmap/get-node.ts.
 *
 * The previous revision defined a local `patch_mindmap` / `generateSummary` /
 * `collectAncestors` / `collectDescendants` and asserted on those, so deleting
 * the production cascade (`applyPatchAction`, `summarize_node`'s ancestor /
 * descendant refresh) left every test green.
 *
 * Only the outbound LLM boundary is mocked: `summarizeWithExplorer` is the one
 * call that leaves the process, so it is the one seam stubbed here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const summarize = vi.hoisted(() => ({
  calls: [] as Array<{ title: string; text: string; ancestorContext: string; workDir: string }>,
}));

vi.mock('../../mindmap/explorer-agent.js', () => ({
  summarizeWithExplorer: vi.fn(
    async (title: string, text: string, ancestorContext: string, workDir: string) => {
      summarize.calls.push({ title, text, ancestorContext, workDir });
      // Echo the inputs so a cascade bug shows up as wrong summary TEXT, not
      // merely as a missing call.
      return { summary: `S(${title}) [anc:${ancestorContext.split('\n')[0] || ''}]` };
    },
  ),
}));

import {
  patch_mindmap,
  summarize_node,
  add_child_node,
  applyPatchAction,
} from '../../mindmap/patch.js';
import { get_node, get_ancestors, get_descendants } from '../../mindmap/get-node.js';
import type { Mindmap, Node } from '../../mindmap/types.js';

function node(id: string, title: string, level: number, children: Node[] = []): Node {
  return { id, text: `#${level} ${title}`, title, summary: `${title} summary`, level, children, links: [] };
}

function createTestMindmap(): Mindmap {
  return {
    dir: '/test/dir',
    source_file: 'MYCC.md',
    hash: 'test-hash',
    compiled_at: '2024-01-15T10:00:00Z',
    updated_at: '2024-01-15T10:00:00Z',
    root: node('/', 'Root', 0, [
      node('/parent', 'Parent', 1, [
        node('/parent/child', 'Child', 2, [node('/parent/child/grandchild', 'Grandchild', 3)]),
      ]),
    ]),
  };
}

describe('patch_mindmap (real implementation)', () => {
  let mindmap: Mindmap;

  beforeEach(() => {
    summarize.calls.length = 0;
    mindmap = createTestMindmap();
  });

  it('updates the target node text and returns it', async () => {
    const updated = await patch_mindmap(mindmap, '/parent/child', 'New child text');
    expect(updated?.id).toBe('/parent/child');
    expect(get_node(mindmap, '/parent/child')?.text).toBe('New child text');
  });

  it('appends feedback as an HTML comment', async () => {
    await patch_mindmap(mindmap, '/parent/child', 'Body', 'make it shorter');
    expect(get_node(mindmap, '/parent/child')?.text).toBe('Body\n\n<!-- Feedback: make it shorter -->');
  });

  it('returns null for a missing node and mutates nothing', async () => {
    const before = JSON.stringify(mindmap);
    expect(await patch_mindmap(mindmap, '/nope', 'x')).toBeNull();
    expect(JSON.stringify(mindmap)).toBe(before);
  });

  it('cascades to ANCESTORS (root last, deepest parent first)', async () => {
    await patch_mindmap(mindmap, '/parent/child', 'Patched');
    const titles = summarize.calls.map((c) => c.title);
    // The cascade RE-SUMMARIZES THE WHOLE SUBTREE below the target (not just
    // its ancestors): bottom-up descendants first (Grandchild), then the
    // target (Child), then ancestors deepest-first (Parent → Root).
    expect(titles).toEqual(['Grandchild', 'Child', 'Parent', 'Root']);
    expect(get_node(mindmap, '/parent')?.summary).toMatch(/^S\(Parent\)/);
    expect(mindmap.root.summary).toMatch(/^S\(Root\)/);
  });

  it('cascades to DESCENDANTS bottom-up (deepest first)', async () => {
    await patch_mindmap(mindmap, '/parent', 'Patched parent');
    const titles = summarize.calls.map((c) => c.title);
    // grandchild (level 3) before child (level 2), then the target, then root.
    expect(titles).toEqual(['Grandchild', 'Child', 'Parent', 'Root']);
    expect(get_node(mindmap, '/parent/child/grandchild')?.summary).toMatch(/^S\(Grandchild\)/);
  });

  it('passes the parent text as ancestorContext for a descendant', async () => {
    await patch_mindmap(mindmap, '/parent', 'Patched parent');
    const grandchildCall = summarize.calls.find((c) => c.title === 'Grandchild')!;
    expect(grandchildCall.ancestorContext).toBe('#2 Child');
    expect(grandchildCall.workDir).toBe('/test/dir');
  });

  it('bumps updated_at', async () => {
    const before = mindmap.updated_at;
    await patch_mindmap(mindmap, '/parent/child', 'x');
    expect(mindmap.updated_at).not.toBe(before);
  });
});

describe('summarize_node (real implementation)', () => {
  let mindmap: Mindmap;
  beforeEach(() => {
    summarize.calls.length = 0;
    mindmap = createTestMindmap();
  });

  it('regenerates the node summary and writes it in place', async () => {
    const s = await summarize_node(mindmap, '/parent/child');
    expect(s).toMatch(/^S\(Child\)/);
    expect(get_node(mindmap, '/parent/child')?.summary).toBe(s);
  });

  it('feeds ancestor texts as context', async () => {
    await summarize_node(mindmap, '/parent/child/grandchild');
    const call = summarize.calls[0];
    expect(call.ancestorContext).toContain('#0 Root');
    expect(call.ancestorContext).toContain('#1 Parent');
    expect(call.ancestorContext).toContain('#2 Child');
  });

  it('returns null for a missing node', async () => {
    expect(await summarize_node(mindmap, '/nope')).toBeNull();
    expect(summarize.calls).toHaveLength(0);
  });
});

describe('add_child_node (real implementation)', () => {
  let mindmap: Mindmap;
  beforeEach(() => {
    summarize.calls.length = 0;
    mindmap = createTestMindmap();
  });

  it('adds a child at parent.level + 1 and returns it', async () => {
    const added = await add_child_node(mindmap, '/parent', 'New Kid', 'text');
    expect(added).not.toBeNull();
    expect(get_node(mindmap, '/parent').children.map((c) => c.title)).toContain('New Kid');
    expect(added!.level).toBe(2);
  });

  it('returns null when the parent is missing', async () => {
    expect(await add_child_node(mindmap, '/nope', 'X')).toBeNull();
  });
});

describe('applyPatchAction (real implementation)', () => {
  let mindmap: Mindmap;
  beforeEach(() => {
    mindmap = createTestMindmap();
  });

  it('add: creates a node whose id is safeNodeId(title) and flags it as a patch node', () => {
    expect(applyPatchAction(mindmap, { action: 'add', path: '/parent', title: 'Code Cleanup', text: 't' })).toBe(true);
    const added = get_node(mindmap, '/parent/code-cleanup');
    expect(added?.title).toBe('Code Cleanup');
    expect(added?.is_patch).toBe(true);
    expect(added?.is_mycc).toBe(false);
    expect(added?.level).toBe(2);
  });

  it('add: is idempotent (replaying the same line does not duplicate)', () => {
    const action = { action: 'add', path: '/parent', title: 'Dup', text: 't' } as const;
    applyPatchAction(mindmap, action);
    applyPatchAction(mindmap, action);
    expect(get_node(mindmap, '/parent').children.filter((c) => c.id === '/parent/dup')).toHaveLength(1);
  });

  it('add: rejects a missing parent or empty title/text', () => {
    expect(applyPatchAction(mindmap, { action: 'add', path: '/nope', title: 'X', text: 't' })).toBe(false);
    expect(applyPatchAction(mindmap, { action: 'add', path: '/parent', title: '', text: 't' })).toBe(false);
    expect(applyPatchAction(mindmap, { action: 'add', path: '/parent', title: 'X', text: '' })).toBe(false);
  });

  it('add: sanitizes optional links, keeping only well-formed ones', () => {
    applyPatchAction(mindmap, {
      action: 'add',
      path: '/parent',
      title: 'Linked',
      text: 't',
      links: [
        { target_type: 'term', term_name: 'letter-box', comment: 'ok' },
        { target_type: 'url', comment: 'missing url' },
        { target_type: 'bogus', comment: 'bad type' },
      ],
    } as never);
    expect(get_node(mindmap, '/parent/linked')?.links).toEqual([
      { target_type: 'term', term_name: 'letter-box', comment: 'ok' },
    ]);
  });

  it('update: rewrites text, clears the summary, and marks is_patch', () => {
    expect(applyPatchAction(mindmap, { action: 'update', path: '/parent/child', text: 'NEW' })).toBe(true);
    const n = get_node(mindmap, '/parent/child')!;
    expect(n.text).toBe('NEW');
    expect(n.summary).toBe('');
    expect(n.is_patch).toBe(true);
  });

  it('update: refuses the root, an empty text, and a missing path', () => {
    expect(applyPatchAction(mindmap, { action: 'update', path: '/', text: 'x' })).toBe(false);
    expect(applyPatchAction(mindmap, { action: 'update', path: '/parent/child', text: '' })).toBe(false);
    expect(applyPatchAction(mindmap, { action: 'update', path: '/nope', text: 'x' })).toBe(false);
  });

  it('delete: removes a node and refuses the root', () => {
    expect(applyPatchAction(mindmap, { action: 'delete', path: '/parent/child/grandchild' })).toBe(true);
    expect(get_node(mindmap, '/parent/child/grandchild')).toBeNull();
    expect(applyPatchAction(mindmap, { action: 'delete', path: '/' })).toBe(false);
  });

  it('delete: matches by safeNodeId(title), not by literal title', () => {
    applyPatchAction(mindmap, { action: 'add', path: '/parent', title: 'Code Cleanup', text: 't' });
    expect(applyPatchAction(mindmap, { action: 'delete', path: '/parent/code-cleanup' })).toBe(true);
    expect(get_node(mindmap, '/parent/code-cleanup')).toBeNull();
  });

  it('returns false for an unknown action', () => {
    expect(applyPatchAction(mindmap, { action: 'nope', path: '/parent' } as never)).toBe(false);
  });
});

describe('traversal helpers used by the cascade are the real ones', () => {
  it('get_descendants flattens DFS and get_ancestors walks root→parent', () => {
    const mm = createTestMindmap();
    expect(get_descendants(mm.root).map((n) => n.id)).toEqual([
      '/parent', '/parent/child', '/parent/child/grandchild',
    ]);
    expect(get_ancestors(mm, '/parent/child/grandchild').map((n) => n.title)).toEqual([
      'Root', 'Parent', 'Child',
    ]);
  });
});
