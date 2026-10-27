/**
 * recap-rewind.test.ts — the rewind contract of recap.
 *
 * Design under test (see Triologue.getLastBrief / rewindToLastBrief):
 *   - a brief is a rewind anchor IFF it is not `synthetic` AND at least one
 *     message follows its round-trip (the assistant brief call + its tool
 *     result). Nothing else — no "consumed" marker, no pristine-result
 *     heuristic: recap leaves the anchor's round-trip LAST, so the structural
 *     rule alone makes repeated recaps walk backwards;
 *   - recap truncates everything AFTER the brief's round-trip and REWRITES the
 *     brief's own tool RESULT with the note ("OK Note, a recap has reset the
 *     conversation here with summary: …"), ending on role:'tool' for TP parity;
 *   - an INCIDENTAL brief (llm.ts empty-output recovery, hook.ts crossroad) is
 *     marked `synthetic: true` on the assistant MESSAGE and is never an anchor;
 *   - a compaction is the floor: its `compact_resume_*` brief is deliberately
 *     NOT marked `synthetic`, so the first recap after a compaction anchors it
 *     as soon as any activity follows (its summary user-message survives).
 *
 * These are pure store/triologue tests — no LLM, no forks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageStore } from '../../loop/triologue/store.js';
import { buildResumeRoundTrip } from '../../loop/triologue/compact.js';
import { briefToolCall } from '../../loop/triologue/brief.js';
import { buildRecapNote } from '../../loop/triologue/recap-note.js';
import { Triologue } from '../../loop/triologue.js';
import { estimateTokens } from '../../utils/token.js';
import type { Message, ToolCall } from '../../types.js';

// agent-io writes to the terminal; keep the test output clean.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), brief: vi.fn() },
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

describe('MessageStore.briefIndices', () => {
  it('returns nothing when there is no brief', () => {
    const s = store();
    s.push({ role: 'user', content: 'hi' });
    s.push({ role: 'assistant', content: 'hello' });
    expect(s.briefIndices()).toEqual([]);
  });

  it('indexes the assistant message that CALLED brief (not its tool result)', () => {
    const s = store();
    s.push({ role: 'user', content: 'q' });
    s.push({ role: 'assistant', content: '', tool_calls: [briefCall('looked around')] });
    s.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: `brief_${seq}` });
    expect(s.briefIndices()).toEqual([1]);
    expect(s.at(s.briefIndices()[0])?.role).toBe('assistant');
  });

  it('indexes the TRUE array even when sparse holes exist (getRaw divergence)', () => {
    const s = store();
    s.push({ role: 'user', content: 'q' });
    s.push(undefined as unknown as Message); // hole — getRaw() would skip it
    s.push({ role: 'assistant', content: '', tool_calls: [briefCall('anchor')] });
    s.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: `brief_${seq}` });
    // getRaw() index would be 1; truncateTo() needs the true index 2.
    expect(s.briefIndices()).toEqual([2]);
    expect(s.getRaw().length).toBe(3);
  });

  it('skips synthetic briefs; a lone brief is still listed (rule 2 is the facade\'s half)', () => {
    const s = store();
    s.push({ role: 'assistant', content: '', synthetic: true, tool_calls: [{ id: 'm1', function: { name: 'brief', arguments: {} } }] as ToolCall[] });
    s.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: 'm1' });
    s.push({ role: 'assistant', content: '', tool_calls: [{ id: 'r1', function: { name: 'brief', arguments: {} } }] as ToolCall[] });
    s.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: 'r1' });
    expect(s.briefIndices()).toEqual([2]);
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
    expect(t.rewindToLastBrief('nothing')).toBeNull();
    expect(t.getMessages().length).toBe(before);
  });

  it('a lone trailing brief is not an anchor yet; activity after it makes it one', () => {
    pushBrief(t, 'mapped the parser');
    // Rule 2: the newest brief is where the conversation stands.
    expect(t.getLastBrief()).toBeNull();

    t.agent('working on it');
    const peek = t.getLastBrief()!;
    expect(peek.message).toBe('mapped the parser');
    expect(peek.confidence).toBe(7);
    expect(Object.keys(peek).sort()).toEqual(['confidence', 'hash', 'id', 'message', 'span']);
    // The id is opaque: it must not be the raw array index the caller would be
    // tempted to truncate at.
    expect(typeof peek.id).toBe('string');
    // span starts AFTER the brief round-trip (assistant + its tool result) and
    // is exactly the region a rewind would delete.
    expect(peek.span.map((m) => m.content)).toEqual(['working on it']);
  });

  it('rewinds to the brief by rewriting ITS tool result — no recap pair is appended', () => {
    t.user('start');
    pushBrief(t, 'mapped the parser');
    t.agent('thinking');
    t.user('more work');

    const result = t.rewindToLastBrief('SUMMARY BODY')!;
    expect(result.anchorMessage).toBe('mapped the parser');
    // The rewind can only ever ADD tokens when the collapsed span is smaller
    // than what replaces it: the result line is no longer a bare "OK" but the
    // anchor line (plus the recap note appended as line 2), so the delta is
    // span − (anchorLine + note). The two "thinking"/"more work" messages here
    // are tiny, so a small GROWTH is the correct outcome — what must hold is
    // that the span is gone (only growth from the note itself, not the span).
    const spanLen = result.tokensBefore;
    // Measured with the SAME estimator the store uses, so the bound tracks the
    // real contract: the collapsed span is gone and only the replacement result
    // (anchor line + note) remains in its place.
    const noteCost = estimateTokens(t.getMessages().at(-1)!);
    expect(result.tokensAfter).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeLessThan(spanLen + noteCost + 50);

    // ['user','assistant(brief)','tool'] → everything AFTER the brief's
    // round-trip is truncated; the round-trip itself SURVIVES and its result is
    // what carries the note (no assistant(recap)/tool('recap') pair).
    const msgs = t.getMessages();
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(msgs[1].content).toBe('');
    expect(msgs[1].tool_calls?.[0].function.name).toBe('brief');
    expect(msgs[2].tool_name).toBe('brief');
    expect(msgs[2].tool_call_id).toBe((msgs[1].tool_calls?.[0] as ToolCall).id);
    // Pin THIS anchor's hash, not "some hash-shaped token": a regex of
    // /^\[[A-Za-z0-9_-]+\]/ also accepts a token that names a DIFFERENT brief,
    // so a wrong-anchor bug (the exact failure a colliding hash used to cause)
    // would still pass.
    // LINE 1 keeps the anchor (hash + word) but RETIRES the `recap(target_brief=…)`
    // invitation — the span it named is exactly what this recap just deleted —
    // and LINE 2 is the recap summary.
    const content = msgs[2].content as string;
    const line1 = content.split('\n')[0] ?? '';
    const rest = content.split('\n').slice(2);
    // LINE 1 is the note's own marker — there is no anchor line any more, and no
    // hash for the model to address: the fold is decided outside the conversation.
    // (split('\n') on a note whose first line is the marker yields an EMPTY line 1.)
    expect(line1).toBe('[RECAP]');
    expect(rest.join('\n')).toBe(buildRecapNote('SUMMARY BODY').replace(/^\[RECAP\]\n\n/, ''));
    expect(msgs[2].content).toContain('SUMMARY BODY');
    expect(t.getLastRole()).toBe('tool'); // TP parity handoff to the next agent()
  });

  it('a second recap at the SAME anchor overwrites the note (pure overwrite, no stacking)', () => {
    pushBrief(t, 'only anchor');
    t.agent('work');
    t.rewindToLastBrief('summary one');
    expect(t.getMessages().at(-1)!.content).toContain('summary one');

    // New activity after the anchor's round-trip re-arms the SAME brief (rule
    // 2 needs no "consumed" marker), so the second recap targets it again and
    // OVERWRITES its result rather than stacking a second note.
    t.agent('more work');
    expect(t.rewindToLastBrief('summary two')!.anchorMessage).toBe('only anchor');

    const note = t.getMessages().at(-1)!.content;
    expect(note).toContain('summary two');
    expect(note).not.toContain('summary one'); // previous summary dropped
    expect(t.getMessages().filter((m) => m.content.includes('summary two')).length).toBe(1);
  });

  it('quotes the anchor brief and keeps the steering message last', () => {
    pushBrief(t, 'mapped the parser');
    t.agent('work');
    t.agent('more work');
    t.rewindToLastBrief('SUMMARY BODY\n\n**Next direction:** do X');

    const note = t.getMessages().at(-1)!.content;
    expect(note).toContain('[RECAP]');
    expect(note).toContain('SUMMARY BODY');
    expect(note.trimEnd().endsWith('**Next direction:** do X')).toBe(true);
  });

  it('is repeatable: a second recap rewinds to the brief BEFORE (the anchor trails the history)', () => {
    pushBrief(t, 'FIRST');
    t.agent('work one');
    pushBrief(t, 'SECOND');
    t.agent('work two');

    expect(t.getLastBrief()!.message).toBe('SECOND');
    t.rewindToLastBrief('summary one');

    // Recap left SECOND's round-trip LAST, so it now has nothing after it —
    // rule 2 alone moves the anchor back to FIRST.
    expect(t.getLastBrief()!.message).toBe('FIRST');

    t.rewindToLastBrief('summary two');
    const msgs = t.getMessages();
    // SECOND's round-trip is gone too; only its quoted text survives in note two,
    // written into FIRST's own result (nothing appended).
    expect(msgs.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(msgs[1].content).toContain('summary two');
    expect(msgs[1].content).toContain('summary two');
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

    // Right after a compaction the floor brief IS the last message pair, so
    // there is nothing below it to collapse yet.
    expect(t.getLastBrief()).toBeNull();
    expect(t.rewindToLastBrief('post-compact note')).toBeNull();

    // The first real activity after the boundary arms the floor brief.
    t.user('next question');
    const peek = t.getLastBrief()!;
    expect(peek.message).toBe('Re-orienting on the compacted summary to resume the in-flight task.');
    expect(peek.span.map((m) => m.content)).toEqual(['next question']);

    const result = t.rewindToLastBrief('post-compact note')!;
    expect(result.anchorMessage).toBe('Re-orienting on the compacted summary to resume the in-flight task.');
    const msgs = t.getMessages();
    expect(msgs[0].role).toBe('user'); // the compaction summary is preserved
    expect(msgs[0].content).toContain('SUMMARY OF EVERYTHING');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('clamps a stale wrap-up mark so a later rollback cannot extend the array', () => {
    pushBrief(t, 'anchor');
    t.agent('work');
    t.agent('more work');
    // Simulate an ESC wrap-up that started beyond the post-rewind length.
    t.beginWrapUp();
    const activeBefore = t.hasActiveWrapUp();
    t.rewindToLastBrief('note');
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
    // (20 fillers already follow the brief round-trip — it is an anchor.)
    t.rewindToLastBrief('note');
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

    const result = t.rewindToLastBrief('note')!;
    expect(result.anchorMessage).toBe('the real anchor');
    expect(t.getMessages().some(
      (m) => String(m.content ?? '').includes('RECAP'),
    )).toBe(true);
  });

  it('only a marked MESSAGE is incidental: no registry, no prefix', () => {
    // Provenance is a message flag. A model-authored string cannot forge it
    // (arguments are never read for it), and no call-id convention has to be
    // remembered: an id that HAPPENS to look synthetic is still a real anchor.
    const store = new MessageStore();
    expect(store.briefIndices()).toEqual([]);

    // An UNMARKED call is a candidate (fail safe), even if its id looks incidental.
    store.push({ role: 'assistant', content: '', tool_calls: [{ id: 'synthetic_brief_lookalike', function: { name: 'brief', arguments: {} } }] as ToolCall[] });
    store.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: 'synthetic_brief_lookalike' });
    expect(store.briefIndices()).toEqual([0]);

    // The SAME shape, marked, does not.
    store.push({ role: 'assistant', content: '', synthetic: true, tool_calls: [{ id: 'marked_1', function: { name: 'brief', arguments: {} } }] as ToolCall[] });
    store.push({ role: 'tool', tool_name: 'brief', content: 'OK', tool_call_id: 'marked_1' });
    expect(store.briefIndices()).toEqual([0]);
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
    expect(store.briefIndices()).toEqual([]);
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
    expect(t.rewindToLastBrief('y')).toBeNull();
  });

  it('refuses to truncate when the anchor moved since the peek (TOCTOU)', () => {
    // FIRST is the current anchor — two real briefs, so the peek is stable.
    pushBrief(t, 'FIRST');
    t.agent('work');
    const staleId = t.getLastBrief()!.id;
    expect(t.getLastBrief()!.message).toBe('FIRST');

    // A SECOND brief + activity lands while the caller awaits the recap forks:
    // the anchor MOVES forward to SECOND.
    pushBrief(t, 'SECOND');
    t.agent('work on SECOND');
    t.agent('more work on SECOND');
    const len = t.getMessages().length;
    expect(t.getLastBrief()!.id).not.toBe(staleId);

    // The caller still holds the OLD id → rewind must be a no-op, not a
    // truncation at the NEW anchor (which was never summarized).
    expect(t.rewindToLastBrief('note', staleId)).toBeNull();
    expect(t.getMessages().length).toBe(len);
    expect(t.getLastBrief()?.message).toBe('SECOND');

    // With the current id the same call succeeds — at SECOND.
    expect(t.rewindToLastBrief('note', t.getLastBrief()!.id)).not.toBeNull();
    expect(t.getMessages().at(-1)!.content).toContain('RECAP');
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

/**
 * H1 — a FAILED recap changes nothing and leaves no residue.
 *
 * `fail()` in states/hook.ts answers the recap call with a plain tool-call
 * error; the triologue is never truncated and no earlier brief's result is
 * rewritten. The only thing that could still go wrong is the ANCHOR RULE
 * mistaking that error round-trip for activity — which would arm the previous
 * brief as an anchor for the NEXT recap to fold, deleting the user's
 * still-unserved query.
 *
 * The rule needs no per-message marker: the recap tool never produces activity
 * (success truncates to the anchor's round-trip; failure answers and stops), so
 * a `recap` round-trip is skipped by tool name alone.
 */
describe('H1 — a failed recap leaves no activity behind', () => {
  /** What handleRecapCall's fail() registers: agent(recap) + tool('recap', error). */
  function failRecap(t: Triologue, id: string, message: string): void {
    t.agent('', [{ id, function: { name: 'recap', arguments: { description: 'd', comment: 'c' } } }]);
    t.tool('recap', message, id);
  }

  it('a lone brief + a failed recap is NOT an anchor', () => {
    const t = new Triologue();
    pushBrief(t, 'ONLY BRIEF');
    failRecap(t, 'recap_1', '[RECAP] Nothing to collapse — there is no new activity past your last brief.');

    expect(t.getLastBrief()).toBeNull();
    expect(t.rewindToLastBrief('note')).toBeNull();
  });

  it('a failure after real briefs does not move the anchor forward', () => {
    const t = new Triologue();
    pushBrief(t, 'FIRST');
    t.agent('some work');
    pushBrief(t, 'SECOND');
    const before = t.getLastBrief()!.id;
    expect(t.getLastBrief()!.message).toBe('FIRST');

    failRecap(t, 'recap_2', 'Error: the last brief changed while summarizing');

    expect(t.getLastBrief()!.id).toBe(before);
  });

  it('a failure collapses nothing: message count and anchor note are untouched', () => {
    const t = new Triologue();
    pushBrief(t, 'ANCHOR');
    t.user('still unserved');
    const before = t.getMessages().map((m) => m.content);
    const anchorResultBefore = t.getMessages().find((m) => m.tool_name === 'brief')!.content;

    failRecap(t, 'recap_3', 'Error: the recap note is 30000 chars, over the 25000-char limit');

    const after = t.getMessages();
    // BEFORE (the bug): the span was summarized + truncated. AFTER: the only
    // change is the error round-trip itself.
    expect(after.slice(0, before.length).map((m) => m.content)).toEqual(before);
    expect(after.length).toBe(before.length + 2);
    expect(after.find((m) => m.tool_name === 'brief')!.content).toBe(anchorResultBefore);
  });

  it('real activity after a failure still arms the anchor', () => {
    const t = new Triologue();
    pushBrief(t, 'ANCHOR');
    failRecap(t, 'recap_4', 'Error: no usable summary');
    expect(t.getLastBrief()).toBeNull();

    t.agent('', [{ id: 'bash_1', function: { name: 'bash', arguments: { command: 'ls' } } }]);
    t.tool('bash', 'a b c', 'bash_1');
    expect(t.getLastBrief()!.message).toBe('ANCHOR');
    // Its span starts after the round-trip: the failed recap is history now,
    // and the next successful recap will fold it along with the real work.
    expect(t.getLastBrief()!.span.map((m) => m.content)).toEqual([
      '',
      'Error: no usable summary',
      '',
      'a b c',
    ]);
  });

  it('a successful recap leaves its anchor round-trip last (rule 3, unchanged)', () => {
    const t = new Triologue();
    pushBrief(t, 'ANCHOR');
    t.user('work');
    expect(t.rewindToLastBrief('SUMMARY')!.anchorMessage).toBe('ANCHOR');
    // The note went into the BRIEF's tool result — no new message appeared.
    const last = t.getMessages().at(-1)!;
    expect(last.role).toBe('tool');
    expect(last.tool_name).toBe('brief');
    expect(last.content).toContain('SUMMARY');
  });
});

/**
 * M1 — the anchor fingerprint is (call id, args), never the array index.
 */
describe('M1 — anchor identity', () => {
  it('does not depend on the store index', () => {
    // Pad the prefix so the brief sits at different indexes in two stores.
    const mk = (pad: number) => {
      const x = new Triologue();
      for (let i = 0; i < pad; i++) x.user(`pad ${i}`);
      x.agent('', [{ id: 'brief_fixed', function: { name: 'brief', arguments: { message: 'M', confidence: 7 } } }]);
      x.tool('brief', 'OK', 'brief_fixed');
      x.user('after');
      return x.getLastBrief()!.id;
    };
    const a = mk(0);
    const b = mk(3);
    // The token must not include the array index: a replay that shifts indexes
    // still names the same brief.
    expect(a).toBe(b);
    // The fingerprint is the call id alone.
    expect(a).toBe('brief_fixed');
  });

  it('a reused call id collapses to the MOST RECENT anchor (id-only fingerprint)', () => {
    // An id collision is not something the producers do (`newBriefCallId` is
    // random; provider ids are chosen per call), but a hand-built or restored
    // history can carry one. The contract is then "newest wins": the anchor is
    // resolved newest-first, so recap can never truncate an OLDER span on the
    // strength of a stale fingerprint.
    const t = new Triologue();
    t.agent('', [{ id: 'brief_dup', function: { name: 'brief', arguments: { message: 'ONE' } } }]);
    t.tool('brief', 'OK', 'brief_dup');
    t.user('activity');
    const first = t.getLastBrief()!;
    expect(first.id).toBe('brief_dup');

    t.agent('', [{ id: 'brief_dup', function: { name: 'brief', arguments: { message: 'TWO' } } }]);
    t.tool('brief', 'OK', 'brief_dup');
    t.user('activity 2');
    expect(t.getLastBrief()!.id).toBe(first.id);
    expect(t.getLastBrief()!.message).toBe('TWO');

    // The stale fingerprint still MATCHES (that is what id-only means), so the
    // guard passes. What contains the damage is that resolution never picks a
    // stale slot: the note lands in the NEWEST anchor (TWO) — the same span the
    // caller would have summarized — and ONE's round-trip survives above it.
    expect(t.rewindToLastBrief('SUMMARY', first.id)).not.toBeNull();
    const msgs = t.getMessages();
    // ONE's round-trip and its work survive; only the span after TWO is gone.
    expect(msgs.map((m) => m.content)).toEqual([
      '',
      'OK', // ONE's result: untouched
      'activity',
      '',
      // TWO's own result: the note, written at the RESOLVED occurrence.
      expect.stringContaining('SUMMARY'),
    ]);
  });
});

/**
 * M2 — the anchor is resolved ONCE: the span start and the truncation point
 * come from the same tool-result index, and an orphan brief is never an anchor.
 */
describe('M2 — single anchor resolution', () => {
  it('rewrites the resolved brief result, not an older result sharing its call id', () => {
    // Same shape as the M1 reused-id case, without the hand-built store: two
    // briefs share one call id, the newest is the anchor, and recap must write
    // the note into the NEWEST result. BEFORE (rewrite searched from 0): the
    // note landed in brief#1's result while brief#2's stayed "OK" — silently
    // corrupting the wrong message.
    const t = new Triologue();
    t.agent('', [{ id: 'brief_dup', function: { name: 'brief', arguments: { message: 'ONE' } } }]);
    t.tool('brief', 'OK ONE', 'brief_dup');
    t.user('activity');
    t.agent('', [{ id: 'brief_dup', function: { name: 'brief', arguments: { message: 'TWO' } } }]);
    t.tool('brief', 'OK TWO', 'brief_dup');
    t.user('activity 2');

    expect(t.rewindToLastBrief('SUMMARY')).not.toBeNull();
    const msgs = t.getMessages();
    expect(msgs).toHaveLength(5);
    expect(msgs[1].content).toBe('OK ONE'); // the older result is untouched
    expect(msgs[4].content).toContain('SUMMARY'); // the note lands on TWO's result
    expect(msgs[4].content).toContain('SUMMARY');
  });

  it('resolveAnchor matches the brief result by tool NAME too, not just the reused call id', () => {
    // hasMessagesAfterBrief already rejects this shape, so the second line of
    // defence is resolveAnchor itself — the path that TRUNCATES and REWRITES.
    // A provider call id is unique only within a turn, so a reused id must not
    // bind another tool's result to the brief: the note would land in the bash
    // result and the brief's own tool_call would be left dangling.
    //
    // Shape (built directly in the store: the public API's TP fixer would inject
    // an assistant for the dangling call and hide the case):
    //   assistant(brief "ORPHAN", id=reused) → tool(bash, id=reused) → user
    const t = new Triologue();
    const internal = t as unknown as {
      store: MessageStore;
      briefStack: { resolveAnchor: (expected?: string) => unknown };
    };
    internal.store.replaceAll([
      { role: 'assistant', content: '', tool_calls: [{ id: 'reused', function: { name: 'brief', arguments: { message: 'ORPHAN', confidence: 7 } } }] },
      { role: 'tool', tool_name: 'bash', content: 'not the brief answer', tool_call_id: 'reused' },
      { role: 'user', content: 'later activity' },
    ] as Message[]);

    // The public scan refuses first (orphan: no BRIEF result).
    expect(t.getLastBrief()).toBeNull();

    // Force the scan onto that brief, as a future scan rule or a restored
    // history could: resolveAnchor must STILL refuse. BEFORE: it bound the bash
    // result to the brief call and returned a snapshot. The anchor walk is
    // exercised through the manager (briefStack) because the facade exposes
    // only the peek/rewind surface.
    expect(internal.briefStack.resolveAnchor()).toBeNull();
    expect(t.getMessages()[1].content).toBe('not the brief answer');
  });

  it('an orphan brief (no tool result) is not an anchor', () => {
    const t = new Triologue();
    t.agent('', [{ id: 'brief_orphan', function: { name: 'brief', arguments: { message: 'ORPHAN' } } }]);
    t.user('activity without an answer');
    // BEFORE: resolveAnchor accepted it, then rewindToLastBrief refused on its
    // own (resultIndex < 0) — after the caller had already paid for two forks.
    expect(t.getLastBrief()).toBeNull();
    expect(t.rewindToLastBrief('note')).toBeNull();
  });

  it('the span never starts with an unrelated tool result after the brief', () => {
    const t = new Triologue();
    t.agent('', [{ id: 'brief_x', function: { name: 'brief', arguments: { message: 'ANCHOR' } } }]);
    t.tool('brief', 'OK', 'brief_x');
    // A tool result NOT answering the brief call (no result for it at all would
    // make it an orphan; here the result arrives late, after other activity).
    t.user('q');
    t.agent('', [{ id: 'bash_x', function: { name: 'bash', arguments: {} } }]);
    t.tool('bash', 'output', 'bash_x');
    // BEFORE: `if (at(start).role === 'tool') start++` skipped the first message
    // unconditionally, slicing 'output' out of the span it must summarize.
    expect(t.getLastBrief()!.span.map((m) => m.content)).toEqual(['q', '', 'output']);
  });

  it('rewind truncates at the same index the span started from', () => {
    const t = new Triologue();
    t.agent('', [{ id: 'brief_y', function: { name: 'brief', arguments: { message: 'ANCHOR' } } }]);
    t.tool('brief', 'OK', 'brief_y');
    t.user('q1');
    t.agent('', [{ id: 'bash_y', function: { name: 'bash', arguments: {} } }]);
    t.tool('bash', 'out', 'bash_y');
    const result = t.rewindToLastBrief('SUMMARY')!;
    expect(result).not.toBeNull();
    // anchor round-trip only: assistant(brief) + tool('brief', note)
    expect(t.getMessages().length).toBe(2);
    expect(t.getMessages().at(-1)!.content).toContain('SUMMARY');
  });
});
