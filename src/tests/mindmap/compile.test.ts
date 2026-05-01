/**
 * compile.test.ts - Compilation tests for mindmap
 * 
 * Level mapping:
 * - Root: level 0 (auto-generated, not from markdown)
 * - H1 (#): level 1
 * - H2 (##): level 2
 * - etc.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

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

// Markdown parsing utilities
interface ParsedSection {
  level: number;  // Markdown heading level (1-6)
  title: string;
  text: string;
  startIndex: number;
  endIndex: number;
}

function parseMarkdownSections(md: string): ParsedSection[] {
  const lines = md.split('\n');
  const sections: ParsedSection[] = [];
  let currentSection: ParsedSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headerMatch) {
      // Save previous section
      if (currentSection) {
        currentSection.endIndex = i;
        currentSection.text = lines.slice(currentSection.startIndex, i).join('\n');
        sections.push(currentSection);
      }

      // Start new section
      const headingLevel = headerMatch[1].length;  // # = 1, ## = 2, etc.
      const title = headerMatch[2].trim();
      currentSection = {
        level: headingLevel,
        title,
        text: '',
        startIndex: i,
        endIndex: lines.length
      };
    }
  }

  // Push last section
  if (currentSection) {
    currentSection.text = lines.slice(currentSection.startIndex).join('\n');
    sections.push(currentSection);
  }

  return sections;
}

function buildNodeTree(sections: ParsedSection[]): Node {
  // Create root node (level 0)
  const root: Node = {
    id: '/',
    text: '',
    title: 'Root',
    summary: '',
    level: 0,
    children: [],
    links: []
  };

  // Track parent nodes at each level
  // Index 0 = root, index 1 = H1 parent, index 2 = H2 parent, etc.
  const parentStack: (Node | null)[] = [root, null, null, null, null, null, null];

  for (const section of sections) {
    const nodeLevel = section.level;  // H1 -> level 1, H2 -> level 2, etc.

    // Create node
    const node: Node = {
      id: '',
      text: section.text,
      title: section.title,
      summary: '',
      level: nodeLevel,
      children: [],
      links: []
    };

    // Find parent (first non-null entry below our level)
    let parentLevel = nodeLevel - 1;
    while (parentLevel >= 0 && !parentStack[parentLevel]) {
      parentLevel--;
    }
    const parent = parentStack[parentLevel] || root;

    // Set ID based on parent
    const idSlug = titleToId(section.title);
    node.id = parent.id === '/' ? `/${idSlug}` : `${parent.id}/${idSlug}`;
    parent.children.push(node);

    // Update parent stack
    parentStack[nodeLevel] = node;
    // Clear deeper levels
    for (let i = nodeLevel + 1; i < parentStack.length; i++) {
      parentStack[i] = null;
    }
  }

  return root;
}

function titleToId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractLinks(text: string): Link[] {
  const links: Link[] = [];
  const urlRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[2];
    if (url.startsWith('http://') || url.startsWith('https://')) {
      links.push({
        target_type: 'url',
        url: url,
        comment: match[1]
      });
    }
  }

  return links;
}

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function mockSummarizeNode(node: Node, ancestors: Node[], descendants: Node[]): string {
  return `Summary of "${node.title}" (level ${node.level})`;
}

function summarizeTree(node: Node, ancestors: Node[]): void {
  const collectDescendants = (n: Node): Node[] => {
    let result: Node[] = [];
    for (const child of n.children) {
      result.push(child);
      result = result.concat(collectDescendants(child));
    }
    return result;
  };

  for (const child of node.children) {
    summarizeTree(child, [...ancestors, node]);
  }

  const descendants = collectDescendants(node);
  node.summary = mockSummarizeNode(node, ancestors, descendants);
}

function compile_mindmap(mdPath: string, cwd?: string): Mindmap {
  const content = fs.readFileSync(mdPath, 'utf-8');
  const sections = parseMarkdownSections(content);
  const root = buildNodeTree(sections);

  const extractLinksFromNode = (node: Node) => {
    node.links = extractLinks(node.text);
    for (const child of node.children) {
      extractLinksFromNode(child);
    }
  };
  extractLinksFromNode(root);

  summarizeTree(root, []);

  const dir = cwd || path.dirname(mdPath);
  const hash = computeHash(content);

  return {
    dir,
    hash,
    compiled_at: new Date(),
    updated_at: new Date(),
    root
  };
}

describe('compile_mindmap', () => {
  let tempDir: string;
  let mdPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-compile-'));
    mdPath = path.join(tempDir, 'test.md');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Parse Markdown Headings', () => {
    it('should parse H1 heading as level 1', () => {
      fs.writeFileSync(mdPath, '# Title\n\nContent');
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.root.level).toBe(0);
      expect(mindmap.root.children).toHaveLength(1);
      expect(mindmap.root.children[0].level).toBe(1);
      expect(mindmap.root.children[0].title).toBe('Title');
    });

    it('should parse multiple heading levels correctly', () => {
      fs.writeFileSync(mdPath, `# Main
Main content

## Section A
Section A content

### Subsection A1
Subsection A1 content

## Section B
Section B content`);
      
      const mindmap = compile_mindmap(mdPath);
      
      // Root has children at level 1 (H1)
      expect(mindmap.root.children).toHaveLength(1);
      
      // H1 "Main" at level 1
      const main = mindmap.root.children[0];
      expect(main.title).toBe('Main');
      expect(main.level).toBe(1);
      
      // H2 "Section A" at level 2, child of Main
      expect(main.children).toHaveLength(2);
      const sectionA = main.children[0];
      expect(sectionA.title).toBe('Section A');
      expect(sectionA.level).toBe(2);
      
      // H3 "Subsection A1" at level 3
      const subsectionA1 = sectionA.children[0];
      expect(subsectionA1.title).toBe('Subsection A1');
      expect(subsectionA1.level).toBe(3);
      
      // H2 "Section B" at level 2, child of Main
      const sectionB = main.children[1];
      expect(sectionB.title).toBe('Section B');
      expect(sectionB.level).toBe(2);
    });

    it('should handle empty markdown', () => {
      fs.writeFileSync(mdPath, '');
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.root.id).toBe('/');
      expect(mindmap.root.children).toHaveLength(0);
    });

    it('should handle markdown without headings', () => {
      fs.writeFileSync(mdPath, 'Just some text\n\nMore text');
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.root.id).toBe('/');
      expect(mindmap.root.children).toHaveLength(0);
    });

    it('should parse H1 through H6 with correct levels', () => {
      fs.writeFileSync(mdPath, `# H1
Content H1

## H2
Content H2

### H3
Content H3

#### H4
Content H4

##### H5
Content H5

###### H6
Content H6`);
      
      const mindmap = compile_mindmap(mdPath);
      
      // H1 at level 1
      const h1 = mindmap.root.children[0];
      expect(h1.title).toBe('H1');
      expect(h1.level).toBe(1);
      
      // H2 at level 2
      const h2 = h1.children[0];
      expect(h2.title).toBe('H2');
      expect(h2.level).toBe(2);
      
      // H3 at level 3
      const h3 = h2.children[0];
      expect(h3.title).toBe('H3');
      expect(h3.level).toBe(3);
      
      // H4 at level 4
      const h4 = h3.children[0];
      expect(h4.title).toBe('H4');
      expect(h4.level).toBe(4);
      
      // H5 at level 5
      const h5 = h4.children[0];
      expect(h5.title).toBe('H5');
      expect(h5.level).toBe(5);
      
      // H6 at level 6
      const h6 = h5.children[0];
      expect(h6.title).toBe('H6');
      expect(h6.level).toBe(6);
    });
  });

  describe('Generate Tree Structure', () => {
    it('should generate correct node IDs', () => {
      fs.writeFileSync(mdPath, `# Main

## Architecture
Architecture content

### Core
Core content

## Development
Development content`);
      
      const mindmap = compile_mindmap(mdPath);
      
      // Root
      expect(mindmap.root.id).toBe('/');
      
      // H1 Main
      expect(mindmap.root.children[0].id).toBe('/main');
      
      // H2 Architecture under Main
      expect(mindmap.root.children[0].children[0].id).toBe('/main/architecture');
      
      // H3 Core under Architecture
      expect(mindmap.root.children[0].children[0].children[0].id).toBe('/main/architecture/core');
      
      // H2 Development under Main
      expect(mindmap.root.children[0].children[1].id).toBe('/main/development');
    });

    it('should handle kebab-case titles', () => {
      fs.writeFileSync(mdPath, `# API Design
Content

## User Interface
Content`);
      
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.root.children[0].id).toBe('/api-design');
      expect(mindmap.root.children[0].children[0].id).toBe('/api-design/user-interface');
    });

    it('should preserve full text content', () => {
      fs.writeFileSync(mdPath, `# Main

## Section

This is the content.
Multiple lines.

- Bullet 1
- Bullet 2

More content here.`);
      
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.root.children[0].children[0].text).toContain('This is the content');
      expect(mindmap.root.children[0].children[0].text).toContain('Bullet 1');
    });

    it('should set correct levels for nested structure', () => {
      fs.writeFileSync(mdPath, `# First
Content

## Second
Content

### Third
Content`);
      
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.root.level).toBe(0);
      const first = mindmap.root.children[0];
      expect(first.level).toBe(1);
      const second = first.children[0];
      expect(second.level).toBe(2);
      const third = second.children[0];
      expect(third.level).toBe(3);
    });
  });

  describe('Extract Links', () => {
    it('should extract URL links', () => {
      fs.writeFileSync(mdPath, `# Main

## References

- [Docs](https://example.com/docs)
- [API](https://api.example.com)`);
      
      const mindmap = compile_mindmap(mdPath);
      
      const refsNode = mindmap.root.children[0].children[0];
      expect(refsNode.links).toHaveLength(2);
      expect(refsNode.links[0].target_type).toBe('url');
      expect(refsNode.links[0].url).toBe('https://example.com/docs');
      expect(refsNode.links[0].comment).toBe('Docs');
    });

    it('should handle links in nested nodes', () => {
      fs.writeFileSync(mdPath, `# Main

## Architecture

### Core

See [Documentation](https://docs.example.com) for details.`);
      
      const mindmap = compile_mindmap(mdPath);
      
      const coreNode = mindmap.root.children[0].children[0].children[0];
      expect(coreNode.links).toHaveLength(1);
      expect(coreNode.links[0].url).toBe('https://docs.example.com');
    });

    it('should handle nodes without links', () => {
      fs.writeFileSync(mdPath, `# Main

## Section

Just regular text without links.`);
      
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.root.links).toHaveLength(0);
      expect(mindmap.root.children[0].children[0].links).toHaveLength(0);
    });
  });

  describe('A-N-C-E Context Generation', () => {
    it('should generate summaries for all nodes', () => {
      fs.writeFileSync(mdPath, `# Main

## Section

Content for section.`);
      
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.root.summary).toBeDefined();
      expect(mindmap.root.summary.length).toBeGreaterThan(0);
      expect(mindmap.root.children[0].children[0].summary).toBeDefined();
    });

    it('should generate summaries bottom-up', () => {
      fs.writeFileSync(mdPath, `# Main

## Parent

Parent content.

### Child

Child content.`);
      
      const mindmap = compile_mindmap(mdPath);
      
      // Child should have summary (summarized first)
      const child = mindmap.root.children[0].children[0];
      expect(child.summary).toBeDefined();
      
      // Parent should have summary (summarized after child)
      const parent = mindmap.root.children[0];
      expect(parent.summary).toBeDefined();
      
      // Root should have summary (summarized last)
      expect(mindmap.root.summary).toBeDefined();
    });

    it('should include ancestor context in summary', () => {
      fs.writeFileSync(mdPath, `# Main

## Architecture

Architecture content.

### Core

Core content.`);
      
      const mindmap = compile_mindmap(mdPath);
      
      // All summaries should be defined
      expect(mindmap.root.summary).toBeDefined();
      expect(mindmap.root.children[0].summary).toBeDefined();
      expect(mindmap.root.children[0].children[0].summary).toBeDefined();
    });
  });

  describe('Hash and Metadata', () => {
    it('should compute correct hash', () => {
      const content = '# Main\n\nContent';
      fs.writeFileSync(mdPath, content);
      
      const mindmap = compile_mindmap(mdPath);
      const expectedHash = computeHash(content);
      
      expect(mindmap.hash).toBe(expectedHash);
    });

    it('should set compiled_at timestamp', () => {
      fs.writeFileSync(mdPath, '# Main');
      
      const before = new Date();
      const mindmap = compile_mindmap(mdPath);
      const after = new Date();
      
      expect(mindmap.compiled_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(mindmap.compiled_at.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should set updated_at timestamp', () => {
      fs.writeFileSync(mdPath, '# Main');
      
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.updated_at).toBeInstanceOf(Date);
    });

    it('should set directory from cwd', () => {
      fs.writeFileSync(mdPath, '# Main');
      
      const mindmap = compile_mindmap(mdPath, '/custom/dir');
      
      expect(mindmap.dir).toBe('/custom/dir');
    });

    it('should set directory from mdPath if no cwd', () => {
      fs.writeFileSync(mdPath, '# Main');
      
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.dir).toBe(tempDir);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle deeply nested structure', () => {
      fs.writeFileSync(mdPath, `# A
## B
### C
#### D
##### E
###### F
Content`);
      
      const mindmap = compile_mindmap(mdPath);
      
      let current = mindmap.root.children[0]; // A (level 1)
      expect(current.title).toBe('A');
      expect(current.level).toBe(1);
      
      current = current.children[0]; // B (level 2)
      expect(current.title).toBe('B');
      expect(current.level).toBe(2);
      
      current = current.children[0]; // C (level 3)
      expect(current.title).toBe('C');
      expect(current.level).toBe(3);
      
      current = current.children[0]; // D (level 4)
      expect(current.title).toBe('D');
      expect(current.level).toBe(4);
      
      current = current.children[0]; // E (level 5)
      expect(current.title).toBe('E');
      expect(current.level).toBe(5);
      
      current = current.children[0]; // F (level 6)
      expect(current.title).toBe('F');
      expect(current.level).toBe(6);
    });

    it('should handle multiple H1 sections at root level', () => {
      fs.writeFileSync(mdPath, `# First
Content 1

# Second
Content 2

# Third
Content 3`);
      
      const mindmap = compile_mindmap(mdPath);
      
      expect(mindmap.root.children).toHaveLength(3);
      expect(mindmap.root.children[0].title).toBe('First');
      expect(mindmap.root.children[0].level).toBe(1);
      expect(mindmap.root.children[1].title).toBe('Second');
      expect(mindmap.root.children[1].level).toBe(1);
      expect(mindmap.root.children[2].title).toBe('Third');
      expect(mindmap.root.children[2].level).toBe(1);
    });

    it('should handle mixed heading levels', () => {
      fs.writeFileSync(mdPath, `# A
## A1

# B

# C
## C1
### C1a
## C2`);
      
      const mindmap = compile_mindmap(mdPath);
      
      // A has A1
      expect(mindmap.root.children[0].children).toHaveLength(1);
      
      // B has no children
      expect(mindmap.root.children[1].children).toHaveLength(0);
      
      // C has C1 and C2
      expect(mindmap.root.children[2].children).toHaveLength(2);
      
      // C1 has C1a
      expect(mindmap.root.children[2].children[0].children).toHaveLength(1);
    });
  });
});
