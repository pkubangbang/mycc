/**
 * patch-jsonl.ts - Append-only JSONL log of mindmap patch actions
 *
 * The mindmap-patch.jsonl file is an independent on-disk line that records
 * structural changes (add/update/delete) produced by recap. It is replayed
 * at startup to rebuild the in-memory merged tree (mindmap.json + patches).
 *
 * Key properties:
 * - Append-only during a session (one line per patch action)
 * - Fully rewritten during `/mindmap compile` patch rebuild (BFS dedup)
 * - Hash-gated: each action records the mindmap.json hash it was created
 *   against; only hash-matching actions are replayed
 *
 * @see docs/mindmap-redesign.md
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MindmapPatchAction, Node } from './types.js';

/**
 * Validate a patch action's structural integrity before it enters the jsonl.
 *
 * This is the "orphan-prevention" gate. The two causes of an `add` patch being
 * silently skipped at replay time are:
 *   1. empty `title` or empty `text` — `applyPatchAction` returns false on
 *      `!action.title || !action.text`, so the parent never enters the tree
 *      and every later child under it becomes an orphan;
 *   2. an `add` whose `path` is not "/" and is not a chain of non-empty
 *      segments — a malformed/relative parent path can never resolve.
 *
 * Rejecting such actions at the append boundary keeps the log clean: a bad
 * parent never lands in the file, so it can never orphan its descendants.
 * `update`/`delete` are also sanity-checked (non-root, non-empty path).
 *
 * @param action - The patch action to validate
 * @returns true if the action is structurally sound and safe to persist
 */
export function validatePatchAction(action: MindmapPatchAction): boolean {
  if (!action || typeof action.action !== 'string') return false;
  if (typeof action.path !== 'string' || action.path.length === 0) return false;

  switch (action.action) {
    case 'add':
      // 'add' needs a non-empty title and non-empty text, plus a valid parent path.
      if (!action.title || action.title.trim().length === 0) return false;
      if (!action.text || action.text.trim().length === 0) return false;
      // Parent path must be "/" or a "/a/b/..." chain of non-empty segments.
      return action.path === '/' || isWellFormedPath(action.path);

    case 'update':
      // Cannot update root; needs non-empty text and a non-root path.
      if (action.path === '/' || action.path === '') return false;
      if (!action.text || action.text.trim().length === 0) return false;
      return isWellFormedPath(action.path);

    case 'delete':
      // Cannot delete root; needs a non-root, well-formed path.
      if (action.path === '/' || action.path === '') return false;
      return isWellFormedPath(action.path);

    default:
      return false;
  }
}

/**
 * A well-formed node path is "/" or "/seg1/seg2/..." with non-empty segments
 * and no double slashes. Used to reject malformed parent paths on 'add'.
 */
function isWellFormedPath(p: string): boolean {
  if (!p.startsWith('/')) return false;
  if (p.length === 1) return true; // "/"
  if (p.endsWith('/')) return false; // no trailing slash (except root)
  if (p.includes('//')) return false; // no double slashes
  return p.slice(1).split('/').every(s => s.length > 0);
}

/**
 * Get the default patch JSONL path for a project
 * @param projectDir - The project directory (default: current working directory)
 * @returns Path to .mycc/mindmap-patch.jsonl
 */
export function getPatchPath(projectDir?: string): string {
  const baseDir = projectDir || process.cwd();
  return path.join(baseDir, '.mycc', 'mindmap-patch.jsonl');
}

/**
 * Append a single patch action to the JSONL file (append-only).
 * Creates the file if it does not exist.
 *
 * Sanitizes the action through `validatePatchAction` first: structurally
 * invalid actions (empty title/text for 'add', malformed paths, root
 * update/delete) are rejected before they touch the log. This prevents
 * orphan-creating parents from ever entering the append-only file — a bad
 * parent skipped at write time cannot later orphan its descendants.
 *
 * @param action - The patch action to append
 * @param patchPath - Path to the JSONL file
 * @returns true if appended, false if rejected by validation
 */
export function appendPatch(action: MindmapPatchAction, patchPath: string): boolean {
  if (!validatePatchAction(action)) {
    return false;
  }
  const dir = path.dirname(patchPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(patchPath, `${JSON.stringify(action)}\n`, 'utf-8');
  return true;
}

/**
 * Read all patch actions from the JSONL file.
 * Malformed lines are skipped (logged to stderr).
 *
 * @param patchPath - Path to the JSONL file
 * @returns Array of patch actions in file order (oldest first)
 */
export function readAllPatches(patchPath: string): MindmapPatchAction[] {
  if (!fs.existsSync(patchPath)) {
    return [];
  }
  const content = fs.readFileSync(patchPath, 'utf-8');
  const lines = content.split('\n');
  const actions: MindmapPatchAction[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as MindmapPatchAction;
      // Accept only structurally valid actions so legacy/malformed entries
      // (e.g. an 'add' with empty text from an older writer) are dropped at
      // read time rather than replayed as doomed-to-skip orphans.
      if (parsed && validatePatchAction(parsed)) {
        actions.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return actions;
}

/**
 * Write a complete set of patch actions to the JSONL file, replacing the old content.
 * Used during patch rebuild to produce a clean, minimal patch set.
 *
 * Filters out structurally invalid actions via `validatePatchAction` so a
 * rebuild (which BFS-walks the in-memory tree and may encounter a node with
 * empty text) cannot re-introduce orphan-creating 'add' actions back into the
 * log. This is the rebuild-path counterpart to `appendPatch`'s runtime gate.
 *
 * @param actions - The patch actions to write (in order)
 * @param patchPath - Path to the JSONL file
 */
export function writePatches(actions: MindmapPatchAction[], patchPath: string): void {
  const dir = path.dirname(patchPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const valid = actions.filter(a => validatePatchAction(a));
  const content = valid.map((a) => JSON.stringify(a)).join('\n');
  // Trailing newline if non-empty
  const output = content.length > 0 ? `${content}\n` : '';
  fs.writeFileSync(patchPath, output, 'utf-8');
}

/**
 * Clear the patch JSONL file (write empty content).
 * Used after a successful compile when patches are baked into mindmap.json.
 *
 * @param patchPath - Path to the JSONL file
 */
export function clearPatches(patchPath: string): void {
  if (fs.existsSync(patchPath)) {
    fs.writeFileSync(patchPath, '', 'utf-8');
  }
}

/**
 * Rebuild the patch JSONL from the in-memory merged tree (BFS traversal).
 *
 * Produces a minimal, consistent patch set:
 * - One 'add' per surviving patch-added node (is_mycc=false)
 * - One 'update' per surviving text modification (is_mycc=true, is_patch=true)
 * - One 'add' per MYCC.md-deleted node (is_mycc=true, not in fresh baseTree):
 *   when MYCC.md removes a node that was previously compiled into mindmap.json,
 *   re-compile would drop it. To PRESERVE the content, the node is converted
 *   to an 'add' patch (is_mycc=false on replay) so it survives in the tree
 *   as patch-added knowledge. The entire deleted subtree is preserved this way
 *   because the BFS visits every node in the old merged tree.
 *
 * This eliminates duplicate/stale patches that accumulate over time, while
 * ensuring MYCC.md deletions do not silently discard agent-known knowledge.
 *
 * @param mergedTree - The in-memory merged tree (mindmap + patches applied)
 * @param baseTree - The freshly compiled mindmap.json tree (is_mycc only)
 * @param mindmapHash - Hash of the freshly compiled mindmap.json
 * @returns Array of clean patch actions
 */
export function rebuildPatches(
  mergedTree: Node,
  baseTree: Node,
  mindmapHash: string,
): MindmapPatchAction[] {
  const actions: MindmapPatchAction[] = [];
  const now = new Date().toISOString();
  const queue: Node[] = [mergedTree];

  // Collect fresh-base paths once, for the deleted-node check.
  // A node in the old merged tree that is is_mycc=true but NOT in the fresh
  // base was removed from MYCC.md → preserve it as an 'add' patch.
  const basePaths = collectPaths(baseTree);

  // BFS traversal of the merged tree
  while (queue.length > 0) {
    const node = queue.shift()!;
    queue.push(...node.children);

    if (!node.is_mycc) {
      // Patch-added node → emit 'add' action
      const segments = node.id.split('/').filter((s) => s.length > 0);
      const parentPath = segments.length > 0
        ? `/${segments.slice(0, -1).join('/')}`
        : '/';
      actions.push({
        action: 'add',
        path: parentPath,
        title: node.title,
        text: node.text,
        timestamp: now,
        checkpoint_id: '',
        reason: 'Rebuilt from in-memory state',
        mindmap_hash: mindmapHash,
      });
    } else if (!basePaths.has(node.id)) {
      // MYCC.md-deleted node (was is_mycc, now absent from fresh base) →
      // PRESERVE as an 'add' patch. On replay it becomes is_mycc=false,
      // so the content survives even though MYCC.md no longer has it.
      // Skip root: root always exists and cannot be added/deleted.
      if (node.id === '/' || node.id === '') {
        // root is always present — no action
      } else {
        const segments = node.id.split('/').filter((s) => s.length > 0);
        const parentPath = segments.length > 0
          ? `/${segments.slice(0, -1).join('/')}`
          : '/';
        actions.push({
          action: 'add',
          path: parentPath,
          title: node.title,
          text: node.text,
          timestamp: now,
          checkpoint_id: '',
          reason: 'Preserved from MYCC.md deletion',
          mindmap_hash: mindmapHash,
        });
      }
    } else if (node.is_patch) {
      // MYCC.md node modified by patch → emit 'update' to preserve patched text
      actions.push({
        action: 'update',
        path: node.id,
        text: node.text,
        timestamp: now,
        checkpoint_id: '',
        reason: 'Rebuilt from in-memory state',
        mindmap_hash: mindmapHash,
      });
    }
    // else: is_mycc=true, is_patch=false, in base → pure MYCC.md node, no action
  }

  return actions;
}

/**
 * Collect all node IDs in a tree into a Set (for fast membership lookup)
 */
function collectPaths(node: Node): Set<string> {
  const paths = new Set<string>();
  function walk(n: Node) {
    paths.add(n.id);
    for (const child of n.children) {
      walk(child);
    }
  }
  walk(node);
  return paths;
}