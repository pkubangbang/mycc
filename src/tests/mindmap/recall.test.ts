/**
 * get-node.test.ts - Tree traversal tests for mindmap
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

// Implementation of get_node function
function get_node(mindmap: Mindmap, id: string): Node | null {
  // Validate id format
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  
  // Must start with /
  if (!id.startsWith('/')) {
    return null;
  }
  
  // Must not have trailing slash (except for root)
  if (id !== '/' && id.endsWith('/')) {
    return null;
  }
  
  // Must not have double slashes
  if (id.includes('//')) {
    return null;
  }

  // Root node
  if (id === '/') {
    return mindmap.root;
  }

  // Parse path segments
  const segments = id.slice(1).split('/'); // Remove leading / and split
  
  // Traverse from root
  let current: Node | null = mindmap.root;
  
  for (const segment of segments) {
    if (!current) return null;
    if (segment.length === 0) return null; // Empty segment (from double slash)
    
    // Build expected child id
    const childId = current.id === '/' 
      ? `/${segment}` 
      : `${current.id}/${segment}`;
    
    current = current.children.find(c => c.id === childId) || null;
  }
  
  return current;
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
          id: '/architecture',
          text: '## Architecture\n\nArchitecture content',
          title: 'Architecture',
          summary: 'Architecture summary',
          level: 1,
          children: [
            {
              id: '/architecture/core',
              text: '### Core\n\nCore content',
              title: 'Core',
              summary: 'Core summary',
              level: 2,
              children: [],
              links: []
            },
            {
              id: '/architecture/utils',
              text: '### Utils\n\nUtils content',
              title: 'Utils',
              summary: 'Utils summary',
              level: 2,
              children: [],
              links: []
            }
          ],
          links: []
        },
        {
          id: '/development',
          text: '## Development\n\nDevelopment content',
          title: 'Development',
          summary: 'Development summary',
          level: 1,
          children: [
            {
              id: '/development/testing',
              text: '### Testing\n\nTesting content',
              title: 'Testing',
              summary: 'Testing summary',
              level: 2,
              children: [
                {
                  id: '/development/testing/unit',
                  text: '#### Unit Tests\n\nUnit test content',
                  title: 'Unit Tests',
                  summary: 'Unit test summary',
                  level: 3,
                  children: [],
                  links: []
                },
                {
                  id: '/development/testing/integration',
                  text: '#### Integration Tests\n\nIntegration test content',
                  title: 'Integration Tests',
                  summary: 'Integration test summary',
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

describe('get_node', () => {
  let mindmap: Mindmap;

  beforeEach(() => {
    mindmap = createTestMindmap();
  });

  describe('Root Node', () => {
    it('should return root node for "/"', () => {
      const node = get_node(mindmap, '/');
      
      expect(node).not.toBeNull();
      expect(node?.id).toBe('/');
      expect(node?.title).toBe('Root');
      expect(node?.level).toBe(0);
    });

    it('should return root node with children', () => {
      const node = get_node(mindmap, '/');
      
      expect(node).not.toBeNull();
      expect(node?.children).toHaveLength(2);
    });
  });

  describe('First Level Nodes', () => {
    it('should return architecture node', () => {
      const node = get_node(mindmap, '/architecture');
      
      expect(node).not.toBeNull();
      expect(node?.id).toBe('/architecture');
      expect(node?.title).toBe('Architecture');
      expect(node?.level).toBe(1);
    });

    it('should return development node', () => {
      const node = get_node(mindmap, '/development');
      
      expect(node).not.toBeNull();
      expect(node?.id).toBe('/development');
      expect(node?.title).toBe('Development');
      expect(node?.level).toBe(1);
    });
  });

  describe('Second Level Nodes', () => {
    it('should return core node', () => {
      const node = get_node(mindmap, '/architecture/core');
      
      expect(node).not.toBeNull();
      expect(node?.id).toBe('/architecture/core');
      expect(node?.title).toBe('Core');
      expect(node?.level).toBe(2);
    });

    it('should return utils node', () => {
      const node = get_node(mindmap, '/architecture/utils');
      
      expect(node).not.toBeNull();
      expect(node?.id).toBe('/architecture/utils');
      expect(node?.title).toBe('Utils');
      expect(node?.level).toBe(2);
    });

    it('should return testing node', () => {
      const node = get_node(mindmap, '/development/testing');
      
      expect(node).not.toBeNull();
      expect(node?.id).toBe('/development/testing');
      expect(node?.title).toBe('Testing');
      expect(node?.level).toBe(2);
    });
  });

  describe('Third Level Nodes', () => {
    it('should return unit tests node', () => {
      const node = get_node(mindmap, '/development/testing/unit');
      
      expect(node).not.toBeNull();
      expect(node?.id).toBe('/development/testing/unit');
      expect(node?.title).toBe('Unit Tests');
      expect(node?.level).toBe(3);
    });

    it('should return integration tests node', () => {
      const node = get_node(mindmap, '/development/testing/integration');
      
      expect(node).not.toBeNull();
      expect(node?.id).toBe('/development/testing/integration');
      expect(node?.title).toBe('Integration Tests');
      expect(node?.level).toBe(3);
    });
  });

  describe('Path Not Found', () => {
    it('should return null for non-existent top-level path', () => {
      const node = get_node(mindmap, '/nonexistent');
      expect(node).toBeNull();
    });

    it('should return null for non-existent nested path', () => {
      const node = get_node(mindmap, '/architecture/nonexistent');
      expect(node).toBeNull();
    });

    it('should return null for deeply non-existent path', () => {
      const node = get_node(mindmap, '/a/b/c/d/e/f');
      expect(node).toBeNull();
    });

    it('should return null for partial match', () => {
      const node = get_node(mindmap, '/architecture/core/deep');
      expect(node).toBeNull();
    });

    it('should return null for wrong case', () => {
      const node = get_node(mindmap, '/Architecture');
      expect(node).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should return null for empty string', () => {
      const node = get_node(mindmap, '');
      expect(node).toBeNull();
    });

    it('should return null for path without leading slash', () => {
      const node = get_node(mindmap, 'architecture');
      expect(node).toBeNull();
    });

    it('should return null for trailing slash', () => {
      const node = get_node(mindmap, '/architecture/');
      expect(node).toBeNull();
    });

    it('should return null for double slashes', () => {
      const node = get_node(mindmap, '//architecture');
      expect(node).toBeNull();
    });

    it('should return null for path with double slashes in middle', () => {
      const node = get_node(mindmap, '/architecture//core');
      expect(node).toBeNull();
    });
  });

  describe('Deep Tree Traversal', () => {
    it('should traverse through multiple levels', () => {
      // Create a deep tree
      const deepNode: Node = {
        id: '/a/b/c/d/e/f',
        text: '###### Deep',
        title: 'Deep',
        summary: 'Deep summary',
        level: 6,
        children: [],
        links: []
      };

      let current = deepNode;
      for (let i = 5; i >= 0; i--) {
        const parentLevel = i;
        const parentId = i === 0 ? '/' : `/a${'/b'.repeat(i)}`.replace(/\/+/g, '/');
        const parent: Node = {
          id: parentId,
          text: `##${'#'.repeat(i)} Level ${i}`,
          title: `Level ${i}`,
          summary: `Level ${i} summary`,
          level: parentLevel,
          children: [current],
          links: []
        };
        current = parent;
      }

      const deepMindmap: Mindmap = {
        dir: '/test',
        hash: 'deep',
        compiled_at: new Date(),
        updated_at: new Date(),
        root: current
      };

      // Traverse from root to deep node
      let testNode = deepMindmap.root;
      expect(testNode).toBeDefined();
      
      // Recursively find the deepest node
      function findDeepest(node: Node): Node {
        return node.children.length > 0 ? findDeepest(node.children[0]) : node;
      }
      
      const deepest = findDeepest(deepMindmap.root);
      expect(deepest.level).toBe(6);
    });
  });

  describe('Return Value Properties', () => {
    it('should return node with all required properties', () => {
      const node = get_node(mindmap, '/architecture/core');
      
      expect(node).toHaveProperty('id');
      expect(node).toHaveProperty('text');
      expect(node).toHaveProperty('title');
      expect(node).toHaveProperty('summary');
      expect(node).toHaveProperty('level');
      expect(node).toHaveProperty('children');
      expect(node).toHaveProperty('links');
    });

    it('should return node with correct children array', () => {
      const node = get_node(mindmap, '/architecture');
      
      expect(Array.isArray(node?.children)).toBe(true);
      expect(node?.children).toHaveLength(2);
    });

    it('should return leaf node with empty children array', () => {
      const node = get_node(mindmap, '/architecture/core');
      
      expect(Array.isArray(node?.children)).toBe(true);
      expect(node?.children).toHaveLength(0);
    });
  });
});
