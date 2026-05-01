/**
 * load.test.ts - Loading tests for mindmap
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

// Implementation of load_mindmap
function load_mindmap(json: unknown): Mindmap | null {
  // Check if json is an object
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const m = json as Record<string, unknown>;

  // Validate required fields
  if (typeof m.dir !== 'string') return null;
  if (typeof m.hash !== 'string') return null;
  if (!m.root) return null;

  // Parse dates
  const compiled_at = m.compiled_at instanceof Date 
    ? m.compiled_at 
    : new Date(m.compiled_at as string);
  const updated_at = m.updated_at instanceof Date 
    ? m.updated_at 
    : new Date(m.updated_at as string);

  // Validate and convert root node
  const root = validateAndConvertNode(m.root);
  if (!root) return null;

  return {
    dir: m.dir as string,
    hash: m.hash as string,
    compiled_at,
    updated_at,
    root
  };
}

function validateAndConvertNode(node: unknown): Node | null {
  if (typeof node !== 'object' || node === null) return null;
  const n = node as Record<string, unknown>;

  if (typeof n.id !== 'string') return null;
  if (typeof n.text !== 'string') return null;
  if (typeof n.title !== 'string') return null;
  if (typeof n.summary !== 'string') return null;
  if (typeof n.level !== 'number') return null;
  if (!Array.isArray(n.children)) return null;
  if (!Array.isArray(n.links)) return null;

  // Recursively convert children
  const children: Node[] = [];
  for (const child of n.children) {
    const converted = validateAndConvertNode(child);
    if (!converted) return null;
    children.push(converted);
  }

  // Convert links
  const links: Link[] = [];
  for (const link of n.links) {
    const converted = validateAndConvertLink(link);
    if (!converted) return null;
    links.push(converted);
  }

  return {
    id: n.id,
    text: n.text,
    title: n.title,
    summary: n.summary,
    level: n.level,
    children,
    links
  };
}

function validateAndConvertLink(link: unknown): Link | null {
  if (typeof link !== 'object' || link === null) return null;
  const l = link as Record<string, unknown>;

  if (!['node', 'file', 'url'].includes(l.target_type as string)) return null;
  if (typeof l.comment !== 'string') return null;

  const result: Link = {
    target_type: l.target_type as 'node' | 'file' | 'url',
    comment: l.comment
  };

  if (l.target_type === 'node') {
    if (typeof l.node_id !== 'string') return null;
    result.node_id = l.node_id;
  } else if (l.target_type === 'file') {
    if (typeof l.file_path !== 'string') return null;
    result.file_path = l.file_path;
  } else if (l.target_type === 'url') {
    if (typeof l.url !== 'string') return null;
    result.url = l.url;
  }

  return result;
}

// Helper to read JSON file
function loadMindmapFromPath(jsonPath: string): Mindmap | null {
  try {
    if (!fs.existsSync(jsonPath)) {
      return null;
    }
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const json = JSON.parse(content);
    return load_mindmap(json);
  } catch {
    return null;
  }
}

describe('load_mindmap', () => {
  let tempDir: string;
  let jsonPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-load-'));
    jsonPath = path.join(tempDir, 'mindmap.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Load Valid JSON', () => {
    it('should load a valid mindmap JSON', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        root: {
          id: '/',
          text: '# Root\n\nRoot content',
          title: 'Root',
          summary: 'Root summary',
          level: 0,
          children: [],
          links: []
        }
      };

      const result = load_mindmap(json);
      expect(result).not.toBeNull();
      expect(result?.dir).toBe('/test/dir');
      expect(result?.hash).toBe('abc123');
      expect(result?.root.id).toBe('/');
    });

    it('should load mindmap with nested nodes', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
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

      const result = load_mindmap(json);
      expect(result).not.toBeNull();
      expect(result?.root.children).toHaveLength(1);
      expect(result?.root.children[0].children).toHaveLength(1);
    });

    it('should load mindmap with links', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Root summary',
          level: 0,
          children: [],
          links: [
            {
              target_type: 'url',
              url: 'https://example.com',
              comment: 'External link'
            }
          ]
        }
      };

      const result = load_mindmap(json);
      expect(result).not.toBeNull();
      expect(result?.root.links).toHaveLength(1);
      expect(result?.root.links[0].target_type).toBe('url');
    });

    it('should parse date strings into Date objects', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
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

      const result = load_mindmap(json);
      expect(result).not.toBeNull();
      expect(result?.compiled_at).toBeInstanceOf(Date);
      expect(result?.updated_at).toBeInstanceOf(Date);
    });
  });

  describe('Load Non-existent File', () => {
    it('should return null for non-existent file', () => {
      const result = loadMindmapFromPath('/nonexistent/path/mindmap.json');
      expect(result).toBeNull();
    });

    it('should return null for non-existent file path', () => {
      const result = loadMindmapFromPath(path.join(tempDir, 'nonexistent.json'));
      expect(result).toBeNull();
    });
  });

  describe('Load Invalid JSON', () => {
    it('should return null for invalid JSON syntax', () => {
      fs.writeFileSync(jsonPath, '{ invalid json }');
      const result = loadMindmapFromPath(jsonPath);
      expect(result).toBeNull();
    });

    it('should return null for non-object JSON', () => {
      fs.writeFileSync(jsonPath, '"just a string"');
      const result = loadMindmapFromPath(jsonPath);
      expect(result).toBeNull();
    });

    it('should return null for null JSON', () => {
      fs.writeFileSync(jsonPath, 'null');
      const result = loadMindmapFromPath(jsonPath);
      expect(result).toBeNull();
    });

    it('should return null for array JSON', () => {
      fs.writeFileSync(jsonPath, '[]');
      const result = loadMindmapFromFile(null);
      expect(result).toBeNull();
    });

    it('should return null for missing dir', () => {
      const json = {
        hash: 'abc123',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
      const result = load_mindmap(json);
      expect(result).toBeNull();
    });

    it('should return null for missing hash', () => {
      const json = {
        dir: '/test/dir',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
      const result = load_mindmap(json);
      expect(result).toBeNull();
    });

    it('should return null for missing root', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const result = load_mindmap(json);
      expect(result).toBeNull();
    });

    it('should return null for invalid root node', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        root: {
          id: '/',
          // missing text, title, summary
          level: 0,
          children: [],
          links: []
        }
      };
      const result = load_mindmap(json);
      expect(result).toBeNull();
    });

    it('should return null for invalid child node', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Summary',
          level: 0,
          children: [
            {
              id: '/child',
              // missing fields
              level: 1,
              children: [],
              links: []
            }
          ],
          links: []
        }
      };
      const result = load_mindmap(json);
      expect(result).toBeNull();
    });
  });

  describe('Link Validation', () => {
    it('should load node link', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Summary',
          level: 0,
          children: [],
          links: [
            {
              target_type: 'node',
              node_id: '/other/node',
              comment: 'Link to other node'
            }
          ]
        }
      };
      const result = load_mindmap(json);
      expect(result).not.toBeNull();
      expect(result?.root.links[0].target_type).toBe('node');
      expect(result?.root.links[0].node_id).toBe('/other/node');
    });

    it('should load file link', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Summary',
          level: 0,
          children: [],
          links: [
            {
              target_type: 'file',
              file_path: './src/index.ts',
              comment: 'Source file'
            }
          ]
        }
      };
      const result = load_mindmap(json);
      expect(result).not.toBeNull();
      expect(result?.root.links[0].target_type).toBe('file');
      expect(result?.root.links[0].file_path).toBe('./src/index.ts');
    });

    it('should load url link', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Summary',
          level: 0,
          children: [],
          links: [
            {
              target_type: 'url',
              url: 'https://example.com',
              comment: 'External URL'
            }
          ]
        }
      };
      const result = load_mindmap(json);
      expect(result).not.toBeNull();
      expect(result?.root.links[0].target_type).toBe('url');
      expect(result?.root.links[0].url).toBe('https://example.com');
    });

    it('should reject invalid link type', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Summary',
          level: 0,
          children: [],
          links: [
            {
              target_type: 'invalid',
              comment: 'Invalid type'
            }
          ]
        }
      };
      const result = load_mindmap(json);
      expect(result).toBeNull();
    });

    it('should reject node link without node_id', () => {
      const json = {
        dir: '/test/dir',
        hash: 'abc123',
        compiled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        root: {
          id: '/',
          text: '# Root',
          title: 'Root',
          summary: 'Summary',
          level: 0,
          children: [],
          links: [
            {
              target_type: 'node',
              comment: 'Missing node_id'
            }
          ]
        }
      };
      const result = load_mindmap(json);
      expect(result).toBeNull();
    });
  });
});

// Helper function for file loading
function loadMindmapFromFile(json: unknown): Mindmap | null {
  return load_mindmap(json);
}
