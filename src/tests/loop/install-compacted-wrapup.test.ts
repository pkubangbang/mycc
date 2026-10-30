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

  it('segment install with tailFrom: splices when the tail does not START with a tool row', () => {
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

    // The tail's LAST role is irrelevant on the splice path: a user query typed
    // while the archive summarized is the normal case, and it must install
    // (peer review: enforcing "ends on tool" here refused the archive exactly
    // when the agent kept working).
    const t2 = build();
    t2.user('q3'); // 5 messages; tail from 4 = [q3]
    expect(t2.installCompacted(triple, 4)).toBe(true);
    expect(t2.getMessages().length).toBe(4);
    expect(t2.getMessages()[3]).toMatchObject({ role: 'user', content: 'q3' });

    // A batch that FOLLOWS the splice point is fine: the splice point is not a
    // tool row, and the tail (assistant → tool) is self-contained.
    const t3 = build();
    t3.agent('', [{ id: 'x', type: 'function', function: { name: 'brief', arguments: {} } } as ToolCall]);
    t3.tool('brief', 'OK', 'x');
    expect(t3.installCompacted(triple, 4)).toBe(true);

    // The tail is never re-validated on the splice path (it is a legal suffix
    // by construction — see installCompacted's contract note), so the check
    // that matters is the replacement HEAD, not where the cut lands.
    const t4 = build();
    t4.agent('', [
      { id: 'y1', type: 'function', function: { name: 'brief', arguments: {} } } as ToolCall,
      { id: 'y2', type: 'function', function: { name: 'read_file', arguments: { path: 'p' } } } as ToolCall,
    ]);
    t4.tool('brief', 'OK', 'y1');
    t4.tool('read_file', 'X', 'y2');
    expect(t4.installCompacted(triple, 5)).toBe(true);

    // A malformed HEAD is refused all-or-nothing.
    const badHead: Message[] = [
      userMsg('[summary]'),
      { role: 'assistant', content: '', tool_calls: [{ id: 's', type: 'function', function: { name: 'brief', arguments: {} } } as ToolCall] }, // unanswered
    ];
    const t5 = build();
    expect(t5.installCompacted(badHead, 4)).toBe(false);
    expect(t5.getMessages().length).toBe(4); // store untouched
  });

  it('segment install while a wrap-up turn is live: installs, wrap-up survives', () => {
    // A segment splice rewrites only the head; the wrap-up turn (its WRAP_UP
    // user message and its mark) lives against the tail and stays valid. Before
    // the review fix this ran the FULL-compact invariant set and killed the
    // wrap-up + dropped deferred input (peer review: facade BUG #1).
    const triologue = buildSixMsgTriologue();
    triologue.beginWrapUp();
    expect(triologue.hasActiveWrapUp()).toBe(true);

    const ok = triologue.installCompacted(triple, 4);
    expect(ok).toBe(true);
    expect(triologue.hasActiveWrapUp()).toBe(true); // wrap-up NOT killed
    expect(triologue.getMessages().length).toBe(3 + (7 - 4)); // head replaced, tail kept

    // A full install (no tailFrom) still ends on the triple's tool role and
    // clears the mark.
    expect(triologue.installCompacted(triple)).toBe(true);
    expect(triologue.hasActiveWrapUp()).toBe(false);
  });
});
