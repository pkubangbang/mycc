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

import { describe, it, expect } from 'vitest';
import { parse_markdown, get_bottom_up_nodes } from '../../mindmap/compile.js';
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

    it('should parse headings with CRLF line endings', () => {
      const md = '# Title\r\n\r\nContent\r\n## Section\r\nSection content\r\n';
      const sections = parse_markdown(md);

      expect(sections).toHaveLength(1);
      expect(sections[0].title).toBe('Title');
      expect(sections[0].level).toBe(1);
      expect(sections[0].children).toHaveLength(1);
      expect(sections[0].children[0].title).toBe('Section');
      expect(sections[0].children[0].level).toBe(2);
    });
  });
});

// The three former `describe.skip(...(requires LLM))` blocks are deleted.
// They ran the real compile model and could never execute in CI, so their
// assertions (`toHaveLength(64)` on a hash, `toContain` on four titles) were
// never verified. `get_bottom_up_nodes` is a pure tree walk and is now covered
// by the real tests below; the LLM path is covered by the live-provider
// diagnostics, not the unit suite.

describe('get_bottom_up_nodes', () => {
  /** Build a Node with only the fields the traversal reads. */
  const node = (title: string, children: Node[] = []): Node => ({
    id: `/mindmap/${title.toLowerCase()}`,
    text: `# ${title}`,
    title,
    summary: '',
    level: 1,
    children,
    links: [],
  });

  // root
  // ├── A
  // │   └── B
  // │       └── C
  // └── D
  const c = node('C');
  const b = node('B', [c]);
  const a = node('A', [b]);
  const d = node('D');
  const root = node('root', [a, d]);

  it('visits every node exactly once, deepest first', () => {
    const titles = get_bottom_up_nodes(root).map(n => n.title);
    expect(titles).toEqual(['C', 'B', 'A', 'D', 'root']);
  });

  it('places each child before its parent and the root last', () => {
    const titles = get_bottom_up_nodes(root).map(n => n.title);
    for (const parent of [root, a, b]) {
      for (const child of parent.children) {
        expect(titles.indexOf(child.title)).toBeLessThan(titles.indexOf(parent.title));
      }
    }
    expect(titles[titles.length - 1]).toBe('root');
  });

  it('returns a single node for a leaf-only tree', () => {
    expect(get_bottom_up_nodes(c).map(n => n.title)).toEqual(['C']);
  });
});
