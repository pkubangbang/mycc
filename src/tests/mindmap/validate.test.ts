/**
 * validate.test.ts - Hash validation tests for mindmap
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
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

// Helper to compute hash
function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Implementation of validate_mindmap
function validate_mindmap(json: unknown, mdPath: string): { valid: boolean; error?: string } {
  // Check if json is an object
  if (typeof json !== 'object' || json === null) {
    return { valid: false, error: 'JSON must be an object' };
  }

  const m = json as Record<string, unknown>;

  // Check required fields
  if (typeof m.dir !== 'string') {
    return { valid: false, error: 'Missing or invalid dir field' };
  }
  if (typeof m.hash !== 'string') {
    return { valid: false, error: 'Missing or invalid hash field' };
  }
  if (!m.root) {
    return { valid: false, error: 'Missing root field' };
  }

  // Validate root node structure
  if (!isValidNodeStructure(m.root)) {
    return { valid: false, error: 'Invalid root node structure' };
  }

  // Check if markdown file exists
  if (!fs.existsSync(mdPath)) {
    return { valid: false, error: 'Markdown file not found' };
  }

  // Read markdown content
  const mdContent = fs.readFileSync(mdPath, 'utf-8');
  const expectedHash = computeHash(mdContent);

  // Compare hashes
  if (m.hash !== expectedHash) {
    return { valid: false, error: 'Hash mismatch - mindmap may be outdated' };
  }

  return { valid: true };
}

function isValidNodeStructure(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as Record<string, unknown>;

  if (typeof n.id !== 'string') return false;
  if (typeof n.text !== 'string') return false;
  if (typeof n.title !== 'string') return false;
  if (typeof n.summary !== 'string') return false;
  if (typeof n.level !== 'number') return false;
  if (!Array.isArray(n.children)) return false;
  if (!Array.isArray(n.links)) return false;

  for (const child of n.children) {
    if (!isValidNodeStructure(child)) return false;
  }

  return true;
}

// Test fixtures
function createTestMindmap(overrides: Partial<Mindmap> = {}): Mindmap {
  return {
    dir: '/test/dir',
    hash: 'test-hash',
    compiled_at: new Date(),
    updated_at: new Date(),
    root: {
      id: '/',
      text: '# Test\n\nTest content',
      title: 'Test',
      summary: 'Test summary',
      level: 0,
      children: [],
      links: []
    },
    ...overrides
  };
}

describe('validate_mindmap', () => {
  let tempDir: string;
  let testMdPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-validate-'));
    testMdPath = path.join(tempDir, 'test.md');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Valid Mindmap', () => {
    it('should validate a valid mindmap with matching hash', () => {
      const mdContent = '# Test\n\nTest content';
      fs.writeFileSync(testMdPath, mdContent);

      const mindmap: Mindmap = {
        dir: tempDir,
        hash: computeHash(mdContent),
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: mdContent,
          title: 'Test',
          summary: 'Test summary',
          level: 0,
          children: [],
          links: []
        }
      };

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(true);
    });

    it('should validate mindmap with nested nodes', () => {
      const mdContent = `# Root

Root content

## Section 1

Section 1 content

### Subsection

Subsection content`;
      fs.writeFileSync(testMdPath, mdContent);

      const mindmap: Mindmap = {
        dir: tempDir,
        hash: computeHash(mdContent),
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: mdContent,
          title: 'Root',
          summary: 'Root summary',
          level: 0,
          children: [
            {
              id: '/section-1',
              text: '## Section 1\n\nSection 1 content',
              title: 'Section 1',
              summary: 'Section 1 summary',
              level: 1,
              children: [
                {
                  id: '/section-1/subsection',
                  text: '### Subsection\n\nSubsection content',
                  title: 'Subsection',
                  summary: 'Subsection summary',
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

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(true);
    });
  });

  describe('Hash Mismatch', () => {
    it('should fail when hash does not match', () => {
      const mdContent = '# Test\n\nTest content';
      fs.writeFileSync(testMdPath, mdContent);

      const mindmap: Mindmap = {
        dir: tempDir,
        hash: 'wrong-hash-abc123',
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: mdContent,
          title: 'Test',
          summary: 'Test summary',
          level: 0,
          children: [],
          links: []
        }
      };

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Hash mismatch');
    });

    it('should fail when markdown file changed after compilation', () => {
      const oldContent = '# Original\n\nOriginal content';
      const newContent = '# Modified\n\nModified content';
      fs.writeFileSync(testMdPath, newContent);

      const mindmap: Mindmap = {
        dir: tempDir,
        hash: computeHash(oldContent),
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: oldContent,
          title: 'Original',
          summary: 'Original summary',
          level: 0,
          children: [],
          links: []
        }
      };

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Hash mismatch');
    });
  });

  describe('Missing Fields', () => {
    it('should fail when dir is missing', () => {
      const mdContent = '# Test\n\nTest content';
      fs.writeFileSync(testMdPath, mdContent);

      const mindmap = {
        hash: computeHash(mdContent),
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: mdContent,
          title: 'Test',
          summary: 'Test summary',
          level: 0,
          children: [],
          links: []
        }
      };

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing or invalid dir');
    });

    it('should fail when hash is missing', () => {
      const mdContent = '# Test\n\nTest content';
      fs.writeFileSync(testMdPath, mdContent);

      const mindmap = {
        dir: tempDir,
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: mdContent,
          title: 'Test',
          summary: 'Test summary',
          level: 0,
          children: [],
          links: []
        }
      };

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing or invalid hash');
    });

    it('should fail when root is missing', () => {
      const mdContent = '# Test\n\nTest content';
      fs.writeFileSync(testMdPath, mdContent);

      const mindmap = {
        dir: tempDir,
        hash: computeHash(mdContent),
        compiled_at: new Date(),
        updated_at: new Date()
      };

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing root');
    });

    it('should fail when root node has missing fields', () => {
      const mdContent = '# Test\n\nTest content';
      fs.writeFileSync(testMdPath, mdContent);

      const mindmap = {
        dir: tempDir,
        hash: computeHash(mdContent),
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

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid root node');
    });

    it('should fail when JSON is null', () => {
      const mdContent = '# Test\n\nTest content';
      fs.writeFileSync(testMdPath, mdContent);

      const result = validate_mindmap(null, testMdPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be an object');
    });

    it('should fail when JSON is a primitive', () => {
      const mdContent = '# Test\n\nTest content';
      fs.writeFileSync(testMdPath, mdContent);

      const result = validate_mindmap('not an object', testMdPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be an object');
    });
  });

  describe('Markdown File Issues', () => {
    it('should fail when markdown file does not exist', () => {
      const mindmap: Mindmap = {
        dir: tempDir,
        hash: 'some-hash',
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: '# Test',
          title: 'Test',
          summary: 'Test',
          level: 0,
          children: [],
          links: []
        }
      };

      const result = validate_mindmap(mindmap, '/nonexistent/path/file.md');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('Deep Node Validation', () => {
    it('should validate deep node structure', () => {
      const mdContent = '# Root\n\nContent';
      fs.writeFileSync(testMdPath, mdContent);

      const mindmap: Mindmap = {
        dir: tempDir,
        hash: computeHash(mdContent),
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: mdContent,
          title: 'Root',
          summary: 'Root summary',
          level: 0,
          children: [
            {
              id: '/a',
              text: '## A',
              title: 'A',
              summary: 'A summary',
              level: 1,
              children: [
                {
                  id: '/a/b',
                  text: '### B',
                  title: 'B',
                  summary: 'B summary',
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

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(true);
    });

    it('should fail when deep node has missing fields', () => {
      const mdContent = '# Root\n\nContent';
      fs.writeFileSync(testMdPath, mdContent);

      const mindmap = {
        dir: tempDir,
        hash: computeHash(mdContent),
        compiled_at: new Date(),
        updated_at: new Date(),
        root: {
          id: '/',
          text: mdContent,
          title: 'Root',
          summary: 'Root summary',
          level: 0,
          children: [
            {
              id: '/a',
              text: '## A',
              title: 'A',
              // missing summary
              level: 1,
              children: [],
              links: []
            }
          ],
          links: []
        }
      };

      const result = validate_mindmap(mindmap, testMdPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid root node');
    });
  });

  describe('Hash Computation', () => {
    it('should compute consistent hash for same content', () => {
      const content = '# Test\n\nTest content';
      const hash1 = computeHash(content);
      const hash2 = computeHash(content);
      expect(hash1).toBe(hash2);
    });

    it('should compute different hash for different content', () => {
      const content1 = '# Test\n\nTest content';
      const content2 = '# Test\n\nDifferent content';
      const hash1 = computeHash(content1);
      const hash2 = computeHash(content2);
      expect(hash1).not.toBe(hash2);
    });

    it('should produce SHA-256 hash of correct length', () => {
      const hash = computeHash('test content');
      expect(hash).toHaveLength(64); // SHA-256 produces 64 hex characters
    });
  });
});
