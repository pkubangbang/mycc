/**
 * todo-header.test.ts - the collapsed todo-panel header string.
 *
 * The format was specified by the user on 2026-10-26:
 *   BEFORE: `📋 Todo 2/6 done · 1 📌`
 *   AFTER:  `TODO 2/6 done (pinned x1)`
 *
 * This file exists because the string previously lived only in a `computed`
 * inside `TodoCard.vue`, where no test could reach it — there is no
 * component-mount harness in this repo. A user-visible string verified only by
 * reading a template is a string that regresses silently. `todoHeader()` is the
 * real production formatter (the component calls it), so these lock the shipped
 * behaviour rather than restating a formula.
 */
import { describe, it, expect } from 'vitest';
import { todoHeader } from '../../web/src/todo-header.js';
import type { TodoListEntry } from '../../web/src/types.js';

const entry = (id: number, over: Partial<TodoListEntry> = {}): TodoListEntry => ({
  id, name: `todo ${id}`, done: false, pinned: false, ...over,
});

describe('todoHeader — the collapsed panel header', () => {
  it('renders the exact user-specified format', () => {
    const todos = [
      entry(1, { done: true }),
      entry(2, { done: true }),
      entry(3),
      entry(4),
      entry(5),
      entry(6, { pinned: true }),
    ];
    expect(todoHeader(todos)).toBe('TODO 2/6 done (pinned x1)');
  });

  it('omits the pinned suffix entirely when nothing is pinned', () => {
    // The old format printed `· 0 📌`-style noise in some paths; the rule is
    // "no suffix, not a zero".
    expect(todoHeader([entry(1), entry(2), entry(3)])).toBe('TODO 0/3 done');
    expect(todoHeader([entry(1, { done: true }), entry(2, { done: true })])).toBe('TODO 2/2 done');
  });

  it('counts every pinned item, pinned-then-done included', () => {
    const todos = [
      entry(1, { pinned: true }),
      entry(2, { pinned: true, done: true }),
      entry(3),
      entry(4, { done: true }),
      entry(5),
      entry(6, { done: true }),
    ];
    // 3/6 done, 2 pinned — pinned is counted regardless of `done`.
    expect(todoHeader(todos)).toBe('TODO 3/6 done (pinned x2)');
  });

  it('is uppercase TODO, never the old `Todo`', () => {
    expect(todoHeader([entry(1)])).toMatch(/^TODO /);
    expect(todoHeader([entry(1)])).not.toContain('Todo ');
  });

  it('carries NO glyph and no separator — the template owns the icon', () => {
    // `span.todo-icon` renders 📋 beside the summary, so an emoji or `·` in the
    // string itself would double the glyph or reintroduce the rejected style.
    const header = todoHeader([entry(1, { pinned: true })]);
    expect(header).not.toContain('📌');
    expect(header).not.toContain('📋');
    expect(header).not.toContain('·');
  });

  it('an empty list reads `0/0 done` without throwing', () => {
    // The card is `v-if="hasRows"`, so this is only reachable transiently — it
    // must still be well-formed rather than crash the render.
    expect(todoHeader([])).toBe('TODO 0/0 done');
  });
});
