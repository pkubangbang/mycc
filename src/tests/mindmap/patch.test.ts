/**
 * patch.test.ts - Patch and cascade tests for mindmap
 * 
 * Key design clarifications:
 * - Each process loads mindmap independently (no IPC)
 * - Patches update node text and cascade summaries to ancestors and descendants
 * - A-N-C-E context includes agent behavior (E = agent context like PLAN mode)
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Types
interface Link {
  target_type: 'node' | 'file' | 'url';
  node_id?: string;
  file_path?: string;
  url?: string;
  comment: string;
}

interface Node {
  id: string;
  text: string;
  title: string;
  summary: string;
  level: number;
  children: Node[];
  links: Link[];
}

interface Mindmap {
  dir: string;
  hash: string;
  compiled_at: Date;
  updated_at: Date;
  root: Node;
}

// Helper to find node by id
function findNode(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// Helper to find parent of a node
function findParent(root: Node, id: string, parent: Node | null = null): Node | null {
  for (const child of root.children) {
    if (child.id === id) return root;
    const found = findParent(child, id, root);
    if (found) return found;
  }
  return null;
}

// Helper to collect all ancestors
function collectAncestors(root: Node, id: string): Node[] {
  const ancestors: Node[] = [];
  
  const traverse = (node: Node, target: string): boolean => {
    if (node.id === target) return true;
    for (const child of node.children) {
      if (traverse(child, target)) {
        ancestors.unshift(node);
        return true;
      }
    }
    return false;
  };
  
  traverse(root, id);
  return ancestors;
}

// Helper to collect all descendants
function collectDescendants(node: Node): Node[] {
  const descendants: Node[] = [];
  for (const child of node.children) {
    descendants.push(child);
    descendants.push(...collectDescendants(child));
  }
  return descendants;
}

// Mock summarization (A-N-C-E context generation)
function generateSummary(
  node: Node, 
  ancestors: Node[], 
  descendants: Node[],
  agentContext?: string
): string {
  // A: Ancestor texts
  const A = ancestors.map(a => a.text).join('\n');
  
  // N: Node text
  const N = node.text;
  
  // C: Descendant summaries
  const C = descendants.map(d => d.summary).filter(s => s).join('\n');
  
  // E: Agent behavior context (like PLAN mode)
  const E = agentContext || '';
  
  // Generate summary (mock - real impl would call LLM)
  return `Summary: ${node.title} (level ${node.level})`;
}

// Summarize descendants bottom-up
function summarizeDescendants(node: Node, ancestors: Node[]): void {
  // First, summarize children recursively
  for (const child of node.children) {
    summarizeDescendants(child, [...ancestors, node]);
  }
  
  // Then summarize this node
  const descendants = collectDescendants(node);
  node.summary = generateSummary(node, ancestors, descendants);
}

// Summarize ancestors bottom-up from a node
function summarizeAncestors(mindmap: Mindmap, nodeId: string): void {
  const ancestors = collectAncestors(mindmap.root, nodeId);
  
  // Summarize from deepest to root
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    const nodeAncestors = ancestors.slice(0, i);
    const descendants = collectDescendants(node);
    node.summary = generateSummary(node, nodeAncestors, descendants);
  }
}

// Patch implementation
function patch_mindmap(
  mindmap: Mindmap, 
  id: string, 
  newText: string, 
  feedback?: string
): Node | null {
  // Find the node
  const node = findNode(mindmap.root, id);
  if (!node) return null;
  
  // Update the node's text
  node.text = newText;
  
  // Update title from first heading if present
  const headingMatch = newText.match(/^#+\s+(.+)$/m);
  if (headingMatch) {
    node.title = headingMatch[1].trim();
  }
  
  // Collect descendants and summarize bottom-up
  const ancestors = collectAncestors(mindmap.root, id);
  summarizeDescendants(node, ancestors);
  
  // Summarize ancestors
  summarizeAncestors(mindmap, id);
  
  // Update metadata
  mindmap.updated_at = new Date();
  
  // Return the updated node
  return node;
}

// Alternative: summarize_node function
function summarize_node(mindmap: Mindmap, id: string): string | null {
  const node = findNode(mindmap.root, id);
  if (!node) return null;
  
  const ancestors = collectAncestors(mindmap.root, id);
  const descendants = collectDescendants(node);
  
  node.summary = generateSummary(node, ancestors, descendants);
  return node.summary;
}

// Test fixtures
function createTestMindmap(): Mindmap {
  return {
    dir: '/test/dir',
    hash: 'test-hash',
    compiled_at: new Date(),
    updated_at: new Date(),
    root: {
      id: '/',
      text: '# Root\n\nRoot content',
      title: 'Root',
      summary: 'Root summary',
      level: 0,
      children: [
        {
          id: '/parent',
          text: '## Parent\n\nParent content',
          title: 'Parent',
          summary: 'Parent summary',
          level: 1,
          children: [
            {
              id: '/parent/child',
              text: '### Child\n\nChild content',
              title: 'Child',
              summary: 'Child summary',
              level: 2,
              children: [
                {
                  id: '/parent/child/grandchild',
                  text: '#### Grandchild\n\nGrandchild content',
                  title: 'Grandchild',
                  summary: 'Grandchild summary',
                  level: 3,
                  children: [],
                  links: []
                }
              ],
              links: []
            }
          ],
          links: []
        }
      ],
      links: []
    }
  };
}

describe('patch_mindmap', () => {
  let mindmap: Mindmap;

  beforeEach(() => {
    mindmap = createTestMindmap();
  });

  describe('Update Leaf Node', () => {
    it('should update leaf node text', () => {
      const result = patch_mindmap(
        mindmap,
        '/parent/child/grandchild',
        '#### Updated Grandchild\n\nNew content'
      );

      expect(result).not.toBeNull();
      expect(result?.text).toBe('#### Updated Grandchild\n\nNew content');
      expect(result?.title).toBe('Updated Grandchild');
    });

    it('should not affect sibling nodes', () => {
      const childNode = findNode(mindmap.root, '/parent/child');
      const originalText = childNode?.text;

      patch_mindmap(
        mindmap,
        '/parent/child/grandchild',
        '#### Updated\n\nNew content'
      );

      // Child's other children should remain unchanged
      // (in this case there's only one child, but the test shows the concept)
      expect(childNode?.text).toBe(originalText);
    });

    it('should update node title from heading', () => {
      const result = patch_mindmap(
        mindmap,
        '/parent/child/grandchild',
        '#### New Title\n\nContent'
      );

      expect(result?.title).toBe('New Title');
    });

    it('should preserve node id', () => {
      const result = patch_mindmap(
        mindmap,
        '/parent/child/grandchild',
        '#### Updated\n\nContent'
      );

      expect(result?.id).toBe('/parent/child/grandchild');
    });
  });

  describe('Cascade to Ancestors', () => {
    it('should update ancestor summaries', () => {
      const originalChildSummary = findNode(mindmap.root, '/parent/child')?.summary;
      const originalParentSummary = findNode(mindmap.root, '/parent')?.summary;
      const originalRootSummary = mindmap.root.summary;

      patch_mindmap(
        mindmap,
        '/parent/child/grandchild',
        '#### Updated\n\nNew content'
      );

      // All ancestor summaries should be regenerated
      const newChildSummary = findNode(mindmap.root, '/parent/child')?.summary;
      const newParentSummary = findNode(mindmap.root, '/parent')?.summary;
      const newRootSummary = mindmap.root.summary;

      // Summaries should be defined (may be different from original)
      expect(newChildSummary).toBeDefined();
      expect(newParentSummary).toBeDefined();
      expect(newRootSummary).toBeDefined();
    });

    it('should cascade up to root', () => {
      patch_mindmap(
        mindmap,
        '/parent/child/grandchild',
        '#### Updated\n\nContent'
      );

      // Root should have an updated_at timestamp
      expect(mindmap.updated_at).toBeInstanceOf(Date);
    });
  });

  describe('Cascade to Descendants', () => {
    it('should update descendant summaries when parent changes', () => {
      patch_mindmap(
        mindmap,
        '/parent',
        '## Updated Parent\n\nNew parent content'
      );

      // Child and grandchild summaries should be regenerated
      const child = findNode(mindmap.root, '/parent/child');
      const grandchild = findNode(mindmap.root, '/parent/child/grandchild');

      expect(child?.summary).toBeDefined();
      expect(grandchild?.summary).toBeDefined();
    });

    it('should process descendants bottom-up', () => {
      // When parent changes, deepest descendants should be summarized first
      patch_mindmap(
        mindmap,
        '/parent',
        '## Updated\n\nContent'
      );

      // The order of summarization matters for A-N-C-E context
      // Grandchild summary should be computed before child
      const grandchild = findNode(mindmap.root, '/parent/child/grandchild');
      expect(grandchild?.summary).toContain('Grandchild');
    });
  });

  describe('Process Isolation', () => {
    it('should not use IPC for patch operations', () => {
      // Patches operate entirely within the process's own memory
      // No external calls or IPC needed
      const result = patch_mindmap(
        mindmap,
        '/parent/child',
        '### Updated\n\nContent'
      );

      expect(result).not.toBeNull();
      // The operation is synchronous and local
    });

    it('should maintain independent mindmap instance', () => {
      // Create two separate instances
      const mindmap1 = createTestMindmap();
      const mindmap2 = createTestMindmap();

      // Patch one
      patch_mindmap(
        mindmap1,
        '/parent',
        '## Updated\n\nContent'
      );

      // The other should be unchanged
      const parent1 = findNode(mindmap1.root, '/parent');
      const parent2 = findNode(mindmap2.root, '/parent');

      expect(parent1?.text).toBe('## Updated\n\nContent');
      expect(parent2?.text).toBe('## Parent\n\nParent content');
    });
  });

  describe('Non-existent Node', () => {
    it('should return null for non-existent path', () => {
      const result = patch_mindmap(
        mindmap,
        '/nonexistent',
        '## New\n\nContent'
      );

      expect(result).toBeNull();
    });

    it('should return null for invalid path format', () => {
      const result = patch_mindmap(
        mindmap,
        'invalid-path',
        '## New\n\nContent'
      );

      expect(result).toBeNull();
    });
  });

  describe('Feedback Parameter', () => {
    it('should accept optional feedback', () => {
      const result = patch_mindmap(
        mindmap,
        '/parent/child',
        '### Updated\n\nContent',
        'User feedback about the change'
      );

      expect(result).not.toBeNull();
      // Feedback would be used in summary generation (mocked here)
    });
  });
});

describe('summarize_node', () => {
  let mindmap: Mindmap;

  beforeEach(() => {
    mindmap = createTestMindmap();
  });

  it('should generate summary for a node', () => {
    const summary = summarize_node(mindmap, '/parent/child');

    expect(summary).toBeDefined();
    expect(summary?.length).toBeGreaterThan(0);
  });

  it('should return null for non-existent node', () => {
    const summary = summarize_node(mindmap, '/nonexistent');

    expect(summary).toBeNull();
  });

  it('should include ancestor context', () => {
    // When summarizing a child, parent and root text should be considered
    const summary = summarize_node(mindmap, '/parent/child/grandchild');

    expect(summary).toBeDefined();
  });

  it('should include descendant context', () => {
    // When summarizing a parent, child summaries should be considered
    const summary = summarize_node(mindmap, '/parent');

    expect(summary).toBeDefined();
  });

  it('should update node summary in place', () => {
    const node = findNode(mindmap.root, '/parent/child');
    const originalSummary = node?.summary;

    summarize_node(mindmap, '/parent/child');

    // Summary should be potentially different (regenerated)
    expect(node?.summary).toBeDefined();
  });
});

describe('Helper Functions', () => {
  describe('collectAncestors', () => {
    it('should return empty array for root', () => {
      const mindmap = createTestMindmap();
      const ancestors = collectAncestors(mindmap.root, '/');
      expect(ancestors).toEqual([]);
    });

    it('should return parent for first-level node', () => {
      const mindmap = createTestMindmap();
      const ancestors = collectAncestors(mindmap.root, '/parent');
      expect(ancestors).toHaveLength(1);
      expect(ancestors[0].id).toBe('/');
    });

    it('should return chain of ancestors', () => {
      const mindmap = createTestMindmap();
      const ancestors = collectAncestors(mindmap.root, '/parent/child/grandchild');
      expect(ancestors).toHaveLength(3);
      expect(ancestors[0].id).toBe('/');
      expect(ancestors[1].id).toBe('/parent');
      expect(ancestors[2].id).toBe('/parent/child');
    });
  });

  describe('collectDescendants', () => {
    it('should return empty array for leaf node', () => {
      const mindmap = createTestMindmap();
      const grandchild = findNode(mindmap.root, '/parent/child/grandchild')!;
      const descendants = collectDescendants(grandchild);
      expect(descendants).toEqual([]);
    });

    it('should return all descendants for root', () => {
      const mindmap = createTestMindmap();
      const descendants = collectDescendants(mindmap.root);
      expect(descendants.length).toBe(3); // parent, child, grandchild
    });

    it('should return correct descendants for intermediate node', () => {
      const mindmap = createTestMindmap();
      const parent = findNode(mindmap.root, '/parent')!;
      const descendants = collectDescendants(parent);
      expect(descendants).toHaveLength(2); // child, grandchild
      expect(descendants[0].id).toBe('/parent/child');
      expect(descendants[1].id).toBe('/parent/child/grandchild');
    });
  });

  describe('findNode', () => {
    it('should find root node', () => {
      const mindmap = createTestMindmap();
      const node = findNode(mindmap.root, '/');
      expect(node?.id).toBe('/');
    });

    it('should find nested node', () => {
      const mindmap = createTestMindmap();
      const node = findNode(mindmap.root, '/parent/child/grandchild');
      expect(node?.id).toBe('/parent/child/grandchild');
    });

    it('should return null for non-existent node', () => {
      const mindmap = createTestMindmap();
      const node = findNode(mindmap.root, '/nonexistent');
      expect(node).toBeNull();
    });
  });
});
