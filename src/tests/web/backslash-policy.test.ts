/**
 * backslash-policy.test.ts - Web UI per-message backslash policy
 *
 * markdown-it implements CommonMark backslash escapes: `\` before ASCII
 * punctuation is consumed. Agent tool briefs quote OS paths, so
 * `read C:\Proj\mycc\.mycc\mindmap.json` rendered as
 * `read C:\Proj\mycc.mycc\mindmap.json` (only `\.` breaks — `\P`/`\m` are not
 * escapable punctuation, which is why the symptom looked dot-specific).
 *
 * The fix is scoped per message (src/web/src/backslash-policy.ts): only
 * path-bearing TOOL messages use the verbatim renderer. These tests pin:
 *
 *   - the policy table: agent prose + user text keep markdown, path tools go
 *     verbatim, other labeled logs stay markdown;
 *   - the two renderers behave as claimed (path preserved vs. corrupted);
 *   - code fences/spans are unaffected by the verbatim renderer.
 */
import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { backslashPolicy, PATH_TOOL_LABELS } from '../../web/src/backslash-policy';

const opts = { html: false, linkify: true, breaks: true } as const;
const md = new MarkdownIt(opts);
const mdVerbatim = new MarkdownIt(opts);
mdVerbatim.inline.ruler.disable('escape');

const WIN_PATH = 'read C:\\Proj\\mycc\\.mycc\\mindmap.json';

describe('backslashPolicy', () => {
  it('keeps markdown for agent prose and user text', () => {
    expect(backslashPolicy({ type: 'result' })).toBe('markdown');
    expect(backslashPolicy({ type: 'user' })).toBe('markdown');
    // even if a result accidentally carries a tool label
    expect(backslashPolicy({ type: 'result', label: 'read' })).toBe('markdown');
  });

  it('goes verbatim for path-bearing tool messages', () => {
    for (const label of ['read', 'write', 'edit', 'grep', 'bash', 'bg_create']) {
      for (const type of ['log', 'warn', 'error']) {
        expect(backslashPolicy({ type, label })).toBe('verbatim');
      }
    }
  });

  it('keeps markdown for labeled logs from non-path tools', () => {
    for (const label of ['wiki_put', 'recall', 'todo_create', 'skill_load', 'issue_create']) {
      expect(backslashPolicy({ type: 'log', label })).toBe('markdown');
    }
    expect(backslashPolicy({ type: 'log' })).toBe('markdown');
  });

  it('covers every file/shell tool the brief emits', () => {
    for (const label of ['read', 'write', 'edit', 'grep']) {
      expect(PATH_TOOL_LABELS.has(label)).toBe(true);
    }
  });

  it('exposes the documented table, not a catch-all', () => {
    expect(PATH_TOOL_LABELS.has('web_fetch')).toBe(false);
    expect(PATH_TOOL_LABELS.size).toBeLessThan(20);
  });
});

describe('the two renderers', () => {
  it('stock markdown-it eats the backslash of `\\.` (the bug)', () => {
    expect(md.render(WIN_PATH).trim())
      .toBe('<p>read C:\\Proj\\mycc.mycc\\mindmap.json</p>');
  });

  it('the verbatim renderer preserves the path', () => {
    expect(mdVerbatim.render(WIN_PATH).trim())
      .toBe('<p>read C:\\Proj\\mycc\\.mycc\\mindmap.json</p>');
  });

  it('prose keeps its markdown escapes', () => {
    expect(md.render('\\*literal\\*').trim()).toBe('<p>*literal*</p>');
  });

  it('the verbatim renderer leaves code fences and spans alone', () => {
    const src = '```\nC:\\a\\.b   \\\\\n```\nand `C:\\x\\.y`';
    expect(mdVerbatim.render(src).trim()).toBe(md.render(src).trim());
  });

  it('still renders genuine emphasis under both', () => {
    expect(md.render('**b**').trim()).toBe('<p><strong>b</strong></p>');
    expect(mdVerbatim.render('**b**').trim()).toBe('<p><strong>b</strong></p>');
  });
});
