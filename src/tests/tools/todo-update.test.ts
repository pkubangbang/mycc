/**
 * todo-update.test.ts - Tests for todo_update tool with hash integrity validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoUpdateTool } from '../../tools/todo_update.js';
import { createMockContext } from './test-utils.js';
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
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'todo_update', expect.any(String), expect.stringContaining('completed'));
  });

  it('should show updated status when done is false', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: false, hash: 'newhash05' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [ ] 1. Task A [hash: newhash05]');

    todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: false });
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'todo_update', expect.any(String), expect.stringContaining('updated'));
  });

  // Hash validation
  it('should return error on hash mismatch', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue(null);
    vi.mocked(mockTodo.getItems).mockReturnValue([
      { id: 1, name: 'Task A', done: false, hash: 'abc12345' },
    ]);

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'wrong!!!!', name: 'Task A', done: true });
    expect(result).toContain('Error: Hash mismatch');
  });

  it('should return error on unknown id', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue(null);
    vi.mocked(mockTodo.getItems).mockReturnValue([]);

    const result = todoUpdateTool.handler(ctx, { id: 999, hash: 'abc12345', name: 'Task A', done: true });
    expect(result).toContain('Error: Todo item #999 not found');
  });

  // Input validation
  it('should return error for non-integer id', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1.5, hash: 'abc12345', name: 'Task', done: false });
    expect(result).toContain('Error: id must be a positive integer');
  });

  it('should return error for non-positive id', () => {
    const result = todoUpdateTool.handler(ctx, { id: 0, hash: 'abc12345', name: 'Task', done: false });
    expect(result).toContain('Error: id must be a positive integer');
  });

  it('should return error for negative id', () => {
    const result = todoUpdateTool.handler(ctx, { id: -1, hash: 'abc12345', name: 'Task', done: false });
    expect(result).toContain('Error: id must be a positive integer');
  });

  it('should return error for empty hash', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1, hash: '', name: 'Task', done: false });
    expect(result).toContain('Error: hash is required');
  });

  it('should return error for missing hash', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1, name: 'Task', done: false });
    expect(result).toContain('Error: hash is required');
  });

  it('should return error for empty name', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: '', done: false });
    expect(result).toContain('Error: name is required');
  });

  it('should return error for non-boolean done', () => {
    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task', done: 'yes' as unknown as boolean });
    expect(result).toContain('Error: done must be a boolean');
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
  it('should include full todo list in output', () => {
    vi.mocked(mockTodo.updateTodo).mockReturnValue({ id: 1, name: 'Task A', done: true, hash: 'newhash10' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [x] 1. Task A [hash: newhash10]');

    const result = todoUpdateTool.handler(ctx, { id: 1, hash: 'abc12345', name: 'Task A', done: true });
    expect(result).toContain('Todo list:');
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

  it('should have id, hash, name, done as required fields', () => {
    const required = todoUpdateTool.input_schema.required;
    expect(required).toContain('id');
    expect(required).toContain('hash');
    expect(required).toContain('name');
    expect(required).toContain('done');
  });
});
