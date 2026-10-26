/**
 * todo-payload.test.ts - the client half of the todo wire contract
 *
 * These tests exist because the /history shape mismatch (server sent the
 * `{type:'todos', todos:[…]}` wrapper, client tested `Array.isArray` on it)
 * silently wiped the panel on every reload and no test covered that path.
 * The normaliser is the single place both transports go through, so pinning
 * it here is what makes the contract testable without a DOM.
 */
import { describe, it, expect } from 'vitest';
import { parseTodoList, parseTodoFrame, normaliseEntry } from '../../web/src/todo-payload';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 1, name: 'a', done: false, pinned: false, ...over,
});

describe('parseTodoList — /history seed (accepts BOTH shapes)', () => {
  it('accepts the BARE array the server now sends', () => {
    const rows = parseTodoList([entry({ id: 2 }), entry({ id: 1 })]);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('accepts the {type,todos} wrapper — the shape that used to wipe the panel', () => {
    // Regression: the server previously shipped this object in /history while
    // the client required an array, so every reload set the list to [].
    const rows = parseTodoList({ type: 'todos', todos: [entry({ id: 7 })] });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(7);
  });

  it('treats null/absent as an empty list (no list yet in this session)', () => {
    expect(parseTodoList(null)).toEqual([]);
    expect(parseTodoList(undefined)).toEqual([]);
  });

  it('sorts by id so render order never depends on arrival order', () => {
    expect(parseTodoList([entry({ id: 9 }), entry({ id: 3 })]).map((r) => r.id)).toEqual([3, 9]);
  });
});

describe('parseTodoList — hostile input', () => {
  it('drops unusable rows instead of throwing (a null row used to break the panel)', () => {
    const rows = parseTodoList([null, entry({ id: 4 }), 'x', 42, entry({ id: 5 })]);
    expect(rows.map((r) => r.id)).toEqual([4, 5]);
  });

  it('drops a row with a non-numeric id or a non-string name', () => {
    expect(normaliseEntry({ id: '1', name: 'a', done: false, pinned: false })).toBeNull();
    expect(normaliseEntry({ id: 1, name: 42, done: false, pinned: false })).toBeNull();
  });

  it('collapses duplicate ids (one id must mean one row)', () => {
    const rows = parseTodoList([entry({ id: 1, name: 'old' }), entry({ id: 1, name: 'new' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('new');
  });

  it('coerces missing done/pinned to false rather than undefined', () => {
    const [row] = parseTodoList([{ id: 1, name: 'bare' }]);
    expect(row.done).toBe(false);
    expect(row.pinned).toBe(false);
  });

  it('omits empty optional fields that cannot be rendered', () => {
    const [row] = parseTodoList([entry({ note: 42, preventStop: null })]);
    expect(row).not.toBeUndefined();
    expect('note' in row).toBe(false);
    expect('preventStop' in row).toBe(false);
  });

  it('keeps real note/preventStop text', () => {
    const [row] = parseTodoList([entry({ note: 'n', preventStop: 'until done' })]);
    expect(row.note).toBe('n');
    expect(row.preventStop).toBe('until done');
  });
});

describe('parseTodoFrame — live WS frame', () => {
  it('accepts the {type,todos} frame', () => {
    expect(parseTodoFrame({ type: 'todos', todos: [entry()] })).toHaveLength(1);
  });

  it('an empty list is a valid replacement (clears the panel)', () => {
    expect(parseTodoFrame({ type: 'todos', todos: [] })).toEqual([]);
  });

  it('returns null for an unusable frame so the caller KEEPS the panel', () => {
    // Distinct from /history on purpose: a malformed push is a frame bug, not
    // evidence that the list is empty, so it must never blank the panel.
    expect(parseTodoFrame(undefined)).toBeNull();
    expect(parseTodoFrame(null)).toBeNull();
    expect(parseTodoFrame('x')).toBeNull();
    expect(parseTodoFrame({ todos: 'nope' })).toBeNull();
  });
});
