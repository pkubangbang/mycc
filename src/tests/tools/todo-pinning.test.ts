/**
 * todo-pinning.test.ts - Tests for the todo_pinning tool
 *
 * Regression guard for the "no list echo" refactor: the open todo list is
 * delivered by the todo project-context populator (buildTodoMessages), so NO
 * branch of this tool — happy path or error path — may render it, and the
 * brief() call must not carry it either. Every assertion that allows an echo
 * sets a REAL 'Todo list:' stub, so the check cannot pass vacuously.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoPinningTool } from '../../tools/todo_pinning.js';
import { createMockContext } from './test-utils.js';
import type { AgentContext, TodoModule } from '../../types.js';

describe('todoPinningTool', () => {
  let ctx: AgentContext;
  let mockTodo: TodoModule;

  beforeEach(() => {
    mockTodo = {
      createTodo: vi.fn(() => ({ id: 1, name: 'test', done: false, hash: 'abc12345' })),
      updateTodo: vi.fn(() => null),
      printTodoList: vi.fn(() => 'No todos.'),
      hasOpenTodo: vi.fn(() => false),
      clear: vi.fn(),
      getItems: vi.fn(() => []),
      pinTodo: vi.fn(() => null),
      findByPreviousHash: vi.fn(() => null),
      getPreventStopCandidates: vi.fn(() => []),
    };
    ctx = createMockContext('/tmp/test');
    ctx.todo = mockTodo;
    vi.clearAllMocks();
    // A live list that WOULD be echoed if the refactor regressed.
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [ ] 1. Task [hash: abc12345]');
  });

  // ── Happy paths ──────────────────────────────────────────────────────────

  it('pins an item and returns only the touched item', () => {
    vi.mocked(mockTodo.pinTodo).mockReturnValue({ id: 1, name: 'Task', done: false, hash: 'newhash01', pinned: true });

    const result = todoPinningTool.handler(ctx, { id: 1, hash: 'abc12345', pinned: true });

    expect(mockTodo.pinTodo).toHaveBeenCalledWith(1, 'abc12345', true, undefined);
    expect(result).toContain('Pinned todo #1');
    expect(result).toContain('hash: newhash01');
  });

  it('unpins an item', () => {
    vi.mocked(mockTodo.pinTodo).mockReturnValue({ id: 1, name: 'Task', done: false, hash: 'newhash02', pinned: false });

    const result = todoPinningTool.handler(ctx, { id: 1, hash: 'abc12345', pinned: false });

    expect(result).toContain('Unpinned todo #1');
    expect(result).toContain('pinned: false');
  });

  it('carries the stop guard when one is provided', () => {
    vi.mocked(mockTodo.pinTodo).mockReturnValue({
      id: 2, name: 'Guarded', done: false, hash: 'newhash03', pinned: true,
      preventStop: 'until every test under src/loop passes',
    });

    const result = todoPinningTool.handler(ctx, {
      id: 2, hash: 'abc12345', pinned: true, preventStop: '  until every test under src/loop passes  ',
    });

    expect(mockTodo.pinTodo).toHaveBeenCalledWith(2, 'abc12345', true, 'until every test under src/loop passes');
    expect(result).toContain('preventStop: until every test under src/loop passes');
  });

  // ── No-list-echo guard (every branch) ────────────────────────────────────

  it('does NOT echo the list or call printTodoList on the happy path', () => {
    vi.mocked(mockTodo.pinTodo).mockReturnValue({ id: 1, name: 'Task', done: false, hash: 'newhash01', pinned: true });

    const result = todoPinningTool.handler(ctx, { id: 1, hash: 'abc12345', pinned: true });

    expect(result).not.toContain('Todo list:');
    expect(mockTodo.printTodoList).not.toHaveBeenCalled();
  });

  it('does NOT echo the list on the not-found error path', () => {
    vi.mocked(mockTodo.pinTodo).mockReturnValue(null);
    vi.mocked(mockTodo.getItems).mockReturnValue([]);

    const result = todoPinningTool.handler(ctx, { id: 9, hash: 'abc12345', pinned: true });

    expect(result).toContain('not found');
    expect(result).not.toContain('Todo list:');
    expect(mockTodo.printTodoList).not.toHaveBeenCalled();
  });

  it('does NOT echo the list on the hash-mismatch error path', () => {
    vi.mocked(mockTodo.pinTodo).mockReturnValue(null);
    vi.mocked(mockTodo.getItems).mockReturnValue([{ id: 1, name: 'Task', done: false, hash: 'livehash' }]);

    const result = todoPinningTool.handler(ctx, { id: 1, hash: 'stalehash', pinned: true });

    expect(result).toContain('Hash mismatch');
    expect(result).toContain('hash: livehash');
    expect(result).toContain('Retry using the current hash above.');
    expect(result).not.toContain('Todo list:');
    expect(mockTodo.printTodoList).not.toHaveBeenCalled();
  });

  it('the brief() call carries no list argument', () => {
    vi.mocked(mockTodo.pinTodo).mockReturnValue({ id: 1, name: 'Task', done: false, hash: 'newhash01', pinned: true });

    todoPinningTool.handler(ctx, { id: 1, hash: 'abc12345', pinned: true });

    // Arity-exact: restoring the list as a 4th argument fails this.
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'todo_pinning', 'pinned #1: Task');
  });

  // ── Validation errors ────────────────────────────────────────────────────

  it('rejects a non-positive / non-integer id', () => {
    expect(todoPinningTool.handler(ctx, { id: 0, hash: 'abc', pinned: true }))
      .toBe('Error: id must be a positive integer.');
    expect(todoPinningTool.handler(ctx, { id: 1.5, hash: 'abc', pinned: true }))
      .toBe('Error: id must be a positive integer.');
    expect(todoPinningTool.handler(ctx, { id: '1', hash: 'abc', pinned: true }))
      .toBe('Error: id must be a positive integer.');
    expect(mockTodo.pinTodo).not.toHaveBeenCalled();
  });

  it('rejects a missing / blank hash', () => {
    expect(todoPinningTool.handler(ctx, { id: 1, hash: '', pinned: true }))
      .toBe('Error: hash is required and must be a non-empty string.');
    expect(todoPinningTool.handler(ctx, { id: 1, hash: '   ', pinned: true }))
      .toBe('Error: hash is required and must be a non-empty string.');
    expect(mockTodo.pinTodo).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean pinned flag', () => {
    expect(todoPinningTool.handler(ctx, { id: 1, hash: 'abc', pinned: 'true' }))
      .toBe('Error: pinned must be a boolean.');
    expect(mockTodo.pinTodo).not.toHaveBeenCalled();
  });

  it('rejects an empty preventStop when one is provided', () => {
    expect(todoPinningTool.handler(ctx, { id: 1, hash: 'abc', pinned: true, preventStop: '  ' }))
      .toBe('Error: preventStop must be a non-empty string when provided.');
    expect(mockTodo.pinTodo).not.toHaveBeenCalled();
  });

  it('does NOT echo the list on any validation-error path', () => {
    for (const args of [
      { id: 0, hash: 'abc', pinned: true },
      { id: 1, hash: '', pinned: true },
      { id: 1, hash: 'abc', pinned: 'yes' },
      { id: 1, hash: 'abc', pinned: true, preventStop: '' },
    ]) {
      const result = todoPinningTool.handler(ctx, args);
      expect(result).not.toContain('Todo list:');
    }
    expect(mockTodo.printTodoList).not.toHaveBeenCalled();
  });

  // ── Metadata ─────────────────────────────────────────────────────────────

  it('is lead-only (scope main)', () => {
    expect(todoPinningTool.scope).toEqual(['main']);
  });

  it('requires id, hash and pinned', () => {
    expect(todoPinningTool.input_schema.required).toEqual(['id', 'hash', 'pinned']);
  });
});
