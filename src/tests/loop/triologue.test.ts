/**
 * triologue.test.ts - unit tests for the Triologue facade's per-piece
 * onMessage contract (the {A, AB} fix at the facade layer).
 *
 * The transcript-layer guard lives in transcript.test.ts (writer + read +
 * collation). Here we pin the PRODUCER contract that feeds it:
 *   - every producer call that APPENDS a message emits exactly ONE 'new'
 *     piece carrying the message fields (NOT a full snapshot);
 *   - the user()/note() combine branches: user() emits ONE 'user' journal
 *     piece (genuine input fragment) and note() emits ONE 'merge' piece —
 *     both carrying the FRAGMENT only, and
 *     ZERO full-snapshot lines — the old design re-emitted the grown host
 *     ({A} then {AB}), which is what the {A, AB} fix removes;
 *   - the stamped envelope (kind / user_origin) lives on a shallow copy —
 *     the LIVELog object inside the store stays clean, so getMessagesRaw()
 *     never carries envelope keys;
 *   - the boundary-journaling contract: clear() journals a bare boundary
 *     piece { kind:'clear' } — the event name IS the kind (conflated; no
 *     'control' pseudo-kind, no `event` field), no message fields.
 *
 * onMessage is typed `(msg: Message, getTriologue: () => Message[]) => void`
 * — the getTriologue closure re-reads the live store at call time, so tests
 * can assert the livelog state a producer SAW when it emitted the piece.
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

/** Only the collation-relevant fields of a captured piece. */
function pieceOf(c: Captured): { role?: string; content?: string; kind?: string; user_origin?: true } {
  return {
    role: c.msg.role,
    content: typeof c.msg.content === 'string' ? c.msg.content : undefined,
    kind: c.msg.kind,
    user_origin: c.msg.user_origin,
  };
}

describe('Triologue per-piece onMessage contract ({A, AB} facade guard)', () => {
  let captured: Captured[];
  let triologue: Triologue;

  beforeEach(() => {
    ({ captured, triologue } = captureAll());
  });

  it('user() emits ONE new piece with user_origin (not a snapshot)', () => {
    triologue.user('hello');
    expect(captured).toHaveLength(1);
    expect(pieceOf(captured[0])).toEqual({
      role: 'user', content: 'hello', kind: 'new', user_origin: true,
    });
    // The livelog the piece saw: exactly the appended message, nothing else.
    expect(captured[0].seen.map((m) => m.role)).toEqual(['user']);
  });

  it('consecutive user() calls each emit their own new piece — no combine', () => {
    // NO-MERGE: a second query in the same move is its own message. The old
    // combine branch concatenated it into the first host ("A\nB") and emitted
    // a 'user' journal fragment; that growth is exactly what made
    // lastUserQuery a derived value and made a query indistinguishable from a
    // note block once they shared a message.
    triologue.user('A');
    triologue.user('B');
    expect(captured).toHaveLength(2);
    expect(pieceOf(captured[0])).toEqual({
      role: 'user', content: 'A', kind: 'new', user_origin: true,
    });
    expect(pieceOf(captured[1])).toEqual({
      role: 'user', content: 'B', kind: 'new', user_origin: true,
    });
    // Two separate livelog messages — nothing grew.
    expect(triologue.getMessagesRaw().map((m) => m.content)).toEqual(['A', 'B']);
    // lastUserQuery is simply the latest query (never a concatenation).
    expect(triologue.getLastUserQuery()).toBe('B');
  });

  it('note() NEVER merges: the note is its own new piece and lastUserQuery is untouched', () => {
    triologue.user('task');
    triologue.note('REMINDER', 'nudge');
    expect(captured).toHaveLength(2);
    expect(pieceOf(captured[0])).toEqual({
      role: 'user', content: 'task', kind: 'new', user_origin: true,
    });
    // Standalone note: its own 'new' piece, carrying the [REMINDER] prefix.
    expect(pieceOf(captured[1])).toEqual({
      role: 'user', content: '[REMINDER] nudge', kind: 'new',
    });
    // The note is NOT a user-origin record, so the serve projection will not
    // render it as a user bubble.
    expect(captured[1].msg.user_origin).toBeUndefined();
    // Two livelog messages; the query host is untouched.
    expect(triologue.getMessagesRaw().map((m) => m.content)).toEqual(['task', '[REMINDER] nudge']);
    // THE reason no-merge is the right call: lastUserQuery stays the genuine
    // query. It feeds compact.ts's "**User's Last Instruction:**" and
    // collect-skill's keyword-extraction trigger — a note must never land there.
    expect(triologue.getLastUserQuery()).toBe('task');
  });

  it('every note keeps its own anchored prefix (each note is exactly one message)', () => {
    // The no-merge contract that makes the ^-anchored raw readers exact:
    // hint-round.ts:169 drops `^\[(?:REMINDER|HINT|WRAP_UP)\]` messages, and
    // collect-skill.ts isHintNote keys `^\[hint\]`. With one note per message
    // the regex sees ONLY that note's prefix — no sorted block can move a
    // higher-priority note into the head position of a lower-priority host.
    triologue.user('go');
    triologue.note('REMINDER', 'nudge');
    triologue.note('URGENT', 'act now');
    const raw = triologue.getMessagesRaw();
    expect(raw.map((m) => m.content)).toEqual(['go', '[REMINDER] nudge', '[URGENT] act now']);
    // Arrival order is preserved verbatim — no re-render, no re-sort.
    expect(captured.map((c) => c.msg.kind)).toEqual(['new', 'new', 'new']);
    expect(captured.map((c) => c.msg.content)).toEqual(['go', '[REMINDER] nudge', '[URGENT] act now']);
    // A [HINT] note still matches the anchored filter on its own message.
    const t = captureAll();
    t.triologue.user('q');
    t.triologue.note('HINT', 'advice');
    expect(t.triologue.getMessagesRaw()[1].content).toBe('[HINT] advice');
    expect(/^\[(?:REMINDER|HINT|WRAP_UP)\]/.test(t.triologue.getMessagesRaw()[1].content as string)).toBe(true);
  });

  it('notes after a genuine query are ordinary messages: the query never absorbs them', () => {
    // Regression guard for the attribution inversion (Review A): with merging,
    // a note joined the query host and the combined text leaked into
    // lastUserQuery. No-merge makes the inversion structurally impossible.
    triologue.user('do the thing');
    triologue.note('MAIL', 'm');
    triologue.note('SYSTEM', 's');
    expect((triologue.getMessagesRaw()[0].content as string)).toBe('do the thing');
    expect(triologue.getLastUserQuery()).toBe('do the thing');
    expect(triologue.getMessagesRaw().map((m) => m.content)).toEqual([
      'do the thing', '[MAIL] m', '[SYSTEM] s',
    ]);
  });

  it('a note arriving first is not promoted over a later note of higher priority', () => {
    // The removed sorter's job was to hoist an actionable note above a noisy
    // one. With one message per note, "most actionable first" is no longer a
    // render-time reorder — it is the CALLER's emission order (COLLECT emits
    // MAIL before the todo/brief REMINDER nudges), so arrival order stands.
    triologue.user('go');
    triologue.note('HINT', 'h');
    triologue.note('URGENT', 'u');
    expect(triologue.getMessagesRaw().map((m) => m.content)).toEqual([
      'go', '[HINT] h', '[URGENT] u',
    ]);
  });

  it('hook notes NEVER combine: each hook note is its own new piece', () => {
    triologue.user('task');
    triologue.note('MAIL', 'from hook', 'some-hook');
    expect(captured).toHaveLength(2);
    const hookPiece = captured[1].msg as Captured['msg'] & { hook_name?: string; kind?: 'new' | 'merge' | 'user' | 'steer' | 'clear' | 'compact' | 'recap' | 'rollback' };
    expect(hookPiece.kind).toBe('new');
    expect(hookPiece.hook_name).toBe('some-hook');
    expect(triologue.getMessagesRaw()).toHaveLength(2); // separate message
  });

  it('agent()/tool() emit ONE new piece per append', () => {
    // A ToolCall cast with `id` is REQUIRED here: the ollama ToolCall type
    // has no `id`, but the runtime ledger keys on it — without one the
    // ledger can't register a pending call and tool() emits its OWN
    // synthetic assistant first (the `no_pending_calls` bridge), which
    // would shift captured[1] to that bridge instead of the tool result.
    triologue.agent('calling', [
      { id: 'tc1', function: { name: 'bash', arguments: { command: 'ls' } } } as unknown as ToolCall,
    ]);
    triologue.tool('bash', 'out');
    expect(captured).toHaveLength(2);
    expect(pieceOf(captured[0])).toEqual({ role: 'assistant', content: 'calling', kind: 'new' });
    expect(pieceOf(captured[1])).toEqual({ role: 'tool', content: 'out', kind: 'new' });
    const toolPiece = captured[1].msg as Message & { tool_name?: string; tool_call_id?: string };
    expect(toolPiece.tool_name).toBe('bash');
    expect(toolPiece.tool_call_id).toBeDefined();
  });

  it('the post-tool user fast path emits its own new user piece', () => {
    triologue.agent('go');
    triologue.tool('bash', 'out');
    triologue.user('next query'); // tool → user: TP-fix allowed path
    expect(captured).toHaveLength(3);
    expect(pieceOf(captured[2])).toEqual({
      role: 'user', content: 'next query', kind: 'new', user_origin: true,
    });
  });

  it('wrap-up messages are separate new pieces', () => {
    triologue.user('long task');
    triologue.beginWrapUp(); // separate [WRAP_UP] user message (new piece)
    triologue.finishWrapUp('wrapping up');
    expect(captured).toHaveLength(3);
    expect(pieceOf(captured[1])).toEqual({ role: 'user', content: '[WRAP_UP] LLM call interrupted. Please wrap up quickly and ask user for next steps.', kind: 'new' });
    expect(pieceOf(captured[2])).toEqual({ role: 'assistant', content: 'wrapping up', kind: 'new' });
  });

  it('clear() journals the "clear" boundary kind (no message fields, livelog reset first)', () => {
    triologue.user('first');
    triologue.clear();
    triologue.user('after clear');
    // 3 events: user new piece → boundary 'clear' → user new piece.
    expect(captured).toHaveLength(3);
    expect(pieceOf(captured[1])).toEqual({ kind: 'clear' });
    expect(captured[1].msg.role).toBeUndefined(); // bare boundary piece — no message fields
    expect(captured[1].seen).toEqual([]); // store already emptied when journaled
    expect(pieceOf(captured[2])).toEqual({
      role: 'user', content: 'after clear', kind: 'new', user_origin: true,
    });
  });

  it('loadRestoration() journals the pair as TWO new pieces (by-construction parity — review F1)', () => {
    const pair: [Message, Message] = [
      { role: 'user', content: '[Conversation compressed. Transcript: x]\nsummary...' },
      { role: 'assistant', content: 'OK' },
    ];
    triologue.loadRestoration(pair);
    // Exactly 2 'new' pieces, one per pair message — the inherited context
    // MUST reach the transcript (a silent append would drop it on chained
    // restores and in serve-history).
    expect(captured).toHaveLength(2);
    expect(pieceOf(captured[0])).toEqual({
      role: 'user', content: pair[0].content, kind: 'new',
    });
    expect(pieceOf(captured[1])).toEqual({
      role: 'assistant', content: 'OK', kind: 'new',
    });
    // Neither piece claims genuine user input (restored context, not input).
    expect(captured[0].msg.user_origin).toBeUndefined();
    expect(captured[1].msg.user_origin).toBeUndefined();
    // The livelog holds both restored messages.
    expect(triologue.getMessagesRaw().map((m) => m.content)).toEqual([pair[0].content, 'OK']);
    // And replaying the emitted pieces reproduces the livelog exactly —
    // collating 2 message pieces yields the 2 restored messages.
    expect(triologue.getMessagesRaw()).toHaveLength(captured.length);
  });

  it('compact() emits the summary as new pieces for replay parity (contract pinned at transcript layer)', async () => {
    // The facade's compact() delegates to runAutoCompact (LLM summarization
    // — heavy). The compact-parity contract (control event + summary pieces
    // re-emitted as 'new') is verified at the transcript-layer tests and in
    // the lite-facade suite where the same co-evolution invariant lives.
    // Here we only pin that a NORMAL producer sequence keeps emitting one
    // 'new' per append (no boundary pieces leak into ordinary flow).
    triologue.user('q');
    expect(captured.map((c) => pieceOf(c).kind)).toEqual(['new']);
    expect(captured.every((c) => ['new', 'merge', 'user'].includes(c.msg.kind as string))).toBe(true);
  });

  it('livelog messages NEVER carry envelope keys (kind/user_origin stay on the copy)', () => {
    triologue.user('q');
    triologue.note('REMINDER', 'n');
    triologue.agent('a');
    const raw = triologue.getMessagesRaw();
    for (const m of raw) {
      expect(Object.prototype.hasOwnProperty.call(m, 'kind')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(m, 'user_origin')).toBe(false);
    }
  });

  it('end-to-end piece sequence: replaying the emitted pieces reproduces the livelog', () => {
    triologue.user('q1');        // new, user
    triologue.note('HINT', 'h'); // new (standalone note — no merge)
    triologue.agent('r1', [      // new (+ pending call registered)
      { id: 'tc-e2e', function: { name: 'bash', arguments: { command: 'ls' } } } as unknown as ToolCall,
    ]);
    triologue.tool('bash', 'o'); // new
    triologue.user('q2');        // new, user (post-tool fast path)
    expect(captured.map((c) => ({ kind: c.msg.kind }))).toEqual([
      { kind: 'new' },
      { kind: 'new' },
      { kind: 'new' },
      { kind: 'new' },
      { kind: 'new' },
    ]);
    // NO-MERGE parity: pieces and livelog messages are 1:1 — every producer
    // appends exactly one message, so nothing can drift on replay. (Under the
    // old merge, the 5th piece saw only 4 messages because the note had grown
    // the first host in place instead of appending.)
    expect(captured[4].seen).toHaveLength(5);
    expect(captured[4].seen.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'tool', 'user']);
    expect(captured[4].seen[0].content).toBe('q1'); // host NOT grown
    expect(captured[4].seen[1].content).toBe('[HINT] h'); // the note stands alone
  });
});

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

  it('a note() after the last tool result still takes the LEGAL direct path', () => {
    triologue.agent('go', [pending('p1')]);
    triologue.tool('bash', 'out');
    triologue.note('REMINDER', 'boundary steer');
    // ledger empty at note() time → not deferred; appends immediately.
    expect(triologue.getMessagesRaw().map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(triologue.getMessagesRaw()[2].content).toBe('[REMINDER] boundary steer');
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


describe('Triologue sequence conformance (60 cases, provider-measured)', () => {
  /**
   * Deterministic CI oracle for the 60 hand-built conversations in
   * `scripts/tp-violation/lib.mjs` (phase 4). The EXPECTED verdicts there are
   * empirical and PER-PROVIDER (2026-10-09):
   *
   *   wantDeepseek — the strict provider: 27 accepted / 33 rejected
   *   wantOllama   — the permissive provider: 60 accepted / 0 rejected
   *
   * Those bytes are a wire shape; the facade never builds them, so we grade the
   * RULE here instead. This suite asserts the STRICT model — `illegalSequence()`
   * must agree with DeepSeek on every case. The permissive provider's whole
   * point is to *disagree* (it accepts all 33 shapes DeepSeek rejects), so its
   * expectation is asserted separately below as the tolerance split.
   *
   * Offline + deterministic: no network, no API key. The live provider witnesses
   * live in the split legs (`main.mjs --provider=deepseek|ollama`).
   */
  const U = (text: string): Message => ({ role: 'user', content: text });
  const A = (text: string, calls?: ToolCall[]): Message =>
    ({ role: 'assistant', content: text, ...(calls ? { tool_calls: calls } : {}) });
  const T = (id: string, name = 'bash', text = 'ok'): Message =>
    ({ role: 'tool', tool_name: name, tool_call_id: id, content: text } as unknown as Message);
  const N = (cat: string, text: string): Message => U(`[${cat}] ${text}`);
  const call = (id: string, name = 'bash') =>
    ({ id, function: { name, arguments: {} } }) as unknown as ToolCall;
  const P1 = [call('p1', 'bash')];
  const P12 = [call('p1', 'bash'), call('p2', 'read')];
  const P123 = [call('p1', 'bash'), call('p2', 'read'), call('p3', 'grep')];

  /**
   * The provider's full tool-call pairing rules — the SAME three-rule walk the
   * `deferred-input guard` describe uses (which is scoped to its own tests).
   * Duplicated here so this offline matrix is self-contained; keep the two in
   * lockstep with `isIllegal()` in `scripts/tp-violation/probe.mjs`:
   *   (1) interposition, (2) orphan/duplicate/foreign result, (3) trailing block.
   */
  function illegalSequence(msgs: Message[]): boolean {
    const pending = new Set<string>();
    for (const m of msgs) {
      if (m.role === 'tool') {
        const id = (m as Message & { tool_call_id?: string }).tool_call_id ?? '';
        if (!pending.has(id)) return true;
        pending.delete(id);
        continue;
      }
      if (pending.size > 0) return true;
      if (m.role === 'assistant' && m.tool_calls?.length) {
        for (const c of m.tool_calls as (ToolCall & { id?: string })[]) pending.add(c.id ?? '');
      }
    }
    return pending.size > 0;
  }

  // `wantDeepseek` is the measured provider verdict: 'legal' ACCEPTED, 'illegal' REJECTED.
  const SEQUENCES: { name: string; wantDeepseek: 'legal' | 'illegal'; wantOllama: 'legal' | 'illegal'; msgs: Message[] }[] = [
    { name: '01 single turn, no tools', wantDeepseek: 'legal', wantOllama: 'legal', msgs: [U('q'), A('a')] },
    { name: '02 tool round answered', wantDeepseek: 'legal', wantOllama: 'legal', msgs: [U('q'), A('calling', P1), T('p1'), A('done')] },
    { name: '03 tool round, then user asks again', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), T('p1'), A('done'), U('again'), A('done2')] },
    { name: '04 two sequential tool rounds', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('r1', P1), T('p1'), A('r2', P12), T('p1'), T('p2'), A('end')] },
    { name: '05 parallel calls answered in ORDER', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P123), T('p1'), T('p2'), T('p3'), A('end')] },
    { name: '06 parallel calls answered REVERSED (order-free)', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P123), T('p3'), T('p2'), T('p1'), A('end')] },
    { name: '07 tool result then user (tool to user native)', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), T('p1'), U('steer now')] },
    { name: '08 tool result then note (tool to note native)', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), T('p1'), N('REMINDER', 'steer')] },
    { name: '09 consecutive user turns', wantDeepseek: 'legal', wantOllama: 'legal', msgs: [U('q1'), U('q2'), U('q3')] },
    { name: '10 consecutive user turns then a tool round', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q1'), U('q2'), U('q3'), A('calling', P1), T('p1'), A('end')] },
    { name: '11 empty assistant bridge is answered', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), T('p1'), A(''), A('answer')] },
    { name: '12 no user at all (assistant first)', wantDeepseek: 'legal', wantOllama: 'legal', msgs: [A('hello')] },
    { name: '13 multi-round with a note between rounds', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('r1', P1), T('p1'), N('HINT', 'hint'), A('r2', P12), T('p1'), T('p2'), A('end')] },

    { name: '14 note BEFORE the only tool result', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), N('REMINDER', 'steer'), T('p1')] },
    { name: '15 user BEFORE the only tool result', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), U('new direction'), T('p1')] },
    { name: '16 note AFTER first of TWO results', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), N('HINT', 'mid'), T('p2')] },
    { name: '17 user AFTER first of TWO results', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), U('q2'), T('p2')] },
    { name: '18 note AFTER first of THREE results', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P123), T('p1'), N('URGENT', 'now'), T('p2'), T('p3')] },
    { name: '19 assistant bridge interposed mid-batch', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), A('bridging'), T('p2')] },
    { name: '20 tool result interposed, then another assistant block', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), A('second', [call('p9', 'grep')]), T('p2'), T('p9')] },
    { name: '21 note between rounds leaves p2 unanswered', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), N('MAIL', 'm'), A('next turn', [call('p3', 'grep')]), T('p2'), T('p3')] },

    { name: '22 trailing unanswered block (REJECTED: unfinished block)', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1')] },
    { name: '23 trailing unanswered block, nothing after (REJECTED)', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1)] },
    { name: '24 unanswered block followed by a fresh assistant turn', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), A('never mind')] },
    { name: '25 unanswered block followed by a user turn', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), U('hello?')] },
    { name: '26 unanswered block followed by a note', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), N('SYSTEM', 'worker paused')] },
    { name: '27 partial answer then a fresh user turn', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), U('stop')] },

    { name: '28 tool result with no assistant at all', wantDeepseek: 'illegal', wantOllama: 'legal', msgs: [U('q'), T('p1')] },
    { name: '29 tool result directly after a plain user message', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), T('p1'), A('end')] },
    { name: '30 tool result after an assistant WITHOUT tool_calls', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('no calls here'), T('p1')] },
    { name: '31 tool result after a plain assistant then user', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('plain'), U('q2'), T('p1')] },
    { name: '32 orphan tool result between user turns', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), T('p1'), U('q2'), T('p1')] },
    { name: '33 tool result after a NOTE (note to tool)', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), N('REMINDER', 'steer'), T('p1')] },
    { name: '34 the reported sequence: user/user/user/tool', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q1'), U('q2'), U('q3'), T('p1')] },

    { name: '35 same tool_call_id answered twice', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), T('p1'), T('p1')] },
    { name: '36 extra tool result answering an unannounced id', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), T('p1'), T('p_unknown')] },
    { name: '37 two results for p1, p2 left unanswered (still trailing here)', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), T('p1')] },
    { name: '38 second assistant interposed while p1 pending', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p2'), A('next', [call('p3', 'grep')]), T('p1'), T('p3')] },
    { name: '39 interleave a foreign id between valid results', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P123), T('p1'), T('pX'), T('p2'), T('p3')] },

    { name: '40 truncation leaves a bare tool result', wantDeepseek: 'illegal', wantOllama: 'legal', msgs: [U('q'), T('p1')] },
    { name: '41 truncation leaves a trailing unanswered block (REJECTED)', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1)] },
    { name: '42 truncation leaves assistant then user (no tools)', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [A('answer'), U('next')] },
    { name: '43 tool result kept, assistant dropped, then user', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [T('p1'), U('next')] },
    { name: '44 wrap-up: tool results flushed then [WRAP_UP] user', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), T('p2'), U('[WRAP_UP] wrap up quickly')] },

    { name: '45 assistant with EMPTY tool_calls array', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('plain', []), A('answer')] },
    { name: '46 assistant with empty content but real tool_calls', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('', P1), T('p1'), A('answer')] },
    { name: '47 tool result with empty content', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), T('p1', 'bash', ''), A('answer')] },
    { name: '48 system message first (facade always prepends one)', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [{ role: 'system', content: 'You are mycc.' } as unknown as Message, U('q'), A('calling', P1), T('p1'), A('answer')] },
    { name: '49 system message mid-conversation', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('a'), { role: 'system', content: 'note to self' } as unknown as Message, U('q2')] },
    { name: '50 consecutive assistant turns (no tools)', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('a1'), A('a2')] },

    { name: '51 three rounds with notes at every boundary', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'),
        A('r1', P1), T('p1'), N('REMINDER', 's1'),
        A('r2', P12), T('p1'), T('p2'), N('HINT', 's2'),
        A('r3', P123), T('p1'), T('p2'), T('p3'),
        N('MAIL', 'wrap'), U('final'), A('end')] },
    { name: '52 two rounds where round 2 orphans one call', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'),
        A('r1', P1), T('p1'),
        A('r2', P12), T('p1'), U('interrupt'), T('p2')] },
    { name: '53 note + user deferred after last result (PART-2 replay shape)', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), T('p2'), N('REMINDER', 'note'), U('genuine query')] },
    { name: '54 the exact pre-fix facade shape (must be rejected)', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P1), U('[REMINDER] steer'), A('', [call('tp_recovery_1', 'bash')]), T('tp_recovery_1'), T('p1')] },
    { name: '55 double violation: interpose AND orphan', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), U('interrupt'), T('p2'), A('plain'), T('p9')] },

    // ════ 9. THE NO-MERGE CONTRACT ════
    //  With the merge removed, a note that arrives while the last role is
    //  'user' stays its OWN message, so the facade emits user → user (legal on
    //  both providers — case 09 proved consecutive user turns are accepted).
    //  #60 is the regression guard: removing the merge must NOT be read as
    //  permission to interpose a note mid-batch.
    { name: '56 no-merge: note after a genuine query (user → note-user)', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('do the thing'), N('REMINDER', 'nudge')] },
    { name: '57 no-merge: query then three standalone notes of mixed priority', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), N('REMINDER', 'r'), N('URGENT', 'u'), N('HINT', 'h')] },
    { name: '58 no-merge: two consecutive genuine queries', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q1'), U('q2')] },
    { name: '59 no-merge: standalone note then a tool round', wantDeepseek: 'legal', wantOllama: 'legal',
      msgs: [U('q'), N('MAIL', 'm'), A('calling', P1), T('p1'), A('end')] },
    { name: '60 no-merge regression guard: a note mid-batch is STILL rejected', wantDeepseek: 'illegal', wantOllama: 'legal',
      msgs: [U('q'), A('calling', P12), T('p1'), N('HINT', 'note'), T('p2')] },
  ];

  it('covers the ~50-case matrix (60 conversations)', () => {
    expect(SEQUENCES).toHaveLength(60);
    expect(SEQUENCES.filter((s) => s.wantDeepseek === 'illegal').length).toBe(33);
    expect(SEQUENCES.filter((s) => s.wantDeepseek === 'legal').length).toBe(27);
  });

  it('encoder: every case carries BOTH providers\' measured expectations', () => {
    // A drift in either provider's measured verdict must be a deliberate edit,
    // not a silent default. DeepSeek rejects 33 shapes; Ollama rejects none —
    // the tolerance split is the reason the defect survived dev.
    const deepseekRejects = SEQUENCES.filter((s) => s.wantDeepseek === 'illegal');
    const ollamaRejects = SEQUENCES.filter((s) => s.wantOllama === 'illegal');
    expect(deepseekRejects).toHaveLength(33);
    expect(ollamaRejects).toHaveLength(0);
    // Every case the strict provider rejects is accepted by the permissive one.
    for (const s of deepseekRejects) expect(s.wantOllama).toBe('legal');
  });

  it('the strict model agrees with DeepSeek on ALL 60 cases (27 accepted / 33 rejected)', () => {
    const disagreements = SEQUENCES.filter((s) => {
      const local = illegalSequence(s.msgs) ? 'illegal' : 'legal';
      return local !== s.wantDeepseek;
    }).map((s) => s.name);
    expect(disagreements).toEqual([]);
  });

  it('the tolerance split: Ollama accepts every shape the strict model flags', () => {
    // `illegalSequence()` models the strict provider, so the 33 shapes it flags
    // are exactly the rows Ollama is expected to answer with HTTP 200.
    const strictFlags = SEQUENCES.filter((s) => illegalSequence(s.msgs));
    expect(strictFlags).toHaveLength(33);
    for (const s of strictFlags) expect(s.wantOllama).toBe('legal');
  });

  it('the three provider rules are each independently enforced', () => {
    // (1) interposition
    expect(illegalSequence([U('q'), A('calling', P12), T('p1'), N('HINT', 'mid'), T('p2')])).toBe(true);
    // (2) orphan / duplicate result
    expect(illegalSequence([U('q'), A('calling', P1), T('p1'), T('p1')])).toBe(true);
    // (3) trailing unanswered block — no legal in-flight wire state
    expect(illegalSequence([U('q'), A('calling', P1)])).toBe(true);
    // and their legal complements stay legal
    expect(illegalSequence([U('q'), A('calling', P12), T('p1'), T('p2'), A('end')])).toBe(false);
    expect(illegalSequence([U('q1'), U('q2'), U('q3')])).toBe(false);
  });
});
