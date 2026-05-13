/**
 * todo-create.test.ts - Tests for todo_create tool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoCreateTool } from '../../tools/todo_create.js';
import { createMockContext } from './test-utils.js';
import type { AgentContext, TodoModule } from '../../types.js';

function createMockTodoContext(): { ctx: AgentContext; mockTodo: TodoModule } {
  const mockTodo: TodoModule = {
    createTodo: vi.fn(() => ({ id: 1, name: 'test', done: false, hash: 'abc12345' })),
    updateTodo: vi.fn(() => null),
    printTodoList: vi.fn(() => 'No todos.'),
    hasOpenTodo: vi.fn(() => false),
    clear: vi.fn(),
    getItems: vi.fn(() => []),
  };
  const ctx = createMockContext('/tmp/test');
  ctx.todo = mockTodo;
  return { ctx, mockTodo };
}

describe('todoCreateTool', () => {
  let ctx: AgentContext;
  let mockTodo: TodoModule;

  beforeEach(() => {
    const result = createMockTodoContext();
    ctx = result.ctx;
    mockTodo = result.mockTodo;
    vi.clearAllMocks();
  });

  it('should create a todo item with name only', () => {
    vi.mocked(mockTodo.createTodo).mockReturnValue({ id: 1, name: 'New task', done: false, hash: 'def67890' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [ ] 1. New task [hash: def67890]');

    const result = todoCreateTool.handler(ctx, { name: 'New task' });
    expect(mockTodo.createTodo).toHaveBeenCalledWith('New task', undefined);
    expect(result).toContain('Created todo #1');
    expect(result).toContain('New task');
    expect(result).toContain('hash: def67890');
  });

  it('should create a todo item with name and note', () => {
    vi.mocked(mockTodo.createTodo).mockReturnValue({ id: 2, name: 'Task with note', done: false, hash: 'ghi11111', note: 'important' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [ ] 2. Task with note (important) [hash: ghi11111]');

    const result = todoCreateTool.handler(ctx, { name: 'Task with note', note: 'important' });
    expect(mockTodo.createTodo).toHaveBeenCalledWith('Task with note', 'important');
    expect(result).toContain('note: important');
  });

  it('should return error for empty name', () => {
    const result = todoCreateTool.handler(ctx, { name: '' });
    expect(result).toContain('Error: name is required');
    expect(mockTodo.createTodo).not.toHaveBeenCalled();
  });

  it('should return error for missing name', () => {
    const result = todoCreateTool.handler(ctx, {});
    expect(result).toContain('Error: name is required');
    expect(mockTodo.createTodo).not.toHaveBeenCalled();
  });

  it('should return error for whitespace-only name', () => {
    const result = todoCreateTool.handler(ctx, { name: '   ' });
    expect(result).toContain('Error: name is required');
    expect(mockTodo.createTodo).not.toHaveBeenCalled();
  });

  it('should trim whitespace from name', () => {
    todoCreateTool.handler(ctx, { name: '  Padded task  ' });
    expect(mockTodo.createTodo).toHaveBeenCalledWith('Padded task', undefined);
  });

  it('should trim whitespace from note', () => {
    todoCreateTool.handler(ctx, { name: 'Task', note: '  padded note  ' });
    expect(mockTodo.createTodo).toHaveBeenCalledWith('Task', 'padded note');
  });

  it('should include full todo list in output', () => {
    vi.mocked(mockTodo.createTodo).mockReturnValue({ id: 1, name: 'Task', done: false, hash: 'abc12345' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [ ] 1. Task [hash: abc12345]');

    const result = todoCreateTool.handler(ctx, { name: 'Task' });
    expect(result).toContain('Todo list:');
  });

  it('should call brief with todo info', () => {
    vi.mocked(mockTodo.createTodo).mockReturnValue({ id: 1, name: 'My task', done: false, hash: 'abc12345' });
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n  [ ] 1. My task [hash: abc12345]');

    todoCreateTool.handler(ctx, { name: 'My task' });
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'todo_create', expect.any(String), expect.stringContaining('My task'));
  });

  // Tool metadata
  it('should have correct name', () => {
    expect(todoCreateTool.name).toBe('todo_create');
  });

  it('should have correct scope', () => {
    expect(todoCreateTool.scope).toEqual(['main', 'child']);
  });

  it('should have name as required field', () => {
    expect(todoCreateTool.input_schema.required).toContain('name');
  });

  it('should handle special characters in name', () => {
    const specialName = 'Fix bug #123 [URGENT] <test>';
    todoCreateTool.handler(ctx, { name: specialName });
    expect(mockTodo.createTodo).toHaveBeenCalledWith(specialName, undefined);
  });

  it('should accept very long name', () => {
    const longName = 'A'.repeat(500);
    todoCreateTool.handler(ctx, { name: longName });
    expect(mockTodo.createTodo).toHaveBeenCalledWith(longName, undefined);
  });

  it('should handle empty note as undefined', () => {
    todoCreateTool.handler(ctx, { name: 'Task', note: '' });
    expect(mockTodo.createTodo).toHaveBeenCalledWith('Task', undefined);
  });
});
