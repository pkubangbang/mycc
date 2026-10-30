/**
 * bash-judge.ts - Multi-step bash command judging logic
 */

import type { ParsedIntent, BashJudgeResult } from './types.js';
import { parseIntent, validateIntent, isReadOnlyVerb, isMutationVerb } from './intent-parser.js';
import { findDangerousCommand } from './dangerous-commands.js';
import { MODEL, retryMultipleChoice } from '../../engine/chat-provider.js';

/**
 * Detect the `batch=i_know` escape-hatch PARAM in a raw intent string.
 *
 * Design: batch deletions (DELETE verb + isBatchDelete) are routed through an
 * LLM safeguard (analyzeBatchDelete) to classify them as SAFE/DANGEROUS/
 * UNCERTAIN before possibly asking the user. The LLM call costs latency and
 * tokens even for obvious-safe cleanup like `rm -rf node_modules/`. The Intent
 * Lang provides a PARAM `batch=i_know` that lets the LLM honestly declare
 * awareness that the command is a batch deletion; when present, the system
 * skips the LLM safeguard and routes the decision directly to the user via
 * [y/N] confirmation. The human's approval is the real authorization.
 *
 * Unlike `dangerous=i_know`, this does NOT bypass a hard block (batch deletion
 * is not hard-blocked — it is LLM-judged), so there is no Socratic-withheld
 * hint; the agent learns the PARAM from the PARAM Conventions subsection.
 *
 * This is a lightweight substring check on the raw intent. Grammar validation
 * is not repeated here because this is called in step 4, AFTER step 3 has
 * already validated the intent grammar.
 */
function declaresBatchIKnow(intent: string): boolean {
  return /\bbatch=i_know\b/.test(intent);
}

/**
 * Detect the `dangerous=i_know` escape-hatch PARAM in a raw intent string.
 *
 * Design: dangerous commands are blocked by default. The Intent Lang provides a
 * PARAM `dangerous=i_know` that lets the LLM honestly declare awareness of the
 * risk; when present, the system steps back (skips the hard-block AND the LLM
 * safeguard) and routes the decision to the user via [y/N] confirmation. The
 * underscore in `i_know` is an informational-exceptional signal to the LLM.
 *
 * This is a lightweight substring check on the raw intent (run BEFORE full
 * intent parsing at step 1) so the escape hatch is detected even when the rest
 * of the intent has not yet been validated. If detected, the full intent is
 * then parsed and grammar-validated before routing to the user — a malformed
 * intent with a dangling `dangerous=i_know` substring is rejected with the
 * grammar error rather than bypassing validation.
 */
function declaresDangerousIKnow(intent: string): boolean {
  return /\bdangerous=i_know\b/.test(intent);
}

/**
 * Socratic hint shown when a dangerous command is blocked WITHOUT the
 * `dangerous=i_know` escape param. Names the existence of a PARAM override so
 * the LLM knows an escape hatch exists, but WITHHOLDS the exact key/value — the
 * LLM must consult the intent language PARAM conventions to find `dangerous`.
 */
function dangerousSocraticHint(reason: string): string {
  return (
    `Command blocked: ${reason}.\n\n` +
    `Dangerous commands are blocked by default. The Intent Lang provides a PARAM ` +
    `that declares your awareness of the risk and routes the decision to the user. ` +
    `Consult the intent language PARAM conventions and retry if this is intended.`
  );
}

/**
 * HARD block for plan mode: the dangerous-command list, and nothing else.
 *
 * These are the operations plan mode never runs, whatever the LLM would say:
 * a misclassification here is unrecoverable (formatted filesystems, disk
 * images, `rm -rf /`). Every other command-shape question is a JUDGEMENT, not
 * a fact about the command — see isComplexCommandShape() — and is escalated to
 * the LLM judge instead of being decided by a regex.
 *
 * @returns a block reason when the command is on the dangerous-command list.
 */
function planModeHardBlock(command: string): string | null {
  const match = findDangerousCommand(command);
  if (match) {
    return `This command is on the dangerous-command list (${match.reason}); plan mode never runs it.`;
  }
  return null;
}

/**
 * Is this command's SHAPE too complex to classify with a local rule?
 *
 * DESIGN (the "classify as complex, let the LLM judge" rule). This predicate
 * used to be the mutating-state GUARD for plan mode: a match blocked the
 * command with "The command modifies state". That was wrong in principle, not
 * merely in tuning. The rules below substring-match the WHOLE command line, so
 * they cannot tell a real mutation from a mention of one:
 *
 *   grep -rn "triologue\.\([a-zA-Z_]*\)" src --include=*.ts   → glob in a quoted pattern
 *   cat a.ts && echo "=== truncate" && cat b.ts             → verb word in a quoted label
 *   node -e '... console.log("rm -rf dist/") ...'           → a string literal
 *
 * Each is read-only, and each was blocked. Tightening the regexes (quote
 * tracking, clause parsing, command-word resolution) buys accuracy at the cost
 * of a hand-written shell parser whose misses are silent. The honest reading of
 * a match is therefore "I cannot tell from the text" — so a match now ESCALATES
 * to the existing LLM judge (the one the RUN verb already uses), which sees the
 * command and its purpose and can classify it; the human is the final gate, and
 * an LLM failure or ESC denies.
 *
 * The rules stay as a CHEAP TEST rather than being deleted: they keep trivial
 * read-only commands (`cat file.ts`, `ls`, `git diff`) out of the escalator, so
 * the common case costs no LLM call. Their false positives now cost one LLM
 * round-trip instead of a wrong block, and their false negatives (a mutation
 * with no shape hit) are covered because the declared verb still gates RUN and
 * the mutation verbs, and the dangerous list is checked separately.
 */
function isComplexCommandShape(command: string): boolean {
  return (
    isBatchDelete(command) ||
    // Whole-segment write verbs: redirects, rm/mv/cp/tee/touch/mkdir/rmdir/
    // truncate, in-place editors, and git commands that write (commit/push/
    // checkout/reset/clean/stash).
    /(^|[^\d\s])>{1,2}\s*[^\s&|]/.test(command) || // > file, >> file (not 2>&1)
    /(^|[\s;&|])(rm|rmdir|mv|cp|tee|touch|mkdir|truncate|chmod|chown|ln|dd|sed\s+-i|perl\s+-[a-z]*i)\b/.test(
      command
    ) ||
    /\bgit\s+(commit|push|checkout|switch|reset|clean|stash|merge|rebase|cherry-pick|apply|am|add)\b/.test(
      command
    ) ||
    /\bnpm\s+(publish|install|i|uninstall|update)\b/.test(command) ||
    /\bnpx?\s+(prettier\s+--write)\b/.test(command) ||
    /\bfind\b.*-delete\b/.test(command)
  );
}

/**
 * ONE batch-deletion confirmation, used by both routes (agent-declared
 * `batch=i_know` and the LLM-uncertain fallback). Two hand-written copies had
 * drifted into different wording for the same decision; the wording is now a
 * `why` label, so the user always sees the same shape.
 */
async function confirmBatchDeletion(
  command: string,
  purpose: string | undefined,
  why: string,
  askUser?: (query: string, asker: string, options?: { onEsc?: string }) => Promise<string>
): Promise<BashJudgeResult> {
  if (!askUser) {
    return { decision: 'block', reason: 'Batch deletion requires user confirmation' };
  }
  const answer = await askUser(
    `Batch deletion (${why}).\n\nCommand: ${command}\nPurpose: ${purpose ?? '(none given)'}\n\nAllow this command? [y/N]`,
    'bash-judge',
    { onEsc: 'n' }
  );
  const approved = answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes';
  return {
    decision: approved ? 'allow' : 'block',
    reason: approved ? undefined : 'User denied the batch deletion',
  };
}

/**
 * Why the LLM judge returned 'uncertain'. The grant gate must not report a
 * broken checker as a property of the user's command (row lead-017):
 * - 'llm-error'     the judge call failed (network, 429, outage, bad reply)
 * - 'llm-uncertain' the judge ran and said it cannot tell
 * - 'esc'           the user pressed ESC while the judge was running
 */
export type UncertainCause = 'llm-error' | 'llm-uncertain' | 'esc';

/**
 * Shape returned by the two LLM analyzers. `cause` distinguishes "the checker
 * could not answer" from "the checker could not be reached".
 */
type AnalyzeResult = { decision: 'allow' | 'block' | 'uncertain'; reason?: string; cause?: UncertainCause };

/**
 * Judge a bash command for plan mode safety
 *
 * Steps:
 * 1. Check dangerous commands (pattern matching). For destructive/irreversible
 *    categories, the `dangerous=i_know` intent PARAM routes to user confirmation
 *    instead of hard-blocking; the `system` category stays hard-blocked. When
 *    the escape param is present, the full intent is grammar-validated first —
 *    a malformed intent does NOT bypass validation to reach the user.
 * 2. Check missing intent parameter
 * 3. Check intent grammar (fail fast with retry hint)
 * 4. Check mode + verb (local decision). Batch deletions (DELETE + isBatchDelete)
 *    are LLM-judged; the `batch=i_know` intent PARAM skips the LLM safeguard and
 *    routes directly to user confirmation.
 * 5. LLM judging (parent only, for RUN verb)
 * 6. Ask user (parent only, when uncertain)
 *
 * @param command - The bash command to execute
 * @param intent - The intent string (required)
 * @param mode - Current mode ('plan' or 'normal')
 * @param isChildProcess - Whether this is a child process
 * @param askUser - Function to ask user (only called in parent process)
 * @param escAware - Function to wrap operation with ESC awareness (optional)
 */
export async function judgeBash(
  command: string,
  intent: string,
  mode: 'plan' | 'normal',
  isChildProcess: boolean,
  askUser?: (query: string, asker: string, options?: { onEsc?: string }) => Promise<string>,
  escAware?: <T>(
    operation: (abortController: AbortController) => Promise<T>,
    onCleanUp: () => T | Promise<T>
  ) => Promise<T>
): Promise<BashJudgeResult> {
  // Step 1: Check dangerous commands (local, no LLM).
  //
  // Dangerous commands are blocked by default. For `destructive` and
  // `irreversible` categories, the LLM may declare `dangerous=i_know` in its
  // intent PARAMs to honestly acknowledge the risk — in that case we skip the
  // hard-block AND skip the LLM safeguard (step 5), and route directly to user
  // confirmation (the human's y/N is the real authorization gate).
  // The `system` category (git commit, npm publish) is a routing nudge, NOT a
  // danger gate — it stays hard-blocked with no escape hatch.
  // Without the escape param, the block message is a Socratic hint that names
  // the existence of a PARAM override but withholds the exact key/value.
  // WITH the escape param, the intent is grammar-validated first (mirroring
  // step 3): a malformed intent that merely contains the `dangerous=i_know`
  // substring is rejected with the grammar error and does NOT reach the user.
  const dangerousMatch = findDangerousCommand(command);
  if (dangerousMatch) {
    if (dangerousMatch.category === 'system') {
      return {
        decision: 'block',
        reason: `Command blocked: ${dangerousMatch.reason}`,
      };
    }
    // destructive | irreversible — offer the escape hatch.
    if (declaresDangerousIKnow(intent)) {
      // The escape hatch routes the decision to the human, so the human is the
      // real gate. But it must NOT bypass intent grammar validation: a malformed
      // intent that merely *contains* the `dangerous=i_know` substring (e.g. a
      // bare token "dangerous=i_know" with no VERB OBJECT TO PURPOSE) should be
      // rejected with the grammar error, not routed to the user. An honest
      // declaration is only meaningful when the rest of the intent is well-formed.
      // (This mirrors step 3's validation, run here because step 1 returns early
      // before step 3 is reached.)
      const parsed = parseIntent(intent);
      const validation = validateIntent(parsed, intent);
      if (!validation.valid) {
        return {
          decision: 'block',
          reason: `Error: [Intent] ${validation.error}${validation.hint ? `\nHint: ${validation.hint}` : ''}`,
        };
      }
      if (isChildProcess) {
        return {
          decision: 'block',
          reason: `Dangerous command (${dangerousMatch.reason}) requires user confirmation, which is unavailable in child processes. Ask the lead agent to perform this operation instead.`,
        };
      }
      if (!askUser) {
        return {
          decision: 'block',
          reason: `Dangerous command (${dangerousMatch.reason}) requires user confirmation`,
        };
      }
      const userResponse = await askUser(
        `Dangerous command acknowledged by agent.\n\nCommand: ${command}\nReason: ${dangerousMatch.reason}\nPurpose: ${intent}\n\nAllow this command? [y/N]`,
        'bash-judge',
        { onEsc: 'n' }
      );
      const approved =
        userResponse.toLowerCase().trim() === 'y' || userResponse.toLowerCase().trim() === 'yes';
      return {
        decision: approved ? 'allow' : 'block',
        reason: approved
          ? undefined
          : `User denied the dangerous command (${dangerousMatch.reason})`,
      };
    }
    // No escape param — Socratic hint (names PARAM override existence, withholds key/value).
    return {
      decision: 'block',
      reason: dangerousSocraticHint(dangerousMatch.reason),
    };
  }

  // Step 2: Check for missing intent parameter
  if (!intent) {
    return {
      decision: 'block',
      reason:
        'Error: [Intent] missing intent parameter. Use format: VERB OBJECT TO PURPOSE. Example: READ SOURCE TO check dependencies',
    };
  }

  // Step 3: Parse and validate intent grammar (local, no LLM)
  const parsed = parseIntent(intent);
  const validation = validateIntent(parsed, intent);

  if (!validation.valid) {
    // Return error with hint for LLM to retry
    return {
      decision: 'block',
      reason: `Error: [Intent] ${validation.error}${validation.hint ? `\nHint: ${validation.hint}` : ''}`,
    };
  }

  // Step 4: Mode + verb check
  if (mode === 'normal') {
    // Normal mode: all verbs allowed, but batch deletions require scrutiny
    if (parsed!.verb === 'DELETE' && isBatchDelete(command)) {
      // Child processes cannot use LLM judging — block and suggest explicit verb
      if (isChildProcess) {
        return {
          decision: 'block',
          reason:
            'Batch deletion from child process is not allowed. Ask the lead agent to perform this operation instead.',
        };
      }

      // `batch=i_know` escape hatch: the agent honestly declares this is a
      // batch deletion, so skip the LLM safeguard (analyzeBatchDelete) and
      // route directly to the user. The human's y/N is the real authorization.
      // (Intent grammar was already validated in step 3, so no re-validation.)
      if (declaresBatchIKnow(intent)) {
        return confirmBatchDeletion(command, parsed!.purpose, 'acknowledged by agent', askUser);
      }

      // Parent process: use LLM to analyze batch deletion
      const llmResult = await analyzeBatchDelete(command, parsed!, escAware);
      if (llmResult.decision === 'allow') return { decision: 'allow' };
      if (llmResult.decision === 'block') {
        return {
          decision: 'block',
          reason: llmResult.reason || 'Batch deletion blocked by LLM analysis',
        };
      }

      // Uncertain — ask user
      return confirmBatchDeletion(command, parsed!.purpose, 'detected', askUser);
    }

    return { decision: 'allow' };
  }

  // Plan mode: the command itself must be read-only. The declared verb is
  // agent-authored, so it cannot be the only gate.
  if (isReadOnlyVerb(parsed!.verb)) {
    const hard = planModeHardBlock(command);
    if (hard) {
      return { decision: 'block', reason: hard };
    }
    if (isComplexCommandShape(command)) {
      // The command's SHAPE defeats local classification (a glob or a write
      // verb inside a quoted pattern/label looks identical to the real thing).
      // Read-only verbs are the overwhelming majority in plan mode, and most
      // survey commands are one-command reads that this predicate ignores — so
      // escalation here is rare. See isComplexCommandShape() for why a match
      // means "unknown", not "mutating".
      return judgeComplexInPlanMode(command, parsed!, 'read-only', isChildProcess, askUser, escAware);
    }
    // READ, TEST are allowed in plan mode
    return { decision: 'allow' };
  }

  if (isMutationVerb(parsed!.verb)) {
    // WRITE, EDIT, DELETE, BUILD, INSTALL are blocked in plan mode
    return {
      decision: 'block',
      reason: `Cannot ${parsed!.verb} in plan mode. Verb "${parsed!.verb}" modifies state. Switch to normal mode first or use a read-only verb like [READ] or [TEST].`,
    };
  }

  // Step 5: RUN verb - need LLM analysis (parent only). Every read-only verb
  // was already decided above (hard block, escalate, or allow), so this is the
  // RUN fall-through alone.
  if (parsed!.verb === 'RUN') {
    return judgeComplexInPlanMode(command, parsed!, 'run', isChildProcess, askUser, escAware);
  }

  // Unknown verb (shouldn't reach here due to validation)
  return {
    decision: 'block',
    reason: `Unknown verb: ${parsed!.verb}`,
  };
}

/**
 * Judge a command whose SHAPE beats local classification, in plan mode.
 *
 * ONE helper for the two paths that reach the LLM judge:
 *  - 'run'       the declared verb is RUN (the historical path), and
 *  - 'read-only' the verb is READ/FIND/TEST but isComplexCommandShape() matched,
 *                so the text mentions a glob or a write verb and no local rule
 *                can tell a mention from the real thing.
 *
 * Plan mode only ever ALLOWS a command the judge positively classifies as
 * read-only. An LLM error, an ESC, or the judge saying it cannot tell all fall
 * through to the human, and an unanswered prompt denies — fail closed, exactly
 * as for RUN.
 *
 * The two paths must not share one message: a child process hitting the
 * read-only path was TOLD to "use a specific verb instead of RUN", although its
 * verb WAS specific. That advice is worse than silence — it sends the agent to
 * rewrite a correct intent. Each `origin` therefore names its own cause.
 */
async function judgeComplexInPlanMode(
  command: string,
  parsed: ParsedIntent,
  origin: 'run' | 'read-only',
  isChildProcess: boolean,
  askUser?: (query: string, asker: string, options?: { onEsc?: string }) => Promise<string>,
  escAware?: <T>(
    operation: (abortController: AbortController) => Promise<T>,
    onCleanUp: () => T | Promise<T>
  ) => Promise<T>
): Promise<BashJudgeResult> {
  // Child processes cannot use LLM judging - must be explicit
  if (isChildProcess) {
    return {
      decision: 'block',
      reason: origin === 'run'
        ? 'Ambiguous intent. Use a specific verb instead of RUN. Examples: [READ] SOURCE, [BUILD] ARTIFACT, [TEST] SOURCE'
        : 'This command\'s text contains a glob or a write-verb word, so it cannot be classified safely by a local rule. In a child process it cannot be escalated to the safety checker — ask the lead agent to run it, or simplify it to one plain command (no globs, no quoted verbs).',
    };
  }

  // Parent process: use LLM to analyze (with ESC awareness)
  const llmResult = await analyzeWithLLM(command, parsed, escAware);

  if (llmResult.decision === 'allow') {
    return { decision: 'allow' };
  }

  if (llmResult.decision === 'block') {
    return {
      decision: 'block',
      reason: llmResult.reason || 'Command appears to modify state',
    };
  }

  // Uncertain - ask user (parent only)
  if (!askUser) {
    // No askUser function provided (shouldn't happen in parent).
    // Name the CAUSE: in a child the parent agent reads this reason, and
    // "the checker failed" must not look like "the command is suspicious".
    return {
      decision: 'block',
      reason: llmResult.cause === 'llm-error'
        ? 'The safety checker could not analyse this command (LLM error); retry when the provider is available'
        : 'Unable to determine command safety',
    };
  }

  // Ask user via core.question (ESC-aware). The wording names the CAUSE — a
  // provider outage or the user's own ESC is not "ambiguous intent", which
  // would be a claim about their command (row lead-017). The read-only origin
  // says WHY it got here (a shape match), so the user is not asked to accept a
  // blanket "ambiguous" verdict on a command that may be plain evidence.
  const headline = llmResult.cause === 'llm-error'
    ? 'The safety checker could not be reached, so this command was NOT analysed.'
    : llmResult.cause === 'esc'
      ? 'Analysis was interrupted (ESC), so this command was not fully analysed.'
      : origin === 'run'
        ? 'The command has ambiguous intent.'
        : 'This command is declared read-only but its text contains a glob or a write-verb word, so it was escalated for a safety check that was inconclusive.';
  const userResponse = await askUser(
    `${headline}\n\nCommand: ${command}\nPurpose: ${parsed.purpose}\n\nAllow this command in plan mode? [y/N]`,
    'bash-judge',
    { onEsc: 'n' }
  );

  // If user presses ESC, askUser returns empty string -> treat as "no"
  const approved =
    userResponse.toLowerCase().trim() === 'y' || userResponse.toLowerCase().trim() === 'yes';

  return {
    decision: approved ? 'allow' : 'block',
    reason: approved ? undefined : 'User denied the command',
  };
}

/**
 * Check if a command performs batch deletion (multiple files, globs, or recursive).
 * Single-file deletions (rm file.txt) are not considered batch.
 */
function isBatchDelete(command: string): boolean {
  // Glob characters indicate multi-file targeting
  if (/[*?[\]]/.test(command)) return true;
  // Recursive flag (-r, -rf, -fr, -R, --recursive)
  if (/\brm\s+.*-[a-zA-Z]*[rR]/.test(command)) return true;
  // Multiple explicit file arguments (rm a b c)
  const parts = command
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '');
  if (parts[0] === 'rm' || parts[0] === '\\rm' || parts[0].endsWith('/rm')) {
    const nonFlags = parts.slice(1).filter((p) => !p.startsWith('-'));
    if (nonFlags.length > 1) return true;
  }
  // find ... -delete (batch deletion via find)
  if (/\bfind\b.*-delete\b/.test(command)) return true;
  return false;
}

/**
 * Analyze a batch deletion command with LLM.
 * Uses retryMultipleChoice for SAFE/DANGEROUS/UNCERTAIN classification.
 * Only called for DELETE verb with batch detection in normal mode.
 */
async function analyzeBatchDelete(
  command: string,
  parsed: ParsedIntent,
  escAware?: <T>(
    operation: (abortController: AbortController) => Promise<T>,
    onCleanUp: () => T | Promise<T>
  ) => Promise<T>
): Promise<AnalyzeResult> {
  const systemPrompt = `You are a command safety analyzer. Classify batch deletion commands.

SAFE = Expected cleanup targeting project build artifacts, temp files, or caches. Files are regeneratable.
DANGEROUS = Deletes source code, user data, config files, or files outside the expected project structure.
UNCERTAIN = Cannot determine with confidence.

Answer ONLY with exactly one of: SAFE, DANGEROUS, UNCERTAIN. No other text.`;

  const userPrompt = `Command: ${command}
Purpose: ${parsed.purpose}

Classify this batch deletion command: SAFE, DANGEROUS, or UNCERTAIN?`;

  try {
    const operation = async (abortController: AbortController) => {
      return retryMultipleChoice(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        },
        ['SAFE', 'DANGEROUS', 'UNCERTAIN'],
        { signal: abortController.signal, maxRetries: 2 }
      );
    };

    const onCleanUp = () => null as string | null;

    let result: string | null;
    if (escAware) {
      result = await escAware(operation, onCleanUp);
    } else {
      const abortController = new AbortController();
      result = await operation(abortController);
    }

    if (result === null) return { decision: 'uncertain', cause: 'esc' };

    switch (result) {
      case 'SAFE':
        return { decision: 'allow' };
      case 'DANGEROUS':
        return { decision: 'block', reason: 'LLM determined batch deletion is dangerous' };
      case 'UNCERTAIN':
      default:
        return { decision: 'uncertain', cause: 'llm-uncertain' };
    }
  } catch {
    return { decision: 'uncertain', cause: 'llm-error' };
  }
}

/**
 * Analyze command with LLM to determine if it's a mutation
 * Only called for RUN verb in parent process
 */
async function analyzeWithLLM(
  command: string,
  parsed: ParsedIntent,
  escAware?: <T>(
    operation: (abortController: AbortController) => Promise<T>,
    onCleanUp: () => T | Promise<T>
  ) => Promise<T>
): Promise<AnalyzeResult> {
  const systemPrompt = `You are a command analyzer. Determine if the following command modifies files or state.

Answer ONLY with exactly one of these words (no other text):
- READ (if the command is read-only, no file modifications)
- WRITE (if the command writes to files or modifies state)
- UNCERTAIN (if you cannot determine)

Be conservative: if in doubt, answer UNCERTAIN.`;

  const userPrompt = `Command: ${command}
Purpose: ${parsed.purpose}

Is this command read-only or does it modify state?`;

  try {
    // Use retryMultipleChoice for structured response with retry
    const operation = async (abortController: AbortController) => {
      return retryMultipleChoice(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        },
        ['READ', 'WRITE', 'UNCERTAIN'],
        { signal: abortController.signal, maxRetries: 2 }
      );
    };

    const onCleanUp = () => {
      // If ESC pressed, return uncertain to fall through to user prompt
      return null as string | null;
    };

    let result: string | null;

    if (escAware) {
      result = await escAware(operation, onCleanUp);
    } else {
      // No escAware provided (shouldn't happen in parent) - run directly
      const abortController = new AbortController();
      result = await operation(abortController);
    }

    // If ESC was pressed, result will be null
    if (result === null) {
      return { decision: 'uncertain', cause: 'esc' };
    }

    // Handle each case explicitly
    switch (result) {
      case 'READ':
        return { decision: 'allow' };
      case 'WRITE':
        return { decision: 'block', reason: 'LLM determined command modifies state' };
      case 'UNCERTAIN':
        return { decision: 'uncertain', cause: 'llm-uncertain' };
      default:
        // This shouldn't happen due to retryMultipleChoice validation
        return { decision: 'uncertain', cause: 'llm-error' };
    }
  } catch {
    // If LLM fails or is interrupted, be conservative: ask user
    return { decision: 'uncertain', cause: 'llm-error' };
  }
}
