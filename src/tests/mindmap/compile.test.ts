/**
 * compile.test.ts - Compilation tests for mindmap
 *
 * Level mapping:
 * - Root: level 0 (auto-generated, not from markdown)
 * - H1 (#): level 1
 * - H2 (##): level 2
 * - etc.
 *
 * Note: LLM-dependent tests are skipped by default to keep tests fast.
 * To run them, remove the .skip or run with a longer timeout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parse_markdown,
  compile_mindmap,
  compile_mindmap_from_content,
  get_bottom_up_nodes,
} from '../../mindmap/compile.js';
import type { Node } from '../../mindmap/types.js';

describe('parse_markdown', () => {
  it('should parse H1 heading as level 1 section', () => {
    const md = '# Title\n\nContent';
    const sections = parse_markdown(md);

    expect(sections).toHaveLength(1);
    expect(sections[0].level).toBe(1);
    expect(sections[0].title).toBe('Title');
  });

  it('should parse nested heading hierarchy', () => {
    const md = `# Main
Main content

## Section A
Section A content

### Subsection A1
Subsection A1 content

## Section B
Section B content`;

    const sections = parse_markdown(md);

    // Top level has H1
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('Main');

    // H1 has H2 children
    expect(sections[0].children).toHaveLength(2);
    expect(sections[0].children[0].title).toBe('Section A');
    expect(sections[0].children[1].title).toBe('Section B');

    // First H2 has H3 child
    expect(sections[0].children[0].children).toHaveLength(1);
    expect(sections[0].children[0].children[0].title).toBe('Subsection A1');
  });

  it('should handle empty markdown', () => {
    const sections = parse_markdown('');
    expect(sections).toHaveLength(0);
  });

  it('should handle markdown without headings', () => {
    const md = 'Just some text\n\nMore text';
    const sections = parse_markdown(md);
    expect(sections).toHaveLength(0);
  });

  it('should handle multiple H1 sections', () => {
    const md = `# First
Content 1

# Second
Content 2

# Third
Content 3`;

    const sections = parse_markdown(md);
    expect(sections).toHaveLength(3);
    expect(sections[0].title).toBe('First');
    expect(sections[1].title).toBe('Second');
    expect(sections[2].title).toBe('Third');
  });

  it('should ignore headings inside code blocks', () => {
    const md = `# Main

\`\`\`
## Not A Heading
\`\`\`

## Real Section`;

    const sections = parse_markdown(md);

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('Main');
    expect(sections[0].children).toHaveLength(1);
    expect(sections[0].children[0].title).toBe('Real Section');
  });

  describe('Level jumping', () => {
    it('should handle H1 to H3 jump (skip H2)', () => {
      const md = `# Main
Main content

### Subsection
Subsection content`;

      const sections = parse_markdown(md);

      // H3 should be child of H1
      expect(sections).toHaveLength(1);
      expect(sections[0].title).toBe('Main');
      expect(sections[0].children).toHaveLength(1);
      expect(sections[0].children[0].title).toBe('Subsection');
      expect(sections[0].children[0].level).toBe(3);
    });

    it('should handle H3 back to H2 (going up)', () => {
      const md = `# Main

### Deep section
Deep content

## Section
Section content`;

      const sections = parse_markdown(md);

      // H3 and H2 are both children of H1
      expect(sections).toHaveLength(1);
      expect(sections[0].children).toHaveLength(2);
      expect(sections[0].children[0].title).toBe('Deep section');
      expect(sections[0].children[0].level).toBe(3);
      expect(sections[0].children[1].title).toBe('Section');
      expect(sections[0].children[1].level).toBe(2);
    });

    it('should handle H1 -> H4 -> H2 complex jump', () => {
      const md = `# Main

#### Deep
Deep content

## Section
Section content`;

      const sections = parse_markdown(md);

      // H4 and H2 are both children of H1
      expect(sections).toHaveLength(1);
      expect(sections[0].children).toHaveLength(2);
      expect(sections[0].children[0].title).toBe('Deep');
      expect(sections[0].children[0].level).toBe(4);
      expect(sections[0].children[1].title).toBe('Section');
      expect(sections[0].children[1].level).toBe(2);
    });

    it('should handle multiple level jumps in sequence', () => {
      const md = `# A

#### A_deep_1

##### A_deeper

#### A_deep_2

## B

### B_sub

# C`;

      const sections = parse_markdown(md);

      // Root has A and C (B is under A because H2 under H1)
      expect(sections).toHaveLength(2);

      // A has A_deep_1, A_deep_2, B as children
      const a = sections[0];
      expect(a.title).toBe('A');
      expect(a.children).toHaveLength(3);

      // A_deep_1 has A_deeper as child
      expect(a.children[0].title).toBe('A_deep_1');
      expect(a.children[0].level).toBe(4);
      expect(a.children[0].children).toHaveLength(1);
      expect(a.children[0].children[0].title).toBe('A_deeper');
      expect(a.children[0].children[0].level).toBe(5);

      // A_deep_2 (H4 under A, after popping A_deep_1)
      expect(a.children[1].title).toBe('A_deep_2');
      expect(a.children[1].level).toBe(4);

      // B (H2 under A)
      expect(a.children[2].title).toBe('B');
      expect(a.children[2].level).toBe(2);
      expect(a.children[2].children).toHaveLength(1);
      expect(a.children[2].children[0].title).toBe('B_sub');

      // C is separate top-level section
      const c = sections[1];
      expect(c.title).toBe('C');
      expect(c.children).toHaveLength(0);
    });
  });
});

// LLM-dependent tests - skipped by default for speed
describe.skip('compile_mindmap (requires LLM)', () => {
  let tempDir: string;
  let mdPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-compile-'));
    mdPath = path.join(tempDir, 'test.md');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should compile markdown file to mindmap', async () => {
    fs.writeFileSync(mdPath, '# Title\n\nContent');
    const mindmap = await compile_mindmap(mdPath);

    expect(mindmap.root.id).toBe('/');
    expect(mindmap.root.children).toHaveLength(1);
    expect(mindmap.root.children[0].title).toBe('Title');
    expect(mindmap.root.children[0].level).toBe(1);
    // Summary should be generated (not empty)
    expect(mindmap.root.children[0].summary.length).toBeGreaterThan(0);
  });

  it('should set correct node IDs', async () => {
    fs.writeFileSync(mdPath, `# Main

## Architecture
Architecture content

### Core
Core content

## Development
Development content`);

    const mindmap = await compile_mindmap(mdPath);

    expect(mindmap.root.id).toBe('/');
    expect(mindmap.root.children[0].id).toBe('/Main');
    expect(mindmap.root.children[0].children[0].id).toBe('/Main/Architecture');
    expect(mindmap.root.children[0].children[0].children[0].id).toBe('/Main/Architecture/Core');
    expect(mindmap.root.children[0].children[1].id).toBe('/Main/Development');
  });

  it('should compute hash of source file', async () => {
    const content = '# Main\n\nContent';
    fs.writeFileSync(mdPath, content);
    const mindmap = await compile_mindmap(mdPath);

    expect(mindmap.hash).toHaveLength(64); // SHA-256 hex length
    expect(typeof mindmap.hash).toBe('string');
  });

  it('should set timestamps', async () => {
    fs.writeFileSync(mdPath, '# Main');
    const mindmap = await compile_mindmap(mdPath);

    expect(mindmap.compiled_at).toBeDefined();
    expect(mindmap.updated_at).toBeDefined();
  });

  it('should extract URL links', async () => {
    fs.writeFileSync(mdPath, `# Main

## References

- [Docs](https://example.com/docs)
- [API](https://api.example.com)`);

    const mindmap = await compile_mindmap(mdPath);

    const refsNode = mindmap.root.children[0].children[0];
    expect(refsNode.links).toHaveLength(2);
    expect(refsNode.links[0].target_type).toBe('url');
    expect(refsNode.links[0].url).toBe('https://example.com/docs');
  });

  it('should set preamble as root text', async () => {
    fs.writeFileSync(mdPath, `This is the preamble.

It goes before any heading.

# First Section

First content.`);

    const mindmap = await compile_mindmap(mdPath);

    expect(mindmap.root.text).toContain('This is the preamble');
    expect(mindmap.root.text).toContain('It goes before any heading');
    expect(mindmap.root.text).not.toContain('First Section');
  });

  it('should generate summaries for all nodes', async () => {
    fs.writeFileSync(mdPath, `# Main

## Section

Content for section.`);

    const mindmap = await compile_mindmap(mdPath);

    // All nodes should have summaries
    expect(mindmap.root.summary.length).toBeGreaterThan(0);
    expect(mindmap.root.children[0].summary.length).toBeGreaterThan(0);
    expect(mindmap.root.children[0].children[0].summary.length).toBeGreaterThan(0);
  });
});

describe.skip('compile_mindmap_from_content (requires LLM)', () => {
  it('should compile from string content', async () => {
    const content = '# Main\n\nContent';
    const mindmap = await compile_mindmap_from_content(content, 'test');

    expect(mindmap.root.title).toBe('test');
    expect(mindmap.root.children).toHaveLength(1);
    expect(mindmap.root.children[0].title).toBe('Main');
  });

  it('should compute hash from content', async () => {
    const content = '# Main\n\nContent';
    const mindmap = await compile_mindmap_from_content(content);

    expect(mindmap.hash).toHaveLength(64);
  });
});

describe.skip('get_bottom_up_nodes (requires LLM)', () => {
  it('should return nodes in bottom-up order', async () => {
    const mindmap = await compile_mindmap_from_content(`# A
## B
### C
## D`);

    const nodes = get_bottom_up_nodes(mindmap.root);

    // Deepest (C) should come before its parent (B)
    // B should come before A
    // A and D should come before root
    const titles = nodes.map(n => n.title);
    expect(titles).toContain('C');
    expect(titles).toContain('B');
    expect(titles).toContain('A');
    expect(titles).toContain('D');

    // C should be before B
    const cIndex = titles.indexOf('C');
    const bIndex = titles.indexOf('B');
    expect(cIndex).toBeLessThan(bIndex);
  });
});