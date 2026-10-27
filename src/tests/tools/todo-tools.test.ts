// todo_* tools — merged from the two per-tool files

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoCreateTool } from '../../tools/todo_create.js';
import { createMockContext } from './test-utils.js';
import type { AgentContext, TodoModule } from '../../types.js';
import { todoUpdateTool } from '../../tools/todo_update.js';

describe('todo-create', () => {
  /**
   * todo-create.test.ts - Tests for todo_create tool
   */


  function createMockTodoContext(): { ctx: AgentContext; mockTodo: TodoModule } {
    const mockTodo: TodoModule = {
      createTodo: vi.fn(() => ({ id: 1, name: 'test', done: false, hash: 'abc12345' })),
      updateTodo: vi.fn(() => null),
      printTodoList: vi.fn(() => 'No todos.'),
      hasOpenTodo: vi.fn(() => false),
      clear: vi.fn(),
      getItems: vi.fn(() => []),
      pinTodo: vi.fn(() => null),
      findByPreviousHash: vi.fn(() => null),
      getReactivationCandidates: vi.fn(() => []),
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
      expect(result).toBe('Error: name is required and must be a non-empty string.');
      expect(mockTodo.createTodo).not.toHaveBeenCalled();
    });

    it('should return error for missing name', () => {
      const result = todoCreateTool.handler(ctx, {});
      expect(result).toBe('Error: name is required and must be a non-empty string.');
      expect(mockTodo.createTodo).not.toHaveBeenCalled();
    });

    it('should return error for whitespace-only name', () => {
      const result = todoCreateTool.handler(ctx, { name: '   ' });
      expect(result).toBe('Error: name is required and must be a non-empty string.');
      expect(mockTodo.createTodo).not.toHaveBeenCalled();
    });

    it('should return error for non-string name', () => {
      const result = todoCreateTool.handler(ctx, { name: 123 as unknown as string });
      expect(result).toBe('Error: name is required and must be a non-empty string.');
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
});

describe('todo-update', () => {
  /**
   * todo-update.test.ts - Tests for todo_update tool with hash integrity validation
   */


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
      getReactivationCandidates: vi.fn(() => []),
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

    it('should have id, hash, name as required fields — done is OPTIONAL (issue #6)', () => {
      const required = todoUpdateTool.input_schema.required;
      expect(required).toContain('id');
      expect(required).toContain('hash');
      expect(required).toContain('name');
      expect(required).not.toContain('done');
    });
  });
});
