/**
 * todo-validation.test.ts - Tests for todo_write tool: validation and edge cases
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

describe('todoWriteTool - Validation & Edge Cases', () => {
  let ctx: AgentContext;
  let mockTodo: TodoModule;

  beforeEach(() => {
    const result = createMockTodoContext();
    ctx = result.ctx;
    mockTodo = result.mockTodo;
    vi.clearAllMocks();
  });

  // Error handling
  it('should return error for empty items array', () => {
    const result = todoWriteTool.handler(ctx, { items: [] });
    expect(result).toBe('Error: items must be a non-empty array');
    expect(mockTodo.patchTodoList).not.toHaveBeenCalled();
  });

  it('should return error when items is not an array', () => {
    const result = todoWriteTool.handler(ctx, { items: 'not an array' });
    expect(result).toBe('Error: items must be a non-empty array');
    expect(mockTodo.patchTodoList).not.toHaveBeenCalled();
  });

  it('should return error when items is null', () => {
    const result = todoWriteTool.handler(ctx, { items: null });
    expect(result).toBe('Error: items must be a non-empty array');
    expect(mockTodo.patchTodoList).not.toHaveBeenCalled();
  });

  it('should return error when items is missing', () => {
    const result = todoWriteTool.handler(ctx, {});
    expect(result).toBe('Error: items must be a non-empty array');
    expect(mockTodo.patchTodoList).not.toHaveBeenCalled();
  });

  it('should handle undefined note', () => {
    todoWriteTool.handler(ctx, { items: [{ name: 'Task', note: undefined }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Task', done: false, note: undefined },
    ]);
  });

  it('should handle non-integer id gracefully', () => {
    todoWriteTool.handler(ctx, { items: [{ id: 'str' as unknown as number, name: 'Task' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalled();
  });

  it('should handle negative id', () => {
    todoWriteTool.handler(ctx, { items: [{ id: -1, name: 'Task' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: -1, name: 'Task', done: false, note: undefined },
    ]);
  });

  it('should handle single item array', () => {
    vi.mocked(mockTodo.printTodoList).mockReturnValue('Todo list:\n1. [ ] Only task');
    const result = todoWriteTool.handler(ctx, { items: [{ id: 0, name: 'Only task' }] });
    expect(mockTodo.patchTodoList).toHaveBeenCalledWith([
      { id: 0, name: 'Only task', done: false, note: undefined },
    ]);
    expect(result).toContain('Only task');
  });

  // Tool metadata
  it('should have correct name', () => {
    expect(todoWriteTool.name).toBe('todo_write');
  });

  it('should have correct scope', () => {
    expect(todoWriteTool.scope).toEqual(['main', 'child']);
  });

  it('should have items as required field', () => {
    expect(todoWriteTool.input_schema.required).toContain('items');
  });

  it('should have items as array type in schema', () => {
    const itemsSchema = todoWriteTool.input_schema.properties?.items;
    expect(itemsSchema?.type).toBe('array');
  });

  it('should have name as string in item schema', () => {
    const itemSchema = todoWriteTool.input_schema.properties?.items?.items as { properties: { name: { type: string } } };
    expect(itemSchema?.properties?.name?.type).toBe('string');
  });

  it('should have id as integer in item schema', () => {
    const itemSchema = todoWriteTool.input_schema.properties?.items?.items as { properties: { id: { type: string } } };
    expect(itemSchema?.properties?.id?.type).toBe('integer');
  });

  it('should have done as boolean in item schema', () => {
    const itemSchema = todoWriteTool.input_schema.properties?.items?.items as { properties: { done: { type: string } } };
    expect(itemSchema?.properties?.done?.type).toBe('boolean');
  });

  it('should have note as string in item schema', () => {
    const itemSchema = todoWriteTool.input_schema.properties?.items?.items as { properties: { note: { type: string } } };
    expect(itemSchema?.properties?.note?.type).toBe('string');
  });

  it('should have name as required in item schema', () => {
    const itemSchema = todoWriteTool.input_schema.properties?.items?.items as { required: string[] };
    expect(itemSchema?.required).toContain('name');
  });
});