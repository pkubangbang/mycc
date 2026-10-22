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
    'You are the same agent, in PLAN mode, reflecting on your own status update.',
    '',
    `Your brief: ${briefMessage}`,
    '',
    `Continue as one paragraph beginning "${PLAN_SCOPE_HEADING}, …" — 150-400 words, plain text, no tools.`,
    'Make it a STEP BACK from the task, not a restatement of it. Be concrete (name files, decisions, risks).',
    '',
    'Address exactly these, in this order:',
    '1. Is the work you are about to do serving what the user actually asked for, or have you drifted into a sub-problem?',
    '2. What does this plan assume that you have NOT verified (files, APIs, behaviors, user intent)?',
    '3. What will you regret not deciding now — an interface, an invariant, an ordering, a rollback path?',
    '4. The next step that unlocks the most, and what you will abandon if it fails.',
    '',
    'Do not restate the brief or recap your progress. Output text only.',
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

/** The complete brief tool result: success line + the reflection paragraph. */
export function withPlanScopeNote(note: string): string {
  return `${PRISTINE_BRIEF_RESULT}. ${note}`;
}
