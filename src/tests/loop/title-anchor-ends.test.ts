/**
 * title-anchor-ends.test.ts — pure-function tests for the title anchor
 * scan (MessageStore.titleAnchorEnds / previousTitleAnchorEnd), the entire
 * correctness basis of segment archiving boundaries.
 */

import { describe, it, expect } from 'vitest';
import { MessageStore } from '../../loop/triologue/store.js';
import type { Message, ToolCall } from '../../types.js';

function titleAssistant(ids: string[], names: string[] = []): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: ids.map((id, i) => ({ id, type: 'function', function: { name: names[i] ?? 'mycc_title', arguments: { title: 't' } } }) as ToolCall),
  };
}
function otherAssistant(id: string): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: {} } } as ToolCall],
  };
}
function toolResult(id: string, name = 'mycc_title'): Message {
  return { role: 'tool', tool_name: name, content: 'OK', tool_call_id: id };
}
function userMsg(t: string): Message {
  return { role: 'user', content: t };
}

function storeWith(msgs: Message[]): MessageStore {
  const s = new MessageStore();
  for (const m of msgs) s.push(m);
  return s;
}

describe('titleAnchorEnds / previousTitleAnchorEnd', () => {
  it('one complete title batch → [end of its tool run]', () => {
    const s = storeWith([userMsg('q'), titleAssistant(['t1']), toolResult('t1')]);
    expect(s.titleAnchorEnds()).toEqual([2]);
  });

  it('a batched title call (1 assistant + N results) → end is the last result', () => {
    const s = storeWith([
      userMsg('q'),
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'bash', arguments: {} } } as ToolCall,
        { id: 't', type: 'function', function: { name: 'mycc_title', arguments: {} } } as ToolCall,
      ] },
      toolResult('a', 'bash'),
      toolResult('t'),
      userMsg('next'),
    ]);
    expect(s.titleAnchorEnds()).toEqual([3]);
  });

  it('two batches → both ends in order', () => {
    const s = storeWith([
      titleAssistant(['t1']), toolResult('t1'),
      userMsg('mid'),
      titleAssistant(['t2']), toolResult('t2'),
    ]);
    expect(s.titleAnchorEnds()).toEqual([1, 4]);
  });

  it('incomplete batch (results not landed) → contributes NO anchor', () => {
    // Peer review (store #1 / archiver): publishing the assistant index as an
    // "end" is indistinguishable from a real batch end and bounds a segment
    // mid-batch. An incomplete batch cannot bound anything.
    const s = storeWith([userMsg('q'), titleAssistant(['t1'])]);
    expect(s.titleAnchorEnds()).toEqual([]);
    // ...and it becomes an anchor the moment its results land.
    s.push(toolResult('t1'));
    expect(s.titleAnchorEnds()).toEqual([2]);
  });

  it('multi-call batch: the anchor end is the LAST call\'s result only (walk stops at call ids)', () => {
    // assistant[mycc_title a, read_file b] → tool[a] → tool[b]: end = 3.
    // A following batch's result (foreign call id) must NOT be swallowed.
    const s = storeWith([
      userMsg('q'),
      titleAssistant(['a', 'b'], ['mycc_title', 'read_file']),
      toolResult('a', 'mycc_title'),
      toolResult('b', 'read_file'),
      titleAssistant(['c'], ['mycc_title']),
      toolResult('c', 'mycc_title'),
      toolResult('z', 'read_file'), // foreign result
    ]);
    expect(s.titleAnchorEnds()).toEqual([3, 5]);
  });

  it('previousTitleAnchorEnd: current title is the first anchor → undefined', () => {
    const s = storeWith([titleAssistant(['t1']), toolResult('t1'), userMsg('x'), titleAssistant(['t2']), toolResult('t2')]);
    // current title assistant index is 3; only earlier anchor is end 1... so not first.
    expect(s.previousTitleAnchorEnd(3)).toBe(1);
    // a store with a single title batch: current IS the first anchor
    const s2 = storeWith([titleAssistant(['t1']), toolResult('t1')]);
    expect(s2.previousTitleAnchorEnd(0)).toBeUndefined();
  });

  it('three anchors, current == second → first anchor end', () => {
    const s = storeWith([
      titleAssistant(['a']), toolResult('a'),          // end 1
      titleAssistant(['b']), toolResult('b'),          // end 3
      userMsg('u'),
      titleAssistant(['c']), toolResult('c'),          // end 6 (current, assistant idx 5)
    ]);
    expect(s.previousTitleAnchorEnd(5)).toBe(3);
  });

  it('skip-chain: trigger at a LATER title call still resolves the earlier anchor (skip not permanent)', () => {
    const s = storeWith([
      titleAssistant(['a']), toolResult('a'),   // end 1 (previous anchor)
      userMsg('u'),
      titleAssistant(['b']), toolResult('b'),   // end 4 (skipped trigger's own batch, assistant idx 3)
      userMsg('v'),
      titleAssistant(['c']), toolResult('c'),   // end 7 (later trigger, assistant idx 6)
    ]);
    expect(s.previousTitleAnchorEnd(3)).toBe(1); // first trigger
    expect(s.previousTitleAnchorEnd(6)).toBe(4); // later trigger gets the next anchor, not undefined/6
  });

  it('< vs <= boundary: current index EQUAL to an anchor end does NOT count as previous', () => {
    // store: [titleA, resultA(end 1), titleB, resultB(end 3)]
    const s = storeWith([
      titleAssistant(['a']), toolResult('a'),
      titleAssistant(['b']), toolResult('b'),
    ]);
    // current == end 1 → strictly-less scan must skip it → undefined (not 1).
    // Under the `<=` mutation this returns 1 and fails.
    expect(s.previousTitleAnchorEnd(1)).toBeUndefined();
    expect(s.previousTitleAnchorEnd(3)).toBe(1);
  });

  it('non-title tool calls are ignored', () => {
    const s = storeWith([otherAssistant('r'), toolResult('r', 'read_file')]);
    expect(s.titleAnchorEnds()).toEqual([]);
    expect(s.previousTitleAnchorEnd(0)).toBeUndefined();
  });
});
