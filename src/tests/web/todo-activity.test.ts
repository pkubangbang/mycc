/**
 * todo-activity.test.ts - L2 unit tests for the todo-event classifier
 *
 * `components/todo-activity.ts` is the single source of truth for how the
 * WebUI renders todo tool activity: WHICH log labels are todo events, HOW one
 * is displayed (icon + text), and which transcript `result` bubble stands for
 * a todo tool result.
 *
 * The regression this suite locks down (commit 3b6c8bf): the todo tools moved
 * `printTodoList()` OFF the brief, leaving `content` = "Created #1: <name>" and
 * no `detail`. The WebUI still treated the label as a snapshot carrier, so
 * every todo event rendered as an empty pill. These tests assert the event is
 * recovered from the brief's message (and that an empty body yields NO pill
 * rather than a blank one).
 */
import { describe, it, expect } from 'vitest';
import {
  TODO_EVENT_LABELS,
  isTodoEventLog,
  describeTodoEvent,
  todoEventFromLog,
} from '../../web/src/components/todo-activity.js';
import type { ChatMessage } from '../../web/src/types.js';

/** A live todo brief: what `agentIO.brief` → `hub.broadcast` produces. */
function briefMsg(label: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { type: 'log', label, content, id: 7, timestamp: 1719000000000, ...extra };
}

describe('TODO_EVENT_LABELS', () => {
  it('covers exactly the three todo tools', () => {
    expect([...TODO_EVENT_LABELS].sort()).toEqual(['todo_create', 'todo_pinning', 'todo_update']);
  });
});

describe('isTodoEventLog', () => {
  it('accepts a labeled log from a todo tool', () => {
    expect(isTodoEventLog(briefMsg('todo_create', 'Created #1: x'))).toBe(true);
  });

  it('rejects a non-log, an unlabeled log, and a foreign label', () => {
    expect(isTodoEventLog({ type: 'result', content: 'Created todo #1', label: 'todo_create' })).toBe(false);
    expect(isTodoEventLog({ type: 'log', content: 'plain tool output' })).toBe(false);
    expect(isTodoEventLog(briefMsg('bash', 'ls'))).toBe(false);
  });

  it('rejects null / undefined', () => {
    expect(isTodoEventLog(null)).toBe(false);
    expect(isTodoEventLog(undefined)).toBe(false);
  });
});

describe('describeTodoEvent', () => {
  it('recovers a created todo from the brief CONTENT (no detail — the 3b6c8bf shape)', () => {
    const ev = describeTodoEvent(briefMsg('todo_create', 'Created #1: backfill authorId'));
    expect(ev).toEqual({
      id: 7,
      op: 'todo_create',
      icon: '☐',
      text: 'Created #1: backfill authorId',
      done: false,
    });
  });

  it('marks a completion as done with a checked icon', () => {
    const ev = describeTodoEvent(briefMsg('todo_update', 'completed #2: add tests'));
    expect(ev?.done).toBe(true);
    expect(ev?.icon).toBe('☑');
  });

  it('does NOT treat a plain update as done', () => {
    const ev = describeTodoEvent(briefMsg('todo_update', 'updated #2: add tests'));
    expect(ev?.done).toBe(false);
    expect(ev?.icon).toBe('☐');
  });

  it('uses the pin glyph for pinning and unpinning', () => {
    expect(describeTodoEvent(briefMsg('todo_pinning', 'pinned #3: guard'))?.icon).toBe('📌');
    expect(describeTodoEvent(briefMsg('todo_pinning', 'unpinned #3: guard'))?.icon).toBe('📌');
  });

  it('returns null for an EMPTY brief body instead of rendering a blank pill', () => {
    expect(describeTodoEvent(briefMsg('todo_create', ''))).toBeNull();
    expect(describeTodoEvent(briefMsg('todo_create', '   \n  '))).toBeNull();
  });

  it('falls back to detail when content is empty (legacy 4th-arg callers)', () => {
    const ev = describeTodoEvent(briefMsg('todo_create', '', { detail: 'Created #1: legacy' }));
    expect(ev?.text).toBe('Created #1: legacy');
  });

  it('collapses a multi-line body to its first non-empty line', () => {
    const ev = describeTodoEvent(briefMsg('todo_create', '\nCreated #1: x\nTodo list:\n  [ ] 1. y'));
    expect(ev?.text).toBe('Created #1: x');
  });

  it('returns null for a non-todo message', () => {
    expect(describeTodoEvent(briefMsg('bash', 'ls -la'))).toBeNull();
  });

  it('keys on the message id, falling back to its timestamp', () => {
    expect(describeTodoEvent(briefMsg('todo_create', 'Created #1: x'))?.id).toBe(7);
    const noId = { type: 'log' as const, label: 'todo_create', content: 'Created #1: x', timestamp: 42 };
    expect(describeTodoEvent(noId)?.id).toBe(42);
  });
});

describe('todoEventFromLog (transcript-loaded tool results)', () => {
  it('recognises a created-todo result by its first line', () => {
    const msg: ChatMessage = { type: 'result', content: 'Created todo #4\n  name: x\n  done: false', id: 9 };
    expect(todoEventFromLog(msg)).toMatchObject({ op: 'todo_create', icon: '☐', text: 'Created todo #4', id: 9 });
  });

  it('distinguishes pinned / unpinned / updated results', () => {
    const res = (first: string): ChatMessage => ({ type: 'result', content: `${first}\n  name: x` });
    expect(todoEventFromLog(res('Pinned todo #4'))?.op).toBe('todo_pinning');
    expect(todoEventFromLog(res('Unpinned todo #4'))?.icon).toBe('📌');
    expect(todoEventFromLog(res('Updated todo #4'))?.op).toBe('todo_update');
  });

  it('rejects assistant replies and non-todo tool results', () => {
    expect(todoEventFromLog({ type: 'result', content: 'Done — I created the file.' })).toBeNull();
    expect(todoEventFromLog({ type: 'result', content: 'Error: name is required' })).toBeNull();
    expect(todoEventFromLog({ type: 'log', content: 'Created todo #1' })).toBeNull();
  });
});
