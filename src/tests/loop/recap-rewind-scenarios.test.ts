/**
 * recap-rewind-scenarios.test.ts — the rewind sequences, end to end.
 *
 * recap writes its summary into the anchor brief's own tool RESULT (in place;
 * recap-note.ts) instead of appending a summary turn.
 *
 * THE ANCHOR RULE (the one rule selection follows):
 *
 *     a brief is an anchor only when it is NOT synthetic AND there are OTHER
 *     messages after its round-trip (the assistant brief call + its tool
 *     result)
 *
 * A brief with nothing after it is not an anchor yet — it is where the
 * conversation currently stands. "Other messages" includes ANOTHER BRIEF: a
 * lone brief3 after a recap does not anchor by itself, but once anything lands
 * after brief3 (even one more brief) brief3 stands as an anchor.
 *
 * Scenarios (exactly as specified; `t` = an ordinary tool round-trip):
 *   1. b1 → t → b2 → t → recap                     → rewinds to b2
 *   2. … → recap → recap                           → b1 (b2's round-trip is
 *                                                    last again after recap 1)
 *   3. … → recap → t → recap                       → b2 (t re-armed b2)
 *   4. … → recap → b3 → recap                      → b2 (a lone b3 is not an
 *                                                    anchor; it only re-arms b2)
 *
 * A fifth case documents the "…even another brief" half of the rule: one more
 * brief after b3 makes b3 itself the anchor.
 *
 * Pure store/triologue tests — no LLM, no forks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Triologue } from '../../loop/triologue.js';
import type { ToolCall } from '../../types.js';

// agent-io writes to the terminal; keep the test output clean.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// LINE 1 of a brief result is the anchor line (`[<hash>] ANCHOR — recap(…)`);
// a recap APPENDS its note as LINE 2 and RETIRES the invitation (the span it
// named is gone), leaving `[<hash>] ANCHOR`. withNoteOnly therefore accepts both
// shapes of line 1 and requires the marker on the following line — never a
// particular hash value.
const ANCHOR_LINE_RE = /^\[[A-Za-z0-9_-]+\] ANCHOR(?: — recap\(target_brief="[A-Za-z0-9_-]*"\) folds the work after this point)?$/;
const NOTE_PREFIX = 'Note, a recap has reset the conversation here with summary: ';
function withNoteOnly(content: string | undefined): boolean {
  if (!content) return false;
  const [line1, ...rest] = content.split('\n');
  if (!ANCHOR_LINE_RE.test(line1)) return false;
  // A pristine anchor line is NOT a note.
  return rest.length > 0 && rest[0].startsWith(NOTE_PREFIX);
}

let seq = 0;
function briefCall(message: string, confidence = 7): ToolCall {
  seq++;
  return {
    id: `brief_${seq}`,
    function: { name: 'brief', arguments: { message, confidence } },
  };
}

/** assistant(brief) → tool('brief', 'OK') — one brief round-trip. */
function pushBrief(t: Triologue, message: string): string {
  const call = briefCall(message);
  t.agent('', [call]);
  t.tool('brief', 'OK', call.id);
  return call.id;
}

/** A real tool round-trip (assistant with tool_calls → its tool result). */
function pushTool(t: Triologue, name = 'bash'): string {
  seq++;
  const id = `${name}_${seq}`;
  t.agent('', [{ id, function: { name, arguments: { command: 'ls' } } } as ToolCall]);
  t.tool(name, 'file listing', id);
  return id;
}

/** The content of the tool result answering `callId`. */
function resultOf(t: Triologue, callId: string): string | undefined {
  return t.getMessages().find((m) => m.role === 'tool' && m.tool_call_id === callId)?.content;
}

describe('recap rewind scenarios (anchor = non-synthetic brief with activity after it)', () => {
  let t: Triologue;

  beforeEach(() => {
    seq = 0;
    t = new Triologue();
  });

  it('1. b1 → t → b2 → t → recap rewinds to b2', () => {
    const b1 = pushBrief(t, 'BRIEF ONE');
    pushTool(t);
    const b2 = pushBrief(t, 'BRIEF TWO');
    pushTool(t);

    const result = t.rewindToLastBrief('summary of the span')!;
    expect(result.anchorMessage).toBe('BRIEF TWO');

    // b2's OWN result carries the note; everything after b2 is folded away.
    expect(withNoteOnly(resultOf(t, b2))).toBe(true);
    expect(resultOf(t, b2)).toContain('summary of the span');
    expect(t.getMessages().at(-1)!.tool_call_id).toBe(b2);
    expect(t.getLastRole()).toBe('tool');
    // b1 and its tool survive untouched.
    expect(resultOf(t, b1)).toBe('OK');
  });

  it('2. … → recap → recap rewinds to b1 on the second recap', () => {
    const b1 = pushBrief(t, 'BRIEF ONE');
    pushTool(t);
    const b2 = pushBrief(t, 'BRIEF TWO');
    pushTool(t);

    expect(t.rewindToLastBrief('summary one')!.anchorMessage).toBe('BRIEF TWO');

    // Recap 1 truncated at b2's result, so b2 is the newest brief with nothing
    // after it — rule 2 skips it and b1 (which has b2 after it) anchors.
    const second = t.rewindToLastBrief('summary two')!;
    expect(second.anchorMessage).toBe('BRIEF ONE');
    expect(withNoteOnly(resultOf(t, b1))).toBe(true);
    expect(resultOf(t, b1)).toContain('summary two');
    // b2 was folded into the span.
    expect(resultOf(t, b2)).toBeUndefined();
    expect(t.getMessages().at(-1)!.tool_call_id).toBe(b1);
  });

  it('3. … → recap → tool → recap rewinds to b2 (the tool re-armed it)', () => {
    const b1 = pushBrief(t, 'BRIEF ONE');
    pushTool(t);
    const b2 = pushBrief(t, 'BRIEF TWO');
    pushTool(t);

    expect(t.rewindToLastBrief('summary one')!.anchorMessage).toBe('BRIEF TWO');

    // Activity after b2's round-trip: "acting on the summary" + a tool result.
    t.agent('acting on the summary');
    pushTool(t);

    const len = t.getMessages().length;
    const second = t.rewindToLastBrief('summary two')!;
    expect(second.anchorMessage).toBe('BRIEF TWO');
    expect(t.getMessages().length).toBeLessThan(len);

    // The anchor result is OVERWRITTEN in place (not appended): b2's note now
    // holds the second summary, and the history ends on b2's round-trip.
    expect(withNoteOnly(resultOf(t, b2))).toBe(true);
    expect(resultOf(t, b2)).toContain('summary two');
    expect(resultOf(t, b2)).not.toContain('summary one');
    expect(t.getMessages().at(-1)!.tool_call_id).toBe(b2);
    // b1 kept its pristine result — it was never the anchor here.
    expect(resultOf(t, b1)).toBe('OK');
  });

  it('4. … → recap → brief3 → recap rewinds to b2 (brief3 alone is not an anchor)', () => {
    const b1 = pushBrief(t, 'BRIEF ONE');
    pushTool(t);
    const b2 = pushBrief(t, 'BRIEF TWO');
    pushTool(t);

    expect(t.rewindToLastBrief('summary one')!.anchorMessage).toBe('BRIEF TWO');

    // A lone brief3 has nothing after it yet — it stands where the conversation
    // is, so it is NOT an anchor. b2, with brief3 after it, anchors again;
    // brief3 is folded into the span.
    const b3 = pushBrief(t, 'BRIEF THREE');
    const second = t.rewindToLastBrief('summary two')!;
    expect(second.anchorMessage).toBe('BRIEF TWO');
    expect(resultOf(t, b3)).toBeUndefined();
    expect(resultOf(t, b2)).toContain('summary two');
    expect(t.getMessages().at(-1)!.tool_call_id).toBe(b2);
    expect(resultOf(t, b1)).toBe('OK');
  });

  it('5. … → recap → brief3 → brief4 → recap: another brief makes brief3 stand as an anchor', () => {
    pushBrief(t, 'BRIEF ONE');
    pushTool(t);
    const b2 = pushBrief(t, 'BRIEF TWO');
    pushTool(t);
    expect(t.rewindToLastBrief('summary one')!.anchorMessage).toBe('BRIEF TWO');

    // brief3, then one more brief (brief4) after it — "even another brief"
    // counts as activity, so brief3 becomes an anchor.
    const b3 = pushBrief(t, 'BRIEF THREE');
    const b4 = pushBrief(t, 'BRIEF FOUR');

    const second = t.rewindToLastBrief('summary two')!;
    expect(second.anchorMessage).toBe('BRIEF THREE');
    expect(withNoteOnly(resultOf(t, b3))).toBe(true);
    expect(resultOf(t, b3)).toContain('summary two');
    expect(resultOf(t, b4)).toBeUndefined();          // folded into the span
    // b2 still holds RECAP ONE's note — it was that recap's anchor. A later
    // rewind elsewhere never disturbs an anchor it did not select.
    expect(resultOf(t, b2)).toContain('summary one');
    expect(t.getMessages().at(-1)!.tool_call_id).toBe(b3);
  });

  // ---------------------------------------------------------------------
  // Explicit `target` (recap(target_brief="<hash>")) — the model chooses the
  // position instead of guessing which brief the default rule will pick.
  // The hash shown on a brief's result is a digest of the call id (see
  // briefHash); `recap(target_brief=…)` accepts that hash or the full call id.
  // ---------------------------------------------------------------------
  it('6. target rewinds to an EARLIER brief even when a newer solidified one exists', () => {
    const b1 = pushBrief(t, 'BRIEF ONE');
    pushTool(t);
    const b2 = pushBrief(t, 'BRIEF TWO');
    pushTool(t);

    // The default rule would pick b2 (newest solidified); the explicit target
    // wins over the "solidified" rule.
    expect(t.getLastBrief()!.id).toBe(b2);
    expect(t.getLastBrief(b1)!.id).toBe(b1);

    const result = t.rewindToLastBrief('summary', undefined, `[${b1}]`)!;
    expect(result.anchorMessage).toBe('BRIEF ONE');
    // Everything after b1's round-trip is gone — including the newer b2.
    expect(resultOf(t, b2)).toBeUndefined();
    expect(withNoteOnly(resultOf(t, b1))).toBe(true);
    expect(resultOf(t, b1)).toContain('summary');
    expect(t.getMessages().at(-1)!.tool_call_id).toBe(b1);
  });

  it('7. an unknown target refuses and leaves the history untouched', () => {
    const b1 = pushBrief(t, 'BRIEF ONE');
    pushTool(t);
    const len = t.getMessages().length;

    expect(t.getLastBrief('nope12')).toBeNull();
    expect(t.rewindToLastBrief('summary', undefined, 'nope12')).toBeNull();
    // No silent fallback to the default anchor: b1 is still pristine.
    expect(t.getMessages().length).toBe(len);
    expect(resultOf(t, b1)).toBe('OK');
  });

  it('8. a target may address a brief by its full call id', () => {
    const b1 = pushBrief(t, 'BRIEF ONE');
    pushTool(t);
    const b2 = pushBrief(t, 'BRIEF TWO');
    pushTool(t);

    expect(t.getLastBrief(b2)!.id).toBe(b2);
    expect(t.rewindToLastBrief('summary', undefined, b1)!.anchorMessage).toBe('BRIEF ONE');
    expect(resultOf(t, b2)).toBeUndefined();
    expect(withNoteOnly(resultOf(t, b1))).toBe(true);
  });

  it('9. a target naming the LAST brief has nothing to collapse → null, unchanged', () => {
    const b1 = pushBrief(t, 'BRIEF ONE');
    pushTool(t);
    const b2 = pushBrief(t, 'BRIEF TWO');
    const len = t.getMessages().length;

    // b2 is the very last round-trip: there is no span beneath it.
    expect(t.getLastBrief(b2)).toBeNull();
    expect(t.rewindToLastBrief('summary', undefined, b2)).toBeNull();
    expect(t.getMessages().length).toBe(len);
    expect(resultOf(t, b1)).toBe('OK');
    expect(resultOf(t, b2)).toBe('OK');
  });
});
