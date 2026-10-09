#!/usr/bin/env node
/**
 * tp-violation — message-sequence conformance, judged by the PROVIDER.
 *
 * ─── The two provider invariants ────────────────────────────────────────────
 * (1) An assistant message carrying `tool_calls` MUST be followed by tool
 *     messages answering EACH `tool_call_id`, before any other role appears.
 *         DeepSeek: HTTP 400 "must be followed by tool messages responding to
 *         each 'tool_call_id'".
 * (2) A `tool` message MUST answer a tool_call_id announced by a preceding
 *     assistant — a tool result may never appear first or twice.
 *         DeepSeek: HTTP 400 "Messages with role 'tool' must be a response to
 *         a preceding message with 'tool_calls'".
 *
 * Ollama tolerates violations of both; DeepSeek enforces them. This is why the
 * defect survived on the dev provider.
 *
 * ─── What this covers ───────────────────────────────────────────────────────
 * Phase 1 (offline, CI): drives the REAL facade through a producer-order matrix
 *   and checks the sequence it builds with isIllegal().
 * Phase 2 (live): posts any illegal facade output to the provider.
 * Phase 3 (live): hand-built wire probes isolating provider tolerance.
 * Phase 4 (live, the exhaustive one): ~55 hand-built SEQUENCES covering the
 *   whole role algebra — every interposition point, every truncation point,
 *   every duplicate/order variant. Each is judged by the real provider, and
 *   the LOCAL checker is simultaneously graded against the provider's verdict,
 *   so a blind spot in isIllegal() shows up as a MISMATCH row.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/tp-violation/probe.mjs --mock                    # phases 1
 *   node scripts/tp-violation/probe.mjs --provider=deepseek       # all phases
 *   node scripts/tp-violation/probe.mjs --provider=ollama
 *
 * Exit 0 when conclusive, 1 on transport errors or a violated phase-1 invariant.
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const has = (n) => argv.includes(`--${n}`);
const PROVIDER = flag('provider');
const OFFLINE = has('mock');
/** Only run the exhaustive sequence matrix (skip the facade phases). */
const ONLY_SEQ = has('sequences');
/** Print every row, not just the mismatches/interesting ones. */
const VERBOSE = has('verbose');

if (PROVIDER) process.env.API_PROVIDER = PROVIDER;

// The facade (and its provider layer) are TypeScript. Node must be told how to
// load a .ts module before ANY dynamic import of one — register tsx here, at
// the top of the module, so it is in force for every import below (the offline
// matrix needs Triologue just as much as the live phases need retryChat; the
// earlier revision only registered inside the live branch, so --mock imported
// the .ts un-transpiled and Node handed back a namespace with no constructor).
const { register } = await import('tsx/esm/api');
register();

let Triologue, retryChat, MODEL, getApiProvider;
let loadEnv;
{
  const load = async (rel) => import(pathToFileURL(join(REPO, rel)).href);
  ({ Triologue } = await load('src/loop/triologue.ts'));
  if (!OFFLINE) {
    ({ retryChat, MODEL } = await load('src/engine/chat-provider.ts'));
    ({ getApiProvider, loadEnv } = await load('src/config.ts'));
    loadEnv();
  }
}

// ── The invariant, as code ──────────────────────────────────────────────────
/**
 * Full-fidelity model of the provider's tool-call pairing rules — BOTH
 * invariants, as measured by phase 4 against live DeepSeek (the earlier
 * narrower version only caught interposition and had 13 blind spots).
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
 *       unanswered block is NOT in-flight-legal: the provider rejects the
 *       request outright ("insufficient tool messages following tool_calls
 *       message"). Measured on cases 22, 23, 41.
 *
 * Note the asymmetry this leaves: a legal in-flight shape does not exist at the
 * wire level — the provider never sees a facade that is mid-batch. The facade
 * must therefore answer (or drop) every block before it ever posts.
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

const roles = (msgs) => msgs.map((m) => m.role).join(' → ');
const tc = (id, name) => ({ id, function: { name, arguments: {} } });
const describe = (msgs) =>
  msgs.map((m) => (m.tool_calls ? `${m.role}[${m.tool_calls.map((c) => c.id).join(',')}]` : m.role)).join(' → ');

// ── MATRIX: every producer order that can interleave with tool calls ───────
/**
 * `expect` is the ASSERTION ABOUT THE INVARIANT:
 *   'legal'      — the facade may never build an illegal sequence here
 *   'illegal'    — (only used to demonstrate the pre-fix shape; must be absent
 *                  from a healthy tree)
 */
const MATRIX = [
  // ── baseline ──
  { name: 'agent → tool → note (true turn boundary)', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash')]); t.tool('bash', 'o'); t.note('REMINDER', 'b'); } },
  // ── single pending call ──
  { name: 'note() with 1 call pending', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash')]); t.note('REMINDER', 's'); t.tool('bash', 'o'); } },
  { name: 'user() with 1 call pending', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash')]); t.user('new direction'); t.tool('bash', 'o'); } },
  { name: 'hook note() with 1 call pending', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash')]); t.note('MAIL', 'hooked', 'some-hook'); t.tool('bash', 'o'); } },
  { name: 'all five categories with 1 call pending', expect: 'legal',
    build: (t) => {
      t.agent('go', [tc('p1', 'bash')]);
      for (const c of ['URGENT', 'MAIL', 'HINT', 'SYSTEM', 'REMINDER']) t.note(c, `${c} text`);
      t.tool('bash', 'o');
    } },
  { name: 'note(), user(), note() with 1 call pending', expect: 'legal',
    build: (t) => {
      t.agent('go', [tc('p1', 'bash')]);
      t.note('URGENT', 'a'); t.user('q'); t.note('HINT', 'b');
      t.tool('bash', 'o');
    } },
  // ── multi pending call ──
  { name: 'multi-call: note before any result', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash'), tc('p2', 'read')]); t.note('MAIL', 's'); t.tool('bash', 'o1'); t.tool('read', 'o2'); } },
  { name: 'multi-call: note BETWEEN the two results', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash'), tc('p2', 'read')]); t.tool('bash', 'o1'); t.note('HINT', 'mid'); t.tool('read', 'o2'); } },
  { name: 'multi-call: note after the LAST result', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash'), tc('p2', 'read')]); t.tool('bash', 'o1'); t.tool('read', 'o2'); t.note('SYSTEM', 'late'); } },
  { name: 'triple-call: notes interleaved between results', expect: 'legal',
    build: (t) => {
      t.agent('go', [tc('p1', 'bash'), tc('p2', 'read'), tc('p3', 'grep')]);
      t.note('URGENT', 'a'); t.tool('bash', 'o1');
      t.user('q'); t.tool('read', 'o2');
      t.note('HINT', 'b'); t.tool('grep', 'o3');
    } },
  // ── interrupt / recovery paths ──
  { name: 'skipPendingTools() answers all calls, then note', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash'), tc('p2', 'read')]); t.skipPendingTools('[interrupted]'); t.note('SYSTEM', 'paused'); } },
  { name: 'note deferred across an ESC interrupt', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash')]); t.note('SYSTEM', 'p'); t.skipPendingTools('[interrupted]'); } },
  { name: 'second agent() while calls pending (duplicate-assistant recovery)', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash')]); t.agent('again', [tc('p2', 'read')]); t.tool('read', 'o2'); } },
  { name: 'note then second agent() while pending', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash')]); t.note('MAIL', 'n'); t.agent('again', [tc('p2', 'read')]); t.tool('read', 'o2'); } },
  // ── reset / drop points: a deferred input must NOT resurrect ──
  { name: 'clear() while a note is deferred', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash')]); t.note('URGENT', 'x'); t.clear(); t.user('after clear'); } },
  { name: 'beginWrapUp() flushes pending (skips) then note', expect: 'legal',
    build: (t) => { t.agent('go', [tc('p1', 'bash')]); t.note('SYSTEM', 'p'); t.beginWrapUp(); t.user('next'); } },
  // ── longer realistic turn ──
  { name: 'realistic: two tool rounds with notes at each boundary', expect: 'legal',
    build: (t) => {
      t.user('do the work');
      t.agent('step 1', [tc('a1', 'bash')]); t.tool('bash', 'r1'); t.note('REMINDER', 'steer 1');
      t.agent('step 2', [tc('a2', 'read'), tc('a3', 'grep')]);
      t.tool('read', 'r2'); t.note('HINT', 'steer 2'); t.tool('grep', 'r3');
      t.note('MAIL', 'wrap'); t.user('final');
    } },
];

// ── Phase 3: hand-built tolerance probes (coarse, kept for continuity) ─────
const MOCK = {
  A_legal: [
    { role: 'user', content: 'Read notes.txt.' },
    { role: 'assistant', content: 'Calling.', tool_calls: [tc('m1', 'bash')] },
    { role: 'tool', tool_name: 'bash', tool_call_id: 'm1', content: 'hi' },
    { role: 'user', content: 'Summarize in three words.' },
  ],
  B_interposed_note: [
    { role: 'user', content: 'Read notes.txt.' },
    { role: 'assistant', content: 'Calling.', tool_calls: [tc('m1', 'bash')] },
    { role: 'user', content: '[REMINDER] Steering notes (mid-task direction):\n(1) check the header' },
    { role: 'tool', tool_name: 'bash', tool_call_id: 'm1', content: 'hi' },
    { role: 'user', content: 'Summarize in three words.' },
  ],
  C_empty_assistant_bridge: [
    { role: 'user', content: 'Read notes.txt.' },
    { role: 'assistant', content: 'Calling.', tool_calls: [tc('m1', 'bash')] },
    { role: 'assistant', content: '' },
    { role: 'user', content: '[REMINDER] Steering notes (mid-task direction):\n(1) check the header' },
    { role: 'tool', tool_name: 'bash', tool_call_id: 'm1', content: 'hi' },
    { role: 'user', content: 'Summarize in three words.' },
  ],
  D_orphaned_tool_calls: [
    { role: 'user', content: 'Read notes.txt.' },
    { role: 'assistant', content: 'Calling.', tool_calls: [tc('m1', 'bash')] },
    { role: 'assistant', content: 'Never mind.' },
    { role: 'user', content: 'Summarize in three words.' },
  ],
  E_second_call_unanswered: [
    { role: 'user', content: 'Read both files.' },
    { role: 'assistant', content: 'Calling.', tool_calls: [tc('m1', 'bash'), tc('m2', 'read')] },
    { role: 'tool', tool_name: 'bash', tool_call_id: 'm1', content: 'one' },
    { role: 'user', content: '[HINT] mid-batch note' },
    { role: 'tool', tool_name: 'read', tool_call_id: 'm2', content: 'two' },
    { role: 'user', content: 'Summarize.' },
  ],
};

// ── Phase 4: the exhaustive role-sequence matrix ──────────────────────────
/**
 * Each case is a COMPLETE conversation. `expect` is the invariant assertion
 * used OFFLINE (when there is no provider verdict); `wantDeepseek` is the expected
 * PROVIDER verdict used LIVE.
 *
 *   legal   — must be ACCEPTED  (a shape the facade is allowed to build)
 *   illegal — must be REJECTED  (a shape the facade must never build)
 *
 * `wantDeepseek` is deliberately the ground truth for phase 4: if the local isIllegal()
 * disagrees with the provider, the row is reported as a MISMATCH so the
 * checker's blind spots are visible rather than hidden.
 */
const U = (text) => ({ role: 'user', content: text });
const A = (text, calls) => ({ role: 'assistant', content: text || '', ...(calls ? { tool_calls: calls } : {}) });
const T = (id, name, text) => ({ role: 'tool', tool_name: name || 'bash', tool_call_id: id, content: text || 'ok' });
const N = (cat, text) => U(`[${cat}] ${text}`);
const P1 = [tc('p1', 'bash')];
const P12 = [tc('p1', 'bash'), tc('p2', 'read')];
const P123 = [tc('p1', 'bash'), tc('p2', 'read'), tc('p3', 'grep')];

const SEQUENCES = [
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
  //  Measured: the provider refuses an unanswered block even at the very end of
  //  the request. There is no legal "in-flight" wire state — the facade must
  //  answer (or drop) every block before posting.
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
];

// ── Runner ─────────────────────────────────────────────────────────────────
let inconclusive = 0;
let invariantBreaches = 0;

function makeFacade() {
  // Deliberately empty onMessage: the guard must hold regardless of listeners.
  return new Triologue({ onMessage: () => {}, tokenThreshold: 50000, resultThreshold: 100000 });
}

function runMatrix() {
  console.log('── phase 1: producer-order matrix (real facade, offline) ──\n');
  const built = [];
  for (const c of MATRIX) {
    const t = makeFacade();
    t.user('task');
    let threw = null;
    try { c.build(t); } catch (e) { threw = e; }
    if (threw) {
      console.log(`  [threw] ${c.name}\n          ${String(threw.message).slice(0, 100)}`);
      built.push({ c, msgs: null, illegal: false });
      continue;
    }
    const msgs = t.getMessages();
    const illegal = isIllegal(msgs);
    const ok = c.expect === 'legal' ? !illegal : illegal;
    if (!ok) invariantBreaches++;
    console.log(`  [${ok ? 'ok ' : 'BAD'}] ${c.name}`);
    console.log(`          ${describe(msgs)}${illegal ? '   ← ILLEGAL' : ''}`);
    built.push({ c, msgs, illegal });
  }
  return built;
}

async function post(messages) {
  try {
    const resp = await retryChat(
      { model: MODEL, messages, tools: [], think: false },
      { signal: AbortSignal.timeout(120000) },
    );
    return { status: 'ACCEPTED', detail: `reply: ${String(resp?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 60)}` };
  } catch (err) {
    const code = err?.status ?? err?.statusCode;
    const msg = String(err?.message ?? err);
    // deepseek's wrapper embeds the status in the text rather than setting
    // .status, so match the body too or real rejections get misfiled.
    const rejected =
      /40\d/.test(String(code)) ||
      /API error 4\d\d|invalid_request_error|must be followed by tool messages|must be a response to a preceding message/i.test(msg);
    if (!rejected) inconclusive++;
    return { status: rejected ? 'REJECTED' : 'TRANSPORT-ERROR', detail: msg.replace(/\s+/g, ' ').slice(0, 170) };
  }
}

/** Phase 4: post every sequence, grade the local checker against the verdict. */
/**
 * Phase 4 — grade the matrix against a KNOWN-CORRECT provider verdict set.
 *
 * The split legs each carry their OWN expectation table (`wantDeepseek` for DeepSeek;
 * `wantOllama` for Ollama), so the same 55 cases are graded twice against two
 * DIFFERENT oracles — which is the point: the provider asymmetry is the finding,
 * not an accident of the run. A permissive run that accepts an interposed block
 * is a PASS on the Ollama leg and a FAIL on the DeepSeek leg.
 *
 * `expected` is the measured verdict map (probe run 2026-10-09). When the
 * provider's live verdict disagrees with the expectation we emit a `BAD` row.
 */
function wantFor(case_, provider) {
  return provider === 'ollama' ? case_.wantOllama : case_.wantDeepseek;
}

async function runSequences(provider) {
  console.log(`\n── phase 4: exhaustive sequence matrix vs the LIVE ${provider} provider (${SEQUENCES.length} cases) ──\n`);
  let accepted = 0, rejected = 0, mismatches = 0, wrong = 0;

  for (const c of SEQUENCES) {
    process.stdout.write(`  ${c.name}... `);
    const r = await post(c.msgs);
    const localIllegal = isIllegal(c.msgs);
    const localVerdict = localIllegal ? 'illegal' : 'legal';
    const wantDeepseek = wantFor(c, provider);

    // Where the two verdicts must agree (the provider is ground truth).
    const agrees = wantDeepseek === localVerdict;
    // Where the run itself was informative.
    const informative = r.status !== 'TRANSPORT-ERROR';
    const providerOk = informative && r.status === (wantDeepseek === 'legal' ? 'ACCEPTED' : 'REJECTED');

    if (r.status === 'ACCEPTED') accepted++;
    else if (r.status === 'REJECTED') rejected++;
    if (!agrees) mismatches++;
    if (informative && !providerOk) wrong++;

    const tag = !informative ? '???' : providerOk ? 'ok ' : 'BAD';
    if (VERBOSE || tag !== 'ok ' || !agrees) {
      console.log(`${r.status}  [${tag}]${agrees ? '' : `  ← EXPECTATION MISMATCH (expected ${wantDeepseek}, local checker says ${localVerdict})`}`);
      console.log(`          ${describe(c.msgs)}`);
      console.log(`          ${r.detail}`);
    } else {
      console.log(`${r.status}  [${tag}]`);
    }
  }

  console.log(`\n── phase 4 verdict (${provider}) ──`);
  console.log(`  cases: ${SEQUENCES.length}   accepted: ${accepted}   rejected: ${rejected}`);
  console.log(`  expectation mismatches: ${wrong}   checker-vs-provider mismatches: ${mismatches}`);

  // Reproducibility guard. On the strict provider the matrix is measured:
  // 23 accepted / 32 rejected. A run that ACCEPTS EVERYTHING is the signature of
  // a silent failure — the requests never reached the strict provider (wrong
  // --provider, a permissive fallback, or a misrouted request) — so every
  // verdict is garbage that happens to look like a clean sweep. Fail loudly.
  if (provider === 'deepseek' && rejected === 0) {
    console.log('\n  ⚠ all cases ACCEPTED on deepseek — expected 32 rejections.');
    console.log('    A strict provider cannot accept an interposed/orphaned tool block,');
    console.log('    so this run never reached it. Treating as inconclusive.');
    inconclusive++;
  }
  // Symmetric guard for the permissive provider: nothing may be rejected there.
  if (provider === 'ollama' && rejected > 0) {
    console.log(`\n  ⚠ ${rejected} case(s) REJECTED on ollama — the permissive provider was`);
    console.log('    expected to accept every shape. Check model/config drift.');
    inconclusive++;
  }
  return { wrong, mismatches, accepted, rejected };
}

async function main() {
  console.log('\n═══ tp-violation probe ═══');
  const provider = PROVIDER ?? 'deepseek';
  if (!OFFLINE) console.log(`provider: ${provider}   model: ${MODEL}`);
  console.log('facade:   real Triologue (never hand-mocked)\n');

  if (OFFLINE) {
    const built = runMatrix();
    console.log('\n── phase 1 verdict (--mock: offline) ──');
    console.log(`  cases: ${MATRIX.length}   invariant breaches: ${invariantBreaches}`);
    console.log(`  illegal sequences built: ${built.filter((b) => b.illegal).length}`);
    console.log('\n  (phase 4 sequence matrix needs a live provider — run without --mock)\n');
    return invariantBreaches === 0 ? 0 : 1;
  }

  if (!ONLY_SEQ) {
    const built = runMatrix();
    const illegalCases = built.filter((b) => b.illegal);

    if (illegalCases.length > 0) {
      console.log('\n── phase 2: ILLEGAL sequences vs the live provider ──\n');
      for (const b of illegalCases) {
        process.stdout.write(`  posting "${b.c.name}"... `);
        const r = await post(b.msgs);
        console.log(r.status);
        console.log(`          ${r.detail}`);
      }
    } else {
      console.log('\n── phase 2: skipped — the facade built no illegal sequence ──');
    }

    console.log('\n── phase 3: hand-built wire cases (provider tolerance) ──\n');
    const phase3 = [];
    for (const [label, msgs] of Object.entries(MOCK)) {
      process.stdout.write(`  ${label}... `);
      const r = await post(msgs);
      console.log(`${r.status}  ${r.detail.slice(0, 90)}`);
      phase3.push({ label, ...r, illegal: isIllegal(msgs) });
    }
    const base = phase3.find((p) => p.label === 'A_legal');
    if (base?.status !== 'ACCEPTED') inconclusive++;
  }

  const seq = await runSequences(provider);

  console.log('\n═══ summary ═══');
  console.log(`  provider                    : ${provider}`);
  console.log(`  invariant breaches (phase 1): ${invariantBreaches}`);
  console.log(`  sequence cases              : ${SEQUENCES.length} (${seq.accepted} accepted / ${seq.rejected} rejected)`);
  console.log(`  expectation mismatches      : ${seq.wrong}`);
  console.log(`  checker blind spots         : ${seq.mismatches}`);
  console.log(`  transport errors            : ${inconclusive}`);
  const ok = inconclusive === 0 && invariantBreaches === 0 && seq.wrong === 0;
  console.log(`\n  ${ok ? 'CONCLUSIVE ✓' : 'INCONCLUSIVE ✗'}\n`);
  return ok ? 0 : 1;
}

// Entry point: run ONLY when invoked directly as a script. This module is a
// manual diagnostic that posts to LIVE providers — it must never be pulled in
// as a side effect of an import (e.g. by a test runner that happened to match
// it). Importing it must be inert.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tp-violation/probe.mjs')) {
  process.exit(await main());
}
