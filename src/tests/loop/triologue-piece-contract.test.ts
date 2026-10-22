/**
 * triologue-piece-contract.test.ts - the Triologue facade's per-piece
 * onMessage contract (the {A, AB} fix at the facade layer).
 *
 * The transcript-layer guard lives in transcript.test.ts (writer + read +
 * collation). Here we pin the PRODUCER contract that feeds it:
 *   - every producer call that APPENDS a message emits exactly ONE 'new'
 *     piece carrying the message fields (NOT a full snapshot);
 *   - user() emits ONE 'user' journal piece (genuine input fragment) and
 *     note() ONE 'new' piece — both carrying the FRAGMENT only, and ZERO
 *     full-snapshot lines — the old design re-emitted the grown host
 *     ({A} then {AB}), which is what the {A, AB} fix removes;
 *   - the stamped envelope (kind / user_origin) lives on a shallow copy —
 *     the LIVELog object inside the store stays clean, so getMessagesRaw()
 *     never carries envelope keys;
 *   - the boundary-journaling contract: clear() journals a bare boundary
 *     piece { kind:'clear' } — no 'control' pseudo-kind, no `event` field.
 *
 * onMessage is typed `(msg: Message, getTriologue: () => Message[]) => void`
 * — the getTriologue closure re-reads the live store at call time, so tests
 * can assert the livelog state a producer SAW when it emitted the piece.
 *
 * Split out of triologue.test.ts (811 lines) at the seam between the
 * append-contract, the deferred-input guard, and the provider conformance
 * matrix.
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
    // The result is anchored to the CALL it answers — the id must be echoed
    // from the pending ledger, not invented at the tool() call site.
    const issued = (captured[0].msg.tool_calls as (ToolCall & { id: string })[])[0].id;
    expect(toolPiece.tool_call_id).toBe('tc1');
    expect(toolPiece.tool_call_id).toBe(issued);
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
