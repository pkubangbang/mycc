import type { TodoItem } from '../../types.js';

/**
 * Render free-form todo fields safely in a single transcript/prompt line.
 *
 * Stored values are left intact. Rendering collapses whitespace and replaces
 * control characters so names, notes, and stop-guard text cannot forge extra
 * todo rows or prompt sections. This intentionally does not truncate: call
 * sites that need a bounded analysis field can apply their own explicit budget.
 */
export function sanitizeTodoField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const flat = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat || undefined;
}

/** Authoritative, single-row details used when a hash-guarded write is stale. */
export function renderTodoItemDetails(item: TodoItem): string {
  const name = sanitizeTodoField(item.name) ?? '(unnamed)';
  const note = sanitizeTodoField(item.note);
  const preventStop = sanitizeTodoField(item.preventStop);
  const lines = [
    `  id: ${item.id}`,
    `  name: ${name}`,
    `  done: ${item.done}`,
  ];
  if (note) lines.push(`  note: ${note}`);
  lines.push(`  pinned: ${item.pinned === true}`);
  if (preventStop) lines.push(`  preventStop: ${preventStop}`);
  lines.push(`  hash: ${item.hash}`);
  return lines.join('\n');
}
