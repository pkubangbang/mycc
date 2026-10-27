/**
 * recap-rewind-anchor.test.ts — WHERE a brief becomes a rewind anchor.
 *
 * Design under test (see Triologue.getLastBrief / rewindToLastBrief):
 *   - a brief is a rewind anchor IFF it is not `synthetic` AND at least one
 *     message follows its round-trip (the assistant brief call + its tool
 *     result). Nothing else — no "consumed" marker, no pristine-result
 *     heuristic: recap leaves the anchor's round-trip LAST, so the structural
 *     rule alone makes repeated recaps walk backwards;
 *   - recap truncates everything AFTER the brief's round-trip and REWRITES the
 *     brief's own tool RESULT with the note, ending on role:'tool' for TP
 *     parity;
 *   - an INCIDENTAL brief (llm.ts empty-output recovery, hook.ts crossroad) is
 *     marked `synthetic: true` on the assistant MESSAGE and is never an anchor;
 *   - a compaction is the floor: its `compact_resume_*` brief is deliberately
 *     NOT marked `synthetic`, so the first recap after a compaction anchors it
 *     as soon as any activity follows.
 *
 * These are pure store/triologue tests — no LLM, no forks.
 *
 * Split out of recap-rewind.test.ts (674 lines) at the behaviour seam: this
 * file owns anchor SELECTION (briefIndices, getLastBrief, rewindToLastBrief);
 * recap-rewind-regressions.test.ts owns the synthetic/TOCTOU/span-space
 * regressions, and recap-rewind-identity.test.ts owns anchor IDENTITY.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageStore } from '../../loop/triologue/store.js';
import { buildResumeRoundTrip } from '../../loop/triologue/compact.js';
import { briefToolCall } from '../../loop/triologue/brief.js';
import { briefHash } from '../../loop/triologue/recap-note.js';
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
    // The hash is the token recap(target_brief=...) takes, derived from the id —
    // never the id's raw prefix (ids share `brief_<epoch-ms>`, so a prefix cut
    // would name the oldest same-epoch brief instead of this one).
    expect(peek.hash).toBe(briefHash(peek.id));
    expect(peek.hash).not.toBe(peek.id.slice(0, 8));
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
    // Tokens must DROP only when the collapsed span outweighs the note itself
    // (the result line is no longer a bare "OK" — it is the anchor line plus the
    // recap note appended as line 2, so the delta is span − (anchor + note)).
    // The two "thinking"/"more work" messages here are tiny, so a small GROWTH
    // is correct; what must hold is that the collapsed span itself is gone.
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
    // Line 1 is the fixed anchor line; the note is line 2.
    // A folded anchor: the invitation is retired, the address and the note stay.
    expect(msgs[2].content).toMatch(/^\[RECAP\]\n\n/);
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
    expect(note).not.toContain('[RECAP] collapse');
    // The anchor's message is no longer quoted into the note: it lives in the\n    // audit record instead (a fold is decided outside the conversation, so the\n    // model never addresses an anchor). See recap-note.ts buildRecapNote.\n    expect(note).toContain('SUMMARY BODY');
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
