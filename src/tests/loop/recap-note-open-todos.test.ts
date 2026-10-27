/**
 * recap-note-open-todos.test.ts — the recap note's THIRD part.
 *
 * A recap rewrites the anchor brief's tool result with a note. That note is
 * three parts, IN THIS ORDER:
 *
 *   1. the `[RECAP]` header (line 1 is the anchor line, kept by the rewind),
 *   2. the span summary / discard note (`additionalMessage`),
 *   3. the OPEN TODO LIST — the one piece of live state that does NOT live in
 *      the transcript, so without it a fold resumes the model with no record of
 *      what it had promised to keep doing.
 *
 * What is locked here:
 *   - ORDER is part of the contract (summary before list): the checklist is what
 *     the next turn should read first, so it comes last;
 *   - the list is omitted ENTIRELY when there is nothing open (no empty heading);
 *   - "open" means `!done` OR `pinned` (a pinned guard is still relevant with a
 *     tick next to it) — settled, unpinned rows are dropped;
 *   - the SIZE PRE-CHECK measures the whole note including the list, because the
 *     note is written AFTER the truncation (an under-measured note loses the
 *     span it was meant to record).
 *
 * Both entry points are exercised through the REAL `Triologue` facade, so a
 * change to how it forwards the list (or to where the note is composed) fails
 * here rather than in a copy of the implementation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Triologue } from '../../loop/triologue.js';
import {
  OPEN_TODOS_HEADING,
  buildRecapNote,
  formatOpenTodos,
} from '../../loop/triologue/recap-note.js';
import type { ToolCall } from '../../types.js';

// agent-io writes to the terminal; keep the test output clean.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), brief: vi.fn() },
}));

let seq = 0;

/** assistant(brief) → tool('brief','OK') — one anchor round-trip. */
function pushBrief(t: Triologue, message: string): void {
  seq++;
  const call: ToolCall = {
    id: `brief_${seq}`,
    function: { name: 'brief', arguments: { message, confidence: 7 } },
  };
  t.agent('', [call]);
  t.tool('brief', 'OK', call.id);
}

const OPEN_ITEMS = [
  { id: 1, name: 'wire the todo list', done: false },
  { id: 2, name: 'already settled', done: true },
  { id: 3, name: 'pinned guard', done: false, pinned: true, preventStop: 'until tests pass' },
  { id: 4, name: 'pinned but done', done: true, pinned: true },
];

describe('formatOpenTodos', () => {
  it('returns nothing for an absent or empty list — the section never renders empty', () => {
    expect(formatOpenTodos(undefined)).toBe('');
    expect(formatOpenTodos([])).toBe('');
    // A list with no OPEN row is the same as no list: no dangling heading.
    expect(formatOpenTodos([{ id: 1, name: 'done', done: true }])).toBe('');
  });

  it('lists the open rows in list order, keeps pinned-done, drops settled unpinned rows', () => {
    const text = formatOpenTodos(OPEN_ITEMS);
    expect(text.startsWith(`${OPEN_TODOS_HEADING}\n`)).toBe(true);
    expect(text).toContain('[ ] #1 wire the todo list');
    expect(text).toContain('[ ] #3 pinned guard (pinned) [preventStop: until tests pass]');
    // DONE + PINNED survives: a pinned item is a long-term reminder whose
    // condition outlives its tick (the same rule Todo.hasOpenTodo uses).
    expect(text).toContain('[x] #4 pinned but done (pinned)');
    // DONE + UNPINNED is the settled part of the checklist — not carried.
    expect(text).not.toContain('already settled');
    // Order is the list's own order, not a re-sort.
    expect(text.indexOf('#1')).toBeLessThan(text.indexOf('#3'));
    expect(text.indexOf('#3')).toBeLessThan(text.indexOf('#4'));
  });

  it('carries the id (the model\'s only handle) and never the integrity hash', () => {
    const text = formatOpenTodos([{ id: 42, name: 'x', done: false }]);
    expect(text).toContain('#42');
    expect(text).not.toMatch(/hash:/);
  });
});

describe('buildRecapNote — three parts, in order', () => {
  it('header → summary → open todos', () => {
    const note = buildRecapNote('mapped the parser', 'SUMMARY BODY', formatOpenTodos(OPEN_ITEMS));
    expect(note).toBe(
      [
        '[RECAP]',
        'Rewound past the brief: "mapped the parser"',
        '',
        'SUMMARY BODY',
        '',
        `${OPEN_TODOS_HEADING}`,
        '[ ] #1 wire the todo list',
        '[ ] #3 pinned guard (pinned) [preventStop: until tests pass]',
        '[x] #4 pinned but done (pinned)',
      ].join('\n'),
    );
    // ORDER, stated as a fact rather than implied by the fixture:
    expect(note.indexOf('SUMMARY BODY')).toBeLessThan(note.indexOf(OPEN_TODOS_HEADING));
  });

  it('is exactly the two-part note when nothing is open (no trailing separator)', () => {
    const withEmpty = buildRecapNote('anchor', 'SUMMARY BODY', '');
    const withoutArg = buildRecapNote('anchor', 'SUMMARY BODY');
    expect(withEmpty).toBe(withoutArg);
    expect(withEmpty.endsWith('SUMMARY BODY')).toBe(true);
    expect(withEmpty).not.toContain(OPEN_TODOS_HEADING);
  });
});

describe('Triologue — the open todos reach the WRITTEN note and its size pre-check', () => {
  let t: Triologue;

  beforeEach(() => {
    seq = 0;
    t = new Triologue();
  });

  /** The note body the rewind actually stored in the anchor's tool result. */
  function storedNote(): string {
    const last = t.getMessages().at(-1)!;
    expect(last.role).toBe('tool');
    return last.content;
  }

  it('appends the open list after the summary in the anchor result', () => {
    pushBrief(t, 'mapped the parser');
    t.agent('work');
    const openTodos = formatOpenTodos(OPEN_ITEMS);

    expect(t.rewindToLastBrief('SUMMARY BODY', undefined, undefined, openTodos)).not.toBeNull();

    const note = storedNote();
    // Line 1 is untouched structure; line 2 is the note.
    expect(note.startsWith('[RECAP]')).toBe(false); // line 1 is the anchor line
    expect(note).toContain('Note, a recap has reset the conversation here with summary: ');
    expect(note).toContain('SUMMARY BODY');
    expect(note).toContain(OPEN_TODOS_HEADING);
    expect(note).toContain('#1 wire the todo list');
    expect(note.indexOf('SUMMARY BODY')).toBeLessThan(note.indexOf(OPEN_TODOS_HEADING));
    // Still ends on role 'tool' — the note rides in the anchor's own result.
    expect(t.getLastRole()).toBe('tool');
  });

  it('omits the section entirely when the caller passes nothing', () => {
    pushBrief(t, 'anchor');
    t.agent('work');
    t.rewindToLastBrief('SUMMARY BODY');
    expect(storedNote()).not.toContain(OPEN_TODOS_HEADING);
  });

  it('recapNoteSize measures the string the rewind writes — WITH the list', () => {
    pushBrief(t, 'anchor');
    t.agent('work');
    const openTodos = formatOpenTodos(OPEN_ITEMS);

    const sized = t.recapNoteSize('SUMMARY BODY', undefined, undefined, openTodos)!;
    const withList = sized;
    const withoutList = t.recapNoteSize('SUMMARY BODY')!;
    t.rewindToLastBrief('SUMMARY BODY', undefined, undefined, openTodos);
    const written = storedNote();

    // anchoredNoteLength counts exactly the rewritten result, so `sized` IS the
    // stored length. A caller that spliced the list into its summary itself
    // would be sized as if the section did not exist — the whole reason the
    // list travels as an argument.
    expect(sized).toBe(written.length);
    // And it is strictly larger than a check that forgot the list: the gap is
    // the section plus its separator, which is what an over-size refusal would
    // otherwise under-count. Measured on the SAME anchor, before the rewind
    // folds it (a folded line 1 is shorter — the invitation is retired — so a
    // size taken after the write would compare two different strings).
    expect(withList - withoutList).toBe(2 + openTodos.length); // '\n\n' + section
  });
});
