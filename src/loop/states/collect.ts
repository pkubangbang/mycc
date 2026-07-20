/**
 * collect.ts - COLLECT state handler
 *
 * Pre-LLM pipeline: child questions, mail collection,
 * hint round, todo nudging, brief nudging,
 * role sequence validation.
 */

import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { startWrapUp } from '../esc-wrap-up.js';
import { isVerbose } from '../../config.js';
import { loader } from '../../context/shared/loader.js';
import { forkChat } from '../../engine/chat-provider.js';
import type { SequenceEvent } from '../../hook/sequence.js';
import { getSkillTriologueStatus } from '../../utils/skill-dedup.js';
import { listWorktrees } from '../../context/worktree-store.js';
import { getServeHub } from '../../serve/serve-registry.js';
import * as fs from 'fs';
import * as path from 'path';

// Confusion threshold for hint generation
const CONFUSION_THRESHOLD = 10;
// Minimum message count before hint generation
const MIN_MESSAGES_FOR_HINT = 6;

/**
 * Generate a human-readable breakdown of confusion factors
 */
function generateBreakdown(
  confusionIndex: number,
  events: SequenceEvent[]
): string {
  const parts: string[] = [];

  // Count assistant turns (inferred from events - each turn has multiple tools)
  // Estimate turns by counting unique tool call batches
  const turnCount = Math.ceil(events.length / 3); // rough estimate
  if (turnCount > 0) {
    parts.push(`${turnCount} assistant turns`);
  }

  // Count errors — only match error/failed/fatal at the start of the result
  // to avoid false positives from normal file content containing these words.
  // Keep 'includes' for OS error codes (ENOENT, EACCES, EPERM) which are
  // specific identifiers that won't appear in file content.
  const errors = events.filter(e => {
    const result = e.result?.toLowerCase() || '';
    return result.startsWith('error:') || result.startsWith('error ') ||
           result.startsWith('fatal:') || result.startsWith('failed:') ||
           result.startsWith('failed ') ||
           result.includes('enoent') || result.includes('eacces') ||
           result.includes('eperm') || result.includes('permission denied');
  });
  if (errors.length > 0) {
    parts.push(`${errors.length} tool errors`);
  }

  return parts.length > 0 ? parts.join(', ') : 'No issues detected';
}

/**
 * Shape of a single reactivation evaluation returned by the LLM via forkChat.
 */
interface ReactivationEvaluation {
  id: number;
  hash: string;
  reopen: boolean;
  reason?: string;
}

/**
 * Parse the forkChat result into a list of reactivation evaluations.
 *
 * Tolerant parsing: tries a direct `JSON.parse` first; on failure, attempts to
 * regex-extract the first `[...]` JSON array and retry; on any failure or
 * non-array shape, returns null (caller skips this turn).
 *
 * Exported for unit testing (see src/tests/loop/states/collect-reactivation.test.ts).
 */
export function parseReactivationResult(raw: string): ReactivationEvaluation[] | null {
  const trimmed = raw.trim();
  // 1. Direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as ReactivationEvaluation[];
    return null;
  } catch {
    // fall through to extraction
  }
  // 2. Extract first JSON array from surrounding noise
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed as ReactivationEvaluation[];
  } catch {
    // give up
  }
  return null;
}

/**
 * Evaluate completed pinned todos carrying a reactivation condition and reopen
 * those whose condition is met. Runs in the COLLECT state, immediately before
 * the todo nudge, on the same throttle cycle (so the nudge prints the
 * already-updated list — no "closed then reopened" contradiction).
 *
 * Uses `forkChat` with `toolChoice: 'none'` to preserve the prompt cache and
 * ask the LLM to return a JSON array. Every failure path is silent
 * (verbose-only) and never blocks the agent loop:
 *  - no candidates → no forkChat call
 *  - forkChat throws → catch, skip this turn
 *  - non-JSON / non-array result → skip this turn
 *  - per-entry: wrong types, hash mismatch (hallucination), reopen=false → skip entry
 */
async function checkReactivation(env: MachineEnv): Promise<void> {
  const { triologue, ctx } = env;
  const candidates = ctx.todo.getReactivationCandidates();
  if (candidates.length === 0) return;

  // Build the evaluation prompt. `id` is fixed (echoed back); `hash` is
  // supplied by the LLM from the conversation context so the anti-hallusion
  // check stays active — a fabricated hash won't match the candidate.
  const todoLines = candidates.map(
    (c) => `#${c.id} "${c.name}" — Condition: "${c.reactivate}"`,
  );
  const prompt =
    'You are evaluating whether any pinned todos should be reactivated (marked back to not done).\n\n' +
    `Pinned todos to evaluate:\n${todoLines.join('\n')}\n\n` +
    'Based on the conversation context above, for EACH todo, determine if its reactivation condition has been met.\n\n' +
    'Reply with ONLY a JSON array, no other text. Schema:\n' +
    '[\n' +
    '  {"id": <todo_id>, "hash": "<current_hash_of_this_todo>", "reopen": <true|false>, "reason": "<one sentence>"}\n' +
    ']\n\n' +
    'Rules:\n' +
    '- "id": the todo ID as listed above (echo it back).\n' +
    '- "hash": the current hash of this todo item (from the todo list you have seen in conversation).\n' +
    '- "reopen": true only if the condition has clearly been met in the recent conversation.\n' +
    '- If no relevant event has occurred, or you are unsure, use false.\n' +
    '- Do not reactivate based on events that happened before the todo was last completed.';

  const fullMessages = triologue.getMessages();
  const allTools = loader.getToolsForScope(env.scope);

  let result: string;
  try {
    result = await forkChat(fullMessages, allTools, prompt, undefined, 'none');
  } catch (err) {
    ctx.core.verbose('reactivate', `forkChat failed: ${(err as Error).message}, skipping reactivation this turn`);
    return;
  }

  const evaluations = parseReactivationResult(result);
  if (!evaluations) {
    ctx.core.verbose('reactivate', 'forkChat returned non-JSON or non-array, skipping reactivation this turn');
    return;
  }

  for (const ev of evaluations) {
    // Per-entry type guards — skip malformed entries, keep going
    if (typeof ev.id !== 'number' || typeof ev.hash !== 'string' || typeof ev.reopen !== 'boolean') {
      continue;
    }
    if (!ev.reopen) continue;

    // Hash anti-hallusion: match by id AND hash. A hallucinated hash won't
    // match and the entry is silently skipped.
    const candidate = candidates.find((c) => c.id === ev.id && c.hash === ev.hash);
    if (!candidate) continue;

    // Reopen directly — the LLM does not decide; the system acts.
    const updated = ctx.todo.updateTodo(
      candidate.id,
      candidate.hash,
      candidate.name,
      false,
      candidate.note,
    );
    if (updated) {
      triologue.note(
        'SYSTEM',
        `Pinned todo #${candidate.id} "${candidate.name}" reactivated. ` +
          `Condition "${candidate.reactivate}" was met.${ev.reason ? ` ${ev.reason}` : ''}`,
      );
    }
  }
}

export async function handleCollect(
  env: MachineEnv,
  turn: TurnVars,
  _pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  try {
    // 1. Handle pending questions from children
    await ctx.team.handlePendingQuestions();

    // 2. Collect mails — relies on auto-fix for TP-safe injection
    const mails = ctx.mail.collectMails();
    if (mails.length > 0) {
      const parts: string[] = [];

      // Standard mail format
      for (const mail of mails) {
        parts.push(`Mail from ${mail.from}: ${mail.title}\n${mail.content}`);
      }

      const mailContent = parts.join('\n\n---\n\n');

      if (agentIO.isNeglectedMode()) {
        triologue.note('URGENT', `user interrupted - wrap up quickly\n${mailContent}`);
      } else {
        triologue.note('MAIL', mailContent);
      }
    }

    // 2b. Inject team status overview so lead sees deadlines without calling tm_print
    const teamStatus = await ctx.team.printTeam();
    if (teamStatus !== 'No teammates.') {
      triologue.note('SYSTEM', teamStatus);
    }

    // 2c. Drain steering queue (webui-only): if serve is running, consume any
    //     steering notes the user queued during this run and inject them as a
    //     REMINDER note. Unlike the PROMPT synthesis path (which merges stale
    //     notes with a fresh query after an interrupt), this is the in-flight
    //     path: the LLM reached COLLECT mid-run with notes still queued, so
    //     they are current direction for the ongoing work and injected as-is.
    //     Reuses the REMINDER NoteCategory — no new category needed.
    if (getServeHub().isRunning()) {
      const steerNotes = getServeHub().drainSteering();
      if (steerNotes.length > 0) {
        const steerContent = steerNotes.map((n, i) => `(${i + 1}) ${n}`).join('\n');
        triologue.note('REMINDER', `Steering notes from the user (mid-task direction):\n${steerContent}`);
        agentIO.verbose('steer', `Drained ${steerNotes.length} steering note(s) at COLLECT`);
      }
    }

    // 2d. Drain file upload queue (webui-only): if serve is running, save any
    //     uploaded files to ./.mycc/uploaded/ and mention them via a REMINDER
    //     note so the LLM can reference them (e.g. via read_picture).
    if (getServeHub().isRunning()) {
      const files = getServeHub().drainFileUploads();
      if (files.length > 0) {
        const uploadDir = path.join(process.cwd(), '.mycc', 'uploaded');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        const fileInfos: string[] = [];
        for (const file of files) {
          const safeName = `${Date.now()}_${file.filename}`;
          const filePath = path.join(uploadDir, safeName);
          fs.writeFileSync(filePath, Buffer.from(file.data, 'base64'));
          const relPath = path.relative(process.cwd(), filePath);
          fileInfos.push(`- ${file.filename} → ${relPath} (${file.mimeType})${file.text ? `\n  Text: "${file.text.slice(0, 200)}${file.text.length > 200 ? '...' : ''}"` : ''}`);
        }
        triologue.note('REMINDER', `User uploaded file(s):\n${fileInfos.join('\n')}`);
        agentIO.verbose('serve', `Saved ${files.length} uploaded file(s) to ${uploadDir}`);
      }
    }

    // 3. Generate hint round if confusion threshold reached
    const confusionIndex = ctx.core.getConfusionIndex();
    const messageCount = triologue.getMessagesRaw().length;

    if (confusionIndex >= CONFUSION_THRESHOLD && messageCount >= MIN_MESSAGES_FOR_HINT) {
      // Use brief for hint round notification (user-facing)
      ctx.core.brief('info', 'loop', 'Generating hint...');
      // Get pending skills (skills with 'when' but no compiled condition)
      const pendingSkills = env.conditions.getPending();
      // Generate confusion breakdown from sequence events
      const breakdown = generateBreakdown(confusionIndex, env.sequence.getEvents());

      // Use escAware for ESC-interruptible hint generation
      const result = await ctx.core.escAware(
        async (abortController) => {
          return await triologue.generateHintRound(abortController, confusionIndex, breakdown, pendingSkills);
        },
        () => {
          // Start wrap-up when ESC is pressed during hint generation
          startWrapUp(triologue, loader.getToolsForScope(env.scope));
          return 'aborted' as const;
        }
      );
      
      // If aborted (ESC pressed), skip to PROMPT to show prompt immediately
      if (result === 'aborted') {
        agentIO.setNeglectedMode(false);
        return AgentState.PROMPT;
      }
      // Reset confusion after hint
      ctx.core.resetConfusionIndex();
    }

    // 4. Todo nudging with state tracking
    if (ctx.todo.hasOpenTodo()) {
      const currentTodoState = ctx.todo.printTodoList();
      if (currentTodoState !== turn.lastTodoState) {
        turn.nextTodoNudge = 3;
        turn.lastTodoState = currentTodoState;
      }
      turn.nextTodoNudge--;
      if (turn.nextTodoNudge === 0) {
        // (4a) Reactivation FIRST — reopen pinned todos whose condition is met.
        // Runs on the same throttle cycle as the nudge so the nudge below
        // prints the already-updated list (no "closed then reopened" flicker).
        await checkReactivation(env);
        // (4b) Nudge SECOND — prints the now-up-to-date todo list.
        triologue.note('REMINDER', `Update your todos. ${ctx.todo.printTodoList()}`);
        turn.nextTodoNudge = 3;
      }
    }

    // 5. Brief nudging - remind agent to use brief tool
    turn.nextBriefNudge--;
    if (turn.nextBriefNudge <= 0) {
      triologue.note('REMINDER', 'Provide a brief status update using the brief tool. Example: brief("Working on X", 7)');
      turn.nextBriefNudge = 5;
    }

    // 5b. Worktree cleanup nudge.
    //     nextWtNudge == 0 is the "check now" sentinel: cheaply call
    //     listWorktrees() (async git query) each pass. If worktrees exist,
    //     inject a REMINDER and arm the counter to N so we don't nag every
    //     turn. If none, leave the counter at 0 (re-checks next pass).
    //     When the counter is nonzero, just decrement it.
    if (env.nextWtNudge === 0) {
      const worktrees = await listWorktrees(process.cwd());
      if (worktrees.length > 0) {
        const lines = worktrees.map(w => `- ${w.name} at ${w.path} (branch: ${w.branch})`);
        triologue.note(
          'REMINDER',
          `Stale worktrees detected. Consider cleaning them up with bash (git worktree remove <path>) once the work is merged:\n${lines.join('\n')}`
        );
        env.nextWtNudge = 5;
      }
      // else: no worktrees — leave at 0, re-check next pass
    } else {
      env.nextWtNudge--;
    }

    // 6. Consume extracted keywords for proactive skill discovery.
    //    Matches extracted English keywords against loaded skill names and keywords.
    //    Injects a HINT note with skill names and descriptions so the LLM can
    //    decide which skills to load without needing an extra skill_search step.
    //    Dedups against skills already loaded or suggested in the triologue.
    if (turn.extractedKeywords.length > 0) {
      const keywords = turn.extractedKeywords;
      turn.extractedKeywords = []; // consume — only fire once per turn

      const allSkills = ctx.skill.listSkills();
      const matched = allSkills.filter(s => {
        const nameLower = s.name.toLowerCase();
        const kwLower = s.keywords.map(k => k.toLowerCase());
        return keywords.some(kw =>
          nameLower.includes(kw) ||
          kwLower.some(k => k.includes(kw) || kw.includes(k)),
        );
      });

      if (matched.length > 0) {
        const newSkills: string[] = [];
        const suggestedSkills: string[] = [];
        const loadedSkills: string[] = [];

        for (const skill of matched) {
          const status = getSkillTriologueStatus(triologue, skill);
          switch (status) {
            case 'new': {
              const desc = skill.description ? ` (${skill.description})` : '';
              newSkills.push(`${skill.name}${desc}`);
              break;
            }
            case 'suggested':
              suggestedSkills.push(skill.name);
              break;
            case 'loaded':
              loadedSkills.push(skill.name);
              break;
          }
        }

        const lines: string[] = [];
        if (newSkills.length > 0) {
          lines.push(`New relevant skills: ${newSkills.join(', ')}. Use skill_load(name="<exact_name>") to load them.`);
        }
        if (suggestedSkills.length > 0) {
          lines.push(`Also suggesting: ${suggestedSkills.join(', ')}. Use skill_load(name="<exact_name>") to load it.`);
        }
        if (loadedSkills.length > 0) {
          lines.push(`The below skills are loaded and also relevant: ${loadedSkills.join(', ')}.`);
        }
        lines.push('Note: you can also use skill_search to search for skills semantically.');

        triologue.note('HINT', lines.join('\n'));
      }
    }

    // 7. Log message count and token consumption in verbose mode
    if (isVerbose()) {
      const tokenCount = triologue.getTokenCount();
      const tokenThreshold = triologue.getTokenThreshold();
      const utilization = ((tokenCount / tokenThreshold) * 100).toFixed(1);
      ctx.core.verbose('collect', `${messageCount} messages, ${tokenCount}/${tokenThreshold} tokens (${utilization}%)`);
    }

    return AgentState.LLM;
  } catch (err) {
    // Defensive: log as much context as possible for this intermittent error.
    // The classic "Cannot read properties of undefined (reading 'role'/content')"
    // surfaced in COLLECT comes from holes in triologue.messages read by
    // unguarded raw consumers (hint-round, minifier). getMessagesRaw() now
    // filters holes, but if a new throw path emerges we want the stack and
    // the array shape to debug it instead of just the bare error message.
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error && err.stack ? err.stack : '';
    const rawLen = triologue.getMessagesRaw().length;
    const tokLen = triologue.getTokenCount();
    ctx.core.brief(
      'error',
      'collect',
      `COLLECT state error: ${errorMessage}`,
      `messages(raw)=${rawLen} tokens=${tokLen}\n${errorStack}`,
    );
    return AgentState.PROMPT;
  }
}
