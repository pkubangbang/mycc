/**
 * get-node.ts - Tree traversal for mindmap nodes
 * @see docs/mindmap-design.md
 */

import type { Mindmap, Node, GetNodeResult } from './types.js';
import { safeNodeId } from '../utils/sanitize.js';

/**
 * Resolve a path segment to a child node.
 *
 * Node ids are built from `safeNodeId(title)` during compile (compile-utils.ts)
 * and patch replay (patch.ts `add` branch), so the canonical addressing scheme
 * is the normalized id, NOT the raw title. Matching against the raw title
 * breaks when a title contains spaces or special chars (e.g. "Code Cleanup"
 * → id "code-cleanup"): a path segment "code-cleanup" would never equal
 * "Code Cleanup". This helper normalizes each child's title the same way ids
 * are constructed and compares against the segment, keeping traversal
 * consistent with id construction.
 */
function findChild(parent: Node, segment: string): Node | undefined {
  return parent.children.find(c => safeNodeId(c.title) === segment);
}

/**
 * Get a node from the mindmap by its path (id)
 * @param mindmap - The mindmap to search
 * @param id - The slash-separated path (e.g., "/skill/example")
 * @returns The node if found, null otherwise
 */
export function get_node(mindmap: Mindmap, id: string): Node | null {
  // Handle root node
  if (id === '/' || id === '') {
    return mindmap.root;
  }

  // Parse the path into segments
  const segments = id.split('/').filter(s => s.length > 0);
  
  // Traverse from root
  let current: Node = mindmap.root;
  
  for (const segment of segments) {
    // Match by normalized id (safeNodeId of the child's title)
    const child = findChild(current, segment);
    
    if (!child) {
      return null; // Path not found
    }
    
    current = child;
  }
  
  return current;
}

/**
 * Get a node result with detailed path information
 * @param mindmap - The mindmap to search
 * @param id - The slash-separated path
 * @returns GetNodeResult with node, path, and optional error
 */
export function get_node_result(mindmap: Mindmap, id: string): GetNodeResult {
  const path: string[] = [];
  
  // Handle root node
  if (id === '/' || id === '') {
    return {
      node: mindmap.root,
      path: ['/'],
    };
  }

  // Parse the path into segments
  const segments = id.split('/').filter(s => s.length > 0);
  
  // Traverse from root
  let current: Node = mindmap.root;
  path.push('/');
  
  for (const segment of segments) {
    const child = findChild(current, segment);
    
    if (!child) {
      return {
        node: null,
        path,
        error: `Node not found at path: ${id} (missing: ${segment})`,
      };
    }
    
    current = child;
    path.push(current.id);
  }
  
  return {
    node: current,
    path,
  };
}

/**
 * Get all ancestors of a node
 * @param mindmap - The mindmap to search
 * @param id - The node id
 * @returns Array of ancestor nodes from root to parent, or empty if not found
 */
export function get_ancestors(mindmap: Mindmap, id: string): Node[] {
  if (id === '/' || id === '') {
    return []; // Root has no ancestors
  }

  const segments = id.split('/').filter(s => s.length > 0);
  const ancestors: Node[] = [];
  
  let current: Node = mindmap.root;
  ancestors.push(current);
  
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const child = findChild(current, segment);
    
    if (!child) {
      return []; // Path not found
    }
    
    current = child;
    ancestors.push(current);
  }
  
  return ancestors;
}

/**
 * Get all descendants of a node (recursive)
 * @param node - The starting node
 * @returns Flat array of all descendant nodes
 */
export function get_descendants(node: Node): Node[] {
  const descendants: Node[] = [];
  
  function collect(n: Node) {
    for (const child of n.children) {
      descendants.push(child);
      collect(child);
    }
  }
  
  collect(node);
  return descendants;
}

/**
 * Get all descendants at a specific depth
 * @param node - The starting node
 * @param depth - Number of levels to go down (1 = direct children)
 * @returns Array of nodes at the specified depth
 */
export function get_descendants_at_depth(node: Node, depth: number): Node[] {
  if (depth <= 0) {
    return [node];
  }
  
  if (depth === 1) {
    return [...node.children];
  }
  
  const result: Node[] = [];
  for (const child of node.children) {
    result.push(...get_descendants_at_depth(child, depth - 1));
  }
  
  return result;
}
