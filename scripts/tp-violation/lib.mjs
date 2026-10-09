/**
 * tp-violation / lib — the shared fixtures.
 *
 * Holds everything the two provider legs read but never own:
 *   - the message builders (U/A/T/N) and the tool-call bundles (P1/P12/P123)
 *   - `isIllegal()` — the local model of the provider's tool-call pairing rules
 *   - `SEQUENCES` — the 55-case role-sequence matrix, each carrying a
 *     per-provider expectation (`wantDeepseek` for DeepSeek, `wantOllama` for Ollama)
 *
 * A provider leg imports this and posts each case against its own expectation;
 * neither leg may look at the other's field.
 */

// ── The invariant, as code ──────────────────────────────────────────────────
/**
 * Full-fidelity model of the provider's tool-call pairing rules — BOTH
 * invariants, as measured live against DeepSeek (an earlier narrower version
 * only caught interposition and had 13 blind spots).
 *
 * A message sequence is ILLEGAL iff ANY of:
 *
 *   (1) a pending `tool_call_id` is never answered while a later message of any
 *       other role is emitted — i.e. a non-`tool` role is INTERPOSED before a
 *       block is fully answered (note/user/assistant/system mid-batch). This
 *       also covers a SECOND assistant block opening while the first is still
 *       pending.
 *   (2) a `tool` message answers nothing announced — an ORPHAN result (no
 *       assistant before it, or the id was not announced / was already
 *       answered). Duplicate answers and foreign ids land here.
 *   (3) the conversation ENDS with a pending `tool_call_id`. A trailing
 *       unanswered block is NOT in-flight-legal: the strict provider rejects
 *       the request outright ("insufficient tool messages following tool_calls
 *       message"). Measured on cases 22, 23, 41.
 *
 * Note the asymmetry this leaves: a legal in-flight shape does not exist at the
 * wire level — the provider never sees a facade that is mid-batch. The facade
 * must therefore answer (or drop) every block before it ever posts.
 *
 * NOTE: this models the STRICT provider. Ollama enforces neither rule; that
 * asymmetry is the finding, so `SEQUENCES[i].wantOllama` differs from `.wantDeepseek`
 * for all 32 illegal cases.
 */
export function isIllegal(msgs) {
  const pending = new Set();
  for (const m of msgs) {
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? '';
      if (!pending.has(id)) return true; // (2) orphan / duplicate / foreign id
      pending.delete(id);
      continue;
    }
    if (pending.size > 0) return true; // (1) non-tool role interposed mid-batch
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const c of m.tool_calls) pending.add(c.id ?? '');
    }
  }
  return pending.size > 0; // (3) conversation ends with an unanswered block
}

// ── Builders ────────────────────────────────────────────────────────────────
export const roles = (msgs) => msgs.map((m) => m.role).join(' → ');
export const tc = (id, name) => ({ id, function: { name, arguments: {} } });
export const describe = (msgs) =>
  msgs.map((m) => (m.tool_calls ? `${m.role}[${m.tool_calls.map((c) => c.id).join(',')}]` : m.role)).join(' → ');

export const U = (text) => ({ role: 'user', content: text });
export const A = (text, calls) => ({ role: 'assistant', content: text || '', ...(calls ? { tool_calls: calls } : {}) });
export const T = (id, name, text) => ({ role: 'tool', tool_name: name || 'bash', tool_call_id: id, content: text || 'ok' });
export const N = (cat, text) => U(`[${cat}] ${text}`);
export const P1 = [tc('p1', 'bash')];
export const P12 = [tc('p1', 'bash'), tc('p2', 'read')];
export const P123 = [tc('p1', 'bash'), tc('p2', 'read'), tc('p3', 'grep')];

// ── Phase 4: the exhaustive role-sequence matrix ──────────────────────────
/**
 * Each case is a COMPLETE conversation.
 *
 *   `wantDeepseek`       — the measured DEEPSEEK verdict (ground truth for the deepseek leg)
 *   `wantOllama` — the measured OLLAMA verdict (ground truth for the ollama leg)
 *
 *   legal   → the provider ACCEPTED the request
 *   illegal → the provider REJECTED it (HTTP 400)
 *
 * Both fields are EMPIRICAL: measured by posting the exact bytes to each live
 * provider on 2026-10-09 (deepseek: 23 accepted / 32 rejected; ollama: 55
 * accepted / 0 rejected). They are deliberately redundant where the providers
 * agree, so a drift in either leg shows up as a mismatch row.
 */
export const SEQUENCES = [
  // ════ 1. BASELINE LEGAL SHAPES (the shapes the facade is allowed to build) ════
  { name: '01 baseline: single turn, no tools', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('a')] },
  { name: '02 baseline: tool round answered', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), T('p1'), A('done')] },
  { name: '03 baseline: tool round, then user asks again', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), T('p1'), A('done'), U('again'), A('done2')] },
  { name: '04 baseline: two sequential tool rounds', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('r1', P1), T('p1'), A('r2', P12), T('p1'), T('p2'), A('end')] },
  { name: '05 baseline: parallel calls answered in ORDER', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P123), T('p1'), T('p2'), T('p3'), A('end')] },
  { name: '06 baseline: parallel calls answered REVERSED', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P123), T('p3'), T('p2'), T('p1'), A('end')] },
  { name: '07 baseline: tool result then user (tool→user native)', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), T('p1'), U('steer now')] },
  { name: '08 baseline: tool result then note (tool→note native)', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), T('p1'), N('REMINDER', 'steer')] },
  { name: '09 baseline: consecutive user turns', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q1'), U('q2'), U('q3')] },
  { name: '10 baseline: consecutive user turns then a tool round', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q1'), U('q2'), U('q3'), A('calling', P1), T('p1'), A('end')] },
  { name: '11 baseline: empty assistant bridge is answered', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), T('p1'), A(''), A('answer')] },
  { name: '12 baseline: no user at all (assistant first)', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [A('hello')] },
  { name: '13 baseline: multi-round with a note between rounds', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('r1', P1), T('p1'), N('HINT', 'hint'), A('r2', P12), T('p1'), T('p2'), A('end')] },

  // ════ 2. INVARIANT (1): NON-TOOL ROLE INTERPOSED INSIDE A tool_calls BLOCK ════
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
    msgs: [U('q'), A('calling', P12), T('p1'), A('second', [tc('p9', 'grep')]), T('p2'), T('p9')] },
  { name: '21 note between rounds leaves p2 unanswered', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P12), T('p1'), N('MAIL', 'm'), A('next turn', [tc('p3', 'grep')]), T('p2'), T('p3')] },

  // ════ 3. INVARIANT (1): BLOCK NEVER ANSWERED — a trailing block is REJECTED ════
  //  Measured: the strict provider refuses an unanswered block even at the very
  //  end of the request. There is no legal "in-flight" wire state — the facade
  //  must answer (or drop) every block before posting.
  { name: '22 trailing unanswered block (rejected: unfinished block)', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P12), T('p1')] },
  { name: '23 trailing unanswered block, nothing after (rejected)', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1)] },
  { name: '24 unanswered block followed by a fresh assistant turn', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), A('never mind')] },
  { name: '25 unanswered block followed by a user turn', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), U('hello?')] },
  { name: '26 unanswered block followed by a note', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), N('SYSTEM', 'worker paused')] },
  { name: '27 partial answer then a fresh user turn', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P12), T('p1'), U('stop')] },

  // ════ 4. INVARIANT (2): tool MESSAGE WITHOUT A PRECEDING ANNOUNCEMENT ════
  { name: '28 tool result with no assistant at all', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), T('p1')] },
  { name: '29 tool result directly after a plain user message', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), T('p1'), A('end')] },
  { name: '30 tool result after an assistant WITHOUT tool_calls', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('no calls here'), T('p1')] },
  { name: '31 tool result after a plain assistant then user', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('plain'), U('q2'), T('p1')] },
  { name: '32 orphan tool result between user turns', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), T('p1'), U('q2'), T('p1')] },
  { name: '33 tool result after a NOTE (note→tool)', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), N('REMINDER', 'steer'), T('p1')] },
  { name: '34 the reported sequence: user → user → user → tool', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q1'), U('q2'), U('q3'), T('p1')] },

  // ════ 5. DUPLICATE / MISALIGNED tool RESULTS ════
  { name: '35 same tool_call_id answered twice', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), T('p1'), T('p1')] },
  { name: '36 extra tool result answering an unannounced id', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), T('p1'), T('p_unknown')] },
  { name: '37 two results for p1, p2 left unanswered', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P12), T('p1'), T('p1')] },
  { name: '38 answer id belongs to a LATER block', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P12), T('p2'), A('next', [tc('p3', 'grep')]), T('p1'), T('p3')] },
  { name: '39 interleave a foreign id between valid results', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P123), T('p1'), T('pX'), T('p2'), T('p3')] },

  // ════ 6. TRUNCATION / ROLLBACK SHAPES (what recap & wrap-up rollback can leave) ════
  { name: '40 truncation leaves a bare tool result', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), T('p1')] },
  { name: '41 truncation leaves a trailing unanswered block (rejected)', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1)] },
  { name: '42 truncation leaves assistant → user (no tools)', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [A('answer'), U('next')] },
  { name: '43 tool result kept, assistant dropped, then user', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [T('p1'), U('next')] },
  { name: '44 wrap-up: tool results flushed then [WRAP_UP] user', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P12), T('p1'), T('p2'), U('[WRAP_UP] wrap up quickly')] },

  // ════ 7. MESSAGE-SHAPE EDGE CASES ════
  { name: '45 assistant with EMPTY tool_calls array', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('plain', []), A('answer')] },
  { name: '46 assistant with empty content but real tool_calls', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('', P1), T('p1'), A('answer')] },
  { name: '47 tool result with empty content', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), { role: 'tool', tool_name: 'bash', tool_call_id: 'p1', content: '' }, A('answer')] },
  { name: '48 system message first (facade always prepends one)', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [{ role: 'system', content: 'You are mycc.' }, U('q'), A('calling', P1), T('p1'), A('answer')] },
  { name: '49 system message mid-conversation', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('a'), { role: 'system', content: 'note to self' }, U('q2')] },
  { name: '50 consecutive assistant turns (no tools)', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('a1'), A('a2')] },

  // ════ 8. LONGER REALISTIC MIXES ════
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
  { name: '53 note + user deferred after last result (the PART-2 replay shape)', wantDeepseek: 'legal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P12), T('p1'), T('p2'), N('REMINDER', 'note'), U('genuine query')] },
  { name: '54 the exact pre-fix facade shape (must be rejected)', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P1), U('[REMINDER] steer'), A('', [tc('tp_recovery_1', 'bash')]), T('tp_recovery_1'), T('p1')] },
  { name: '55 double violation: interpose AND orphan', wantDeepseek: 'illegal', wantOllama: 'legal',
    msgs: [U('q'), A('calling', P12), U('interrupt'), T('p2'), A('plain'), T('p9')] },

  // ════ 9. THE NO-MERGE CONTRACT (what the facade builds once notes never merge) ════
  //  Under no-merge every note is its OWN message, so a note that arrives while
  //  the last role is 'user' yields user → user on the wire (legal on both
  //  providers — case 09 already proved consecutive user turns are accepted).
  //  These cases are the CONTRACT GUARD for that: if a future change
  //  reintroduces a combine/merge branch, the facade stops producing this shape
  //  and the intent documented here is what breaks.
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

/**
 * The expected verdict for a case on a given provider (and, for a provider with
 * several models, a specific model).
 *
 * Today every Ollama model is equally permissive, so one `wantOllama` column
 * serves them all. The `model` parameter exists so a future model that enforces
 * a rule can carry its own expectation — e.g. `wantOllamaByModel: { 'x:cloud':
 * 'illegal' }` — WITHOUT forking the whole 55-case matrix. Resolution order:
 *   per-model override → provider-wide field → throw (a case with no expectation
 *   must never silently default to 'legal').
 */
export function wantFor(case_, provider, model) {
  const perModel = provider === 'ollama' ? case_.wantOllamaByModel : case_.wantDeepseekByModel;
  if (model && perModel && perModel[model]) return perModel[model];
  const wide = provider === 'ollama' ? case_.wantOllama : case_.wantDeepseek;
  if (wide !== 'legal' && wide !== 'illegal') {
    throw new Error(`${case_.name}: no ${provider} expectation${model ? ` for model ${model}` : ''}`);
  }
  return wide;
}

/**
 * Sanity-check the fixture itself (throws on a malformed matrix). Called by the
 * CLI before any live post, so a fixture edit cannot silently shrink the suite.
 */
export function validateSequences() {
  if (SEQUENCES.length !== 60) throw new Error(`expected 60 sequences, got ${SEQUENCES.length}`);
  for (const c of SEQUENCES) {
    if (c.wantDeepseek !== 'legal' && c.wantDeepseek !== 'illegal') throw new Error(`${c.name}: bad wantDeepseek ${c.wantDeepseek}`);
    if (c.wantOllama !== 'legal' && c.wantOllama !== 'illegal') throw new Error(`${c.name}: bad wantOllama ${c.wantOllama}`);
    if (!Array.isArray(c.msgs) || c.msgs.length === 0) throw new Error(`${c.name}: no msgs`);
  }
  const deepseekReject = SEQUENCES.filter((c) => c.wantDeepseek === 'illegal').length;
  const ollamaReject = SEQUENCES.filter((c) => c.wantOllama === 'illegal').length;
  return { count: SEQUENCES.length, deepseekReject, ollamaReject };
}
