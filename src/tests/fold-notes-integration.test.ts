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

/**
 * /token must measure what the LLM sees: the conversation share and the
 * `messages` count come from the FOLDED projection, never from the raw array.
 * A fold that /token cannot see would make the budget report disagree with the
 * very payload it claims to describe.
 */
const nudge = (body: string): Message =>
  ({ role: 'user', content: `[NUDGE] ${body}` }) as Message;
const assistant = (content: string): Message => ({ role: 'assistant', content }) as Message;

describe('token accounting reads the folded projection', () => {
  it('getConversationForProvider() excludes stale nudge text', () => {
    const store = new MessageStore();
    store.push(assistant('a0'));
    store.push(nudge(`nudge-1 ${'x'.repeat(400)}`));
    // One later assistant row is what makes the first nudge stale
    // (STALE_ASSISTANT_ROWS = 1).
    store.push(assistant('a1'));

    const raw = store.getRaw();
    const outbound = store.getConversationForProvider();

    // Same rows, same order — only the stale nudge's content differs.
    expect(outbound.length).toBe(raw.length);
    expect(outbound.map((m) => m.role)).toEqual(raw.map((m) => m.role));
    expect(outbound.map((m) => m.content)).toContain(FOLDED_NUDGE_TEXT);
    // The 400-char body is gone from the outbound view, still present raw.
    expect(outbound.some((m) => String(m.content).includes('xxxx'))).toBe(false);
    expect(raw.some((m) => String(m.content).includes('xxxx'))).toBe(true);
  });

  it('keeps a nudge that no later assistant row has superseded', () => {
    const store = new MessageStore();
    store.push(assistant('a0'));
    store.push(nudge('current-1'));

    expect(store.getConversationForProvider().map((m) => m.content)).toContain('[NUDGE] current-1');
  });

  it('getContextBudget reports the folded conversation, not the raw one', async () => {
    const { Triologue } = await import('../loop/triologue.js');
    const { estimateTokensForMessages } = await import('../utils/token.js');
    const t = new Triologue({ tokenThreshold: 50000 });
    t.user('go');
    t.agent('a1');
    t.note('NUDGE', `big ${'y'.repeat(400)}`);
    t.agent('a2');
    t.note('NUDGE', 'small');
    t.agent('a3');

    const budget = t.getContextBudget([]);
    const raw = estimateTokensForMessages(t.getMessagesRaw());
    // The fold's effect, measured on the outbound payload: the /token figure
    // must describe the conversation the model sees, not the raw array.
    const folded = estimateTokensForMessages(t.getMessages()) - budget.projectContext;

    expect(budget.conversation).toBe(folded);
    expect(budget.conversation).toBeLessThan(raw);
  });
});
