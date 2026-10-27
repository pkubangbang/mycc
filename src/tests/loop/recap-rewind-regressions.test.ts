/**
 * recap-rewind-regressions.test.ts — the recap rewind REGRESSION set: synthetic
 * anchors, the TOCTOU window, span index space, and failed-recaps-left-nothing.
 *
 * Split out of recap-rewind.test.ts (674 lines) at the behaviour seam: anchor
 * selection lives in recap-rewind-anchor.test.ts and anchor identity in
 * recap-rewind-identity.test.ts. These cases pin the guards that keep a recap
 * from folding a span it must not touch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageStore } from '../../loop/triologue/store.js';
import { Triologue } from '../../loop/triologue.js';
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
    expect(t.rewindToLastBrief('x', 'y')).toBeNull();
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
    expect(t.rewindToLastBrief('collapse', 'note', staleId)).toBeNull();
    expect(t.getMessages().length).toBe(len);
    expect(t.getLastBrief()?.message).toBe('SECOND');

    // With the current id the same call succeeds — at SECOND.
    expect(t.rewindToLastBrief('collapse', 'note', t.getLastBrief()!.id)).not.toBeNull();
    expect(t.getMessages().at(-1)!.content).toContain('Rewound past the brief: "SECOND"');
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
    expect(t.rewindToLastBrief('collapse', 'note')).toBeNull();
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
    expect(t.rewindToLastBrief('collapse', 'SUMMARY')!.anchorMessage).toBe('ANCHOR');
    // The note went into the BRIEF's tool result — no new message appeared.
    const last = t.getMessages().at(-1)!;
    expect(last.role).toBe('tool');
    expect(last.tool_name).toBe('brief');
    expect(last.content).toContain('SUMMARY');
  });
});

/**
 * R2 — a `recap(target=…)` refusal must name the REAL reason. The hash a model
 * most naturally tries is the one on the line it is reading, and that anchor has
 * nothing after it yet — saying "No brief matches target" there denies the
 * transcript the model is looking at.
 */
describe('target refusal reason', () => {
  it('a freshly printed anchor is refused as nothing-after, not as unknown', () => {
    const t = new Triologue();
    t.user('plan');
    pushBrief(t, 'ANCHOR'); // its round-trip is the last thing in the store
    const hash = t.listBriefHashes()[0].hash;
    expect(t.getLastBrief(hash)).toBeNull(); // it is not foldable yet …
    expect(t.targetRefusal(hash)).toBe('nothing-after'); // … but it EXISTS
  });

  it('an unknown hash is unknown', () => {
    const t = new Triologue();
    pushBrief(t, 'ANCHOR');
    t.user('work');
    expect(t.targetRefusal('deadbeef')).toBe('unknown');
  });

  it('a foldable anchor needs no refusal, and no target means no refusal either', () => {
    const t = new Triologue();
    pushBrief(t, 'ANCHOR');
    t.user('work');
    expect(t.targetRefusal(t.listBriefHashes()[0].hash)).toBeNull();
    expect(t.targetRefusal(undefined)).toBeNull();
  });
});

/**
 * M1 — the anchor fingerprint is (call id, args), never the array index.
 */
