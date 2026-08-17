/**
 * patch-validation.test.ts — Lock in Fix A (orphan-prevention sanity checks)
 * and Fix B (get_node resolves path segments by normalized id, not raw title).
 *
 * These tests import the REAL modules (no local re-implementations) so they
 * exercise the actual production code paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  validatePatchAction,
  appendPatch,
  writePatches,
  readAllPatches,
} from '../../mindmap/patch-jsonl.js';
import { get_node, get_ancestors } from '../../mindmap/get-node.js';
import { applyPatchAction } from '../../mindmap/patch.js';
import { safeNodeId } from '../../utils/sanitize.js';
import type { Mindmap, Node, MindmapPatchAction, Link } from '../../mindmap/types.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A mindmap whose child titles contain spaces, so safeNodeId(title) ≠ title. */
function makeMindmap(): Mindmap {
  const codeCleanup: Node = {
    id: '/mycc.md/code-cleanup', title: 'Code Cleanup', text: 'cleanup rules',
    summary: '', level: 2, children: [], links: [], is_mycc: true,
  };
  const mycc: Node = {
    id: '/mycc.md', title: 'mycc.md', text: 'project doc',
    summary: '', level: 1, children: [codeCleanup], links: [], is_mycc: true,
  };
  const root: Node = {
    id: '/', title: 'Root', text: 'root', summary: '',
    level: 0, children: [mycc], links: [],
  };
  return {
    dir: '/tmp', source_file: 'MYCC.md', hash: 'h1',
    compiled_at: '', updated_at: '', root,
  };
}

const baseAdd = (): MindmapPatchAction => ({
  action: 'add', path: '/mycc.md', title: 'New Node', text: 'some text',
  timestamp: '', checkpoint_id: '', reason: 'test', mindmap_hash: 'h1',
});

// ── Fix A: validatePatchAction orphan prevention ──────────────────────────

describe('validatePatchAction (Fix A — orphan prevention)', () => {
  it('accepts a well-formed add with non-empty title and text', () => {
    expect(validatePatchAction(baseAdd())).toBe(true);
  });

  it('rejects an add with empty text (would orphan its descendants)', () => {
    const a = baseAdd();
    a.text = '';
    expect(validatePatchAction(a)).toBe(false);
    a.text = '   ';
    expect(validatePatchAction(a)).toBe(false);
  });

  it('rejects an add with empty title', () => {
    const a = baseAdd();
    a.title = '';
    expect(validatePatchAction(a)).toBe(false);
  });

  it('rejects an add with a malformed parent path (double slash)', () => {
    const a = baseAdd();
    a.path = '/mycc.md//sub';
    expect(validatePatchAction(a)).toBe(false);
  });

  it('rejects an add with a trailing-slash parent path', () => {
    const a = baseAdd();
    a.path = '/mycc.md/';
    expect(validatePatchAction(a)).toBe(false);
  });

  it('rejects update/delete targeting root', () => {
    const u = { ...baseAdd(), action: 'update' as const, path: '/' };
    const d = { ...baseAdd(), action: 'delete' as const, path: '/' };
    expect(validatePatchAction(u)).toBe(false);
    expect(validatePatchAction(d)).toBe(false);
  });

  it('rejects an unknown action type', () => {
    const a = baseAdd();
    (a as { action: string }).action = 'noop';
    expect(validatePatchAction(a)).toBe(false);
  });
});

// ── Fix A: appendPatch / writePatches / readAllPatches enforce validation ───

describe('appendPatch + readAllPatches (Fix A — write/read gates)', () => {
  let tmpFile: string;
  beforeEach(() => {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'patch-')), 'p.jsonl');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it('appends a valid action and reads it back', () => {
    expect(appendPatch(baseAdd(), tmpFile)).toBe(true);
    expect(readAllPatches(tmpFile)).toHaveLength(1);
  });

  it('refuses to append an invalid action (empty text) and the file stays empty', () => {
    const a = baseAdd();
    a.text = '';
    expect(appendPatch(a, tmpFile)).toBe(false);
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(readAllPatches(tmpFile)).toHaveLength(0);
  });

  it('writePatches filters out invalid actions on rebuild', () => {
    const valid = baseAdd();
    const orphan = baseAdd();
    orphan.text = '';
    writePatches([valid, orphan], tmpFile);
    const read = readAllPatches(tmpFile);
    expect(read).toHaveLength(1);
    expect(read[0].text).toBe('some text');
  });

  it('readAllPatches silently drops legacy invalid lines (defense in depth)', () => {
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    const good = baseAdd();
    const bad = baseAdd();
    bad.text = '';
    fs.writeFileSync(tmpFile, `${JSON.stringify(good)}\n${JSON.stringify(bad)}\n`, 'utf-8');
    expect(readAllPatches(tmpFile)).toHaveLength(1);
  });
});

// ── Fix B: get_node resolves by normalized id ──────────────────────────────

describe('get_node (Fix B — normalized-id matching)', () => {
  let mindmap: Mindmap;
  beforeEach(() => { mindmap = makeMindmap(); });

  it('resolves a child whose title has spaces via its sanitized id segment', () => {
    // title "Code Cleanup" → safeNodeId → "code-cleanup"
    const node = get_node(mindmap, '/mycc.md/code-cleanup');
    expect(node).not.toBeNull();
    expect(node!.title).toBe('Code Cleanup');
  });

  it('returns null for a segment that matches the raw title but not the id', () => {
    // Raw title "Code Cleanup" must NOT match a "code cleanup" segment —
    // the canonical address is the normalized id, not the raw title.
    expect(get_node(mindmap, '/mycc.md/Code Cleanup')).toBeNull();
    expect(get_node(mindmap, '/mycc.md/code cleanup')).toBeNull();
  });

  it('applyPatchAction add+child round-trips through normalized-id get_node', () => {
    // Add a child under /mycc.md/code-cleanup with a spaced title; then resolve
    // it by its sanitized id — this is the scenario that used to cause 4 of the
    // "7 skipped" because the child patch path used the sanitized id while
    // get_node matched against the raw title.
    const parent = get_node(mindmap, '/mycc.md/code-cleanup');
    expect(parent).not.toBeNull();

    const add: MindmapPatchAction = {
      action: 'add', path: '/mycc.md/code-cleanup',
      title: '中文顿号 Multi-line Edit', text: 'rule body',
      timestamp: '', checkpoint_id: '', reason: 't', mindmap_hash: 'h1',
    };
    expect(applyPatchAction(mindmap, add)).toBe(true);

    const expectedId = `${parent!.id}/${safeNodeId(add.title!)}`;
    expect(get_node(mindmap, expectedId)).not.toBeNull();
    expect(get_node(mindmap, expectedId)!.title).toBe('中文顿号 Multi-line Edit');
  });

  it('get_ancestors resolves a normalized-id path whose titles contain spaces', () => {
    const add: MindmapPatchAction = {
      action: 'add', path: '/mycc.md/code-cleanup',
      title: 'Deep Rule', text: 'x',
      timestamp: '', checkpoint_id: '', reason: 't', mindmap_hash: 'h1',
    };
    applyPatchAction(mindmap, add);
    const childId = '/mycc.md/code-cleanup/deep-rule';
    const ancestors = get_ancestors(mindmap, childId);
    expect(ancestors.map((a) => a.id)).toEqual(['/', '/mycc.md', '/mycc.md/code-cleanup']);
  });
});

// ── Patch-sourced links: patch-added nodes carry term links (runtime hoist) ──

describe('applyPatchAction add replays action.links (term hoist)', () => {
  let mindmap: Mindmap;
  beforeEach(() => { mindmap = makeMindmap(); });

  it('attaches action.links onto the new node (term links hoist to root Key Terms)', () => {
    // Add a terminology-style node directly under /mycc.md (present in the
    // fixture) so applyPatchAction can resolve the parent.
    const add: MindmapPatchAction = {
      action: 'add', path: '/mycc.md',
      title: 'backlog / livelog / TP constraint',
      text: 'backlog = the append-only triologue JSONL file; livelog = the in-memory Triologue messages array.',
      timestamp: '', checkpoint_id: '', reason: 'terminology', mindmap_hash: 'h1',
      links: [
        { target_type: 'term', term_name: 'backlog', comment: 'append-only triologue JSONL on disk' },
        { target_type: 'term', term_name: 'livelog', comment: 'in-memory Triologue messages array' },
      ],
    };
    expect(applyPatchAction(mindmap, add)).toBe(true);

    // Resolve the new node by its sanitized id (title contains spaces/slashes
    // → safeNodeId collapses 'backlog / livelog / TP constraint' to
    // 'backlog-livelog-tp-constraint').
    const node = get_node(mindmap, '/mycc.md/backlog-livelog-tp-constraint');
    expect(node).not.toBeNull();
    const termLinks = node!.links.filter((l) => l.target_type === 'term');
    expect(termLinks.map((l) => l.term_name).sort()).toEqual(['backlog', 'livelog']);
  });

  it('omits action.links entirely when not provided (backward compatible)', () => {
    const add: MindmapPatchAction = {
      action: 'add', path: '/mycc.md', title: 'Plain Node', text: 'no links',
      timestamp: '', checkpoint_id: '', reason: 't', mindmap_hash: 'h1',
    };
    expect(applyPatchAction(mindmap, add)).toBe(true);
    const node = get_node(mindmap, '/mycc.md/plain-node');
    expect(node).not.toBeNull();
    expect(node!.links).toEqual([]);
  });

  it('drops malformed link entries (bad target_type / missing target field) defensively', () => {
    const add: MindmapPatchAction = {
      action: 'add', path: '/mycc.md', title: 'Bad Links', text: 'x',
      timestamp: '', checkpoint_id: '', reason: 't', mindmap_hash: 'h1',
      links: [
        { target_type: 'term', term_name: 'good-term', comment: 'ok' },
        { target_type: 'term', term_name: '', comment: 'empty term dropped' },
        { target_type: 'bogus' as Link['target_type'], comment: 'bad type dropped' },
        { target_type: 'file', comment: 'no file_path dropped' },
        null as unknown as Link,
      ],
    };
    expect(applyPatchAction(mindmap, add)).toBe(true);
    const node = get_node(mindmap, '/mycc.md/bad-links');
    expect(node).not.toBeNull();
    expect(node!.links).toHaveLength(1);
    expect(node!.links[0].target_type).toBe('term');
    expect(node!.links[0].term_name).toBe('good-term');
  });
});