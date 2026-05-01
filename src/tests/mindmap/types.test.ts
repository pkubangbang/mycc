/**
 * types.test.ts - Type validation tests for mindmap
 */

import { describe, it, expect } from 'vitest';

// Type definitions - these should match the implementation
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

// Helper functions for type validation
function isValidLink(link: unknown): link is Link {
  if (typeof link !== 'object' || link === null) return false;
  const l = link as Record<string, unknown>;
  
  if (!['node', 'file', 'url'].includes(l.target_type as string)) return false;
  if (typeof l.comment !== 'string') return false;
  
  // Target-specific fields
  if (l.target_type === 'node' && typeof l.node_id !== 'string') return false;
  if (l.target_type === 'file' && typeof l.file_path !== 'string') return false;
  if (l.target_type === 'url' && typeof l.url !== 'string') return false;
  
  return true;
}

function isValidNode(node: unknown): node is Node {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as Record<string, unknown>;
  
  if (typeof n.id !== 'string') return false;
  if (typeof n.text !== 'string') return false;
  if (typeof n.title !== 'string') return false;
  if (typeof n.summary !== 'string') return false;
  if (typeof n.level !== 'number') return false;
  if (!Array.isArray(n.children)) return false;
  if (!Array.isArray(n.links)) return false;
  
  // Validate children recursively
  for (const child of n.children) {
    if (!isValidNode(child)) return false;
  }
  
  // Validate links
  for (const link of n.links) {
    if (!isValidLink(link)) return false;
  }
  
  return true;
}

function isValidMindmap(mindmap: unknown): mindmap is Mindmap {
  if (typeof mindmap !== 'object' || mindmap === null) return false;
  const m = mindmap as Record<string, unknown>;
  
  if (typeof m.dir !== 'string') return false;
  if (typeof m.hash !== 'string') return false;
  if (!(m.compiled_at instanceof Date || typeof m.compiled_at === 'string')) return false;
  if (!(m.updated_at instanceof Date || typeof m.updated_at === 'string')) return false;
  if (!isValidNode(m.root)) return false;
  
  return true;
}

describe('Mindmap Types', () => {
  describe('Link Type', () => {
    it('should validate a valid node link', () => {
      const link: Link = {
        target_type: 'node',
        node_id: '/architecture/core',
        comment: 'Related to core module'
      };
      expect(isValidLink(link)).toBe(true);
    });

    it('should validate a valid file link', () => {
      const link: Link = {
        target_type: 'file',
        file_path: './src/index.ts',
        comment: 'Source file'
      };
      expect(isValidLink(link)).toBe(true);
    });

    it('should validate a valid url link', () => {
      const link: Link = {
        target_type: 'url',
        url: 'https://example.com/docs',
        comment: 'External documentation'
      };
      expect(isValidLink(link)).toBe(true);
    });

    it('should reject link without target_type', () => {
      const link = {
        node_id: '/test',
        comment: 'Missing target_type'
      };
      expect(isValidLink(link)).toBe(false);
    });

    it('should reject link without comment', () => {
      const link = {
        target_type: 'node',
        node_id: '/test'
      };
      expect(isValidLink(link)).toBe(false);
    });

    it('should reject link with invalid target_type', () => {
      const link = {
        target_type: 'invalid',
        comment: 'Invalid target type'
      };
      expect(isValidLink(link)).toBe(false);
    });

    it('should reject node link without node_id', () => {
      const link = {
        target_type: 'node',
        comment: 'Missing node_id'
      };
      expect(isValidLink(link)).toBe(false);
    });

    it('should reject file link without file_path', () => {
      const link = {
        target_type: 'file',
        comment: 'Missing file_path'
      };
      expect(isValidLink(link)).toBe(false);
    });

    it('should reject url link without url', () => {
      const link = {
        target_type: 'url',
        comment: 'Missing url'
      };
      expect(isValidLink(link)).toBe(false);
    });
  });

  describe('Node Type', () => {
    it('should validate a valid root node', () => {
      const node: Node = {
        id: '/',
        text: '# Root\n\nRoot content',
        title: 'Root',
        summary: 'Root summary',
        level: 0,
        children: [],
        links: []
      };
      expect(isValidNode(node)).toBe(true);
    });

    it('should validate a valid leaf node', () => {
      const node: Node = {
        id: '/architecture/core',
        text: '### Core\n\nCore content',
        title: 'Core',
        summary: 'Core summary',
        level: 2,
        children: [],
        links: []
      };
      expect(isValidNode(node)).toBe(true);
    });

    it('should validate node with children', () => {
      const node: Node = {
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
          }
        ],
        links: []
      };
      expect(isValidNode(node)).toBe(true);
    });

    it('should validate node with links', () => {
      const node: Node = {
        id: '/references',
        text: '## References\n\n- [Docs](https://example.com)',
        title: 'References',
        summary: 'Reference links',
        level: 1,
        children: [],
        links: [
          {
            target_type: 'url',
            url: 'https://example.com',
            comment: 'Docs'
          }
        ]
      };
      expect(isValidNode(node)).toBe(true);
    });

    it('should reject node without id', () => {
      const node = {
        text: '# Root',
        title: 'Root',
        summary: 'Summary',
        level: 0,
        children: [],
        links: []
      };
      expect(isValidNode(node)).toBe(false);
    });

    it('should reject node without text', () => {
      const node = {
        id: '/',
        title: 'Root',
        summary: 'Summary',
        level: 0,
        children: [],
        links: []
      };
      expect(isValidNode(node)).toBe(false);
    });

    it('should reject node without title', () => {
      const node = {
        id: '/',
        text: '# Root',
        summary: 'Summary',
        level: 0,
        children: [],
        links: []
      };
      expect(isValidNode(node)).toBe(false);
    });

    it('should reject node without summary', () => {
      const node = {
        id: '/',
        text: '# Root',
        title: 'Root',
        level: 0,
        children: [],
        links: []
      };
      expect(isValidNode(node)).toBe(false);
    });

    it('should reject node without level', () => {
      const node = {
        id: '/',
        text: '# Root',
        title: 'Root',
        summary: 'Summary',
        children: [],
        links: []
      };
      expect(isValidNode(node)).toBe(false);
    });

    it('should reject node with non-array children', () => {
      const node = {
        id: '/',
        text: '# Root',
        title: 'Root',
        summary: 'Summary',
        level: 0,
        children: 'not an array',
        links: []
      };
      expect(isValidNode(node)).toBe(false);
    });

    it('should reject node with invalid children', () => {
      const node = {
        id: '/',
        text: '# Root',
        title: 'Root',
        summary: 'Summary',
        level: 0,
        children: [{ invalid: 'node' }],
        links: []
      };
      expect(isValidNode(node)).toBe(false);
    });

    it('should reject node with invalid links', () => {
      const node = {
        id: '/',
        text: '# Root',
        title: 'Root',
        summary: 'Summary',
        level: 0,
        children: [],
        links: [{ invalid: 'link' }]
      };
      expect(isValidNode(node)).toBe(false);
    });
  });

  describe('Mindmap Type', () => {
    it('should validate a valid mindmap', () => {
      const mindmap: Mindmap = {
        dir: '/path/to/resources',
        hash: 'abc123def456',
        compiled_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Root summary',
          level: 0,
          children: [],
          links: []
        }
      };
      expect(isValidMindmap(mindmap)).toBe(true);
    });

    it('should validate mindmap with nested structure', () => {
      const mindmap: Mindmap = {
        dir: '/path/to/resources',
        hash: 'abc123',
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Root summary',
          level: 0,
          children: [
            {
              id: '/child',
              text: '## Child',
              title: 'Child',
              summary: 'Child summary',
              level: 1,
              children: [
                {
                  id: '/child/grandchild',
                  text: '### Grandchild',
                  title: 'Grandchild',
                  summary: 'Grandchild summary',
                  level: 2,
                  children: [],
                  links: []
                }
              ],
              links: []
            }
          ],
          links: []
        }
      };
      expect(isValidMindmap(mindmap)).toBe(true);
    });

    it('should reject mindmap without dir', () => {
      const mindmap = {
        hash: 'abc123',
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Summary',
          level: 0,
          children: [],
          links: []
        }
      };
      expect(isValidMindmap(mindmap)).toBe(false);
    });

    it('should reject mindmap without hash', () => {
      const mindmap = {
        dir: '/path',
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Summary',
          level: 0,
          children: [],
          links: []
        }
      };
      expect(isValidMindmap(mindmap)).toBe(false);
    });

    it('should reject mindmap without root', () => {
      const mindmap = {
        dir: '/path',
        hash: 'abc123',
        compiled_at: new Date(),
        updated_at: new Date()
      };
      expect(isValidMindmap(mindmap)).toBe(false);
    });

    it('should reject mindmap with invalid root', () => {
      const mindmap = {
        dir: '/path',
        hash: 'abc123',
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          // missing text, title, summary
          level: 0,
          children: [],
          links: []
        }
      };
      expect(isValidMindmap(mindmap)).toBe(false);
    });

    it('should accept mindmap with string dates', () => {
      // JSON parsed dates are strings, should still validate
      const mindmap = {
        dir: '/path',
        hash: 'abc123',
        compiled_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Summary',
          level: 0,
          children: [],
          links: []
        }
      };
      expect(isValidMindmap(mindmap)).toBe(true);
    });
  });

  describe('Node Path IDs', () => {
    it('should accept root path', () => {
      expect(isValidNode({
        id: '/',
        text: '# Root',
        title: 'Root',
        summary: 'Summary',
        level: 0,
        children: [],
        links: []
      })).toBe(true);
    });

    it('should accept single-level path', () => {
      expect(isValidNode({
        id: '/architecture',
        text: '## Architecture',
        title: 'Architecture',
        summary: 'Summary',
        level: 1,
        children: [],
        links: []
      })).toBe(true);
    });

    it('should accept multi-level path', () => {
      expect(isValidNode({
        id: '/development/testing/unit-tests',
        text: '#### Unit Tests',
        title: 'Unit Tests',
        summary: 'Summary',
        level: 3,
        children: [],
        links: []
      })).toBe(true);
    });

    it('should accept path with kebab-case', () => {
      expect(isValidNode({
        id: '/architecture/core-module',
        text: '### Core Module',
        title: 'Core Module',
        summary: 'Summary',
        level: 2,
        children: [],
        links: []
      })).toBe(true);
    });
  });
});
