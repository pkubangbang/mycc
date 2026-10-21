/**
 * recap-rewind.test.ts — the rewind contract of recap.
 *
 * Design under test (see Triologue.getLastBrief / rewindToLastBrief):
 *   - every REAL `brief` is a rewind anchor;
 *   - recap truncates AT the last brief and appends a merge round-trip
 *     (assistant + tool('recap'), ending on role:'tool' for TP parity);
 *   - the merge node is a `recap` call, never a `brief` one, so it can never be
 *     re-selected as an anchor → repeated recaps rewind progressively further;
 *   - a compaction is the floor: its `compact_resume_*` brief is the
 *     only anchor left, and the summary user-message survives the rewind.
 *     Its message is deliberately NOT marked `synthetic`.
 *   - an INCIDENTAL brief (llm.ts empty-output recovery, hook.ts crossroad) is
 *     marked `synthetic: true` on the assistant MESSAGE and is never an anchor.
 *
 * These are pure store/triologue tests — no LLM, no forks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageStore } from '../../loop/triologue/store.js';
import { buildResumeRoundTrip } from '../../loop/triologue/compact.js';
import { briefToolCall } from '../../loop/triologue/brief.js';
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

  it('exposes the anchor message and an opaque id, but never an index', () => {
    pushBrief(t, 'mapped the parser');
    const peek = t.getLastBrief()!;
    expect(peek.message).toBe('mapped the parser');
    expect(peek.confidence).toBe(7);
    expect(Object.keys(peek).sort()).toEqual(['confidence', 'id', 'message', 'span']);
    // The id is opaque: it must not be the raw array index the caller would be
    // tempted to truncate at.
    expect(typeof peek.id).toBe('string');
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
    // Simulate EXACTLY what compact() leaves behind: the 3-message post-compact
    // pair built by compact.ts. The resume brief must NOT be tagged
    // `synthetic` — that tag is for INCIDENTAL briefs (llm.ts empty-output
    // recovery, hook.ts crossroad). Tagging the floor would make it ineligible
    // and leave recap with no anchor at all after every compaction, which is
    // the P1 an earlier fixture hid by hand-building an untagged shape that
    // production could not produce.
    // Build the floor with the REAL producer, not a hand-written shape: a
    // fixture that restates compact()'s output cannot catch a producer-side
    // change (such as re-adding a `synthetic` tag), and this test exists for
    // exactly that class of bug.
    (t as unknown as { store: MessageStore }).store.replaceAll(
      buildResumeRoundTrip({
        briefCall: briefToolCall(
          'Re-orienting on the compacted summary to resume the in-flight task.',
          7,
          'compact_resume_test',
        ),
        summaryPrefix: '',
        summary: 'SUMMARY OF EVERYTHING',
        focusSection: '',
        userQueryNote: '',
      }),
    );

    const peek = t.getLastBrief()!;
    expect(peek.message).toBe('Re-orienting on the compacted summary to resume the in-flight task.');
    expect(peek.span).toEqual([]); // nothing to collapse right after a compaction

    const result = t.rewindToLastBrief('post-compact', 'note')!;
    expect(result.anchorMessage).toBe('Re-orienting on the compacted summary to resume the in-flight task.');
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

describe('P2 regressions: synthetic anchors, TOCTOU, span index space', () => {
  let t: Triologue;
  beforeEach(() => {
    seq = 0;
    t = new Triologue();
  });

  it('skips synthetic briefs: they are messages, never rewind anchors', () => {
    pushBrief(t, 'the real anchor');
    // Provenance is a property of the MESSAGE, set by the producer that
    // injected it — never a call-id convention.
    seq++;
    t.agent('', [{
      id: `brief_${seq}`,
      function: { name: 'brief', arguments: { message: 'Let me see what to do next.', confidence: 7 } },
    }], { synthetic: true });
    t.tool('brief', 'OK', `brief_${seq}`);
    t.agent('some work happened');

    // The anchor is still the REAL brief, not the synthetic one right above.
    expect(t.getLastBrief()?.message).toBe('the real anchor');

    const result = t.rewindToLastBrief('collapse', 'note')!;
    expect(result.anchorMessage).toBe('the real anchor');
    expect(t.getMessages().some(
      (m) => String(m.content ?? '').includes('Rewound past the brief: "the real anchor"'),
    )).toBe(true);
  });

  it('only a marked MESSAGE is incidental: no registry, no prefix', () => {
    // Provenance is a message flag. A model-authored string cannot forge it
    // (arguments are never read for it), and no call-id convention has to be
    // remembered: an id that HAPPENS to look synthetic is still a real anchor.
    const store = new MessageStore();
    expect(store.findLastBriefAnchor()).toBe(-1);

    // An UNMARKED call anchors (fail safe), even if its id looks incidental.
    store.push({ role: 'assistant', content: '', tool_calls: [{ id: 'synthetic_brief_lookalike', function: { name: 'brief', arguments: {} } }] as ToolCall[] });
    store.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: 'synthetic_brief_lookalike' });
    expect(store.findLastBriefAnchor()).toBe(0);

    // The SAME shape, marked, does not.
    store.push({ role: 'assistant', content: '', synthetic: true, tool_calls: [{ id: 'marked_1', function: { name: 'brief', arguments: {} } }] as ToolCall[] });
    store.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: 'marked_1' });
    expect(store.findLastBriefAnchor()).toBe(0);
  });

  it('strips the synthetic marker from the provider payload', () => {
    // `synthetic` is runtime bookkeeping: the LLM must never see it, or it
    // could imitate the marker in its own output.
    const store = new MessageStore();
    store.setSystemPrompt('sys');
    store.push({ role: 'assistant', content: '', synthetic: true, tool_calls: [{ id: 'x', function: { name: 'brief', arguments: { message: 'm' } } }] as ToolCall[] });
    const outbound = store.getFullMessages();
    expect(outbound[0]).toEqual({ role: 'system', content: 'sys' });
    expect(outbound[1].synthetic).toBeUndefined();
    expect('synthetic' in outbound[1]).toBe(false);
    // The in-memory message keeps the mark — it is the anchor rule's input.
    expect(store.at(0)!.synthetic).toBe(true);
    expect(store.findLastBriefAnchor()).toBe(-1);
  });

  it('whitelists provider fields: a non-provider key is dropped, not spread', () => {
    // The projection is an ALLOW-LIST, so a field nobody remembered to exclude
    // (hook_name is runtime bookkeeping for the minifier, never wire data) is
    // absent from the payload instead of leaking to the model.
    const store = new MessageStore();
    store.push({ role: 'user', content: 'q', hook_name: 'some-hook' });
    const outbound = store.getFullMessages();
    expect(outbound[0]).toEqual({ role: 'user', content: 'q' });
    expect('hook_name' in outbound[0]).toBe(false);
    // The store itself keeps the field — only the egress view is narrowed.
    expect(store.at(0)!.hook_name).toBe('some-hook');
  });

  it('keeps every provider-visible field, including the extended ones', () => {
    const store = new MessageStore();
    const toolCalls = [{ id: 'c1', function: { name: 'bash', arguments: { command: 'ls' } } }] as ToolCall[];
    store.push({ role: 'assistant', content: 'thinking out loud', thinking: 'hmm', tool_calls: toolCalls, reasoning_content: 'r' });
    store.push({ role: 'tool', tool_name: 'bash', content: 'ok', tool_call_id: 'c1' });
    const [assistant, toolMsg] = store.getFullMessages();
    expect(assistant).toEqual({ role: 'assistant', content: 'thinking out loud', thinking: 'hmm', tool_calls: toolCalls, reasoning_content: 'r' });
    expect(toolMsg).toEqual({ role: 'tool', tool_name: 'bash', content: 'ok', tool_call_id: 'c1' });
  });

  it('a synthetic-only history has no anchor at all', () => {
    seq++;
    t.agent('', [{
      id: `brief_${seq}`,
      function: { name: 'brief', arguments: { message: 'Re-orienting on the compacted summary.', confidence: 7 } },
    }], { synthetic: true });
    t.tool('brief', 'OK', `brief_${seq}`);
    expect(t.getLastBrief()).toBeNull();
    expect(t.rewindToLastBrief('x', 'y')).toBeNull();
  });

  it('refuses to truncate when the anchor moved since the peek (TOCTOU)', () => {
    pushBrief(t, 'first anchor');
    t.agent('work after the first anchor');
    const staleId = t.getLastBrief()!.id;

    // A second real brief lands while the caller awaits the recap forks.
    pushBrief(t, 'second anchor');
    const len = t.getMessages().length;

    // The caller still holds the OLD id → rewind must be a no-op, not a
    // truncation at the NEW anchor (which was never summarized).
    expect(t.rewindToLastBrief('collapse', 'note', staleId)).toBeNull();
    expect(t.getMessages().length).toBe(len);
    expect(t.getLastBrief()?.message).toBe('second anchor');

    // With the current id the same call succeeds.
    expect(t.rewindToLastBrief('collapse', 'note', t.getLastBrief()!.id)).not.toBeNull();
    expect(t.getLastBrief()?.message).toBe('first anchor');
  });

  it('span slices the TRUE array: a hole before the anchor does not shift it', () => {
    const s = store();
    s.push({ role: 'user', content: 'q' });
    s.push(undefined as unknown as Message); // hole — getRaw() skips it
    s.push({ role: 'assistant', content: '', tool_calls: [briefCall('anchor')] });
    s.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: `brief_${seq}` });
    s.push({ role: 'user', content: 'after' });

    const tr = new Triologue();
    const internal = (tr as unknown as { store: MessageStore }).store;
    internal.replaceAll((s as unknown as { messages: Message[] }).messages ?? []);

    // With getRaw() the slice would start one element early (true index 4 vs
    // raw index 3), leaking the anchor's own tool result into the span.
    const span = tr.getLastBrief()!.span;
    expect(span.map((m) => m.content)).toEqual(['after']);
  });
});
