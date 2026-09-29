/**
 * triologue.test.ts - unit tests for the Triologue facade's per-piece
 * onMessage contract (the {A, AB} fix at the facade layer).
 *
 * The transcript-layer guard lives in transcript.test.ts (writer + read +
 * collation). Here we pin the PRODUCER contract that feeds it:
 *   - every producer call that APPENDS a message emits exactly ONE 'new'
 *     piece carrying the message fields (NOT a full snapshot);
 *   - the user()/note() combine branches (a MUTATION of the last user
 *     message) emit exactly ONE 'merge' piece carrying the FRAGMENT, and
 *     ZERO full-snapshot lines — the old design re-emitted the grown host
 *     ({A} then {AB}), which is what the {A, AB} fix removes;
 *   - the stamped envelope (kind / turn_id / user_origin) lives on a
 *     shallow copy — the LIVELog object inside the store stays clean, so
 *     getMessagesRaw() never carries envelope keys;
 *   - turn identity: user() mints a fresh turn on a non-combine path
 *     (post-increment from 0, first turn = 1), merge pieces INHERIT the
 *     host turn's id, tool/assistant pieces carry the current turn,
 *     finishWrapUp() mints its own turn, and clear() resets the counter;
 *   - the post-tool fast path mints a fresh turn for the next user query.
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
  msg: Message & { kind?: 'new' | 'merge'; turn_id?: number; user_origin?: true };
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
function pieceOf(c: Captured): { role?: string; content?: string; kind?: string; turn_id?: number; user_origin?: true } {
  return {
    role: c.msg.role,
    content: typeof c.msg.content === 'string' ? c.msg.content : undefined,
    kind: c.msg.kind,
    turn_id: c.msg.turn_id,
    user_origin: c.msg.user_origin,
  };
}

describe('Triologue per-piece onMessage contract ({A, AB} facade guard)', () => {
  let captured: Captured[];
  let triologue: Triologue;

  beforeEach(() => {
    ({ captured, triologue } = captureAll());
  });

  it('user() mints turn 1 on a fresh triologue and emits ONE new piece (not a snapshot)', () => {
    triologue.user('hello');
    expect(captured).toHaveLength(1);
    expect(pieceOf(captured[0])).toEqual({
      role: 'user', content: 'hello', kind: 'new', turn_id: 1, user_origin: true,
    });
    // The livelog the piece saw: exactly the appended message, nothing else.
    expect(captured[0].seen.map((m) => m.role)).toEqual(['user']);
  });

  it('combined user() emits ONE merge piece carrying the FRAGMENT — never the grown host', () => {
    triologue.user('A');
    triologue.user('B'); // combine path: A grows to "A\nB" in memory
    expect(captured).toHaveLength(2);
    expect(pieceOf(captured[0])).toEqual({
      role: 'user', content: 'A', kind: 'new', turn_id: 1, user_origin: true,
    });
    expect(pieceOf(captured[1])).toEqual({
      role: 'user', content: 'B', kind: 'merge', turn_id: 1, // inherits host turn
    });
    expect(captured[1].msg.user_origin).toBeUndefined(); // a fragment, not genuine input
    // THE {A, AB} REGRESSION GUARD: the second emit is the fragment "B",
    // NOT the full mutated host "A\nB".
    expect(captured[1].msg.content).toBe('B');
    // Zero full-snapshot / grown-host lines in the whole emitted stream.
    expect(captured.some((c) => c.msg.content === 'A\nB')).toBe(false);
    // In-memory livelog still holds the combined content (LLM view unchanged).
    const raw = triologue.getMessagesRaw();
    expect(raw.map((m) => m.content)).toEqual(['A\nB']);
  });

  it('note() combine emits ONE merge piece for the note fragment with the host turn_id', () => {
    triologue.user('task');
    triologue.note('REMINDER', 'nudge');
    expect(captured).toHaveLength(2);
    expect(pieceOf(captured[0])).toEqual({
      role: 'user', content: 'task', kind: 'new', turn_id: 1, user_origin: true,
    });
    expect(pieceOf(captured[1])).toEqual({
      role: 'user', content: '[REMINDER] nudge', kind: 'merge', turn_id: 1,
    });
    // Livelog combined; the fragment alone went to onMessage.
    expect((triologue.getMessagesRaw()[0].content as string)).toBe('task\n[REMINDER] nudge');
    expect(captured.some((c) => c.msg.content === 'task\n[REMINDER] nudge')).toBe(false);
  });

  it('hook notes NEVER combine: each hook note is its own new piece', () => {
    triologue.user('task');
    triologue.note('MAIL', 'from hook', 'some-hook');
    expect(captured).toHaveLength(2);
    const hookPiece = captured[1].msg as Captured['msg'] & { hook_name?: string; kind?: 'new' | 'merge'; turn_id?: number };
    expect(hookPiece.kind).toBe('new');
    expect(hookPiece.hook_name).toBe('some-hook');
    expect(hookPiece.turn_id).toBe(1); // current turn, no mint (not a user turn)
    expect(triologue.getMessagesRaw()).toHaveLength(2); // separate message
  });

  it('tool() emits ONE new piece per result; each carries the current turn — no mint', () => {
    // Before ANY user() call the turn counter is 0: minting belongs to
    // user()/finishWrapUp() (turn = a user query's identity); agent()/tool()
    // appends INHERIT the current counter. Turn 0 = pre-first-user messages.
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
    expect(pieceOf(captured[0])).toEqual({ role: 'assistant', content: 'calling', kind: 'new', turn_id: 0 });
    expect(pieceOf(captured[1])).toEqual({ role: 'tool', content: 'out', kind: 'new', turn_id: 0 });
    const toolPiece = captured[1].msg as Message & { tool_name?: string; tool_call_id?: string };
    expect(toolPiece.tool_name).toBe('bash');
    expect(toolPiece.tool_call_id).toBeDefined();
  });

  it('the post-tool user fast path mints a FRESH turn for the next query', () => {
    triologue.agent('go');
    triologue.tool('bash', 'out'); // turn 1
    triologue.user('next query'); // tool → user: TP-fix allowed path, fresh turn
    expect(captured).toHaveLength(3);
    expect(pieceOf(captured[2])).toEqual({
      role: 'user', content: 'next query', kind: 'new', turn_id: 1, user_origin: true,
    });
  });

  it('finishWrapUp() mints its own turn for the wrap-up assistant piece', () => {
    triologue.user('long task');
    triologue.beginWrapUp(); // separate [WRAP_UP] user message (new piece, turn stays)
    triologue.finishWrapUp('wrapping up');
    expect(captured).toHaveLength(3);
    expect(pieceOf(captured[1])).toEqual({ role: 'user', content: '[WRAP_UP] LLM call interrupted. Please wrap up quickly and ask user for next steps.', kind: 'new', turn_id: 1 });
    expect(pieceOf(captured[2])).toEqual({ role: 'assistant', content: 'wrapping up', kind: 'new', turn_id: 2 });
  });

  it('clear() resets the turn counter; the next user() mints turn 1 again', () => {
    triologue.user('first');
    triologue.clear();
    triologue.user('after clear');
    expect(captured).toHaveLength(2);
    expect(pieceOf(captured[1])).toEqual({
      role: 'user', content: 'after clear', kind: 'new', turn_id: 1, user_origin: true,
    });
  });

  it('livelog messages NEVER carry envelope keys (kind/turn_id/user_origin stay on the copy)', () => {
    triologue.user('q');
    triologue.note('REMINDER', 'n');
    triologue.agent('a');
    const raw = triologue.getMessagesRaw();
    for (const m of raw) {
      expect(Object.prototype.hasOwnProperty.call(m, 'kind')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(m, 'turn_id')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(m, 'user_origin')).toBe(false);
    }
  });

  it('end-to-end turn shape: turn ids replayable into the collated view', () => {
    triologue.user('q1');        // turn 1 (new, user)
    triologue.note('HINT', 'h'); // merge, turn 1
    triologue.agent('r1', [      // new, turn 1 (+ pending call registered)
      { id: 'tc-e2e', function: { name: 'bash', arguments: { command: 'ls' } } } as unknown as ToolCall,
    ]);
    triologue.tool('bash', 'o'); // new, turn 1
    triologue.user('q2');        // turn 2 (post-tool fast path mints)
    expect(captured.map((c) => ({ kind: c.msg.kind, turn_id: c.msg.turn_id }))).toEqual([
      { kind: 'new', turn_id: 1 },
      { kind: 'merge', turn_id: 1 },
      { kind: 'new', turn_id: 1 },
      { kind: 'new', turn_id: 1 },
      { kind: 'new', turn_id: 2 },
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