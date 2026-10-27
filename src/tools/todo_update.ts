/**
 * todo_update.ts - Update an existing todo item
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { sanitizeTodoField, renderTodoItemDetails } from '../context/shared/todo-render.js';

export const todoUpdateTool: ToolDefinition = {
  name: 'todo_update',
  description: 'Update an existing todo item by id. You MUST provide the item\'s current hash — the update is rejected if the hash doesn\'t match (prevents stale updates). Get the hash from todo_create output, the todo list, or the recap note. OMIT `done` to keep the item\'s current completion state (e.g. when only adding a note).',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'Item ID to update',
      },
      hash: {
        type: 'string',
        description: 'Current hash of the item (from todo_create output or the todo list). Must match the stored hash.',
      },
      name: {
        type: 'string',
        description: 'Todo item name/description',
      },
      done: {
        type: 'boolean',
        description: 'Whether the item is completed. OMIT to leave the current state unchanged ' +
          '(the tool preserves it) — you do not need to restate it just to edit a note.',
      },
      note: {
        type: 'string',
        description: 'Optional note for the item',
      },
    },
    required: ['id', 'hash', 'name'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const id = args.id as number;
    const hash = args.hash as string;
    const name = args.name as string;
    const doneArg = args.done;
    const noteArg = args.note;

    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      return 'Error: id must be a positive integer.';
    }

    if (!hash || typeof hash !== 'string' || hash.trim() === '') {
      return 'Error: hash is required and must be a non-empty string.';
    }

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return 'Error: name is required and must be a non-empty string.';
    }

    // Omitted fields preserve current state; an explicit empty note clears it.
    // The write remains protected by updateTodo's current-hash gate.
    const current = ctx.todo.getItems().find((i) => i.id === id);
    let done: boolean;
    if (doneArg === undefined) {
      if (!current) return `Error: Todo item #${id} not found. Use the current todo list to find the correct id.`;
      done = current.done;
    } else if (typeof doneArg !== 'boolean') {
      return 'Error: done must be a boolean (omit it to keep the current value).';
    } else { done = doneArg; }
    if (noteArg !== undefined && typeof noteArg !== 'string') return 'Error: note must be a string when provided.';
    const note = noteArg === undefined ? current?.note : (noteArg as string).trim() || undefined;
    const updated = ctx.todo.updateTodo(id, hash.trim(), name.trim(), done, note);    const updated = ctx.todo.updateTodo(id, hash.trim(), name.trim(), done, note?.trim() || undefined);

    if (!updated) {
      // Check if id doesn't exist vs hash mismatch
      const items = ctx.todo.getItems();
      const exists = items.some((i) => i.id === id);
      if (!exists) {
        return `Error: Todo item #${id} not found. Use the current todo list to find the correct id.`;
      }
      // Always return this row's authoritative handle, even after its former
      // hash has aged out of the bounded lineage ring.
      const currentItem = items.find((i) => i.id === id)!;
      const lineageMatch = ctx.todo.findByPreviousHash(hash.trim(), id);
      const cause = lineageMatch ? 'The supplied hash is a known stale hash.' : 'The supplied hash does not match the current item.';
      return `Error: Hash mismatch for todo #${id}. ${cause} No changes were applied.\nCurrent item:\n${renderTodoItemDetails(currentItem)}\nRetry using the current hash above.`;
    }

    const status = updated.done ? 'completed' : 'updated';
    const safeName = sanitizeTodoField(updated.name) ?? '(unnamed)';
    const safeNote = sanitizeTodoField(updated.note);
    // THE AUTO-CLEAR GHOST (review B6). `updateTodo` returns the edited item even
    // when the same call's auto-clear PURGED it (it drops every non-pinned row once
    // all of them are done). Reporting that item normally would tell the model it
    // completed something and hand it a hash it can never use — the row is gone
    // from `getItems()` and never returns to the prompt or the recap note. So
    // verify the returned item against the LIVE list, and report the purge as a
    // purge. The list itself is already correct (the emit carries the post-purge
    // snapshot), so this is about the tool result not contradicting it.
    const stillPresent = ctx.todo.getItems().some((i) => i.id === updated.id);
    if (!stillPresent) {
      const remaining = ctx.todo.getItems();
      // Say ONE true thing about what remains (round-2 review, minor #5). The old
      // wording asserted "the list is now empty" and then appended "N pinned
      // reminder(s) remain" — a self-contradiction in a tool result the model
      // treats as authoritative.
      const pinnedNote = remaining.length > 0
        ? `The ${remaining.length} pinned reminder(s) survive (pinned items are never auto-cleared).`
        : 'No todos remain.';
      const safeName = sanitizeTodoField(updated.name) ?? '(unnamed)';
      ctx.core.brief('info', 'todo_update', `completed #${updated.id}: ${safeName} (auto-cleared)`);
      return `Completed todo #${updated.id} (${safeName}) — this was the last open item, so every
non-pinned todo was AUTO-CLEARED. ${pinnedNote}
  The item and its hash no longer exist; do not try to update #${updated.id} again.`;
    }
    // The open todo list is NOT echoed here: the list reaches the agent through
    // the todo project-context populator (buildTodoMessages) and the explicit
    // /todos slash command. Only the touched item + its new hash is returned.
    ctx.core.brief('info', 'todo_update', `${status} #${updated.id}: ${safeName}`);

    return `Updated todo #${updated.id}
  name: ${safeName}
  done: ${updated.done}${safeNote ? `\n  note: ${safeNote}` : ''}
  hash: ${updated.hash}`;
  },
};
