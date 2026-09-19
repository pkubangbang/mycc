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

// ── loadMore anchor contract (peer-review regression #28 / #26) ──
//
// ChatLog.vue's loadMore() scroll-anchoring captures the FIRST visible
// message as the anchor, then after prepending older messages relocates it
// in the DOM by its data-msg-key to restore its viewport offset. The anchor
// is visibleMessages[0], so at CAPTURE time its v-for index is 0 and the
// captured key is messageKey(anchorMsg, 0). After the prepend the SAME
// message sits at a higher v-for index k (older rows were prepended above
// it), so the DOM emits messageKey(anchorMsg, k). The captured key locates
// the element after the re-render ONLY IF the key is index-independent.
//
// These tests pin that contract directly: an id-bearing anchor's key is
// identical at index 0 (capture) and index k (post-prepend DOM), so the
// querySelector lookup succeeds; an id-LESS anchor's fallback key embeds
// the window-relative index and so DIFFERS across the shift — which is why
// loadMore's anchor RELIES on the id guarantee (both store entry paths,
// fetchHistory + hydrateFromCache, assign a nextId() to every message,
// making id-less messages unreachable in the rendered list). The id-less
// case is asserted here to document the trap, not to require a fix — the
// guarantee that makes it dead is what the anchor depends on.
describe('messageKey — loadMore anchor key stable across a window shift (#26/#28)', () => {
  it('id-bearing anchor: key at capture (index 0) === key after prepend (index k)', () => {
    // The anchor is the first visible message. loadMore prepends, say, 20
    // older rows, so the anchor's v-for index moves 0 → 20. Its key MUST be
    // the same so the querySelector('[data-msg-key="..."]') in loadMore's
    // nextTick still finds it.
    const anchor = mk({ id: 55, timestamp: 1000, label: 'assistant' });
    const captured = messageKey(anchor, 0); // capture-time key
    const domAfter = messageKey(anchor, 20); // post-prepend DOM key
    expect(captured).toBe(domAfter);
    expect(captured).toBe('id:55');
  });

  it('id-bearing anchor stays stable for an arbitrary shift amount', () => {
    // Pin the property for a range of prepend sizes so a future change to
    // the id-key format (e.g. accidentally folding in the index) is caught.
    const anchor = mk({ id: 9, timestamp: 5, label: 'user' });
    const captured = messageKey(anchor, 0);
    for (const shift of [1, 5, 20, 100, 999]) {
      expect(messageKey(anchor, shift)).toBe(captured);
    }
  });

  it('id-LESS anchor: fallback key CHANGES across the shift (the trap, documented)', () => {
    // The id-less fallback key embeds the window-relative index, so the
    // capture-time key "#0" does NOT equal the post-prepend DOM key "#k".
    // This is why loadMore's anchor cannot rely on the fallback path — and
    // why the store's id guarantee (every rendered message is id-bearing)
    // is loadMore's correctness precondition, not just an optimization.
    // This test documents the instability; it is NOT a bug to fix.
    const anchor = mk({ timestamp: 1000, label: 'assistant' }); // no id
    const captured = messageKey(anchor, 0);
    const domAfter = messageKey(anchor, 20);
    expect(captured).not.toBe(domAfter);
    expect(captured).toBe('1000 assistant #0');
    expect(domAfter).toBe('1000 assistant #20');
  });

  it('the anchor contract holds for the realistic mixed window (id anchor + id-less tail)', () => {
    // A realistic visible window: older id-bearing history at the top (the
    // anchor) plus a couple of id-less entries that predate the id scheme
    // below it. loadMore anchors on visibleMessages[0] (the id-bearing
    // oldest), so its key survives the prepend regardless of the id-less
    // entries below — the contract the runtime actually exercises.
    const window = [
      mk({ id: 1, timestamp: 10, label: 'assistant' }), // anchor (index 0)
      mk({ id: 2, timestamp: 20, label: 'user' }),
      mk({ timestamp: 30, label: 'brief' }), // id-less, below the anchor
      mk({ timestamp: 40, label: 'result' }), // id-less, below the anchor
    ];
    const anchor = window[0];
    const captured = messageKey(anchor, 0);
    // After a 20-row prepend the anchor moves to index 20; the id-less
    // entries move to 21/22 but the anchor's key is unchanged.
    expect(messageKey(anchor, 20)).toBe(captured);
    // And the anchor's key stays distinct from every other row's key both
    // before and after the shift (no accidental collision in the lookup).
    const beforeKeys = window.map((m, i) => messageKey(m, i));
    const afterKeys = window.map((m, i) => messageKey(m, i + 20));
    expect(beforeKeys.includes(captured)).toBe(true);
    expect(afterKeys.includes(captured)).toBe(true);
    expect(new Set(afterKeys).size).toBe(afterKeys.length);
  });
});