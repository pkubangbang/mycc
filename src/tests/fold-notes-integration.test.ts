/**
 * fold-notes-integration.test.ts — the fold as seen THROUGH the outbound
 * chokepoint `MessageStore.getFullMessages()` (docs/loop/note-taxonomy.md §10
 * item 2: "after three consecutive passes, the outbound projection contains
 * complete content only for the current pass's nudge").
 *
 * The unit suite (fold-notes.test.ts) pins `foldStaleNudges` in isolation. This
 * file pins the WIRING: that the projection actually runs inside
 * getFullMessages(), that it leaves the store, `length`, `tokenCount` and the
 * raw array untouched, and that a surviving (non-foldable) note is still
 * delivered verbatim after the same three passes.
 */
import { describe, it, expect } from 'vitest';
import { MessageStore } from '../loop/triologue/store.js';
import { FOLDED_NUDGE_TEXT } from '../loop/triologue/fold-notes.js';
import type { Message } from '../types.js';

const providerContents = (store: MessageStore): string[] =>
  store.getFullMessages().map((m) => String(m.content ?? ''));

/** One COLLECT pass: the model works (assistant rows) and COLLECT appends a nudge. */
function pass(store: MessageStore, nudgeBody: string): void {
  store.push({ role: 'assistant', content: `working (${nudgeBody})` });
  store.push({ role: 'tool', content: 'result', tool_name: 'bash' } as Message);
  store.push({ role: 'user', content: `[NUDGE] ${nudgeBody}` });
}

describe('foldStaleNudges wired into MessageStore.getFullMessages', () => {
  it('exposes full content only for the current pass after three passes', () => {
    const store = new MessageStore();
    store.setSystemPrompt('sys');
    pass(store, 'nudge-1');
    pass(store, 'nudge-2');
    pass(store, 'nudge-3');

    const out = providerContents(store);

    // Passes 1 and 2 are superseded; pass 3 is still current.
    expect(out).toContain('[NUDGE] nudge-3');
    expect(out).not.toContain('[NUDGE] nudge-1');
    expect(out).not.toContain('[NUDGE] nudge-2');
    // Structure is preserved: system row + 9 conversation rows.
    expect(out.length).toBe(1 + 9);
    expect(store.length).toBe(9);
    expect(store.getRaw().map((m) => m.role)).toEqual([
      'assistant', 'tool', 'user',
      'assistant', 'tool', 'user',
      'assistant', 'tool', 'user'
    ]);
  });

  it('replaces exactly two of the three nudges with the fixed placeholder', () => {
    const store = new MessageStore();
    pass(store, 'nudge-1');
    pass(store, 'nudge-2');
    pass(store, 'nudge-3');

    const folded = providerContents(store).filter((c) => c === FOLDED_NUDGE_TEXT);
    expect(folded.length).toBe(2);
  });

  it('does not mutate the store, length, raw content or tokenCount', () => {
    const store = new MessageStore();
    pass(store, 'nudge-1');
    pass(store, 'nudge-2');
    store.recomputeTokenCount();

    const rawBefore = store.getRaw().map((m) => m.content);
    const tokensBefore = store.tokenCount;
    const lengthBefore = store.length;

    store.getFullMessages();
    store.getFullMessages();

    expect(store.getRaw().map((m) => m.content)).toEqual(rawBefore);
    expect(store.tokenCount).toBe(tokensBefore);
    expect(store.length).toBe(lengthBefore);
    expect(store.getRaw()[2].content).toBe('[NUDGE] nudge-1');
  });

  it('never folds a REMINDER note sitting through the same three passes', () => {
    const store = new MessageStore();
    store.push({ role: 'assistant', content: 'a1' });
    store.push({ role: 'user', content: '[REMINDER] steer: use tabs' });
    pass(store, 'nudge-1');
    pass(store, 'nudge-2');

    const out = providerContents(store);
    // The REMINDER survives verbatim even though two assistant rows follow it.
    expect(out).toContain('[REMINDER] steer: use tabs');
    // Only the NUDGE rows fold — here just pass 1's nudge is stale (pass 2's
    // is still current), so exactly one placeholder appears.
    expect(out.filter((c) => c === FOLDED_NUDGE_TEXT).length).toBe(1);
    expect(out.filter((c) => c.startsWith('[REMINDER]')).length).toBe(1);
  });

  it('folds a stale nudge even when MAIL and HINT notes follow it', () => {
    const store = new MessageStore();
    store.push({ role: 'assistant', content: 'a1' });
    store.push({ role: 'user', content: '[NUDGE] stale one' });
    store.push({ role: 'assistant', content: 'a2' });
    store.push({ role: 'user', content: '[MAIL] hello' });
    store.push({ role: 'assistant', content: 'a3' });
    store.push({ role: 'user', content: '[HINT] Problem Analysis: x' });

    const out = providerContents(store);
    expect(out).toContain(FOLDED_NUDGE_TEXT);
    expect(out).toContain('[MAIL] hello');
    expect(out).toContain('[HINT] Problem Analysis: x');
  });
});
