/**
 * triologue-sequence-conformance.test.ts - the offline provider oracle for the
 * Triologue facade's tool-call pairing rules (60 hand-built conversations).
 *
 * Split out of triologue.test.ts (811 lines) at the behaviour seam: this file
 * carries only the self-contained conformance matrix (it builds its own
 * messages and never touches the store), so it needs no Triologue instance.
 */

import { describe, it, expect } from 'vitest';
import type { Message, ToolCall } from '../../types.js';

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
