/**
 * todo-basics.test.ts - Tests for todo_write tool: basic operations
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoWriteTool } from '../../tools/todo_write.js';
import { createMockContext } from './test-utils.js';
import type { AgentContext, TodoModule } from '../../types.js';

function createMockTodoContext(): { ctx: AgentContext; mockTodo: TodoModule } {
  const mockTodo: TodoModule = {
    patchTodoList: vi.fn(),
    printTodoList: vi.fn().mockReturnValue('Todo list: empty'),
    hasOpenTodo: vi.fn().mockReturnValue(false),
    clear: vi.fn(),
  };
  const ctx = createMockContext('/tmp/test');
  ctx.todo = mockTodo;
  return { ctx, mockTodo };
}

describe('todoWriteTool - Basic Operations', () => {
  let ctx: AgentContext;
  let mockTodo: TodoModule;

  beforeEach(() => {
    const result = createMockTodoContext();
    ctx = result.ctx;
    mockTodo = result.mockTodo;
    vi.clearAllMocks();
  });

  // Adding new todo items
  it('should add a new todo item', () => {
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n1. [ ] New task');
    const result = todoWriteTool.handler(ctx, { items: [{ name: 'New task' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'New task', done: false, note: undefined },
    ]);
    expect(result).toContain('Todo list');
  });

  it('should add multiple new todo items', () => {
    todoWriteTool.handler(ctx, { items: [{ name: 'Task 1' }, { name: 'Task 2' }, { name: 'Task 3' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Task 1', done: false, note: undefined },
      { id: 0, name: 'Task 2', done: false, note: undefined },
      { id: 0, name: 'Task 3', done: false, note: undefined },
    ]);
  });

  it('should add a todo item with a note', () => {
    todoWriteTool.handler(ctx, { items: [{ name: 'Task', note: 'Remember' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Task', done: false, note: 'Remember' },
    ]);
  });

  it('should handle item with undefined id as new item', () => {
    todoWriteTool.handler(ctx, { items: [{ id: undefined, name: 'Task' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Task', done: false, note: undefined },
    ]);
  });

  it('should handle id of 0 as new item', () => {
    todoWriteTool.handler(ctx, { items: [{ id: 0, name: 'New task' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'New task', done: false, note: undefined },
    ]);
  });

  // Updating existing items
  it('should update an existing todo item by id', () => {
    todoWriteTool.handler(ctx, { items: [{ id: 1, name: 'Updated', done: true }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 1, name: 'Updated', done: true, note: undefined },
    ]);
  });

  it('should update multiple existing items', () => {
    todoWriteTool.handler(ctx, { items: [{ id: 1, name: 'A', done: true }, { id: 2, name: 'B', done: true }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 1, name: 'A', done: true, note: undefined },
      { id: 2, name: 'B', done: true, note: undefined },
    ]);
  });

  it('should update item note', () => {
    todoWriteTool.handler(ctx, { items: [{ id: 1, name: 'Task', note: 'New note' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 1, name: 'Task', done: false, note: 'New note' },
    ]);
  });

  it('should handle update without name change', () => {
    todoWriteTool.handler(ctx, { items: [{ id: 1, name: undefined as unknown as string, done: true }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalled();
  });

  it('should handle mix of add and update in single call', () => {
    todoWriteTool.handler(ctx, { items: [{ id: 0, name: 'New' }, { id: 1, name: 'Updated' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'New', done: false, note: undefined },
      { id: 1, name: 'Updated', done: false, note: undefined },
    ]);
  });

  // Done flag behavior
  it('should mark item as done when done is true', () => {
    todoWriteTool.handler(ctx, { items: [{ name: 'Task', done: true }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Task', done: true, note: undefined },
    ]);
  });

  it('should default done to false when not specified', () => {
    todoWriteTool.handler(ctx, { items: [{ name: 'Task' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Task', done: false, note: undefined },
    ]);
  });

  it('should handle explicit false for done flag', () => {
    todoWriteTool.handler(ctx, { items: [{ name: 'Task', done: false }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Task', done: false, note: undefined },
    ]);
  });

  it('should handle undefined done flag', () => {
    todoWriteTool.handler(ctx, { items: [{ name: 'Task', done: undefined }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Task', done: false, note: undefined },
    ]);
  });

  it('should handle mixed done states in batch update', () => {
    todoWriteTool.handler(ctx, {
      items: [{ id: 1, name: 'A', done: true }, { id: 2, name: 'B', done: false }, { name: 'C', done: true }],
    });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 1, name: 'A', done: true, note: undefined },
      { id: 2, name: 'B', done: false, note: undefined },
      { id: 0, name: 'C', done: true, note: undefined },
    ]);
  });

  it('should handle item with all optional fields', () => {
    todoWriteTool.handler(ctx, { items: [{ id: 1, name: 'Task', done: true, note: 'Done!' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 1, name: 'Task', done: true, note: 'Done!' },
    ]);
  });

  it('should handle item with only required field (name)', () => {
    todoWriteTool.handler(ctx, { items: [{ name: 'Minimal' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Minimal', done: false, note: undefined },
    ]);
  });

  it('should accept very long item name', () => {
    const longName = 'A'.repeat(500);
    todoWriteTool.handler(ctx, { items: [{ name: longName }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: longName, done: false, note: undefined },
    ]);
  });

  it('should preserve special characters in name', () => {
    const specialName = 'Fix bug #123 [URGENT] <test>';
    todoWriteTool.handler(ctx, { items: [{ name: specialName }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: specialName, done: false, note: undefined },
    ]);
  });

  // Output formatting
  it('should return the result of printTodoList', () => {
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Custom list');
    expect(todoWriteTool.handler(ctx, { items: [{ name: 'Task' }] })).toBe('Custom list');
  });

  it('should call brief with completed action when all items are done', () => {
    const brief = vi.mocked(ctx.core.brief);
    todoWriteTool.handler(ctx, { items: [{ id: 1, name: 'A', done: true }, { id: 2, name: 'B', done: true }] });
    expect(brief).toHaveBeenCalledWith('info', 'todo_write', expect.stringContaining('completed'));
  });

  it('should call brief with updated action when some items are not done', () => {
    const brief = vi.mocked(ctx.core.brief);
    todoWriteTool.handler(ctx, { items: [{ id: 1, name: 'A', done: true }, { id: 2, name: 'B', done: false }] });
    expect(brief).toHaveBeenCalledWith('info', 'todo_write', expect.stringContaining('updated'));
  });

  it('should include checkmark for done items in summary', () => {
    const brief = vi.mocked(ctx.core.brief);
    todoWriteTool.handler(ctx, { items: [{ id: 1, name: 'Done', done: true }] });
    expect(brief.mock.calls[0][2]).toContain('✓');
  });

  it('should include circle for pending items in summary', () => {
    const brief = vi.mocked(ctx.core.brief);
    todoWriteTool.handler(ctx, { items: [{ id: 1, name: 'Pending', done: false }] });
    expect(brief.mock.calls[0][2]).toContain('○');
  });

  it('should include note in summary when present', () => {
    const brief = vi.mocked(ctx.core.brief);
    todoWriteTool.handler(ctx, { items: [{ name: 'Task', note: 'Note' }] });
    expect(brief.mock.calls[0][2]).toContain('Note');
  });
});