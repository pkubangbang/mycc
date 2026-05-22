/**
 * diff-mindmap.ts - Incremental mindmap compilation via diff
 *
 * Compares old and new node trees to find changes, then re-summarizes
 * only the nodes that need updating using bottom-up traversal.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Node, MindmapJSON } from './types.js';
import { compute_hash } from './validate.js';
import { parse_markdown, build_node, extract_links, collect_nodes_bottom_up, ProgressTracker } from './compile-utils.js';
import { get_node, get_ancestors } from './get-node.js';
import { remove_node } from './patch.js';
import { summarizeWithExplorer } from './explorer-agent.js';

/**
 * Result of diffing old and new node trees
 */
export interface DiffResult {
  /** Nodes that exist in new but not in old */
  added: Map<string, Node>;
  /** IDs of nodes that exist in old but not in new */
  removed: Set<string>;
  /** Nodes where text differs between old and new */
  textChanged: Map<string, Node>;
}

/**
 * Build a map of nodes by ID for quick lookup
 */
function build_node_map(node: Node, map: Map<string, Node>): void {
  map.set(node.id, node);
  for (const child of node.children) {
    build_node_map(child, map);
  }
}

/**
 * Compare old and new node trees to find differences
 * @param oldRoot - Root of existing mindmap
 * @param newRoot - Root of newly parsed markdown
 * @returns DiffResult with added, removed, and changed nodes
 */
export function diff_nodes(oldRoot: Node, newRoot: Node): DiffResult {
  const result: DiffResult = {
    added: new Map(),
    removed: new Set(),
    textChanged: new Map(),
  };

  const oldMap = new Map<string, Node>();
  build_node_map(oldRoot, oldMap);

  const newMap = new Map<string, Node>();
  build_node_map(newRoot, newMap);

  // Find removed nodes
  for (const [id] of oldMap) {
    if (!newMap.has(id)) {
      result.removed.add(id);
    }
  }

  // Find added and changed nodes
  for (const [id, newNode] of newMap) {
    const oldNode = oldMap.get(id);
    if (!oldNode) {
      result.added.set(id, newNode);
    } else if (oldNode.text !== newNode.text) {
      result.textChanged.set(id, newNode);
    }
  }

  return result;
}

/**
 * Insert a node into the tree at its parent
 * @param mindmap - The mindmap to modify
 * @param node - The node to insert
 * @returns true if inserted successfully
 */
function insert_node(mindmap: MindmapJSON, node: Node): boolean {
  // Find parent from node.id (e.g., "/parent/child" -> parent is "/parent")
  const lastSlash = node.id.lastIndexOf('/');
  const parentId = lastSlash === 0 ? '/' : node.id.substring(0, lastSlash);

  const parent = get_node(mindmap, parentId);
  if (!parent) {
    return false;
  }

  parent.children.push(node);
  return true;
}

/**
 * Build root node from parsed sections
 */
function build_root_node(sections: ReturnType<typeof parse_markdown>, preamble: string, fileName: string): Node {
  return {
    id: '/',
    text: preamble,
    title: fileName,
    summary: '',
    level: 0,
    children: sections.map((s) => build_node(s, '/', 1)),
    links: extract_links(preamble),
  };
}

/**
 * Incrementally compile mindmap by re-summarizing only changed nodes
 *
 * Algorithm:
 * 1. Parse new markdown
 * 2. Diff old and new trees to find changes
 * 3. Apply removals and additions
 * 4. Update text for changed nodes (clear links for re-validation)
 * 5. Bottom-up traversal: mark nodes needing update
 * 6. Re-summarize marked nodes (links populated by LLM's mark_* tools)
 * 7. Update metadata
 *
 * @param mdPath - Path to markdown file
 * @param existingMindmap - Existing compiled mindmap
 * @param workDir - Working directory
 * @param outPath - Output file path for atomic save
 * @returns Updated mindmap
 */
export async function incremental_compile(
  mdPath: string,
  existingMindmap: MindmapJSON,
  workDir: string,
  outPath?: string
): Promise<MindmapJSON> {
  const absolutePath = path.resolve(workDir, mdPath);
  const content = fs.readFileSync(absolutePath, 'utf-8');

  // 1. Parse new markdown
  const sections = parse_markdown(content);
  const firstHeadingMatch = content.match(/^#{1,6}\s+/m);
  const preamble = firstHeadingMatch
    ? content.slice(0, content.indexOf(firstHeadingMatch[0])).trim()
    : content.trim();
  const fileName = path.basename(absolutePath, path.extname(absolutePath));
  const newRoot = build_root_node(sections, preamble, fileName);

  // 2. Diff old and new
  const diff = diff_nodes(existingMindmap.root, newRoot);

  // 3. Handle removals
  for (const id of diff.removed) {
    remove_node(existingMindmap, id);
  }

  // 4. Handle additions
  for (const [_id, newNode] of diff.added) {
    insert_node(existingMindmap, newNode);
  }

  // 5. Update text for changed nodes and clear links (LLM will re-validate)
  for (const [_id, newNode] of diff.textChanged) {
    const oldNode = get_node(existingMindmap, _id);
    if (oldNode) {
      oldNode.text = newNode.text;
      oldNode.links = []; // Clear links - LLM will re-validate via mark_* during exploration
    }
  }

  // 5b. Clear links for added nodes (will be populated during summarization)
  for (const [_id, newNode] of diff.added) {
    newNode.links = []; // Links populated during summarization
  }

  // 6. Single bottom-up traversal with propagation
  //    Track which nodes need re-summarizing
  const needsUpdate = new Set<string>();

  // First pass: mark nodes that need update (bottom-up ensures children processed first)
  const allNodes = collect_nodes_bottom_up(existingMindmap.root);

  for (const node of allNodes) {
    // Check if text changed or added, or if any child was removed
    const textChanged = diff.textChanged.has(node.id) || diff.added.has(node.id);
    const childRemoved = Array.from(diff.removed).some(removedId => {
      return removedId.startsWith(`${node.id}/`) && 
             (removedId.split('/').length === node.id.split('/').length + 1);
    });

    // Check if any child needs update
    const childNeedsUpdate = node.children.some((child) => needsUpdate.has(child.id));

    if (textChanged || childRemoved || childNeedsUpdate) {
      needsUpdate.add(node.id);
    }
  }

  // Count nodes needing update for progress
  const nodesToUpdate = allNodes.filter((n) => needsUpdate.has(n.id));
  const totalNodes = nodesToUpdate.length;

  console.log(`[mindmap] Incremental: ${totalNodes} nodes need update (${diff.textChanged.size} changed, ${diff.added.size} added, ${diff.removed.size} removed)`);

  // Progress tracking
  const tracker = new ProgressTracker(totalNodes, 3);

  // Print initial empty lines for progress display
  process.stdout.write('\n\n\n\n');

  // Second pass: re-summarize nodes that need it
  let processedCount = 0;
  for (const node of allNodes) {
    if (needsUpdate.has(node.id)) {
      tracker.onNodeStart(node.title);

      const ancestors = get_ancestors(existingMindmap, node.id);
      const ancestorTexts = ancestors.map((a) => a.text).join('\n\n---\n\n');

      // Create progress callback that wraps tracker with node info
      const onProgress = (round: number, tool: string, args: Record<string, unknown>) => {
        tracker.onProgress(node.title, node.level, round, tool, args);
      };

      const result = await summarizeWithExplorer(node.title, node.text, ancestorTexts, workDir, onProgress);

      node.summary = result.summary;

      // Add marked files/URLs as links (LLM validated via mark_* tools)
      for (const item of result.markedFiles) {
        node.links.push({
          target_type: 'file',
          file_path: item.path,
          comment: item.reason || 'Discovered during exploration',
        });
      }
      for (const item of result.markedUrls) {
        node.links.push({
          target_type: 'url',
          url: item.path,
          comment: item.reason || 'Discovered during exploration',
        });
      }
      for (const item of result.markedTerms) {
        node.links.push({
          target_type: 'term',
          term_name: item.term,
          comment: item.context || 'Project-specific term',
        });
      }

      tracker.onNodeComplete(node.title);
      processedCount++;

      // Save progress
      if (outPath) {
        existingMindmap.updated_at = new Date().toISOString();
        save_mindmap_atomic(existingMindmap, outPath);
      }
    }
  }

  // Clean up progress display
  tracker.finish();
  process.stdout.write('\x1b[4A\x1b[J');

  // 7. Update metadata and persist to disk
  existingMindmap.hash = compute_hash(content);
  existingMindmap.updated_at = new Date().toISOString();

  if (outPath) {
    save_mindmap_atomic(existingMindmap, outPath);
  }

  console.log(`[mindmap] Completed ${processedCount} nodes`);
  return existingMindmap;
}

/**
 * Save mindmap atomically (copy-on-write)
 * Writes to temp file first, then renames to ensure concurrent readers see valid data
 * @param mindmap - The mindmap to save
 * @param outPath - Output file path
 */
export function save_mindmap_atomic(mindmap: MindmapJSON, outPath: string): void {
  const tempPath = `${outPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(mindmap, null, 2));
  fs.renameSync(tempPath, outPath);
}