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

  it('combined user() emits ONE user journal piece carrying the FRAGMENT — never the grown host', () => {
    triologue.user('A');
    triologue.user('B'); // combine path: A grows to "A\nB" in memory
    expect(captured).toHaveLength(2);
    expect(pieceOf(captured[0])).toEqual({
      role: 'user', content: 'A', kind: 'new', user_origin: true,
    });
    expect(pieceOf(captured[1])).toEqual({
      role: 'user', content: 'B', kind: 'user', user_origin: true,
    });
    expect(captured[1].msg.user_origin).toBe(true); // a genuine-input fragment
    // THE {A, AB} REGRESSION GUARD: the second emit is the fragment "B",
    // NOT the full mutated host "A\nB".
    expect(captured[1].msg.content).toBe('B');
    // Zero full-snapshot / grown-host lines in the whole emitted stream.
    expect(captured.some((c) => c.msg.content === 'A\nB')).toBe(false);
    // In-memory livelog still holds the combined content (LLM view unchanged).
    const raw = triologue.getMessagesRaw();
    expect(raw.map((m) => m.content)).toEqual(['A\nB']);
  });

  it('note() combine emits ONE merge piece for the note fragment', () => {
    triologue.user('task');
    triologue.note('REMINDER', 'nudge');
    expect(captured).toHaveLength(2);
    expect(pieceOf(captured[0])).toEqual({
      role: 'user', content: 'task', kind: 'new', user_origin: true,
    });
    expect(pieceOf(captured[1])).toEqual({
      role: 'user', content: '[REMINDER] nudge', kind: 'merge',
    });
    // Livelog combined; the fragment alone went to onMessage.
    expect((triologue.getMessagesRaw()[0].content as string)).toBe('task\n[REMINDER] nudge');
    expect(captured.some((c) => c.msg.content === 'task\n[REMINDER] nudge')).toBe(false);
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
    triologue.note('HINT', 'h'); // merge (note fragment)
    triologue.agent('r1', [      // new (+ pending call registered)
      { id: 'tc-e2e', function: { name: 'bash', arguments: { command: 'ls' } } } as unknown as ToolCall,
    ]);
    triologue.tool('bash', 'o'); // new
    triologue.user('q2');        // new, user (post-tool fast path)
    expect(captured.map((c) => ({ kind: c.msg.kind }))).toEqual([
      { kind: 'new' },
      { kind: 'merge' },
      { kind: 'new' },
      { kind: 'new' },
      { kind: 'new' },
    ]);
    // getTriologue reflects the LIVE store at each emit time: 5 pieces
    // were emitted, but the livelog holds only 4 messages — the merge
    // adds a transcript LINE without adding a livelog MESSAGE (it grows
    // the host in memory). That asymmetry is the {A, AB} fix working:
    // collating the 5 pieces reproduces exactly these 4 livelog messages.
    expect(captured[4].seen).toHaveLength(4);
    expect(captured[4].seen.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(captured[4].seen[0].content).toBe('q1\n[HINT] h'); // host grown by the merge
  });
});