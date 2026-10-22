/**
 * plan-scope.ts - the PLAN-mode "larger scope" reflection appended to a brief.
 *
 * WHY IT EXISTS
 * An agent in plan mode can spend a long time inside one sub-problem without
 * asking whether that sub-problem is the right one. The loop therefore makes
 * every brief, while planning, carry one extra paragraph:
 *
 *   tool('brief', "OK. When thinking on the larger scope, …", callId)
 *
 * WHY THE TOOL STAGE OWNS IT
 * A brief's RESULT is produced by execution, not by policy. Computing it here,
 * at the point where the tool result is produced, keeps it on the single path
 * everything else uses (triologue.tool) — no field on the call, no DTO carrying
 * a result, no second writer. The `brief` tool itself stays a plain reporter:
 * it never forks an LLM, and it does not know this section exists.
 *
 * WHY IT IS ONE-SHOT
 * The text rides in the brief's own tool result, which is the rewind anchor's
 * note slot: the next recap of this stretch OVERWRITES it with the span summary.
 * That is deliberate — the reflection describes the work that follows this
 * brief, so when that work is folded into a summary, the reflection is folded
 * with it. Nothing accumulates across recaps.
 *
 * WHAT IT ASKS (the four escape-hatch checks)
 * It is NOT a progress review. A plan can be executed perfectly and still be
 * wrong, because every step optimised inside a frame nobody questioned. The
 * four lines each attack that frame from a different angle:
 *   TUNNEL     — break a rule, if the simplification beats the stated cost;
 *   SUBLATE    — unify two warring requirements under one named invariant;
 *   WRONG PRB  — would you still do this if the task had never been proposed?
 *   REVERSIBLE — is this a one-way door, and is there a two-way equivalent?
 * Every line admits "none", and the model has NO tools: when a check needs an
 * unread file it must answer "needs read of <path>" rather than guess.
 *
 * CONTRACT: never fail the brief. Any failure (fork throw, ESC, empty output,
 * no room) returns null and the caller stores the plain success result.
 */
import type { Message, Tool } from '../types.js';
import { forkChat } from '../engine/chat-provider.js';
import { PRISTINE_BRIEF_RESULT, PLAN_SCOPE_HEADING } from './triologue/recap-note.js';

/** Head room for the fork's signal + the result threshold's own safety slack. */
const SCOPE_NOTE_OVERHEAD_CHARS = 512;

/** The prompt. TEXT ONLY — the reflection must not take actions. */
function buildPrompt(briefMessage: string): string {
  return [
    'You are the same agent, in PLAN mode. This is not a progress check — it is the moment to',
    'ask whether the problem you are solving is the right one at all.',
    '',
    `Your brief: ${briefMessage}`,
    '',
    'LOCAL OPTIMA ARE THE FAILURE MODE. A plan can be perfectly executed and still be wrong,',
    'because every step optimises inside a frame nobody questioned. Your job here is to question',
    'the frame: to find the move that is cheap only if you make it NOW, and expensive later.',
    '',
    'Everything you may cite must already appear above: the user\'s request, your tool calls and',
    'their results. You have NO tools here — you cannot read anything new. If a check needs a',
    'file you have not read, answer with "needs read of <path>" and nothing else: naming what',
    'you must read is worth more than guessing what it says.',
    '',
    'Output plain text, exactly four lines, in this order, each starting with its label:',
    '',
    'TUNNEL: ...',
    'SUBLATE: ...',
    'WRONG PRB: ...',
    'REVERSIBLE: ...',
    '',
    'TUNNEL — the quantum-tunnelling move. Is there a RULE (a scope declaration, an interface',
    '  contract, a hook, a documented promise, a habit of this codebase) that, if broken now,',
    '  would make this work SIMPLER? Give all three, in one line: the rule and where it lives',
    '  (`file.ts:LINE` or a named contract); what simplification it buys, counted (tools / files /',
    '  branches / states removed); and what it costs (who breaks, what must migrate, whether it',
    '  can be undone). A rule break with no stated cost is not a tunnel, it is damage — omit it.',
    '  A bare "none" is NOT acceptable: write `none — <one clause saying why no rule stands in',
    '  the way here>`. Do NOT invent a tunnel to fill the line; do not hide behind the format',
    '',
    'SUBLATE — is one of the tensions you are carrying actually two projections of a SINGLE',
    '  higher-order requirement? Write it as thesis vs antithesis, then name the synthesis as one',
    '  invariant with a name you could put in a doc. Unifying a contradiction removes the conflict;',
    '  breaking a rule only moves it (compare with TUNNEL — prefer this when both are available).',
    '  `none — <one clause: the requirements here simply do not collide>`. A task list is not a',
    '  tension, and saying so in one clause is the honest answer.',
    '',
    'WRONG PRB — stronger than "did I drift": if this task had never been proposed, would you',
    '  still do this now? If not, say what you would do instead and why the user\'s phrasing',
    '  points elsewhere. The cheaper equivalent of what was asked counts as an answer.',
    '  Otherwise `no — <one clause naming what the user actually asked and why this serves it>`.',
    '',
    'REVERSIBLE — is the step you are about to take a one-way door? Name it if so. If a two-way',
    '  equivalent exists that costs little more, name that instead. One-way doors with no',
    '  alternative are exactly what locks a frame in place. `two-way — <the revert, named>` if',
    '  that is the honest answer.',
    '',
    'Banned: restating the brief, recapping progress, and any sentence that would be equally true',
    'of a different task ("consider the bigger picture", "there may be risks", "we should validate").',
    'Every line must be checkable against a file, a named decision, or a user statement above.',
  ].join('\n');
}

/** Provider reasoning echoes (thinking blocks) must not reach the tool result. */
function stripReasoningEcho(text: string): string {
  return text
    .replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
    .trim();
}

/**
 * Clamp at a word boundary. tool() DUMPS an over-size result to a file instead
 * of storing it, which would replace the anchor's note with a path — so the
 * reflection must always fit, even if that means ending it early.
 */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 60));
  const at = cut.lastIndexOf(' ');
  return `${(at > 0 ? cut.slice(0, at) : cut).trimEnd()} …(truncated)`;
}

/** Normalize the model's paragraph to the required opening. */
function normalizeOpening(text: string): string {
  const body = text.replace(new RegExp(`^\\s*${PLAN_SCOPE_HEADING}[,:]?\\s*`, 'i'), '').trim();
  return `${PLAN_SCOPE_HEADING}, ${body}`;
}

export interface PlanScopeDeps {
  /** Messages + tools of the CURRENT turn (the prompt-cache prefix). MUST end
   *  on a complete round-trip: an unanswered assistant tool_calls block is
   *  rejected by strict providers. */
  messages: Message[];
  tools: Tool[];
  briefMessage: string;
  /** tool()'s result limit — the note must fit under it. */
  resultThreshold: number;
  /** ESC-aware runner owned by the caller (ctx.core.escAware): it gives the
   *  fork a LIVE abort signal and lets ESC cancel it mid-flight. */
  escAware: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>;
}

/**
 * Build the plan-scope reflection. Returns null when there is nothing usable to
 * append (the caller then stores the plain success result).
 *
 * Pure I/O: one forkChat, no triologue mutation.
 */
export async function buildPlanScopeNote(deps: PlanScopeDeps): Promise<string | null> {
  const budget = deps.resultThreshold - PRISTINE_BRIEF_RESULT.length - 2 - SCOPE_NOTE_OVERHEAD_CHARS;
  if (budget < 200) return null; // no room worth writing — leave the brief plain

  const prompt = buildPrompt(deps.briefMessage);
  let out: string | null;
  try {
    // escAware owns the abort slot for the duration of the fork, so ESC during
    // the reflection actually cancels it (a tool-stage wrapper's signal is
    // already dead by then and cannot).
    out = await deps.escAware(
      async (ac) => await forkChat(deps.messages, deps.tools, prompt, ac.signal, 'none'),
      () => null as string | null,
    );
  } catch {
    return null; // a reflection is an enhancement, never a dependency
  }

  const body = stripReasoningEcho(out ?? '');
  if (!body) return null;
  return clamp(normalizeOpening(body), budget);
}

/**
 * Render the reflection for the TERMINAL (the tool result keeps the raw form).
 *
 * The model answers in four labelled lines; a terminal block reads far better
 * with a heading rule and one line per label than as a grey wall of text. Any
 * line that does not carry a known label (a model that ignored the format) is
 * passed through unchanged — the display must never drop content it does not
 * recognise.
 */
// Labels the prompt asks for, in order. Kept as one alternation below so the
// formatter re-cuts even when the model answers as a single run-on paragraph.
/** Where each label's value ends and the NEXT label begins. */
const LABEL_RE = /\b(TUNNEL|SUBLATE|WRONG PRB|REVERSIBLE)\b\s*[:\u2014-]\s*/gi;

/** Display width of the label column (longest label is 10 chars). */
const LABEL_WIDTH = 12;

/**
 * Render the reflection for the TERMINAL (the tool result keeps the raw form).
 *
 * The model answers in four labelled lines, but it does not always honour the
 * newlines — a single long paragraph with all four labels inline is common. So
 * a line-based split is not enough: the text is re-cut at the LABELS, giving
 * one aligned row per label. Text that carries no label at all is passed
 * through unchanged (the display must never drop, or reformat away, content it
 * does not recognise).
 */
export function formatPlanScopeForDisplay(note: string): string {
  const body = note.replace(new RegExp(`^\\s*${PLAN_SCOPE_HEADING}[,:]?\\s*`, 'i'), '').trim();
  if (!body) return note;

  const marks: Array<{ label: string; at: number; end: number }> = [];
  for (const m of body.matchAll(LABEL_RE)) {
    marks.push({ label: m[1].toUpperCase(), at: m.index ?? 0, end: m.index! + m[0].length });
  }
  if (marks.length === 0) return note; // unlabelled prose — show it verbatim

  // A lead-in before the first label (e.g. "Serves the ask.") rides on the
  // first row rather than becoming a stray line.
  const head = body.slice(0, marks[0].at).replace(/^[,;\s]+|[,;\s]+$/g, '');
  const rows = marks.map((mark, i) => {
    const until = i + 1 < marks.length ? marks[i + 1].at : body.length;
    const value = body.slice(mark.end, until).replace(/^[,;\s]+|[,;\s]+$/g, '');
    const lead = i === 0 && head ? ` ${head}` : '';
    return `${mark.label.padEnd(LABEL_WIDTH)}${lead}${value ? ` ${value}` : ''}`.trimEnd();
  });

  return ['── plan-scope ──────────────────────────────────', ...rows].join('\n');
}

/** The complete brief tool result: success line + the reflection paragraph. */
export function withPlanScopeNote(note: string): string {
  return `${PRISTINE_BRIEF_RESULT}. ${note}`;
}
