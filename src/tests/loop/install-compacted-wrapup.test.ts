/**
 * install-compacted-wrapup.test.ts - observable regression test for the
 * stale-wrapUpMark hazard that installCompacted's wrapUp.reset() guards.
 *
 * Scenario: a wrap-up turn is live (wrapUpMark set at the store length), then
 * installCompacted() replaces the store with a SHORTER summary triple. Without
 * the reset inside installCompacted, a later rollbackWrapUp() would do
 * `messages.length = <stale mark>` on the short array, stretching it with
 * undefined sparse holes and crashing raw readers.
 *
 * Assertions are observable, not internal (per peer review): after
 * installCompacted + rollbackWrapUp, getMessages() contains no undefined/hole
 * entries and minifyMessages(getFullMessages()) completes.
 */

import { describe, it, expect } from 'vitest';
import { Triologue } from '../../loop/triologue.js';
import { minifyMessages } from '../../utils/llm-chat-minifier.js';
import type { Message, ToolCall } from '../../types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}
// Ollama's ToolCall has no `id`; mycc's ToolCall adds it, so a tool_calls
// literal carrying an id needs the cast.

describe('installCompacted + wrap-up mark lifecycle', () => {
  const triple: Message[] = [
    userMsg('[summary] archived'),
    { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'brief', arguments: {} } } as ToolCall] },
    { role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: 'x' },
  ];

  function buildSixMsgTriologue(): Triologue {
    const triologue = new Triologue({ tokenThreshold: 50000, resultThreshold: 100000 });
    triologue.user('q1');
    triologue.agent('a1');
    triologue.user('q2');
    triologue.agent('a2');
    triologue.user('q3');
    triologue.agent('a3');
    return triologue;
  }

  it('clears the live wrap-up mark (isActive false) after a full install', () => {
    const triologue = buildSixMsgTriologue();
    triologue.beginWrapUp();
    expect(triologue.hasActiveWrapUp()).toBe(true);

    triologue.installCompacted(triple);

    // Direct assertion of the invariant wrapUp.reset() provides. This FAILS
    // under the mutation that removes `this.wrapUp.reset()` from
    // installCompacted (peer mutation check), unlike hole-counting alone.
    expect(triologue.hasActiveWrapUp()).toBe(false);

    // rollbackWrapUp is now a no-op; store unchanged and hole-free.
    const before = triologue.getMessages();
    triologue.rollbackWrapUp();
    const after = triologue.getMessages();
    expect(after.length).toBe(before.length);
    for (const m of after) {
      expect(m && typeof m === 'object' && typeof m.role === 'string').toBe(true);
    }
    expect(() => minifyMessages(after)).not.toThrow();
  });

  it('segment install with tailFrom: splices only when the candidate ends on tool', () => {
    const build = () => {
      const t = new Triologue({ tokenThreshold: 50000, resultThreshold: 100000 });
      t.user('q1');
      t.agent('a1');
      t.user('q2');
      t.agent('a2');
      return t; // 4 messages, ends on assistant
    };
    // tail from 4 = [] → candidate is just the triple (ends on tool) → installed
    const t1 = build();
    expect(t1.installCompacted(triple, 4)).toBe(true);
    expect(t1.getMessages().length).toBe(3);

    const t2 = build();
    t2.user('q3'); // 5 messages; tail from 4 = [q3] ends on user → refused
    expect(t2.installCompacted(triple, 4)).toBe(false);
    expect(t2.getMessages().length).toBe(5); // store untouched
  });

  it('segment install while a wrap-up turn is live: refused, store + mark untouched', () => {
    // beginWrapUp appends a WRAP_UP user message at the end, so any tail splice
    // that keeps the store end includes that user role → candidate ends on
    // `user` → parity pre-check refuses (all-or-nothing: store untouched,
    // wrap-up mark stays active).
    const triologue = buildSixMsgTriologue();
    triologue.beginWrapUp();
    expect(triologue.hasActiveWrapUp()).toBe(true);

    const ok = triologue.installCompacted(triple, 4);
    expect(ok).toBe(false);
    expect(triologue.hasActiveWrapUp()).toBe(true);
    expect(triologue.getMessages().length).toBe(7); // unchanged

    // A full install (no tailFrom) still ends on the triple's tool role and
    // clears the mark.
    expect(triologue.installCompacted(triple)).toBe(true);
    expect(triologue.hasActiveWrapUp()).toBe(false);
  });
});
