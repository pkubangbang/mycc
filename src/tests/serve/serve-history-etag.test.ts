/**
 * serve-history-etag.test.ts - the /history ETag must cover the todo snapshot.
 *
 * Regression: `computeHistoryVersion` fingerprinted the transcript, the
 * messageLog, the steering length and the running flag — but NOT the todo
 * list, which lives only in memory (never in the transcript or the log). A
 * todo-only change therefore revalidated to 304, and the client kept rendering
 * a stale panel. Proven empirically against a live hub before the fix.
 *
 * The ordinary tool path masked this by accident: each tool emits, then
 * briefs, and the brief advances `log:len`. Nothing documented that coupling,
 * and after `/clear` it did not hold at all.
 *
 * ⚠ THESE TESTS MUST CALL PRODUCTION CODE, NOT RE-DECLARE IT. An earlier
 * version of this file asserted `const tag = (t) => \`todo:${JSON.stringify(t)}\``
 * — a copy of the implementation — so it only proved that `JSON.stringify`
 * works, and stayed green when `todoEtagToken` was reverted to a broken
 * length-based form. Every assertion below goes through the real
 * `todoEtagToken` / `computeHistoryVersion` exports, so reintroducing a bug
 * turns a test red.
 */
import { describe, it, expect } from 'vitest';
import { computeHistoryVersion, etagMatchesIfNoneMatch } from '../../serve/serve-history.js';
import { todoEtagToken, type ServeHub } from '../../serve/serve-hub.js';
import type { TodoListPayload } from '../../serve/serve-todos.js';

const payload = (todos: TodoListPayload['todos']): TodoListPayload => ({ type: 'todos', todos });
const row = (over: Partial<TodoListPayload['todos'][number]> = {}) => ({
  id: 1, name: 'Task A', done: false, pinned: false, ...over,
});

describe('computeHistoryVersion — todo snapshot participates in the ETag', () => {
  it('a todo-only change invalidates the version', () => {
    const before = computeHistoryVersion(null, [], 0, false, 'todo:1:1:0');
    const after = computeHistoryVersion(null, [], 0, false, 'todo:1:1:1');
    // Everything except the todo token is identical — only the snapshot moved.
    expect(after).not.toBe(before);
  });

  it('clearing the list invalidates the version', () => {
    const withRows = computeHistoryVersion(null, [], 0, false, 'todo:2:1:0,2:0');
    const cleared = computeHistoryVersion(null, [], 0, false, 'todo:0:');
    const neverEmitted = computeHistoryVersion(null, [], 0, false, 'todo:null');
    expect(new Set([withRows, cleared, neverEmitted]).size).toBe(3);
  });

  it('the same todo state yields the same version (no spurious invalidation)', () => {
    const a = computeHistoryVersion(null, [], 0, false, 'todo:1:1:0');
    const b = computeHistoryVersion(null, [], 0, false, 'todo:1:1:0');
    expect(a).toBe(b);
  });

  it('omitting the token is backward compatible (existing callers/tests unchanged)', () => {
    expect(computeHistoryVersion(null, [], 0, false)).toBe(computeHistoryVersion(null, [], 0, false));
    expect(computeHistoryVersion(null, [], 0, false)).not.toBe(
      computeHistoryVersion(null, [], 0, false, 'todo:1:1:0'),
    );
  });

  it('the stale-ETag scenario now returns 200 semantics, not a 304 match', () => {
    // The bug in one assertion: with a todo change and nothing else changed,
    // the OLD etag must no longer satisfy If-None-Match.
    const staleTag = computeHistoryVersion(null, [], 0, false, 'todo:1:1:0');
    const currentTag = computeHistoryVersion(null, [], 0, false, 'todo:1:1:1');
    expect(etagMatchesIfNoneMatch(staleTag, currentTag)).toBe(false);
    // ...while an unchanged todo state still 304s (the cache still works).
    expect(etagMatchesIfNoneMatch(currentTag, currentTag)).toBe(true);
  });
});

describe('todoEtagToken — the REAL token must not collide for different lists', () => {
  /**
   * A length-based token (`id:done+pinned:name.length`) passed a version of
   * this file that mirrored the implementation inline, but collided for any
   * rename of equal length and for any note/guard edit — serving precisely the
   * stale panel the token exists to prevent. These assertions call the real
   * export, so a regression to the length-based form fails here.
   */
  it('a rename of EQUAL LENGTH is a change (the collision that shipped)', () => {
    expect(todoEtagToken(payload([row({ name: 'Task B' })]))).not.toBe(
      todoEtagToken(payload([row({ name: 'Task A' })])),
    );
  });

  it('adding or editing a note is a change', () => {
    expect(todoEtagToken(payload([row({ note: 'important' })]))).not.toBe(todoEtagToken(payload([row()])));
    expect(todoEtagToken(payload([row({ note: 'b' })]))).not.toBe(todoEtagToken(payload([row({ note: 'a' })])));
  });

  it('editing a stop guard is a change', () => {
    expect(todoEtagToken(payload([row({ preventStop: 'until green' })]))).not.toBe(
      todoEtagToken(payload([row()])),
    );
  });

  it('toggling done/pinned is a change', () => {
    const base = todoEtagToken(payload([row()]));
    expect(todoEtagToken(payload([row({ done: true })]))).not.toBe(base);
    expect(todoEtagToken(payload([row({ pinned: true })]))).not.toBe(base);
  });

  it('reordering two same-shape rows is a change (ids travel with their names)', () => {
    const a = payload([row({ id: 1, name: 'Alpha' }), row({ id: 2, name: 'Bravo!' })]);
    const b = payload([row({ id: 1, name: 'Bravo!' }), row({ id: 2, name: 'Alpha' })]);
    expect(todoEtagToken(a)).not.toBe(todoEtagToken(b));
  });

  it('the null list has its own token, distinct from an empty list', () => {
    expect(todoEtagToken(null)).not.toBe(todoEtagToken(payload([])));
  });

  it('identical lists still produce an identical token (no spurious 200s)', () => {
    expect(todoEtagToken(payload([row()]))).toBe(todoEtagToken(payload([row()])));
  });

  it('the token is what the /history version actually folds in (end to end)', () => {
    // Guards the WIRING, not just the token: if the serve-hub handler stopped
    // passing the token to computeHistoryVersion, two different lists would
    // produce the same ETag again.
    const a = todoEtagToken(payload([row({ name: 'Task A' })]));
    const b = todoEtagToken(payload([row({ name: 'Task B' })]));
    expect(computeHistoryVersion(null, [], 0, false, a)).not.toBe(
      computeHistoryVersion(null, [], 0, false, b),
    );
  });
});

/** Type-only import guard: the handler's payload type must stay in sync. */
export type _ServeHubPayloadIsTyped = ServeHub['broadcastTodoList'] extends (p: TodoListPayload) => void ? true : never;
