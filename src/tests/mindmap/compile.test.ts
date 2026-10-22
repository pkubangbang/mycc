/**
 * compile.test.ts - Markdown-section parsing + pure tree helpers.
 *
 * Level mapping:
 * - Root: level 0 (auto-generated, not from markdown)
 * - H1 (#): level 1
 * - H2 (##): level 2
 * - etc.
 *
 * Scope note: this file covers the PURE half of src/mindmap/compile.ts
 * (parse_markdown, get_bottom_up_nodes). The LLM-driven half
 * (compile_mindmap / compile_mindmap_from_content) is NOT covered here: its
 * three `describe.skip('… (requires LLM)')` blocks never executed in CI, so
 * they were removed rather than left as decorative skips. Summarisation is
 * exercised through the fake-provider seams in rotation-compile.test.ts /
 * incremental-compile.test.ts.
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

// get_bottom_up_nodes is a PURE tree walk (src/mindmap/compile-utils.ts): it
// never touches the LLM. It used to be covered only from inside
// describe.skip('get_bottom_up_nodes (requires LLM)'), i.e. never. Build the
// tree by hand and assert the ordering contract directly.
describe('get_bottom_up_nodes', () => {
  const node = (id: string, children: Node[] = []): Node => ({
    id, text: id, title: id.split('/').filter(Boolean).pop() ?? '', summary: '',
    level: id.split('/').length - 1,
    children, links: [], is_mycc: false, is_patch: false,
  });

  it('returns every node children-before-parent, root last', () => {
    // A
    // ├── B
    // │   └── C
    // └── D
    const root = node('/', [node('/A', [node('/A/B', [node('/A/B/C')]), node('/A/D')])]);

    const titles = get_bottom_up_nodes(root).map((n) => n.title);

    expect(titles).toStrictEqual(['C', 'B', 'D', 'A', '']);
    // Deepest node precedes its parent, and the root is the final entry.
    expect(titles.indexOf('C')).toBeLessThan(titles.indexOf('B'));
    expect(titles.indexOf('B')).toBeLessThan(titles.indexOf('A'));
    expect(titles[titles.length - 1]).toBe('');
  });

  it('returns just the node itself for a leaf', () => {
    expect(get_bottom_up_nodes(node('/solo')).map((n) => n.id)).toStrictEqual(['/solo']);
  });
});
