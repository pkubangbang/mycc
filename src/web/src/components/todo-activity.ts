/**
 * todo-activity.ts - todo brief → displayable todo event (PURE, node-testable)
 *
 * The three todo tools (`todo_create` / `todo_update` / `todo_pinning`) emit
 * ONE user-facing brief per mutation (`src/tools/todo_*.ts`):
 *
 *   ctx.core.brief('info', 'todo_create', 'Created #1: <name>')
 *   ctx.core.brief('info', 'todo_update', 'updated #1: <name>' | 'completed #1: <name>')
 *   ctx.core.brief('info', 'todo_pinning', 'pinned #1: <name>' | 'unpinned #1: <name>')
 *
 * i.e. the MESSAGE (the brief's content) is the event summary and there is NO
 * `detail` argument. The full `printTodoList()` snapshot is no longer part of
 * the brief at all (commit 3b6c8bf moved the open list onto the project-context
 * populator so the prompt-cache prefix stays stable) — so a renderer must read
 * `content`, and must NOT expect a snapshot there.
 *
 * This module is the single source of truth for:
 *   - WHICH labels are todo events (`TODO_EVENT_LABELS`),
 *   - HOW one is displayed (icon + text) — `describeTodoEvent`,
 *   - which message a live todo event came from (`todoEventFromLog`).
 *
 * It lives outside the .vue SFC so the contract is unit-testable in the
 * existing node-environment Vitest suite (see `src/tests/web/todo-activity.test.ts`).
 * Both consumers use it: `TodoCard.vue` (the floating turn summary) and
 * `MessageItem.vue` (the inline bubble — which renders the same event ONCE
 * instead of the old empty pill).
 */
import type { ChatMessage } from '../types';

/** Labels whose brief is a todo event (the backend contract, matched exactly). */
export const TODO_EVENT_LABELS = new Set(['todo_create', 'todo_update', 'todo_pinning']);

/** A todo event distilled for display. */
export interface TodoEvent {
  /** Stable id for :key — the originating message id, else its timestamp. */
  id: number;
  /** The backend label (`todo_create` | `todo_update` | `todo_pinning`). */
  op: string;
  /** Leading glyph: ☐ open item, ☑ completed item, 📌 pin change. */
  icon: string;
  /** Human-readable summary: the brief text with its leading verb stripped. */
  text: string;
  /** True for a completion (`todo_update` with done=true). */
  done: boolean;
}

/** Is this a live todo event (a labeled log from one of the todo tools)? */
export function isTodoEventLog(msg: ChatMessage | null | undefined): boolean {
  return !!msg && msg.type === 'log' && !!msg.label && TODO_EVENT_LABELS.has(msg.label);
}

/**
 * Distill a live todo `brief()` log. Returns null for anything that is not a
 * todo event, or whose summary is empty.
 *
 * The summary is the brief's `content` (`brief(level, label, message)`);
 * `detail` (the 4th arg) is consulted only as a fallback for callers that pass
 * it there. Multi-line bodies collapse to their first non-empty line — the
 * card renders one line per event.
 */
export function describeTodoEvent(msg: ChatMessage | null | undefined): TodoEvent | null {
  if (!isTodoEventLog(msg)) return null;
  const raw = ((msg as ChatMessage).content ?? '').trim() || ((msg as ChatMessage).detail ?? '').trim();
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (!line) return null;
  const verb = /^(\S+)\s+#\d+:/.exec(line)?.[1] ?? '';
  const done = msg!.label === 'todo_update' && /^completed\b/i.test(verb);
  const icon = msg!.label === 'todo_pinning' ? '📌' : done ? '☑' : '☐';
  return {
    id: typeof msg!.id === 'number' ? msg!.id : (msg!.timestamp ?? 0),
    op: msg!.label!,
    icon,
    text: line,
    done,
  };
}

/**
 * The todo event a raw tool RESULT stands for.
 *
 * Tool results reach the chat log as two different messages depending on the
 * path: a labeled log (`log` + `label`, live via `brief()`) or a plain tool
 * bubble (`result` loaded from the triologue transcript, whose rendered text
 * starts with the tool's own first line, e.g. `Created todo #1`). The latter
 * carries no label, so it is recognised by that documented first line. Returns
 * null when the result is not a todo-tool result.
 */
export function todoEventFromLog(msg: ChatMessage | null | undefined): TodoEvent | null {
  if (!msg || msg.type !== 'result') return null;
  const line = (msg.content ?? '').split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const m = /^(Created|Updated|Pinned|Unpinned) todo #(\d+)/i.exec(line);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const id = Number(m[2]);
  const op = verb === 'created' ? 'todo_create' : verb === 'updated' ? 'todo_update' : 'todo_pinning';
  return {
    id: typeof msg.id === 'number' ? msg.id : (msg.timestamp ?? 0),
    op,
    icon: op === 'todo_pinning' ? '📌' : '☐',
    text: `${m[1]} todo #${id}`,
    done: false,
  };
}

