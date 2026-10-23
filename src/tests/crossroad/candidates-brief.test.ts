/**
 * Tests for the Web UI crossroad card (`buildCandidatesBrief`) and its
 * single-line preview sanitiser (`plainPreview`).
 *
 * The card is rendered as MARKDOWN in the Web UI (MessageItem.vue, markdown-it
 * with `breaks: true`), so any newline or markdown punctuation that survives
 * into a row is interpreted at render time:
 *  - a newline followed by `2. ` inside a preview starts no list item — it is
 *    a continuation line of the CURRENT item, so the real row 2 vanishes into
 *    row 1 (a run-on paragraph in the screenshot report);
 *  - a preview cut mid-backtick leaves an orphan code span, and the leaked
 *    fence state restyles the NEXT row inconsistently.
 * Both are builder bugs: the row is deliberately mixed markdown (the direction
 * name is bold when selected), so only the PREVIEW must be markdown-inert.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { buildCandidatesBrief, plainPreview } from '../../loop/crossroad.js';

describe('plainPreview — preview must be plain text', () => {
  it('collapses an embedded newline + list marker into one line', () => {
    const out = plainPreview('a\n2. b `c', 100);
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('`');
    expect(out).toBe('a 2. b c');
  });

  it('collapses CRLF, tabs and runs of spaces to a single space', () => {
    expect(plainPreview('a\r\n\tb   c', 100)).toBe('a b c');
  });

  it('strips code spans, fences and emphasis markers from the source', () => {
    expect(plainPreview('run `npm test` then **check** __this__', 100))
      .toBe('run npm test then check this');
    expect(plainPreview('```ts\nconst a = 1;\n```', 100)).toBe('const a = 1;');
  });

  it('truncates AFTER stripping, on a word boundary', () => {
    // The backtick-wrapped source is longer than 100 chars; truncating the RAW
    // text would cut inside the code span. 80 visible x's + " and " fills the
    // limit exactly, so the boundary fallback emits the whole head.
    const source = `\`${'x'.repeat(80)}\` and ${'y'.repeat(60)}`;
    const out = plainPreview(source, 100);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('`');
    expect(out).toBe(`${'x'.repeat(80)} and…`);
  });

  it('cuts at the last space when the limit lands mid-word', () => {
    const out = plainPreview(`${'a'.repeat(95)} ${'b'.repeat(20)}`, 100);
    expect(out).toBe(`${'a'.repeat(95)}…`);
  });

  it('truncates a single long word rather than returning an empty preview', () => {
    const out = plainPreview('z'.repeat(150), 100);
    expect(out).toBe(`${'z'.repeat(100)}…`);
  });

  it('keeps short text untouched apart from whitespace normalisation', () => {
    expect(plainPreview('  short   text  ', 100)).toBe('short text');
  });
});

describe('buildCandidatesBrief — one line per direction', () => {
  const screenshotCandidates = [
    // ~90 chars, NEWLINES + an inline code span: the case the `.length > 100`
    // gate used to pass through verbatim.
    'wait.ts` filename aren\'t enum members.\n   Next: hold myblog on c2b until `source` returns `fix/recap-w',
    'wait.ts filename aren\'t enum members.\n   But I want to flag an assumption I\'ve been coasting on: ever',
    'wait.ts` filename aren\'t enum members.\n   Stepping back: the pattern across this whole stretch is that',
  ];

  it('emits exactly one row per candidate, with no embedded newline', () => {
    const lines = buildCandidatesBrief(screenshotCandidates, 1).split('\n');
    // leading blank line + title + one row per candidate (+ outcome when given)
    expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(3);
    expect(lines).toHaveLength(5);
  });

  it('keeps the bold direction name for the selected row only', () => {
    const text = buildCandidatesBrief(screenshotCandidates, 1);
    expect(text).toContain('✅ **go backward**');
    expect(text).toContain('⬜ go forward');
    expect(text).toContain('⬜ synthesize at a high level');
    // No stray markdown from the previews: every `**` pair is one of the
    // card's own bold spans — exactly two pairs (title + selected name).
    expect((text.match(/\*\*/g) ?? [])).toHaveLength(4);
    const rows = text.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(rows.filter((l) => l.includes('**'))).toHaveLength(1);
  });

  it('preserves generation order (1=forward, 2=backward, 3=synthesize)', () => {
    const lines = buildCandidatesBrief(screenshotCandidates, 2).split('\n');
    const rows = lines.filter((l) => /^\d+\. /.test(l));
    expect(rows[0]).toContain('go forward');
    expect(rows[1]).toContain('go backward');
    expect(rows[2]).toContain('synthesize at a high level');
  });

  it('renders the screenshot case as three rows + inline outcome, no stray markdown', () => {    // The contract: ONE line per direction, no newline/backtick survives into a
    // row, the selected row is the only bold one, and the outcome is the final
    // line of the SAME card (one brief ⇒ one `[crossroad]` header).
    const text = buildCandidatesBrief(
      screenshotCandidates,
      1,
      'the enum only has AWAIT.',
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(7); // '' + title + 3 rows + '' + outcome
    expect(lines[1]).toBe('**🚦 Crossroad** — drafted 3 directions — chose #2:');
    const rows = lines.filter((l) => /^\d+\. /.test(l));
    expect(rows).toHaveLength(3);
    rows.forEach((row) => {
      expect(row).not.toContain('`');
      // A preview cut at the limit ends in exactly one ellipsis.
      expect(row.endsWith('……')).toBe(false);
    });
    expect(rows[0].startsWith("1. ⬜ go forward — wait.ts filename aren't enum members. Next: hold myblog"))
      .toBe(true);
    // Structural only: one ellipsis max per row — the truncation budget is not
    // applied twice, and stripping never leaves a second one behind.
    rows.forEach((row) => {
      expect((row.match(/…/g) ?? []).length).toBeLessThanOrEqual(1);
    });
    expect(rows[1]).toBe("2. ✅ **go backward** — wait.ts filename aren't enum members. But I want to flag an assumption I've been coasting on: ever");
    expect(rows[2]).toBe("3. ⬜ synthesize at a high level — wait.ts filename aren't enum members. Stepping back: the pattern across this whole stretch is that");
    expect(lines[6]).toBe('**Outcome** — the enum only has AWAIT.');
    expect((text.match(/`/g) ?? [])).toHaveLength(0);
  });

  it('folds an outcome into the same card as the final line', () => {
    const text = buildCandidatesBrief(screenshotCandidates, 1, 'However, the enum only has AWAIT.');
    const lines = text.split('\n');
    expect(lines.at(-1)).toBe('**Outcome** — However, the enum only has AWAIT.');
    expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(3);
  });

  it('leaves the card unchanged when no outcome is given', () => {
    expect(buildCandidatesBrief(screenshotCandidates, 1))
      .toBe(buildCandidatesBrief(screenshotCandidates, 1, undefined));
  });

  it('does not add an outcome line for an empty continuation', () => {
    expect(buildCandidatesBrief(screenshotCandidates, 1, '   '))
      .not.toContain('**Outcome**');
  });
});

/**
 * USER-VISIBLE composite: the card as markdown-it actually renders it with the
 * Web UI's exact options (MessageItem.vue:92-99). The tests above assert the
 * builder's strings; this one asserts what the user SEES, so a future edit can
 * keep `plainPreview` correct and still break the join — or re-add a second
 * `[crossroad]` brief — and these tests fail.
 */
describe('crossroad card — rendered composite (markdown-it, breaks:true)', () => {
  const screenshotCandidates = [
    'wait.ts` filename aren\'t enum members.\n   Next: hold myblog on c2b until `source` returns `fix/recap-w',
    'wait.ts filename aren\'t enum members.\n   But I want to flag an assumption I\'ve been coasting on: ever',
    'wait.ts` filename aren\'t enum members.\n   Stepping back: the pattern across this whole stretch is that',
  ];

  it('produces three <li> items, no code spans, and the outcome last', () => {
    const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
    const card = buildCandidatesBrief(
      screenshotCandidates,
      1,
      'the enum only has AWAIT.',
    );
    const html = md.render(card);

    // (a) three separate list items — item 2 is NOT swallowed into item 1
    expect((html.match(/<li>/g) ?? [])).toHaveLength(3);
    const items = html.split('<li>').slice(1);
    expect(items[0]).toContain('go forward');
    expect(items[1]).toContain('<strong>go backward</strong>');
    expect(items[2]).toContain('synthesize at a high level');

    // (b) zero code spans / orphan backticks anywhere in the rendered card
    expect(html).not.toContain('<code>');
    expect(card).not.toContain('`');

    // (c) exactly ONE title line in one message — the `[crossroad]` header is
    //     added by MessageItem.vue per message, so at this layer the contract
    //     is "one card = one title". A second brief would render a second
    //     title under a second header.
    expect(card.split('\n').filter((l) => l.startsWith('**🚦 Crossroad**'))).toHaveLength(1);
    expect(card).not.toMatch(/^Resolved:/m);

    // (d) the outcome is the LAST line of the same card
    expect(card.split('\n').at(-1)).toBe('**Outcome** — the enum only has AWAIT.');
    // The outcome must be OUTSIDE the candidate list: after the closing </ol>.
    // The old assertion (indexOf('<strong>Outcome</strong>') > lastIndexOf('<li>'))
    // was tautologically true when the outcome rendered INSIDE the last <li>,
    // so it graded nothing. Grade the list boundary instead.
    expect(html.indexOf('</ol>')).toBeGreaterThan(-1);
    expect(html.indexOf('<strong>Outcome</strong>')).toBeGreaterThan(html.indexOf('</ol>'));
  });

  it('hook.ts emits exactly one crossroad brief, with Resolved only in the else', () => {
    // Structural guard on the emitter: the card brief and the standalone
    // `Resolved:` brief must stay MUTUALLY EXCLUSIVE (if/else), otherwise the
    // user gets two `[crossroad]` headers for one concept again.
    const hookSource = readFileSync(
      new URL('../../loop/states/hook.ts', import.meta.url), 'utf8',
    );
    const start = hookSource.indexOf('briefAssistantContent(ctx, chat.assistantContent);');
    const end = hookSource.indexOf('chat.crossroadContinuation = undefined;');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = hookSource.slice(start, end);

    // The card brief and the Resolved brief are MUTUALLY EXCLUSIVE branches.
    const elseAt = block.indexOf('\n      } else {');
    expect(elseAt).toBeGreaterThan(-1);
    const cardBranch = block.slice(0, elseAt);
    const elseBranch = block.slice(elseAt);
    expect((block.match(/ctx\.core\.brief\('info', 'crossroad'/g) ?? [])).toHaveLength(2);
    expect(cardBranch).toContain('buildCandidatesBrief(');
    expect(cardBranch).not.toContain('Resolved: ${');
    expect(elseBranch).toContain('`Resolved: ${chat.crossroadContinuation}`');
    expect(elseBranch).not.toContain('buildCandidatesBrief(');
  });
});
