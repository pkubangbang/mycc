/**
 * todo_update.ts - Update an existing todo item
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const todoUpdateTool: ToolDefinition = {
  name: 'todo_update',
  description: 'Update an existing todo item by id. You MUST provide the item\'s current hash — the update is rejected if the hash doesn\'t match (prevents stale updates). Get the hash from todo_create output or the todo list.',
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
        description: 'Whether the item is completed',
      },
      note: {
        type: 'string',
        description: 'Optional note for the item',
      },
    },
    required: ['id', 'hash', 'name', 'done'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const id = args.id as number;
    const hash = args.hash as string;
    const name = args.name as string;
    const done = args.done as boolean;
    const note = args.note as string | undefined;

    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      return 'Error: id must be a positive integer.';
    }

    if (!hash || typeof hash !== 'string' || hash.trim() === '') {
      return 'Error: hash is required and must be a non-empty string.';
    }

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return 'Error: name is required and must be a non-empty string.';
    }

    if (typeof done !== 'boolean') {
      return 'Error: done must be a boolean.';
    }

    const updated = ctx.todo.updateTodo(id, hash.trim(), name.trim(), done, note?.trim() || undefined);

    if (!updated) {
      // Check if id doesn't exist vs hash mismatch
      const items = ctx.todo.getItems();
      const exists = items.some((i) => i.id === id);
      if (!exists) {
        return `Error: Todo item #${id} not found. Use the current todo list to find the correct id.`;
      }
      // Hash mismatch — the item exists but was updated since the LLM last
      // read it. Try to resolve the stale hash against the item's lineage
      // ring: if the stale hash was a PREVIOUS hash of this (or another live)
      // item, emit a warm hint with the CURRENT hash so the LLM can retry this
      // same turn instead of waiting for the next nudge to re-surface it.
      // The WRITE was already rejected by updateTodo — the lineage lookup is
      // observation-only and does NOT apply the stale write.
      const lineageMatch = ctx.todo.findByPreviousHash(hash.trim());
      if (lineageMatch) {
        return `Error: Hash mismatch for todo #${id}. This item was updated since you last saw it — the current hash is ${lineageMatch.hash}. Retry todo_update with the current hash.`;
      }
      return `Error: Hash mismatch for todo #${id}. The item may have been updated since you last read it. Check the current todo list for the latest hash.`;
    }

    const status = updated.done ? 'completed' : 'updated';
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
      ctx.core.brief('info', 'todo_update', `completed #${updated.id}: ${updated.name} (auto-cleared)`);
      return `Completed todo #${updated.id} (${updated.name}) — this was the last open item, so every
non-pinned todo was AUTO-CLEARED. ${pinnedNote}
  The item and its hash no longer exist; do not try to update #${updated.id} again.`;
    }
    // The open todo list is NOT echoed here: the list reaches the agent through
    // the todo project-context populator (buildTodoMessages) and the explicit
    // /todos slash command. Only the touched item + its new hash is returned.
    ctx.core.brief('info', 'todo_update', `${status} #${updated.id}: ${updated.name}`);

    return `Updated todo #${updated.id}
  name: ${updated.name}
  done: ${updated.done}${updated.note ? `\n  note: ${updated.note}` : ''}
  hash: ${updated.hash}`;
  },
};
