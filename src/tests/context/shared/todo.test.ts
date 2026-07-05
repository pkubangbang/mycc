/**
 * todo.test.ts - Direct unit tests for the Todo class (not the tool wrapper)
 * Verifies hash integrity, auto-clear-on-all-done, and monotonic nextId.
 */

import { describe, it, expect } from 'vitest';
import { Todo } from '../../../context/shared/todo.js';

describe('Todo', () => {
  it('should auto-clear items when the last open item is marked done', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');

    // Mark A done — B still open, list should remain
    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.getItems().length).toBe(2);

    // Mark B done — all done, list should auto-clear
    const result = todo.updateTodo(b.id, b.hash, b.name, true);
    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
    expect(todo.getItems().length).toBe(0);
    expect(todo.hasOpenTodo()).toBe(false);
  });

  it('should keep nextId monotonic across auto-clear', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    // items now cleared
    expect(todo.getItems().length).toBe(0);

    // New item should NOT reuse id 1 — must continue from 2
    const b = todo.createTodo('Task B');
    expect(b.id).toBe(2);
    expect(todo.getItems().length).toBe(1);
  });

  it('should not auto-clear when at least one item remains open', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');

    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.getItems().length).toBe(2);
    expect(todo.hasOpenTodo()).toBe(true);
  });

  it('should print "No todos." after auto-clear', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.printTodoList()).toBe('No todos.');
  });

  it('should reject update with stale hash after auto-clear', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    // list cleared — old reference should fail (id no longer found)
    const result = todo.updateTodo(a.id, a.hash, a.name, true);
    expect(result).toBeNull();
  });

  it('should compute hash as 8 hex chars based on name|done|note', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A', 'note text');
    expect(a.hash).toMatch(/^[0-9a-f]{8}$/);
    // Same content → same hash
    const b = todo.createTodo('Task A', 'note text');
    expect(b.hash).toBe(a.hash);
    // Different note → different hash
    const c = todo.createTodo('Task A', 'different note');
    expect(c.hash).not.toBe(a.hash);
  });

  it('should recompute hash after an update', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const updated = todo.updateTodo(a.id, a.hash, 'Renamed', true);
    expect(updated!.hash).not.toBe(a.hash);
    // Re-updating with old hash fails (stale)
    expect(todo.updateTodo(a.id, a.hash, 'Renamed', true)).toBeNull();
  });

  it('clear() should reset both items and nextId', () => {
    const todo = new Todo();
    todo.createTodo('Task A');
    todo.clear();
    expect(todo.getItems().length).toBe(0);
    const b = todo.createTodo('Task B');
    expect(b.id).toBe(1);
  });

  it('should find and close checkpoint todos', () => {
    const todo = new Todo();
    const cp = todo.createTodo('checkpoint: abc12345', 'abc12345');
    expect(todo.findCheckpointTodo('abc12345')).not.toBeNull();
    todo.closeCheckpointTodo('abc12345');
    expect(todo.findCheckpointTodo('abc12345')).toBeNull();
  });
});