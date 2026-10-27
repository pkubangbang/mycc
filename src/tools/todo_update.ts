/**
 * todo_update.ts - Update an existing todo item
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

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

    // `done` is OPTIONAL: omission means "leave the completion state alone".
    //
    // WHY (transcript-verified defect, issue #6). The schema declared `done`
    // required, so a note-only update had to restate it — and a real call omitted
    // it entirely (arguments carried id/hash/name/note, no `done`), producing the
    // hard error "done must be a boolean." That error taught the model the update
    // path was closed, so it created a COPY of the item and closed the copy
    // instead, leaving the original open and stale. A legitimate update must
    // never be rejected for not repeating state the module already holds: we
    // read the current value off the item (which the hash gate has not yet
    // proven live, so the mismatch path below is unchanged).
    let done: boolean;
    if (doneArg === undefined) {
      const current = ctx.todo.getItems().find((i) => i.id === id);
      if (!current) {
        return `Error: Todo item #${id} not found. Use the current todo list to find the correct id.`;
      }
      done = current.done;
    } else if (typeof doneArg !== 'boolean') {
      return 'Error: done must be a boolean (omit it to keep the current value).';
    } else {
      done = doneArg;
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
    ctx.core.brief('info', 'todo_update', ctx.todo.printTodoList(), `${status} #${updated.id}: ${updated.name}`);

    return `Updated todo #${updated.id}
  name: ${updated.name}
  done: ${updated.done}${updated.note ? `\n  note: ${updated.note}` : ''}
  hash: ${updated.hash}

${ctx.todo.printTodoList()}`;
  },
};
