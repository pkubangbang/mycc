/**
 * patch.ts - Update mindmap nodes with cascading summaries
 * @see docs/mindmap-design.md
 *
 * Patch process:
 * 1. Find the target node by id
 * 2. Update the node's text (and optionally incorporate feedback)
 * 3. Update descendants' summaries bottom-up
 * 4. Update ancestors' summaries bottom-up (from deepest to root)
 * 5. Return the updated node
 */

import type { Mindmap, Node } from './types.js';
import type { MindmapPatchAction, Link } from './types.js';
import { get_node, get_ancestors, get_descendants } from './get-node.js';
import { safeNodeId } from '../utils/sanitize.js';
import { summarizeWithExplorer } from './explorer-agent.js';

/**
 * Patch a node in the mindmap with new text
 * @param mindmap - The mindmap to modify
 * @param id - The node id to update
 * @param newText - The new text content
 * @param feedback - Optional feedback to incorporate
 * @returns The updated node, or null if not found
 */
export async function patch_mindmap(
  mindmap: Mindmap,
  id: string,
  newText: string,
  feedback?: string
): Promise<Node | null> {
  // Find the target node
  const targetNode = get_node(mindmap, id);
  if (!targetNode) {
    return null;
  }

  // Get workDir from mindmap
  const workDir = mindmap.dir;

  // Update the node's text
  targetNode.text = feedback
    ? `${newText}\n\n<!-- Feedback: ${feedback} -->`
    : newText;

  // Get all descendants (for bottom-up summary update)
  const descendants = get_descendants(targetNode);

  // Get all ancestors (for top-down summary update)
  const ancestors = get_ancestors(mindmap, id);

  // Step 1: Update descendant summaries bottom-up
  // Sort by level (deepest first)
  descendants.sort((a, b) => b.level - a.level);

  for (const desc of descendants) {
    // Get parent for context
    const parentPath = desc.id.split('/').slice(0, -1).join('/') || '/';
    const parent = get_node(mindmap, parentPath);

    if (parent) {
      const ancestorContext = parent.text;
      const result = await summarizeWithExplorer(
        desc.title,
        desc.text,
        ancestorContext,
        workDir
      );
      desc.summary = result.summary;
    }
  }

  // Step 2: Update target node's summary
  const ancestorTexts = ancestors.map((a) => a.text).join('\n\n---\n\n');
  const targetResult = await summarizeWithExplorer(
    targetNode.title,
    targetNode.text,
    ancestorTexts,
    workDir
  );
  targetNode.summary = targetResult.summary;

  // Step 3: Update ancestors' summaries bottom-up (from deepest to root)
  // Reverse to get from target's parent to root
  const ancestorsToUpdates = [...ancestors].reverse();

  for (const ancestor of ancestorsToUpdates) {
    const ancestorAncestors = get_ancestors(mindmap, ancestor.id);
    const ancestorAncestorTexts = ancestorAncestors
      .map((a) => a.text)
      .join('\n\n---\n\n');

    const ancestorResult = await summarizeWithExplorer(
      ancestor.title,
      ancestor.text,
      ancestorAncestorTexts,
      workDir
    );
    ancestor.summary = ancestorResult.summary;
  }

  // Update modification timestamp
  mindmap.updated_at = new Date().toISOString();

  return targetNode;
}

/**
 * Update just a node's summary (no text change)
 * @param mindmap - The mindmap to modify
 * @param id - The node id to summarize
 * @returns The updated summary, or null if not found
 */
export async function summarize_node(mindmap: Mindmap, id: string): Promise<string | null> {
  const node = get_node(mindmap, id);
  if (!node) {
    return null;
  }

  const ancestors = get_ancestors(mindmap, id);
  const ancestorTexts = ancestors.map((a) => a.text).join('\n\n---\n\n');
  const workDir = mindmap.dir;

  const result = await summarizeWithExplorer(
    node.title,
    node.text,
    ancestorTexts,
    workDir
  );
  node.summary = result.summary;

  mindmap.updated_at = new Date().toISOString();

  return node.summary;
}

/**
 * Add a child node to a parent
 * @param mindmap - The mindmap to modify
 * @param parentId - The parent node id
 * @param title - The new node's title
 * @param text - The new node's text
 * @returns The new child node, or null if parent not found
 */
export async function add_child_node(
  mindmap: Mindmap,
  parentId: string,
  title: string,
  text: string = ''
): Promise<Node | null> {
  const parent = get_node(mindmap, parentId);
  if (!parent) {
    return null;
  }

  const id = parentId === '/' ? `/${title}` : `${parentId}/${title}`;
  const workDir = mindmap.dir;

  const newNode: Node = {
    id,
    title,
    text,
    summary: '',
    level: parent.level + 1,
    children: [],
    links: [],
  };

  // Generate initial summary
  const ancestors = get_ancestors(mindmap, id);
  const ancestorTexts = ancestors.map((a) => a.text).join('\n\n---\n\n');
  const newResult = await summarizeWithExplorer(title, text, ancestorTexts, workDir);
  newNode.summary = newResult.summary;

  parent.children.push(newNode);

  // Update parent summary
  const parentAncestors = get_ancestors(mindmap, parentId);
  const parentAncestorTexts = parentAncestors.map((a) => a.text).join('\n\n---\n\n');
  const parentResult = await summarizeWithExplorer(
    parent.title,
    parent.text,
    parentAncestorTexts,
    workDir
  );
  parent.summary = parentResult.summary;

  mindmap.updated_at = new Date().toISOString();

  return newNode;
}

/**
 * Remove a node from the mindmap
 * @param mindmap - The mindmap to modify
 * @param id - The node id to remove
 * @returns true if removed, false if not found or is root
 */
export async function remove_node(mindmap: Mindmap, id: string): Promise<boolean> {
  if (id === '/' || id === '') {
    return false; // Cannot remove root
  }

  // Get parent
  const segments = id.split('/').filter((s) => s.length > 0);
  const parentPath = `/${segments.slice(0, -1).join('/')}`;
  const nodeTitle = segments[segments.length - 1];

  const parent = get_node(mindmap, parentPath);
  if (!parent) {
    return false;
  }

  // Find and remove the child. Match by normalized id (safeNodeId of the
  // child's title) — the canonical addressing scheme is the normalized id,
  // NOT the raw title (see get-node.ts findChild). A bare toLowerCase title
  // comparison fails for any title with spaces/special chars: path segment
  // "code-cleanup" never equals raw title "Code Cleanup" lowercased to
  // "code cleanup", so the delete silently no-ops.
  const index = parent.children.findIndex(
    (c) => safeNodeId(c.title) === nodeTitle
  );

  if (index === -1) {
    return false;
  }

  parent.children.splice(index, 1);

  // Update parent summary
  const workDir = mindmap.dir;
  const parentAncestors = get_ancestors(mindmap, parentPath);
  const parentAncestorTexts = parentAncestors.map((a) => a.text).join('\n\n---\n\n');
  const parentResult = await summarizeWithExplorer(
    parent.title,
    parent.text,
    parentAncestorTexts,
    workDir
  );
  parent.summary = parentResult.summary;

  mindmap.updated_at = new Date().toISOString();

  return true;
}

/**
 * Move a node to a new parent
 * @param mindmap - The mindmap to modify
 * @param nodeId - The node to move
 * @param newParentId - The new parent's id
 * @returns The moved node, or null if not found
 */
export async function move_node(
  mindmap: Mindmap,
  nodeId: string,
  newParentId: string
): Promise<Node | null> {
  const node = get_node(mindmap, nodeId);
  const newParent = get_node(mindmap, newParentId);

  if (!node || !newParent) {
    return null;
  }

  if (nodeId === '/' || nodeId === '') {
    return null; // Cannot move root
  }

  // Get current parent
  const segments = nodeId.split('/').filter((s) => s.length > 0);
  const oldParentPath = `/${segments.slice(0, -1).join('/')}`;
  const oldParent = get_node(mindmap, oldParentPath);

  if (!oldParent) {
    return null;
  }

  // Remove from old parent. Match by normalized id (safeNodeId of the
  // child's title), NOT the raw title — the canonical addressing scheme is
  // the normalized id (see get-node.ts findChild). A bare toLowerCase title
  // comparison fails for spaced/special-char titles and makes the move a
  // silent no-op.
  const nodeTitle = segments[segments.length - 1];
  const index = oldParent.children.findIndex(
    (c) => safeNodeId(c.title) === nodeTitle
  );

  if (index === -1) {
    return null;
  }

  oldParent.children.splice(index, 1);

  // Update node's id and level
  const newId = newParentId === '/' ? `/${nodeTitle}` : `${newParentId}/${nodeTitle}`;
  update_node_ids(node, newId, newParent.level + 1);

  // Add to new parent
  newParent.children.push(node);

  // Update summaries
  await update_summaries_after_move(mindmap, oldParent);
  await update_summaries_after_move(mindmap, newParent);

  mindmap.updated_at = new Date().toISOString();

  return node;
}

/**
 * Update node IDs recursively after a move
 */
function update_node_ids(node: Node, newId: string, newLevel: number): void {
  node.id = newId;
  node.level = newLevel;

  for (const child of node.children) {
    const childId = `${newId}/${child.title}`;
    update_node_ids(child, childId, newLevel + 1);
  }
}

/**
 * Update summaries after a node move
 */
async function update_summaries_after_move(
  mindmap: Mindmap,
  node: Node
): Promise<void> {
  const ancestors = get_ancestors(mindmap, node.id);
  const ancestorTexts = ancestors.map((a) => a.text).join('\n\n---\n\n');
  const workDir = mindmap.dir;

  const result = await summarizeWithExplorer(
    node.title,
    node.text,
    ancestorTexts,
    workDir
  );
  node.summary = result.summary;
}

/**
 * Apply a single patch action to the in-memory mindmap tree (pure, no LLM).
 *
 * Sets in-memory flags:
 * - add: new node gets is_mycc=false, is_patch=true
 * - update: target node gets is_patch=true (is_mycc preserved), summary cleared
 * - delete: node removed from parent's children
 *
 * @param mindmap - The in-memory mindmap to modify
 * @param action - The patch action to apply
 * @returns true if applied successfully, false if target not found or invalid
 */
export function applyPatchAction(mindmap: Mindmap, action: MindmapPatchAction): boolean {
  switch (action.action) {
    case 'add': {
      const parent = get_node(mindmap, action.path);
      if (!parent) return false;
      if (!action.title || !action.text) return false;

      const id = parent.id === '/'
        ? `/${safeNodeId(action.title)}`
        : `${parent.id}/${safeNodeId(action.title)}`;

      // Idempotency: if a child with this id already exists, skip the push.
      // loadMindmapWithPatches replays all JSONL patch lines on every load
      // with no dedup, so a duplicate 'add' line (e.g. from a crash during
      // rebuildPatches, or a re-run of a patch command) would create a
      // duplicate node — self-amplifying on the next rebuildPatches until a
      // manual /mindmap compile. Treating a duplicate add as a no-op makes
      // replay safe.
      if (parent.children.some(c => c.id === id)) return true;

      const newNode: Node = {
        id,
        title: action.title,
        text: action.text,
        summary: '',
        level: parent.level + 1,
        children: [],
        // Replay optional outbound links from the patch action so patch-added
        // nodes can carry term/file/url/node links. Most importantly, `term`
        // links are hoisted by recall's collectDescendantTerms to the root
        // "Key Terms" list — this is how patch-added terminology surfaces at
        // runtime without recompiling MYCC.md. Filter to well-formed Link
        // objects (defensive: a malformed links array must not poison the tree).
        links: sanitizeLinks(action.links),
        is_mycc: false,  // patch-added, not from MYCC.md
        is_patch: true,  // marked as patch-touched
      };

      parent.children.push(newNode);
      mindmap.updated_at = new Date().toISOString();
      return true;
    }

    case 'update': {
      const node = get_node(mindmap, action.path);
      if (!node) return false;
      if (action.path === '/' || action.path === '') return false;  // cannot update root
      if (!action.text) return false;

      node.text = action.text;
      node.summary = '';  // clear — re-summarized on next compile if is_mycc
      node.is_patch = true;  // mark as patch-modified
      // is_mycc is preserved — an is_mycc node that's patched is still is_mycc
      mindmap.updated_at = new Date().toISOString();
      return true;
    }

    case 'delete': {
      if (action.path === '/' || action.path === '') return false;  // cannot delete root

      const segments = action.path.split('/').filter((s) => s.length > 0);
      if (segments.length === 0) return false;

      const parentPath = `/${segments.slice(0, -1).join('/')}`;
      const nodeTitle = segments[segments.length - 1];

      const parent = get_node(mindmap, parentPath);
      if (!parent) return false;

      // Match by normalized id (safeNodeId of the child's title), NOT the raw
      // title — the canonical addressing scheme is the normalized id (see
      // get-node.ts findChild). A bare toLowerCase title comparison fails for
      // spaced/special-char titles and makes the delete a silent no-op.
      const index = parent.children.findIndex(
        (c) => safeNodeId(c.title) === nodeTitle
      );
      if (index === -1) return false;

      parent.children.splice(index, 1);
      mindmap.updated_at = new Date().toISOString();
      return true;
    }

    default:
      return false;
  }
}

/**
 * Sanitize an optional `links` array from a patch action into well-formed
 * `Link` objects before attaching it to a new node.
 *
 * Defensive: a malformed `links` entry (wrong type, missing target fields,
 * or non-string scalars) is dropped rather than poisoning the tree. Only
 * entries with a valid `target_type` and the corresponding target field
 * survive. `comment` defaults to '' (Link.comment is a required string).
 *
 * This is the single gateway through which patch-sourced links enter the
 * in-memory tree — it is the reason recall's collectDescendantTerms can
 * hoist patch-added `term` links to the root "Key Terms" list at runtime.
 */
function sanitizeLinks(links: Link[] | undefined): Link[] {
  if (!Array.isArray(links)) return [];
  const validTypes = new Set<Link['target_type']>(['node', 'file', 'url', 'term']);
  const out: Link[] = [];
  for (const l of links) {
    if (!l || typeof l !== 'object') continue;
    if (!validTypes.has(l.target_type)) continue;
    const comment = typeof l.comment === 'string' ? l.comment : '';
    switch (l.target_type) {
      case 'node':
        if (typeof l.node_id === 'string' && l.node_id.length > 0)
          out.push({ target_type: 'node', node_id: l.node_id, comment });
        break;
      case 'file':
        if (typeof l.file_path === 'string' && l.file_path.length > 0)
          out.push({ target_type: 'file', file_path: l.file_path, comment });
        break;
      case 'url':
        if (typeof l.url === 'string' && l.url.length > 0)
          out.push({ target_type: 'url', url: l.url, comment });
        break;
      case 'term':
        if (typeof l.term_name === 'string' && l.term_name.length > 0)
          out.push({ target_type: 'term', term_name: l.term_name, comment });
        break;
    }
  }
  return out;
}