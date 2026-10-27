/**
 * recap-rewind-identity.test.ts — the recap anchor FINGERPRINT: (call id, args),
 * never the array index, and single-anchor resolution on a reused id.
 *
 * Split out of recap-rewind.test.ts (674 lines) at the behaviour seam: anchor
 * selection lives in recap-rewind-anchor.test.ts, the synthetic/TOCTOU/span
 * regressions in recap-rewind-regressions.test.ts. This file is the identity
 * contract those two rely on.
 */
import { describe, it, expect, vi } from 'vitest';
import { MessageStore } from '../../loop/triologue/store.js';
import { Triologue } from '../../loop/triologue.js';
import type { Message } from '../../types.js';

// agent-io writes to the terminal; keep the test output clean.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), brief: vi.fn() },
}));

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
    // result to the brief call and returned a snapshot.
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
