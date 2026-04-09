/**
 * todo.ts - Todo module: temporary checklist
 */

import type { TodoModule, TodoItem } from '../types.js';

/**
 * Todo module implementation
 */
export class Todo implements TodoModule {
  private items: TodoItem[] = [];
  private nextId: number = 1;

  /**
   * Update todo list with changes
   */
  patchTodoList(items: TodoItem[]): void {
    for (const item of items) {
      const existing = this.items.find((i) => i.id === item.id);
      if (existing) {
        // Update existing item
        Object.assign(existing, item);
      } else {
        // Add new item
        this.items.push({ ...item, id: item.id || this.nextId++ });
      }
    }
  }

  /**
   * Format todo list for prompt
   */
  printTodoList(): string {
    if (this.items.length === 0) {
      return 'No todos.';
    }

    const lines = ['Todo list:'];
    for (const item of this.items) {
      const marker = item.done ? '[x]' : '[ ]';
      const note = item.note ? ` (${item.note})` : '';
      lines.push(`  ${marker} ${item.id}. ${item.name}${note}`);
    }
    return lines.join('\n');
  }

  /**
   * Check if there are incomplete todos
   */
  hasOpenTodo(): boolean {
    return this.items.some((item) => !item.done);
  }

  /**
   * Clear all todos
   */
  clear(): void {
    this.items = [];
    this.nextId = 1;
  }

  /**
   * Get all items (for testing)
   */
  getItems(): TodoItem[] {
    return [...this.items];
  }
}