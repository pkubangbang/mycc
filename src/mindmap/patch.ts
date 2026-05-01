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
import { get_node, get_ancestors, get_descendants } from './get-node.js';
import { generate_summary } from './compile.js';

/**
 * Patch a node in the mindmap with new text
 * @param mindmap - The mindmap to modify
 * @param id - The node id to update
 * @param newText - The new text content
 * @param feedback - Optional feedback to incorporate
 * @returns The updated node, or null if not found
 */
export function patch_mindmap(
  mindmap: Mindmap,
  id: string,
  newText: string,
  feedback?: string
): Node | null {
  // Find the target node
  const targetNode = get_node(mindmap, id);
  if (!targetNode) {
    return null;
  }
  
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
      const siblingSummaries = parent.children
        .filter(c => c.id !== desc.id)
        .map(c => c.summary)
        .filter(s => s);
      
      desc.summary = generate_summary(
        [parent.text],
        desc.text,
        siblingSummaries
      );
    }
  }
  
  // Step 2: Update target node's summary
  const childSummaries = targetNode.children.map(c => c.summary).filter(s => s);
  const ancestorTexts = ancestors.map(a => a.text);
  
  targetNode.summary = generate_summary(
    ancestorTexts,
    targetNode.text,
    childSummaries,
    feedback // Pass feedback as agent behavior context
  );
  
  // Step 3: Update ancestors' summaries bottom-up (from deepest to root)
  // Reverse to get from target's parent to root
  const ancestorsToUpdates = [...ancestors].reverse();
  
  for (const ancestor of ancestorsToUpdates) {
    const ancestorChildSummaries = ancestor.children.map(c => c.summary).filter(s => s);
    const ancestorAncestors = get_ancestors(mindmap, ancestor.id);
    const ancestorAncestorTexts = ancestorAncestors.map(a => a.text);
    
    ancestor.summary = generate_summary(
      ancestorAncestorTexts,
      ancestor.text,
      ancestorChildSummaries
    );
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
export function summarize_node(mindmap: Mindmap, id: string): string | null {
  const node = get_node(mindmap, id);
  if (!node) {
    return null;
  }
  
  const ancestors = get_ancestors(mindmap, id);
  const childSummaries = node.children.map(c => c.summary).filter(s => s);
  const ancestorTexts = ancestors.map(a => a.text);
  
  node.summary = generate_summary(
    ancestorTexts,
    node.text,
    childSummaries
  );
  
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
export function add_child_node(
  mindmap: Mindmap,
  parentId: string,
  title: string,
  text: string = ''
): Node | null {
  const parent = get_node(mindmap, parentId);
  if (!parent) {
    return null;
  }
  
  const id = parentId === '/' ? `/${title}` : `${parentId}/${title}`;
  
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
  const ancestorTexts = ancestors.map(a => a.text);
  newNode.summary = generate_summary(ancestorTexts, text, []);
  
  parent.children.push(newNode);
  
  // Update parent summary
  const childSummaries = parent.children.map(c => c.summary).filter(s => s);
  const parentAncestors = get_ancestors(mindmap, parentId);
  const parentAncestorTexts = parentAncestors.map(a => a.text);
  
  parent.summary = generate_summary(parentAncestorTexts, parent.text, childSummaries);
  
  mindmap.updated_at = new Date().toISOString();
  
  return newNode;
}

/**
 * Remove a node from the mindmap
 * @param mindmap - The mindmap to modify
 * @param id - The node id to remove
 * @returns true if removed, false if not found or is root
 */
export function remove_node(mindmap: Mindmap, id: string): boolean {
  if (id === '/' || id === '') {
    return false; // Cannot remove root
  }
  
  // Get parent
  const segments = id.split('/').filter(s => s.length > 0);
  const parentPath = `/${segments.slice(0, -1).join('/')}`;
  const nodeTitle = segments[segments.length - 1];
  
  const parent = get_node(mindmap, parentPath);
  if (!parent) {
    return false;
  }
  
  // Find and remove the child
  const index = parent.children.findIndex(
    c => c.title.toLowerCase() === nodeTitle.toLowerCase()
  );
  
  if (index === -1) {
    return false;
  }
  
  parent.children.splice(index, 1);
  
  // Update parent summary
  const childSummaries = parent.children.map(c => c.summary).filter(s => s);
  const parentAncestors = get_ancestors(mindmap, parentPath);
  const parentAncestorTexts = parentAncestors.map(a => a.text);
  
  parent.summary = generate_summary(parentAncestorTexts, parent.text, childSummaries);
  
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
export function move_node(
  mindmap: Mindmap,
  nodeId: string,
  newParentId: string
): Node | null {
  const node = get_node(mindmap, nodeId);
  const newParent = get_node(mindmap, newParentId);
  
  if (!node || !newParent) {
    return null;
  }
  
  if (nodeId === '/' || nodeId === '') {
    return null; // Cannot move root
  }
  
  // Get current parent
  const segments = nodeId.split('/').filter(s => s.length > 0);
  const oldParentPath = `/${segments.slice(0, -1).join('/')}`;
  const oldParent = get_node(mindmap, oldParentPath);
  
  if (!oldParent) {
    return null;
  }
  
  // Remove from old parent
  const nodeTitle = segments[segments.length - 1];
  const index = oldParent.children.findIndex(
    c => c.title.toLowerCase() === nodeTitle.toLowerCase()
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
  update_summaries_after_move(mindmap, oldParent);
  update_summaries_after_move(mindmap, newParent);
  
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
function update_summaries_after_move(mindmap: Mindmap, node: Node): void {
  const ancestors = get_ancestors(mindmap, node.id);
  const ancestorTexts = ancestors.map(a => a.text);
  const childSummaries = node.children.map(c => c.summary).filter(s => s);
  
  node.summary = generate_summary(ancestorTexts, node.text, childSummaries);
}
