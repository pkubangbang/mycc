/**
 * todo-update.test.ts - Tests for todo_update tool with hash integrity validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoUpdateTool } from '../../tools/todo_update.js';
import { createMockContext } from './test-utils.js';
import { Todo } from '../../context/shared/todo.js';
import type { AgentContext, TodoModule } from '../../types.js';

function createMockTodoContext(): { ctx: AgentContext; mockTodo: TodoModule } {
  const mockTodo: TodoModule = {
    createTodo: vi.fn(() => ({ id: 1, name: 'test', done: false, hash: 'abc12345' })),
    updateTodo: vi.fn(() => ({ id: 1, name: 'Updated', done: true, hash: 'newhash99' })),
    printTodoList: vi.fn(() => 'No todos.'),
    hasOpenTodo: vi.fn(() => false),
    clear: vi.fn(),
    getItems: vi.fn(() => [
      { id: 1, name: 'Task A', done: false, hash: 'abc12345' },
      { id: 2, name: 'Task B', done: true, hash: 'def67890' },
    ]),
    pinTodo: vi.fn(() => null),
    findByPreviousHash: vi.fn(() => null),
    getPreventStopCandidates: vi.fn(() => []),
  };
  const ctx = createMockContext('/tmp/test');
  ctx.todo = mockTodo;
  return { ctx, mockTodo };
}

describe('todoUpdateTool', () => {
  let ctx: AgentContext;
  let mockTodo: TodoModule;

  beforeEach(() => {
    const result = createMockTodoContext();
    ctx = result.ctx;
    mockTodo = result.mockTodo;
    vi.clearAllMocks();
  });

  // Basic updates
  it('should update a todo item name', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Changed name', done: false, hash: 'newhash01' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [ ] 1. Changed name [hash: newhash01]');

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Changed name', done: false });
    expect(mockTodo.updateTodo).toHaveBeenCalledWith(1, 'abc12345', 'Changed name', false, undefined);
    expect(result).toContain('Updated todo #1');
  });

  it('should mark a todo item as done', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: true, hash: 'newhash02' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [x] 1. Task A [hash: newhash02]');

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: true });
    expect(mockTodo.updateTodo).toHaveBeenCalledWith(1, 'abc12345', 'Task A', true, undefined);
    expect(result).toContain('done: true');
  });

  it('should update a todo item note', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: false, hash: 'newhash03', note: 'Added note' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [ ] 1. Task A (Added note) [hash: newhash03]');

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: false, note: 'Added note' });
    expect(mockTodo.updateTodo).toHaveBeenCalledWith(1, 'abc12345', 'Task A', false, 'Added note');
    expect(result).toContain('note: Added note');
  });

  it('should show completed status when done is true', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: true, hash: 'newhash04' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [x] 1. Task A [hash: newhash04]');

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: true });
    expect(result).toContain('done: true');
    // The todo list is no longer passed as the brief's message — the detail line carries it.
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'todo_update', expect.stringMatching(/^(completed|updated) #\d+: Task A$/));
  });

  it('should show updated status when done is false', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: false, hash: 'newhash05' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [ ] 1. Task A [hash: newhash05]');

    todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: false });
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'todo_update', expect.stringMatching(/^(completed|updated) #\d+: Task A$/));
  });

  // Hash validation
  it('should return error on hash mismatch', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue(null);
    vi.mocked(mockTodo.getItems).mockReturnValue([
      { id: 1, name: 'Task A', done: false, hash: 'abc12345' },
    ]);

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'wrong!!!!', name: 'Task A', done: true });
    expect(result).toBe('Error: Hash mismatch for todo #1. The item may have been updated since you last read it. Check the current todo list for the latest hash.');
  });

  it('should emit a warm hint with the current hash on a lineage match (stale write still rejected)', () => {
    // The write is rejected (updateTodo returns null) but the stale hash
    // resolves to the current item via findByPreviousHash → the error carries
    // the CURRENT hash so the LLM can retry this same turn.
    vi.mocked(mockTodo.updateTodo).mockReturnValue(null);
    vi.mocked(mockTodo.getItems).mockReturnValue([
      { id: 1, name: 'Renamed', done: true, hash: 'curr00099' },
    ]);
    vi.mocked(mockTodo.findByPreviousHash).mockReturnValue({
      id: 1, name: 'Renamed', done: true, hash: 'curr00099',
    });

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'old12345', name: 'Renamed', done: true });
    expect(mockTodo.updateTodo).toHaveBeenCalledWith(1, 'old12345', 'Renamed', true, undefined);
    expect(mockTodo.findByPreviousHash).toHaveBeenCalledWith('old12345');
    expect(result).toBe('Error: Hash mismatch for todo #1. This item was updated since you last saw it — the current hash is curr00099. Retry todo_update with the current hash.');
  });

  it('should stay silent (generic mismatch) when the stale hash is not in any lineage ring', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue(null);
    vi.mocked(mockTodo.getItems).mockReturnValue([
      { id: 1, name: 'Task A', done: false, hash: 'abc12345' },
    ]);
    vi.mocked(mockTodo.findByPreviousHash).mockReturnValue(null);

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'totallyunknown', name: 'Task A', done: true });
    expect(result).toBe('Error: Hash mismatch for todo #1. The item may have been updated since you last read it. Check the current todo list for the latest hash.');
  });

  it('should return error on unknown id', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue(null);
    vi.mocked(mockTodo.getItems).mockReturnValue([]);

    const result = todoUpdateTool.handler(ctx, { id: 999, hash: 'abc12345', name: 'Task A', done: true });
    expect(result).toBe('Error: Todo item #999 not found. Use the current todo list to find the correct id.');
  });

  // Input validation
  it('should return error for non-integer id', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1.5, hash: 'abc12345', name: 'Task', done: false });
    expect(result).toBe('Error: id must be a positive integer.');
  });

  it('should return error for non-positive id', () => {
    const result = todoUpdateTool.handler(ctx, { id: 0, hash: 'abc12345', name: 'Task', done: false });
    expect(result).toBe('Error: id must be a positive integer.');
  });

  it('should return error for negative id', () => {
    const result = todoUpdateTool.handler(ctx, { id: -1, hash: 'abc12345', name: 'Task', done: false });
    expect(result).toBe('Error: id must be a positive integer.');
  });

  it('should return error for empty hash', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1, hash: '', name: 'Task', done: false });
    expect(result).toBe('Error: hash is required and must be a non-empty string.');
  });

  it('should return error for missing hash', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1, name: 'Task', done: false });
    expect(result).toBe('Error: hash is required and must be a non-empty string.');
  });

  it('should return error for empty name', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: '', done: false });
    expect(result).toBe('Error: name is required and must be a non-empty string.');
  });

  it('should return error for non-boolean done', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task', done: 'yes' as unknown as boolean });
    expect(result).toBe('Error: done must be a boolean (omit it to keep the current value).');
  });

  // ── Issue #6: the pivot defect. A note-only update OMITTED `done` and was
  //    hard-rejected ("Error: done must be a boolean."), which taught the model
  //    the update path was closed — so it created a COPY of the item and closed
  //    the copy, leaving the original open and stale. Omission must PRESERVE the
  //    item's current state instead of failing.
  describe('omitted `done` preserves the current state (issue #6)', () => {
    it('applies a note-only update using the item\'s existing done value', () => {
      // Item #1 in the fixture list is open (done: false).
      vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: false, hash: 'newhash09', note: 'progress' });

      const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', note: 'progress' });

      // The handler did NOT invent `done`: it read the live item and passed it through.
      expect(mockTodo.updateTodo).toHaveBeenCalledWith(1, 'abc12345', 'Task A', false, 'progress');
      expect(result).toContain('Updated todo #1');
    });

    it('preserves done:true for an already-completed item', () => {
      // Item #2 in the fixture list is done: true.
      vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 2, name: 'Task B', done: true, hash: 'newhash10', note: 'n' });

      todoUpdateTool.handler(ctx, { id: 2, hash: 'def67890', name: 'Task B', note: 'n' });

      expect(mockTodo.updateTodo).toHaveBeenCalledWith(2, 'def67890', 'Task B', true, 'n');
    });

    it('reports #id not found instead of crashing when the item is absent', () => {
      const result = todoUpdateTool.handler(ctx, { id: 99, hash: 'abc12345', name: 'Ghost', note: 'n' });
      expect(result).toBe('Error: Todo item #99 not found. Use the current todo list to find the correct id.');
      expect(mockTodo.updateTodo).not.toHaveBeenCalled();
    });

    it('still rejects a present-but-wrong-typed done', () => {
      const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: 'false' as unknown as boolean });
      expect(result).toBe('Error: done must be a boolean (omit it to keep the current value).');
      expect(mockTodo.updateTodo).not.toHaveBeenCalled();
    });

    it('keeps the hash gate authoritative — a stale hash still fails even when done is omitted', () => {
      vi.mocked(mockTodo.updateTodo).mockReturnValue(null);
      const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'STALE123', name: 'Task A', note: 'n' });
      expect(result).toContain('Hash mismatch for todo #1');
    });
  });

  it('should trim whitespace from hash', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: true, hash: 'newhash06' });

    todoUpdateTool.handler(ctx, { id: 1, hash: '  abc12345  ', name: 'Task A', done: true });
    expect(mockTodo.updateTodo).toHaveBeenCalledWith(1, 'abc12345', 'Task A', true, undefined);
  });

  it('should trim whitespace from name', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Trimmed', done: false, hash: 'newhash07' });

    todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: '  Trimmed  ', done: false });
    expect(mockTodo.updateTodo).toHaveBeenCalledWith(1, 'abc12345', 'Trimmed', false, undefined);
  });

  it('should trim whitespace from note', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: false, hash: 'newhash08', note: 'trimmed note' });

    todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: false, note: '  trimmed note  ' });
    expect(mockTodo.updateTodo).toHaveBeenCalledWith(1, 'abc12345', 'Task A', false, 'trimmed note');
  });

  it('should handle empty note as undefined', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: false, hash: 'newhash09' });

    todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: false, note: '' });
    expect(mockTodo.updateTodo).toHaveBeenCalledWith(1, 'abc12345', 'Task A', false, undefined);
  });

  // Output formatting
  it('should NOT echo the open todo list in output', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: true, hash: 'newhash10' });
    // Set a REAL list so the text check has teeth on its own, instead of
    // depending on a stub that leaked from an earlier test.
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [x] 1. Task A [hash: newhash10]');

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: true });
    // The list is delivered by the todo project-context populator
    // (buildTodoMessages) — the tool result carries only the touched item.
    expect(result).not.toContain('Todo list:');
    expect(mockTodo.printTodoList).not.toHaveBeenCalled();
  });

  it('should include new hash in output', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: true, hash: 'newhash10' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [x] 1. Task A [hash: newhash10]');

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: true });
    expect(result).toContain('hash: newhash10');
  });

  // Tool metadata
  it('should have correct name', () => {
    expect(todoUpdateTool.name).toBe('todo_update');
  });

  it('should have correct scope', () => {
    expect(todoUpdateTool.scope).toEqual(['main', 'child']);
  });

  it('should have id, hash, name as required fields — done is OPTIONAL (issue #6)', () => {
    const required = todoUpdateTool.input_schema.required;
    expect(required).toContain('id');
    expect(required).toContain('hash');
    expect(required).toContain('name');
    // `done` is deliberately NOT required: a note-only edit must not have to
    // restate the completion state. Requiring it is what produced the hard
    // rejection that pushed the model into creating duplicate todos.
    expect(required).not.toContain('done');
  });

  it('TELLS the model it may omit done — an undiscoverable optional field is the same trap', () => {
    const props = todoUpdateTool.input_schema.properties as Record<string, { description?: string }>;
    expect(props.done.description).toMatch(/omit/i);
    expect(todoUpdateTool.description).toMatch(/omit/i);
  });
});

// ── Issue #6, lead-requested checks 1-3, against the REAL Todo module ────────
// A mocked `updateTodo` cannot prove the preserve-stale-hash and auto-clear
// interactions, because both live in the module, not the tool. These use the
// real implementation.
describe('todoUpdateTool against the real Todo module (issue #6)', () => {
  function makeRealCtx() {
    const ctx = createMockContext('/tmp/test-issue6');
    ctx.todo = new Todo();
    return ctx;
  }

  it('an omitted done NEVER bypasses the hash gate (stale hash is still rejected)', () => {
    const ctx = makeRealCtx();
    const item = ctx.todo.createTodo('ship it');
    // The item's hash is now stale (something else updated it).
    ctx.todo.updateTodo(item.id, item.hash, 'ship it', false, 'moved on');

    const result = todoUpdateTool.handler(ctx, {
      id: item.id,
      hash: item.hash,          // STALE on purpose
      name: 'ship it',
      note: 'sneaky note',      // and no `done` at all
    });

    expect(result).toContain('Hash mismatch');
    // The stale write did not land — the note is still the newer one.
    expect(ctx.todo.getItems()[0].note).toBe('moved on');
  });

  it('#id not found outranks the omitted-done path (never "done must be a boolean")', () => {
    const ctx = makeRealCtx();
    ctx.todo.createTodo('only item');

    const result = todoUpdateTool.handler(ctx, { id: 999, hash: 'deadbeef', name: 'ghost', note: 'n' });

    expect(result).toBe('Error: Todo item #999 not found. Use the current todo list to find the correct id.');
    expect(result).not.toContain('done must be a boolean');
  });

  it('a note-only edit preserving done does NOT flip the list into the auto-clear purge', () => {
    const ctx = makeRealCtx();
    const a = ctx.todo.createTodo('task A');
    ctx.todo.createTodo('task B');            // both OPEN → no purge condition

    const result = todoUpdateTool.handler(ctx, { id: a.id, hash: a.hash, name: 'task A', note: 'still open' });

    expect(result).toContain('Updated todo #1');
    // Both rows survive: preserving done:false must not complete anything.
    expect(ctx.todo.getItems()).toHaveLength(2);
    expect(ctx.todo.getItems().every((i) => !i.done)).toBe(true);
    expect(ctx.todo.getItems()[0].note).toBe('still open');
  });

  it('a note-only edit preserving done:true does NOT trigger the purge either', () => {
    const ctx = makeRealCtx();
    const a = ctx.todo.createTodo('task A');
    const b = ctx.todo.createTodo('task B');
    // Complete A, leave B open — one open row means no purge.
    const doneA = ctx.todo.updateTodo(a.id, a.hash, 'task A', true)!;

    const result = todoUpdateTool.handler(ctx, { id: doneA.id, hash: doneA.hash, name: 'task A', note: 'annotated' });

    expect(result).toContain('Updated todo #1');
    expect(result).toContain('done: true');
    // Nothing was purged: B is still open, so the list still holds both rows.
    expect(ctx.todo.getItems()).toHaveLength(2);
    expect(ctx.todo.getItems().find((i) => i.id === b.id)?.done).toBe(false);
  });

  it('null and "" are NOT accepted absences — only undefined is', () => {
    const ctx = makeRealCtx();
    const item = ctx.todo.createTodo('task');

    for (const bad of [null, '']) {
      const result = todoUpdateTool.handler(ctx, {
        id: item.id, hash: item.hash, name: 'task', done: bad as unknown as boolean,
      });
      expect(result).toBe('Error: done must be a boolean (omit it to keep the current value).');
    }
    // Nothing was written by either rejected call.
    expect(ctx.todo.getItems()[0].note).toBeUndefined();
  });
});
