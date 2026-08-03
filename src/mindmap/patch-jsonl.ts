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
 * @param action - The patch action to append
 * @param patchPath - Path to the JSONL file
 */
export function appendPatch(action: MindmapPatchAction, patchPath: string): void {
  const dir = path.dirname(patchPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(patchPath, `${JSON.stringify(action)}\n`, 'utf-8');
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
      if (parsed && typeof parsed.action === 'string' && typeof parsed.path === 'string') {
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
 * @param actions - The patch actions to write (in order)
 * @param patchPath - Path to the JSONL file
 */
export function writePatches(actions: MindmapPatchAction[], patchPath: string): void {
  const dir = path.dirname(patchPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = actions.map((a) => JSON.stringify(a)).join('\n');
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