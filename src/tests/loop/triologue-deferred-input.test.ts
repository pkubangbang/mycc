/**
 * triologue-deferred-input.test.ts - the deferred-input guard: a note()/user()
 * that lands while tool_calls are still OUTSTANDING must not append.
 *
 * Split out of triologue.test.ts (811 lines) at the behaviour seam: this file
 * owns the pending-ledger deferral rule and its replay ordering; the append
 * contract lives in triologue-piece-contract.test.ts and the provider matrix
 * in triologue-sequence-conformance.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Triologue } from '../../loop/triologue.js';
import type { Message, ToolCall } from '../../types.js';

/** Captured piece: the shallow-copied message plus the livelog state at emit. */
interface Captured {
  msg: Message & { kind?: 'new' | 'merge' | 'user' | 'steer' | 'clear' | 'compact' | 'recap' | 'rollback'; user_origin?: true };
  /** getTriologue() snapshot taken at emit time (livelog the piece belongs to) */
  seen: Message[];
}

function captureAll(): { captured: Captured[]; triologue: Triologue } {
  const captured: Captured[] = [];
  const triologue = new Triologue({
    onMessage: (msg: Message, getTriologue: () => Message[]) => {
      captured.push({ msg: msg as Captured['msg'], seen: getTriologue() });
    },
    tokenThreshold: 50000,
    resultThreshold: 100000, // oversized-result dump path needs a big threshold
  });
  return { captured, triologue };
}

/**
 * PART 2 — the deferred-input guard.
 *
 * A note()/user() landing while tool_calls are still OUTSTANDING (the ledger
 * is non-empty) must NOT append: the provider requires every tool_call_id to
 * be answered by tool messages before any other role. DeepSeek enforces this
 * with an HTTP 400 ("An assistant message with 'tool_calls' must be followed
 * by tool messages responding to each 'tool_call_id'"); Ollama tolerates it,
 * which is why the bug survived. The submission is DEFERRED and replayed once
 * the LAST pending call resolves.
 */
describe('Triologue deferred-input guard (tool_calls outstanding)', () => {
  let captured: Captured[];
  let triologue: Triologue;

  beforeEach(() => {
    ({ captured, triologue } = captureAll());
  });

  const pending = (id: string, name = 'bash') =>
    ({ id, function: { name, arguments: {} } }) as unknown as ToolCall;

  /**
   * The provider's full tool-call pairing rules (measured live against DeepSeek
   * by `scripts/tp-violation/main.mjs` phase 4 — 60 cases, 2026-10-09). Three
   * independent rejection rules, matching `isIllegal()` in the probe:
   *
   *   (1) a pending `tool_call_id` is never answered while a later non-`tool`
   *       role is reached — i.e. a note/user/assistant/system message is
   *       INTERPOSED inside an open block (incl. a second block opening early);
   *   (2) a `tool` message answers nothing announced — an ORPHAN/duplicate/
   *       foreign `tool_call_id`;
   *   (3) the sequence ENDS with a pending `tool_call_id` — a trailing
   *       unanswered block is REJECTED ("insufficient tool messages following
   *       tool_calls message"), so there is no legal in-flight wire state.
   */
  function illegalSequence(msgs: Message[]): boolean {
    const pending = new Set<string>();
    for (const m of msgs) {
      if (m.role === 'tool') {
        const id = ((m as Message & { tool_call_id?: string }).tool_call_id ?? '');
        if (!pending.has(id)) return true; // (2) orphan / duplicate / foreign id
        pending.delete(id);
        continue;
      }
      if (pending.size > 0) return true; // (1) non-tool role interposed mid-block
      if (m.role === 'assistant' && m.tool_calls?.length) {
        for (const c of m.tool_calls as (ToolCall & { id?: string })[]) pending.add(c.id ?? '');
      }
    }
    return pending.size > 0; // (3) conversation ends with an unanswered block
  }

  it('a note() while a tool call is pending is DEFERRED, not appended', () => {
    triologue.agent('go', [pending('p1')]);
    triologue.note('REMINDER', 'steer');
    // Nothing appended yet — only the assistant message exists.
    expect(triologue.getMessagesRaw().map((m) => m.role)).toEqual(['assistant']);
    // Mid-batch: the lone tool_calls block has no result yet, so the sequence
    // is INCOMPLETE — the provider rejects such a trailing block, which is
    // exactly why nothing may be posted while the guard defers the note.
    // (`illegalSequence` models that strict rule: pending.size > 0 at the end.)
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(true);
    expect(captured).toHaveLength(1); // only the agent() piece
  });

  it('the deferred note is replayed after the LAST pending call resolves', () => {
    triologue.agent('go', [pending('p1')]);
    triologue.note('URGENT', 'act');
    triologue.tool('bash', 'out'); // ledger now empty → flush
    const roles = triologue.getMessagesRaw().map((m) => m.role);
    expect(roles).toEqual(['assistant', 'tool', 'user']);
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
    expect((triologue.getMessagesRaw()[2].content as string)).toBe('[URGENT] act');
  });

  it('multi-call: no flush until the SECOND result lands (else p2 is orphaned)', () => {
    triologue.agent('go', [pending('p1', 'bash'), pending('p2', 'read')]);
    triologue.note('MAIL', 'reply');
    triologue.tool('bash', 'o1');
    // p2 still outstanding — the note must STAY deferred.
    expect(triologue.getMessagesRaw().map((m) => m.role)).toEqual(['assistant', 'tool']);
    // Block still open (p2 unanswered) → incomplete sequence, not postable.
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(true);
    triologue.tool('read', 'o2');
    expect(triologue.getMessagesRaw().map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
  });

  it('THE REPRODUCED CASE: a note between two results is deferred, not interposed', () => {
    // assistant(p1,p2) → tool(p1) → note → tool(p2): lastRole is 'tool' and
    // the ledger still holds p2. An assistant-only guard would let this
    // through the note_after_tool 'allowed' path and orphan p2.
    triologue.agent('go', [pending('p1', 'bash'), pending('p2', 'read')]);
    triologue.tool('bash', 'o1');
    triologue.note('HINT', 'mid-batch');
    triologue.tool('read', 'o2');
    expect(triologue.getMessagesRaw().map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
    // And no spurious second synthetic assistant was injected.
    expect((triologue.getMessagesRaw() as Message[]).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('a deferred user() does NOT merge into a deferred note (force-standalone)', () => {
    triologue.agent('go', [pending('p1')]);
    triologue.note('REMINDER', 'system note');
    triologue.user('genuine query');
    triologue.tool('bash', 'out');
    const raw = triologue.getMessagesRaw();
    expect(raw.map((m) => m.role)).toEqual(['assistant', 'tool', 'user', 'user']);
    // The genuine query is its OWN message — not buried under the note.
    expect(raw[2].content).toBe('[REMINDER] system note');
    expect(raw[3].content).toBe('genuine query');
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
  });

  it('a deferred user() replay updates lastUserQuery (fast-path regression)', () => {
    // REGRESSION: the replay refactor (flushDeferredInputs re-enters user()
    // instead of hand-appending) dropped the old implementation's explicit
    // `setLastUserQuery(item.text)`. On a tool→user 'allowed' provider
    // (ollama/deepseek — the default here) the replayed user() takes the fast
    // path, which RETURNED before the tail setLastUserQuery — leaving the
    // PREVIOUS query as lastUserQuery. Compact would then summarise the stale
    // query as the user's latest intent and lose the newest constraints.
    triologue.user('first query');
    triologue.agent('go', [pending('p1')]);
    triologue.user('deferred latest query'); // ledger non-empty → DEFERRED
    // Still just the first query recorded — the deferred one has not landed.
    expect(triologue.getLastUserQuery()).toBe('first query');
    triologue.tool('bash', 'out'); // ledger drains → flush replays user()
    // The replayed query is now the last genuine instruction.
    expect(triologue.getLastUserQuery()).toBe('deferred latest query');
    expect(triologue.getMessagesRaw().map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
  });

  it('clear()/compact() DROP a deferred input instead of resurrecting it', () => {
    triologue.agent('go', [pending('p1')]);
    triologue.note('URGENT', 'stale');
    triologue.clear();
    // Nothing survives the boundary — a deferred note must never be injected
    // into a context whose pending call is gone.
    expect(triologue.getMessagesRaw()).toHaveLength(0);
  });

  it('skipPendingTools (ESC) flushes the deferred input in order', () => {
    triologue.agent('go', [pending('p1')]);
    triologue.note('SYSTEM', 'worker paused');
    triologue.skipPendingTools('[interrupted]');
    expect(triologue.getMessagesRaw().map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
  });

  it('duplicate_assistant recovery FLUSHES a pending deferred note (FIX-10)', () => {
    // FIX-10: the duplicate_assistant recovery clears the ledger via
    // clearPending(), which removed the referent of any note deferred against
    // the open block. Before the fix the buffer was NOT touched, so the note
    // survived the recovery and re-emitted after the next unrelated tool()
    // resolved — an orphan note with no context. The recovery now FLUSHES the
    // buffer (it just answered every pending call, so the block is closed),
    // exactly as tool()/skipPendingTools do.
    //
    // Shape: assistant(TC p1) → note DEFERRED → agent() (lastRole assistant →
    // duplicate_assistant recovery injects a tool result for p1, clears the
    // ledger, flushes the note) → the new assistant message.
    triologue.agent('first', [pending('p1')]);
    triologue.note('URGENT', 'deferred steer');
    // Nothing appended for the note yet — it is queued while p1 is open.
    expect(triologue.getMessagesRaw().map((m) => m.role)).toEqual(['assistant']);

    triologue.agent('second'); // duplicate_assistant → recovery

    const raw = triologue.getMessagesRaw();
    // The recovery answered p1 (tool), then the deferred note replayed ONCE
    // (user), then the new assistant message. No orphan, no lingering buffer.
    expect(raw.map((m) => m.role)).toEqual(['assistant', 'tool', 'user', 'assistant']);
    expect((raw[2].content as string)).toBe('[URGENT] deferred steer');
    // And the whole sequence is a legal wire shape (no open block, no
    // interposition).
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
  });

  it('a deferred note does NOT re-emit a second time after a later tool() (FIX-10)', () => {
    // The half of FIX-10 that the flush must not get wrong: flushing DRAINS
    // the buffer, so a subsequent tool() (which would normally also flush) must
    // find nothing left. Without draining, the note could re-emit a second time.
    triologue.agent('first', [pending('p1')]);
    triologue.note('MAIL', 'once only');
    triologue.agent('second'); // recovery flushes the note
    // A later unrelated round must NOT replay the note again.
    triologue.agent('calling', [pending('p2')]);
    triologue.tool('bash', 'out');
    const notes = triologue.getMessagesRaw().filter((m) => m.content === '[MAIL] once only');
    expect(notes).toHaveLength(1);
  });

  it('a note() after the last tool result still takes the LEGAL direct path', () => {
    triologue.agent('go', [pending('p1')]);
    triologue.tool('bash', 'out');
    triologue.note('REMINDER', 'boundary steer');
    // ledger empty at note() time → not deferred; appends immediately.
    expect(triologue.getMessagesRaw().map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(triologue.getMessagesRaw()[2].content).toBe('[REMINDER] boundary steer');
  });

  it('closes the oldest pending slot when an id-less tool result has no name match', () => {
    triologue.agent('go', [pending('p1', 'read')]);
    triologue.note('REMINDER', 'queued note');

    triologue.tool('unknown_tool', 'result without a matching name');

    const raw = triologue.getMessagesRaw();
    expect(raw.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect((raw[1] as Message & { tool_call_id?: string }).tool_call_id).toBe('p1');
    expect(raw[2].content).toBe('[REMINDER] queued note');
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
  });

  it('tool() with NO preceding assistant self-heals into a LEGAL standalone block', () => {
    // The `tool_no_assistant` recovery injects a synthetic assistant[TC] so the
    // real result has a block to answer. This path only fires when the ledger
    // is EMPTY (a non-empty ledger always leaves lastRole as assistant/tool),
    // so the injected block is standalone — never interposed inside an open
    // one. Grade the facade's OWN bytes with the strict model: it must be legal.
    triologue.user('q');
    triologue.tool('bash', 'orphan result');
    const raw = triologue.getMessagesRaw();
    // user → assistant(synthetic TC) → tool — a self-contained, answered block.
    expect(raw.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect((raw[1] as Message).tool_calls?.length).toBe(1);
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
  });

  it('finishWrapUp() never streams an assistant mid-block (routes through the append chokepoint)', () => {
    // finishWrapUp() used to push to the store DIRECTLY, bypassing addMessage —
    // a second append entry point with no invariant check. If a tool_call were
    // outstanding when it ran, that raw push would interpose an assistant inside
    // the open block (DeepSeek 400). Drive the real facade: open a block, then
    // run the wrap-up turn; the facade must close the block first, so the tail
    // is a legal tool → user([WRAP_UP]) → assistant.
    triologue.agent('calling', [pending('p1')]);
    triologue.beginWrapUp();      // must flush pending before the WRAP_UP user
    triologue.finishWrapUp('done');
    const roles = triologue.getMessagesRaw().map((m) => m.role);
    // assistant(TC) → tool(flushed) → user([WRAP_UP]) → assistant
    expect(roles).toEqual(['assistant', 'tool', 'user', 'assistant']);
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
    // The wrap-up assistant is the LAST message and carries no tool_calls, so
    // no block is left open.
    expect((triologue.getMessagesRaw().at(-1) as Message).tool_calls).toBeUndefined();
  });

  it('finishWrapUp() with a call arriving after beginWrapUp still closes legally', () => {
    // beginWrapUp() flushes what is pending at call time, but a producer could
    // (in a future call site) register a fresh call before finishWrapUp. The
    // producer-side ledger guard must then flush again rather than interpose.
    triologue.user('q');
    triologue.beginWrapUp();
    // Simulate a late call opening a block after the wrap-up mark.
    triologue.agent('late call', [pending('p1')]);
    triologue.finishWrapUp('wrapping up');
    const roles = triologue.getMessagesRaw().map((m) => m.role);
    // user → user([WRAP_UP]) → assistant(late, TC) → tool(flushed) → assistant
    expect(roles).toEqual(['user', 'user', 'assistant', 'tool', 'assistant']);
    expect(illegalSequence(triologue.getMessages() as Message[])).toBe(false);
  });
});
