/**
 * recap-rewind.test.ts — the rewind contract of recap.
 *
 * Design under test (see Triologue.getLastBrief / rewindToLastBrief):
 *   - every REAL `brief` is a rewind anchor;
 *   - recap truncates AT the last brief and appends a merge round-trip
 *     (assistant + tool('recap'), ending on role:'tool' for TP parity);
 *   - the merge node is a `recap` call, never a `brief` one, so it can never be
 *     re-selected as an anchor → repeated recaps rewind progressively further;
 *   - a compaction is the floor: its synthetic `compact_resume_*` brief is the
 *     only anchor left, and the summary user-message survives the rewind.
 *
 * These are pure store/triologue tests — no LLM, no forks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageStore } from '../../loop/triologue/store.js';
import { Triologue } from '../../loop/triologue.js';
import type { Message, ToolCall } from '../../types.js';

// agent-io writes to the terminal; keep the test output clean.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let seq = 0;
function briefCall(message: string, confidence = 7): ToolCall {
  seq++;
  return {
    id: `brief_${seq}`,
    function: { name: 'brief', arguments: { message, confidence } },
  };
}

/**
 * assistant(brief) → tool('brief','OK') — one anchor round-trip.
 * No `user()` before it: the anchor scan looks only for a brief tool_call.
 */
function pushBrief(t: Triologue, message: string): void {
  t.agent('', [briefCall(message)]);
  t.tool('brief', 'OK', `brief_${seq}`);
}

function store(): MessageStore {
  return new MessageStore();
}

describe('MessageStore.findLastBriefAnchor', () => {
  it('returns -1 when there is no brief', () => {
    const s = store();
    s.push({ role: 'user', content: 'hi' });
    s.push({ role: 'assistant', content: 'hello' });
    expect(s.findLastBriefAnchor()).toBe(-1);
  });

  it('finds the assistant message that CALLED brief (not its tool result)', () => {
    const s = store();
    s.push({ role: 'user', content: 'q' });
    s.push({ role: 'assistant', content: '', tool_calls: [briefCall('looked around')] });
    s.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: `brief_${seq}` });
    expect(s.findLastBriefAnchor()).toBe(1);
    expect(s.at(s.findLastBriefAnchor())?.role).toBe('assistant');
  });

  it('indexes the TRUE array even when sparse holes exist (getRaw divergence)', () => {
    const s = store();
    s.push({ role: 'user', content: 'q' });
    s.push(undefined as unknown as Message); // hole — getRaw() would skip it
    s.push({ role: 'assistant', content: '', tool_calls: [briefCall('anchor')] });
    // getRaw() index would be 1; truncateTo() needs the true index 2.
    expect(s.findLastBriefAnchor()).toBe(2);
    expect(s.getRaw().length).toBe(2);
  });
});

describe('Triologue.getLastBrief / rewindToLastBrief', () => {
  let t: Triologue;

  beforeEach(() => {
    seq = 0;
    t = new Triologue();
  });

  it('returns null when no brief exists — and rewind is a no-op', () => {
    t.user('hello');
    expect(t.getLastBrief()).toBeNull();
    const before = t.getMessages().length;
    expect(t.rewindToLastBrief('nothing', 'x')).toBeNull();
    expect(t.getMessages().length).toBe(before);
  });

  it('exposes the anchor message but never an index', () => {
    pushBrief(t, 'mapped the parser');
    const peek = t.getLastBrief()!;
    expect(peek.message).toBe('mapped the parser');
    expect(peek.confidence).toBe(7);
    expect(Object.keys(peek).sort()).toEqual(['confidence', 'message', 'span']);
    // span starts AFTER the brief round-trip (assistant + its tool result)
    expect(peek.span).toEqual([]);
  });

  it('rewinds to the brief and appends a recap merge pair ending on tool', () => {
    t.user('start');
    pushBrief(t, 'mapped the parser');
    t.agent('thinking');
    t.user('more work');

    const result = t.rewindToLastBrief('collapse', 'SUMMARY BODY')!;
    expect(result.anchorMessage).toBe('mapped the parser');
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);

    const msgs = t.getMessages();
    // ['user','assistant(brief)','tool','assistant(recap)','tool'] →
    // truncate at the brief drops the brief round-trip too:
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(msgs[1].content).toBe('');
    expect(msgs[1].tool_calls?.[0].function.name).toBe('recap');
    expect(msgs[2].tool_name).toBe('recap');
    expect(t.getLastRole()).toBe('tool'); // TP parity handoff to the next agent()
  });

  it('quotes the anchor brief and keeps the steering message last', () => {
    pushBrief(t, 'mapped the parser');
    t.agent('work');
    t.rewindToLastBrief('collapse', 'SUMMARY BODY\n\n**Next direction:** do X');

    const note = t.getMessages().at(-1)!.content;
    expect(note).toContain('[RECAP] collapse');
    expect(note).toContain('Rewound past the brief: "mapped the parser"');
    expect(note).toContain('SUMMARY BODY');
    expect(note.trimEnd().endsWith('**Next direction:** do X')).toBe(true);
  });

  it('is repeatable: a second recap rewinds to the brief BEFORE, and the note is never an anchor', () => {
    pushBrief(t, 'FIRST');
    t.agent('work one');
    pushBrief(t, 'SECOND');
    t.agent('work two');

    expect(t.getLastBrief()!.message).toBe('SECOND');
    t.rewindToLastBrief('one', 'summary one');

    // the recap merge node did not become the anchor
    expect(t.getLastBrief()!.message).toBe('FIRST');

    t.rewindToLastBrief('two', 'summary two');
    const msgs = t.getMessages();
    // FIRST's round-trip is gone too; only its quoted text survives in note two
    expect(msgs.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(msgs[1].content).toContain('Rewound past the brief: "FIRST"');
    expect(t.getLastBrief()).toBeNull(); // no brief left to rewind to
  });

  it('treats a compaction as a floor: the compact_resume brief is the anchor and the summary survives', () => {
    // Simulate what compact() leaves behind by rewinding to nothing and
    // rebuilding the 3-message post-compact pair through the public API.
    const resumeId = 'compact_resume_test';
    (t as unknown as { store: MessageStore }).store.replaceAll([
      { role: 'user', content: '[Conversation compressed] SUMMARY OF EVERYTHING' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: resumeId,
          function: { name: 'brief', arguments: { message: 'Re-orienting on the compacted summary.', confidence: 7 } },
        } as unknown as ToolCall],
      },
      { role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: resumeId },
    ]);

    const peek = t.getLastBrief()!;
    expect(peek.message).toBe('Re-orienting on the compacted summary.');
    expect(peek.span).toEqual([]); // nothing to collapse right after a compaction

    const result = t.rewindToLastBrief('post-compact', 'note')!;
    expect(result.anchorMessage).toBe('Re-orienting on the compacted summary.');
    const msgs = t.getMessages();
    expect(msgs[0].role).toBe('user'); // the compaction summary is preserved
    expect(msgs[0].content).toContain('SUMMARY OF EVERYTHING');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('clamps a stale wrap-up mark so a later rollback cannot extend the array', () => {
    pushBrief(t, 'anchor');
    t.agent('work');
    // Simulate an ESC wrap-up that started beyond the post-rewind length.
    t.beginWrapUp();
    const activeBefore = t.hasActiveWrapUp();
    t.rewindToLastBrief('collapse', 'note');
    expect(activeBefore).toBe(true);
    expect(t.hasActiveWrapUp()).toBe(false); // reset inside the facade

    const len = t.getMessages().length;
    // A rollback now must be a no-op rather than `length = staleMark` (which
    // would grow the array with holes).
    t.rollbackWrapUp();
    expect(t.getMessages().length).toBe(len);
  });

  it('recomputes the token count from the surviving messages', () => {
    pushBrief(t, 'anchor');
    for (let i = 0; i < 20; i++) t.agent(`filler ${i}`.repeat(20));
    t.rewindToLastBrief('collapse', 'note');
    const recount = (t as unknown as { store: MessageStore }).store;
    recount.recomputeTokenCount();
    expect(t.getTokenCount()).toBe(recount.tokenCount);
    expect(t.getTokenCount()).toBeLessThan(500);
  });
});
