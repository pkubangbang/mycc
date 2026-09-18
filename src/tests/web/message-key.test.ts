/**
 * message-key.test.ts - unit tests for the stable + strictly-unique v-for key
 *
 * messageKey() is extracted from ChatLog.vue into a pure module so the key
 * invariants are testable in node (a .vue SFC is not importable here). Two
 * invariants:
 *   1. STABILITY — a message with an id keeps the SAME key regardless of its
 *      rendered-window index. loadMore() prepends older messages and shifts
 *      every index; an id-based key must not change, or Vue recreates the
 *      component and loses MessageItem local state (copied, timers).
 *   2. STRICT UNIQUENESS — even without an id, two messages sharing the same
 *      timestamp + label get distinct keys (index tiebreaker). Vue treats
 *      v-for keys as an identity invariant, not something to tolerate
 *      collisions on.
 */
import { describe, it, expect } from 'vitest';
import { messageKey } from '../../web/src/message-key.js';
import type { ChatMessage } from '../../web/src/types.js';

function mk(partial: Partial<ChatMessage>): ChatMessage {
  return { type: 'user', content: '', ...partial };
}

describe('messageKey — id primary (stability)', () => {
  it('uses "id:<id>" when id is present', () => {
    const m = mk({ id: 42, timestamp: 1000, label: 'assistant' });
    expect(messageKey(m, 3)).toBe('id:42');
  });

  it('is stable across index shifts (the loadMore prepend case)', () => {
    // The same message rendered at index 2, then at index 22 after 20 older
    // messages are prepended, MUST keep the same key — otherwise Vue sees it
    // as a new component and destroys/recreates it (losing local state).
    const m = mk({ id: 7, timestamp: 1000, label: 'assistant' });
    expect(messageKey(m, 2)).toBe(messageKey(m, 22));
    expect(messageKey(m, 2)).toBe('id:7');
  });

  it('ignores timestamp/label when id is present (id wins)', () => {
    const a = mk({ id: 1, timestamp: 1000, label: 'brief' });
    const b = mk({ id: 2, timestamp: 1000, label: 'brief' });
    // Same ts+label, different id → distinct keys (and stable).
    expect(messageKey(a, 0)).toBe('id:1');
    expect(messageKey(b, 1)).toBe('id:2');
    expect(messageKey(a, 0)).not.toBe(messageKey(b, 1));
  });
});

describe('messageKey — fallback (no id, strict uniqueness)', () => {
  it('falls back to timestamp + label + index when no id but both present', () => {
    const m = mk({ timestamp: 1723391724123, label: 'assistant' });
    expect(messageKey(m, 3)).toBe('1723391724123 assistant #3');
  });

  it('falls back to timestamp + index when label is absent', () => {
    const m = mk({ timestamp: 1723391724123 });
    expect(messageKey(m, 7)).toBe('1723391724123 #7');
  });

  it('falls back to label + index when timestamp is absent', () => {
    const m = mk({ label: 'bash' });
    expect(messageKey(m, 2)).toBe('bash #2');
  });

  it('falls back to just the index when nothing is present', () => {
    const m = mk({});
    expect(messageKey(m, 5)).toBe('#5');
  });

  it('is strictly unique for two id-less messages with identical timestamp + label', () => {
    // The case the PR review flagged: the old "<ts> <label>" key (no index)
    // collided here. With the index tiebreaker the two keys MUST differ.
    const a = mk({ timestamp: 1000, label: 'brief' });
    const b = mk({ timestamp: 1000, label: 'brief' });
    expect(messageKey(a, 0)).not.toBe(messageKey(b, 1));
  });

  it('produces all-distinct fallback keys across a list with repeated stamps/labels', () => {
    const list: ChatMessage[] = Array.from({ length: 5 }, () =>
      mk({ timestamp: 999, label: 'brief' }),
    );
    const keys = list.map((m, i) => messageKey(m, i));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('messageKey — mixed list (id + fallback)', () => {
  it('a mixed list yields all-distinct keys', () => {
    // Live message with id, plus two id-less history messages sharing ts+label.
    const list: ChatMessage[] = [
      mk({ id: 100, timestamp: 1, label: 'a' }),
      mk({ timestamp: 2, label: 'b' }),
      mk({ timestamp: 2, label: 'b' }), // same ts+label as above → index breaks tie
      mk({ id: 101, timestamp: 2, label: 'b' }), // same ts+label but distinct id
    ];
    const keys = list.map((m, i) => messageKey(m, i));
    expect(new Set(keys).size).toBe(keys.length);
  });
});