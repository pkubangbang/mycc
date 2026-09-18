/**
 * message-key.test.ts - unit tests for the strictly-unique v-for key helper
 *
 * messageKey() is extracted from ChatLog.vue into a pure module so the
 * uniqueness invariant is testable in node (a .vue SFC is not importable
 * here). Vue treats v-for `:key` as an identity invariant — a DUPLICATE key
 * causes render/DOM-patch bugs (swapped components, lost state), so the key
 * must be strictly unique within the rendered list, not merely "very likely
 * unique". These tests pin that invariant, including the case the PR review
 * flagged: two messages with an identical `timestamp + label`.
 */
import { describe, it, expect } from 'vitest';
import { messageKey } from '../../web/src/message-key.js';
import type { ChatMessage } from '../../web/src/types.js';

function mk(partial: Partial<ChatMessage>): ChatMessage {
  return { type: 'user', content: '', ...partial };
}

describe('messageKey', () => {
  it('combines timestamp + label + index when both are present', () => {
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

  it('falls back to just the index when neither timestamp nor label', () => {
    const m = mk({});
    expect(messageKey(m, 5)).toBe('#5');
  });

  it('is strictly unique for two messages with identical timestamp + label', () => {
    // The case the PR review flagged: the old "<ts> <label>" key (no index)
    // collided here. With the index tiebreaker the two keys MUST differ.
    const a = mk({ timestamp: 1000, label: 'brief' });
    const b = mk({ timestamp: 1000, label: 'brief' });
    expect(messageKey(a, 0)).not.toBe(messageKey(b, 1));
  });

  it('produces all-distinct keys across a list with repeated stamps/labels', () => {
    // Simulate a rendered window where several messages share the same ms
    // and label (e.g. a burst of brief() status lines). Every key must be
    // unique across the whole list — the v-for identity invariant.
    const list: ChatMessage[] = Array.from({ length: 5 }, () =>
      mk({ timestamp: 999, label: 'brief' }),
    );
    const keys = list.map((m, i) => messageKey(m, i));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is stable (same message + index → same key)', () => {
    const m = mk({ timestamp: 5, label: 'tool' });
    expect(messageKey(m, 4)).toBe(messageKey(m, 4));
  });

  it('differs across distinct indices even with no timestamp/label', () => {
    // The bare-index fallback path must still be unique per index.
    const a = mk({});
    const b = mk({});
    expect(messageKey(a, 0)).not.toBe(messageKey(b, 1));
  });
});