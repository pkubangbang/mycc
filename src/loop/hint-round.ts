/**
 * hint-round.ts - Hint round: one process-wide singleton that owns the WHOLE
 * feature (policy + mechanism) and reads its dependencies from the live
 * MachineEnv.
 *
 * HISTORY / OWNERSHIP
 * -------------------
 * The feature used to be split across three layers:
 *
 *     collect.ts → hintSuggester (states/collect-hint.ts, POLICY)
 *                → createManager(env) building a FRESH HintRoundManager
 *                  (triologue/hint-round.ts, MECHANISM) on every round
 *
 * The facade (Triologue) never owned it — but neither did anything else with
 * a stable identity: the policy singleton rebuilt the mechanism object each
 * round. This module collapses both into ONE singleton, `hintRound`:
 *
 *     collect.ts → hintRound.run(turn)
 *                     ├─ gate + breakdown + escAware + outcome  (policy)
 *                     └─ generate → retryLoop → preFilterWikiSuggestion
 *                                                → validateHintData (mechanism)
 *
 * `hintRound.init(env)` hands the singleton the live `MachineEnv` (triologue +
 * ctx + sequence + embedding tracker) at COMPOSITION time; after that it reads
 * through `this.env` directly and pushes its [HINT] note into the triologue via
 * `env.triologue.note('HINT', ...)`.
 *
 * WHY HOLDING `env` IS SAFE (the old per-round construction rationale)
 * ---------------------------------------------------------------------
 * `createManager` used to be rebuilt per round because a cached manager "would
 * be bound to the FIRST env's triologue/wiki/embedding-tracker". That hazard is
 * already excluded by construction: `MachineEnv` is assembled ONCE per process
 * (`AgentStateMachine`'s constructor, driven by agent-repl for the lead), and
 * compact / clear / restore swap the STORE INSIDE the same Triologue instance —
 * the facade object identity never changes and every accessor (`getMessagesRaw`,
 * `note`, …) reads the live store at CALL time. So one held `env` reference is
 * not stale; it is exactly the same reference the state machine holds.
 *
 * The singleton is therefore reset (not re-created) if a second composition
 * ever hands it a different env — see `init()`.
 *
 * SCOPE
 * -----
 * Main process only. Children (teammates) never run a hint round: they request
 * guidance from the lead via `mail_to` (see triologue-lite.ts). The state
 * machine wires `init(env)` for scope 'main' and `reset()` otherwise, so a
 * child that somehow calls `run()` hits the null-env guard and returns
 * 'continue'.
 *
 * OUTCOME CONTRACT (unchanged from the old policy module)
 * ------------------------------------------------------
 *  - 'continue'  — normal pass, hint skipped, or analysis FAILED (the confusion
 *                  signal is preserved so a later round retries).
 *  - 'stop'      — ESC during generation; the caller returns STOP for
 *                  centralized wrap-up.
 * `resetConfusionIndex()` fires ONLY after a hint actually landed.
 */

import type { MachineEnv, TurnVars } from './state-machine.js';
import type { SequenceEvent } from '../hook/sequence.js';
import { retryChat, MODEL } from '../engine/chat-provider.js';
import type { NoteCategory, WikiModule, SearchResult } from '../types.js';
import { minifyMessages } from '../utils/llm-chat-minifier.js';
import { agentIO } from './agent-io.js';

/** Signal returned by HintRound.run to steer the orchestrator. */
export type HintSignal = 'continue' | 'stop';

// Confusion threshold for hint generation
const CONFUSION_THRESHOLD = 10;
// Minimum message count before hint generation
const MIN_MESSAGES_FOR_HINT = 6;

const ANALYSIS_INSTRUCTION = 'Analyze the gap between the user\'s intent and current progress.';
const MAX_HINT_ATTEMPTS = 3;

/**
 * Similarity bar for the hint's wiki PRE-FILTER (0-1).
 *
 * Set to the SYSTEM bar (matching getSkillMatchThreshold, 0.5): a wiki
 * suggestion must clear the same relevance bar the rest of the system treats
 * as "actually related". A lower, hint-specific bar (e.g. 0.25) was tried and
 * rejected as too tolerant — it admits weak matches that name a plausible but
 * irrelevant document, which is more misleading than muting the line.
 *
 * Consequence: honest corpus hits that score below 0.5 are muted. That is the
 * intended trade-off — the pre-filter's job is to suppress doubt, not to
 * manufacture a wiki lead.
 *
 * Overridable via HINT_WIKI_SIMILARITY_BAR for tuning.
 */
const HINT_WIKI_SIMILARITY_BAR = (() => {
  const val = process.env.HINT_WIKI_SIMILARITY_BAR;
  const parsed = val ? parseFloat(val) : NaN;
  return Number.isFinite(parsed) ? parsed : 0.5;
})();

const HINT_SCHEMA = {
  type: 'object',
  properties: {
    blocker: {
      type: 'string',
      description: 'What is preventing progress. Use "no blockers" if there are no real blockers. Be specific and concise.',
    },
    next_step: {
      type: 'string',
      description: 'Concrete, actionable next step describing what the remaining task IS (not a "Continue ..." authorization to progress past a review point). May also carry efficiency guidance (e.g. batch independent tool calls) when the agent is making cautious single-tool turns.',
    },
    focus_on: {
      type: 'string',
      description: 'Key area or priority to focus on.',
    },
    wiki_domain: {
      type: 'string',
      description: 'One domain name copied EXACTLY from the "Available Wiki Domains" list in the prompt. NEVER invent a domain name — a domain not in that list has no documents.',
    },
    wiki_query: {
      type: 'string',
      description: 'Search query for the wiki knowledge base. Use 3-8 keywords describing the specific knowledge gap, NOT a full sentence. Base the query on the actual error messages, tool names, or concepts visible in the conversation. Examples: "intent language verb object table", "ollama retry timeout configuration", "worktree branch switching git". Guessing is encouraged — a rough keyword query is far better than leaving this empty. Never output null or an empty string.',
    },
  },
  required: ['blocker', 'next_step', 'focus_on', 'wiki_domain', 'wiki_query'],
} as const;

const HINT_SYSTEM_PROMPT = `You are a problem-analysis assistant. Your task is to analyze the gap between the user's intent and the agent's current progress, then output a structured JSON analysis.

CRITICAL INSTRUCTIONS:
1. If there are NO REAL blockers preventing progress, set blocker to exactly: "no blockers"
2. Do NOT fabricate blockers. "no blockers" means there is no real obstacle. In that case still fill next_step / focus_on / wiki_query with a genuine description of the current task. IMPORTANT: never frame next_step as a "Continue ..." or "you're fine, keep going" authorization to progress — describe what the remaining task IS (e.g. "The remaining work is completing test coverage for the compact module"), not a sanction to move past a review point. The [HINT] note is always injected, so the agent will read whatever you write here. Any prior [HINT] notes in the context are your own earlier analyses; if the same advice was already given and not acted on, escalate — change the advice, widen the scope, or name why the previous suggestion failed — instead of repeating it.
3. When the blocker involves errors, unfamiliar tools, or missing knowledge, ALWAYS suggest a wiki search by setting wiki_domain and wiki_query. Pick wiki_domain ONLY from the "Available Wiki Domains" list below — copy a name exactly; NEVER invent one. Only leave both empty if the blocker is purely about code logic or syntax.
4. wiki_query construction:
   - Use 3-8 keywords extracted from the error message, tool name, or concept causing the blocker.
   - Format as space-separated keywords, NOT a full sentence. Example: "ollama timeout retry backoff" not "How does ollama handle timeout retries?"
   - GUESSING IS CORRECT BEHAVIOR. You do not need to know the exact answer — your job is to describe what knowledge is missing so a semantic search can find it. A rough but relevant query is always better than an empty string.
   - Even when there are no blockers, fill wiki_query with keywords describing the current task so the search can surface relevant how-to knowledge.
5. In the conversation context, tool calls tagged as ti[hook-name]|tool-name|args were injected by a hookish skill, NOT chosen by the agent. When diagnosing confusion, consider whether a hook is misbehaving — injecting the wrong tool, blocking spuriously, replacing incorrectly, or firing when it shouldn't. If a hook is the blocker, name the hook skill in the blocker field and describe what it is doing wrong.
6. Cautious moves: if you notice the agent is making repeated single-tool-call turns where it could have batched independent calls (e.g. reading files one at a time, pinning todos one by one, creating issues one per turn), this is not a blocker but an efficiency gap. In that case set blocker to "no blockers" and put a concrete batch encouragement in next_step — tell the agent to emit all independent, dependency-free tool calls in a single response. Do NOT encourage batching when one call's arguments depend on another's result (e.g. creating a todo then pinning it by id, reading a file then editing it) or for brief and recap, which must each be called alone.
7. JUDGE STUCK-NESS FROM EVIDENCE, NOT LENGTH. The prompt carries out-of-band state under "## Todo List", "## Mode & Write Scope", "## Recent Permission Blocks" and "## Loop Evidence". Never infer a blocker from how long the conversation is.
   - Name the blocked todo (its number) in next_step when one is clearly the obstacle.
   - When "## Recent Permission Blocks" is present, the goal is right but the REQUEST is wrong: name the rule and give the exact fix (reformat the intent to VERB OBJECT PARAM TO PURPOSE, switch off plan mode, call git_commit instead of bash git commit, or ask the lead to run it).
   - "No repeated-action evidence in the recent window" is EVIDENCE OF ABSENCE: do not invent a tool loop; treat the blocker as an unresolved task.
8. Reply with ONLY a JSON object. No commentary, no markdown fences.
The schema is:
${JSON.stringify(HINT_SCHEMA, null, 2)}

NOTE: the examples below OMIT wiki_domain / wiki_query on purpose — the domain list is dynamic, so no fixed name may appear. Fill both fields by copying a domain from the "Available Wiki Domains" list and writing a 3-8 keyword query.

EXAMPLE A — blocker involves an unfamiliar tool error:
{"blocker":"Agent repeatedly gets 'Error: [Intent]' when calling bash","next_step":"Review the intent-language VERB/OBJECT vocabulary and reformat the bash intent","focus_on":"intent-language syntax for bash tool"}

EXAMPLE B — blocker is a missing API pattern:
{"blocker":"Agent doesn't know how to register a new wiki domain programmatically","next_step":"Search wiki for domain registration API and follow the documented pattern","focus_on":"wiki domain registration API"}

EXAMPLE C — no real blocker (describe the remaining task; do NOT frame this as a "Continue ..." authorization):
{"blocker":"no blockers","next_step":"The remaining work is completing test coverage for the compact module","focus_on":"completing test coverage"}

EXAMPLE D — cautious moves (single-tool turns, encourage batching):
{"blocker":"no blockers","next_step":"You are making one tool call per turn. Batch independent calls — emit all the read_file / todo_pinning / issue_create calls with no data dependency on each other in a single response to save round-trips. Do not batch calls where one needs another's result, and keep brief and recap alone.","focus_on":"batching independent tool calls"}
`;

/** Shape of the parsed hint data from the LLM response. */
interface HintData {
  blocker: string;
  next_step: string;
  focus_on: string;
  wiki_domain: string;
  wiki_query: string;
}

/**
 * Detect repeated tool actions that signal a dead-loop, to feed the hint round
 * as objective evidence (so the LLM's next_step advice targets the actual loop)
 * instead of a vague "the conversation feels long" feeling.
 *
 * A "repeated action" = the same tool called 3+ times in the recent window with
 * results that share the same error-ish prefix. We look at the trailing events
 * (the recent window) and group consecutive same-tool calls; if 3+ share a
 * common error prefix, we report it. Bash is keyed by its first command clause
 * (so repeated `pnpm test` runs group together even when the tail differs);
 * other tools are keyed by a stable arg (path/name/command).
 *
 * Returns a human-readable line like:
 *   "Repeated actions: edit_file ×4 (results start with "Error: old_text not found")"
 * or null if no repetition is found. The hint-round prompt surfaces this line
 * to the LLM as objective evidence of a loop.
 *
 * Exported for unit testing (see src/tests/loop/states/collect-repeated.test.ts).
 */
export function detectRepeatedActions(events: SequenceEvent[]): string | null {
  if (events.length < 3) return null;
  // Inspect only the trailing window — a dead-loop is a RECENT phenomenon.
  const window = events.slice(-8);
  // Group consecutive same-tool calls; report the largest group with 3+ that
  // also share an error prefix in their results.
  const groups: Array<{ tool: string; events: SequenceEvent[] }> = [];
  for (const ev of window) {
    const last = groups[groups.length - 1];
    if (last && last.tool === ev.tool) {
      last.events.push(ev);
    } else {
      groups.push({ tool: ev.tool, events: [ev] });
    }
  }
  let best: { tool: string; count: number; prefix: string } | null = null;
  for (const g of groups) {
    if (g.events.length < 3) continue;
    const prefix = commonErrorPrefix(g.events.map(e => e.result || ''));
    if (prefix) {
      const candidate = { tool: g.tool, count: g.events.length, prefix };
      if (!best || candidate.count > best.count) best = candidate;
    }
  }
  if (!best) return null;
  return `Repeated actions: ${best.tool} ×${best.count} (results start with "${best.prefix}")`;
}

/**
 * Find the longest common error prefix across results that look like errors.
 * Only considers results that start with an error-ish marker; if fewer than
 * 3 share a prefix, returns null (not a dead-loop signal).
 */
function commonErrorPrefix(results: string[]): string | null {
  const errorish = results.filter(r => {
    const lower = r.toLowerCase();
    return lower.startsWith('error:') || lower.startsWith('error ') ||
      lower.startsWith('failed') || lower.includes('not found') ||
      lower.includes('no such') || lower.includes('does not match');
  });
  if (errorish.length < 3) return null;
  // Longest common prefix of the first 40 chars (enough to identify the
  // repeated error class without dumping a whole message into the breakdown).
  const snippets = errorish.map(r => r.slice(0, 40));
  let prefix = snippets[0];
  for (const s of snippets) {
    while (prefix && !s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) break;
  }
  return prefix && prefix.length >= 6 ? prefix : null;
}

/**
 * HintRound — process-wide singleton owning the whole hint-round feature.
 *
 * Lifecycle:
 *   init(env)  — called ONCE by the composition root (AgentStateMachine's
 *                constructor) for the main scope; holds the live MachineEnv.
 *                A second init with a DIFFERENT env resets first, so a stale
 *                binding can never survive a re-composition.
 *   reset()    — idempotent teardown (also the child-process branch).
 *   run(turn)  — COLLECT step 3: gate → generate → handle the outcome.
 *
 * Carries NO per-turn throttle state: its only dedup is the cross-cutting
 * confusion index on `ctx.core`, which the state machine and other states
 * (llm/hook/prompt) also reset. So the state machine never calls `reset()`
 * at turn boundaries.
 */
export class HintRound {
  private env: MachineEnv | null = null;

  /**
   * Bind the singleton to the live machine environment.
   *
   * Called once per process by AgentStateMachine's constructor. Holding this
   * reference is safe across compact/clear/restore because those swap the
   * store INSIDE the same Triologue instance — every accessor resolves the
   * live store at call time (see the module header).
   */
  init(env: MachineEnv): void {
    if (this.env && this.env !== env) {
      // Re-composition: drop any derived state bound to the old env.
      this.reset();
    }
    this.env = env;
  }

  /** Unbind the env (child processes, teardown, re-composition). */
  reset(): void {
    this.env = null;
  }

  /**
   * COLLECT step 3: generate a hint round when confusion is high, and handle
   * its outcomes.
   *
   * @returns `'stop'` if ESC aborted the hint round (caller returns STOP for
   *          centralized wrap-up); `'continue'` for a normal pass, when the
   *          hint block was skipped, when the env is not bound (child), or when
   *          the hint analysis FAILED (no hint injected — the confusion signal
   *          is deliberately preserved rather than cleared).
   *
   * Side effects on `turn`: captures `lastHintFocus` (the hint source) on a
   * successful hint round.
   */
  async run(turn: TurnVars): Promise<HintSignal> {
    const env = this.env;
    if (!env) return 'continue';
    const { triologue, ctx } = env;
    const confusionIndex = ctx.core.getConfusionIndex();
    const messageCount = triologue.getMessagesRaw().length;

    if (confusionIndex < CONFUSION_THRESHOLD || messageCount < MIN_MESSAGES_FOR_HINT) {
      return 'continue';
    }

    // Use brief for hint round notification (user-facing)
    ctx.core.brief('info', 'loop', 'Generating hint...');
    const pendingSkills = env.conditions.getPending();
    // Use escAware for ESC-interruptible hint generation
    const result = await ctx.core.escAware(
      async (abortController) => {
        return await this.generate(abortController, pendingSkills);
      },
      () => {
        // ESC pressed during hint generation — return 'aborted' so the
        // caller returns STOP for centralized wrap-up (stop.ts handles
        // startWrapUp + auto-off + setNeglectedMode).
        return 'aborted' as const;
      }
    );

    // If aborted (ESC pressed), return STOP for centralized wrap-up.
    // Neglected mode is NOT cleared here — stop.ts handles that.
    if (result === 'aborted') {
      return 'stop';
    }
    // Capture focus_on from a successful hint round (hint source for the
    // composite keyword extraction in collect-skill.ts step 6).
    if (typeof result === 'object' && result.status === 'success') {
      turn.lastHintFocus = result.focusOn;
    }
    // If the hint analysis FAILED (malformed output exhausted the bounded
    // 3-attempt budget), NO hint was injected — so this must NOT be treated
    // as a successful intervention. Falling through to the reset below would
    // clear the confusion signal that triggered the round, hiding the fact
    // that no guidance was delivered and forcing confusion to re-accumulate
    // from scratch before the loop retries. Mirror the 'aborted' branch:
    // return WITHOUT resetting, so the preserved signal lets a later COLLECT
    // regenerate the hint once the LLM produces well-formed output. The
    // per-call burst is already bounded by MAX_HINT_ATTEMPTS in generate(),
    // so preserving the signal cannot spin an unbounded malformed-output loop.
    if (result === 'failed') {
      ctx.core.brief('warn', 'loop', 'Hint analysis failed (malformed output); preserving confusion signal to retry later.');
      return 'continue';
    }
    // Reset confusion after a hint that actually landed (success). 'aborted'
    // and 'failed' returned above.
    ctx.core.resetConfusionIndex();
    return 'continue';
  }

  /**
   * Generate a hint round and inject it into the conversation.
   *
   * Extracts focused context from the triologue's messages, queries the LLM
   * for structured problem analysis, formats it, and injects it via
   * `triologue.note('HINT', ...)`. Supports abort via AbortController for ESC.
   *
   * @param abortController - Abort controller for ESC handling
   * The prompt is assembled from OUT-OF-BAND state only (state the transcript
   * cannot reconstruct) plus the transcript view — see the buildStateSections() helper.
   * @param pendingSkills - Skills with 'when' but no compiled condition
   * @returns 'aborted' if ESC was pressed, 'failed' after bounded malformed-output retries,
   *   or a success object.
   */
  private async generate(
    abortController: AbortController,
    pendingSkills?: string[],
  ): Promise<'aborted' | 'failed' | { status: 'success'; focusOn: string }> {
    const env = this.env;
    if (!env) return 'aborted';
    if (agentIO.isNeglectedMode()) return 'aborted';

    // Build compact conversation context for analysis
    const messages = env.triologue.getMessagesRaw();

    // Filter out system noise messages that would distract hint analysis.
    // REMINDER now covers what was previously CONTINUE/FYI (merged into REMINDER).
    // WRAP_UP remains a hardcoded string prefix (no longer a NoteCategory, but
    // the literal "[WRAP_UP] ..." still appears in the triologue from beginWrapUp()).
    //
    // [HINT] notes need finer handling: the category is shared by TWO producers —
    // this analyzer ("Problem Analysis: ...") and the skill suggester
    // (collect-skill.ts injectSkillHint: "New relevant skills / Still available").
    // Keep ONLY this analyzer's own prior output (identified by its body heading),
    // so it can see what it already advised and escalate instead of re-deriving
    // the same blocker every cycle (B-2). A skill-suggestion hint is NOT problem
    // analysis; feeding it in would make the analyzer mistake a skill nudge for
    // its own earlier advice.
    const filteredMessages = messages.filter(msg => {
      if (msg.role === 'system') return false;
      if (msg.role === 'user' && msg.content) {
        if (/^\[(?:REMINDER|WRAP_UP)\]/.test(msg.content)) return false;
        if (/^\[HINT\]/.test(msg.content) && !/^\[HINT\]\s*Problem Analysis:/s.test(msg.content)) return false;
      }
      return true;
    });

    const compactContext = minifyMessages(filteredMessages, { maxContentLength: 300, maxArgsLength: 100, truncateToolOutput: true });

    // Derive wiki domains from the live wiki module. Guarded: in a child
    // process listDomains() is an IPC round-trip that can reject — a failed
    // domain list must degrade to 'No domains available', not fail the whole
    // hint round.
    let domains: Awaited<ReturnType<WikiModule['listDomains']>> = [];
    if (env.ctx.wiki) {
      try {
        domains = await env.ctx.wiki.listDomains();
      } catch (err) {
        agentIO.verbose('triologue', `Hint wiki listDomains failed; proceeding with no domains: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const wikiDomainNames = new Set(domains.map(d => d.domain_name));
    const domainInfo = domains.length > 0
      ? domains.map(d => `- ${d.domain_name}${d.description ? `: ${d.description}` : ''}`).join('\n')
      : 'No domains available';

    const duplicationReport = env.requestEmbeddingTracker.getDuplicationReport();

    const userPrompt = [
      ...buildStateSections(env),
      '## Conversation Context',
      compactContext,
      '',
      '## Available Wiki Domains',
      domainInfo,
      '',
      duplicationReport,
      '',
      ANALYSIS_INSTRUCTION,
    ].join('\n');

    // Malformed output is retryable but must be bounded. retryLoop owns one
    // request/parse/validation attempt; generate() owns the attempt cap.
    for (let attempt = 1; attempt <= MAX_HINT_ATTEMPTS; attempt++) {
      if (abortController.signal.aborted) {
        return 'aborted';
      }
      const outcome = await this.retryLoop(abortController, userPrompt, wikiDomainNames, pendingSkills);
      if (outcome !== 'retry') {
        return outcome;
      }
      agentIO.verbose('triologue', `Hint round attempt ${attempt}/${MAX_HINT_ATTEMPTS} needs retry`);
    }
    agentIO.verbose('triologue', `Hint round exhausted ${MAX_HINT_ATTEMPTS} attempts; skipping hint`);
    return 'failed';
  }

  /**
   * One iteration of the hint-round retry loop.
   *
   * Issues a single retryChat call with the assembled user prompt, parses the
   * JSON response, validates the required fields, formats the HINT note, and
   * injects it into the triologue.
   *
   * @param abortController - Abort handling
   * @param userPrompt - The fully assembled analysis prompt (context + score + domains)
   * @param wikiDomainNames - Set of registered wiki domain names (for pre-filter validation)
   * @param pendingSkills - Skills with 'when' but no compiled condition (for notification)
   * @returns 'aborted' if ESC was pressed, 'success' if the hint was injected,
   *   'retry' if the response was malformed/unparseable and the caller should loop.
   *   Any non-abort error is rethrown to the caller.
   */
  private async retryLoop(
    abortController: AbortController,
    userPrompt: string,
    wikiDomainNames: Set<string>,
    pendingSkills?: string[],
  ): Promise<'aborted' | 'retry' | { status: 'success'; focusOn: string }> {
    try {
      agentIO.verbose('triologue', 'Hint round request');
      const truncatedPrompt = `${userPrompt.split(ANALYSIS_INSTRUCTION)[0]}${ANALYSIS_INSTRUCTION}`;
      agentIO.verbose('triologue', truncatedPrompt, '');

      const response = await retryChat(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: HINT_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          format: HINT_SCHEMA,
          think: true,
        },
        { signal: abortController.signal, neglected: agentIO.isNeglectedMode() },
      );

      const rawContent = response.message.content || '{}';

      let hintData: HintData;
      try {
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          agentIO.verbose('triologue', 'No JSON found in hint response, retrying...');
          return 'retry';
        }
        hintData = JSON.parse(jsonMatch[0]);
        agentIO.verbose('triologue', `Hint round parsed result: ${JSON.stringify(hintData, null, 2)}`);
      } catch {
        agentIO.verbose('triologue', 'JSON parse failed in hint response, retrying...');
        return 'retry';
      }

      // Schema validation: per-field checks via validateHintData(). On
      // failure, log the named bad fields and retry. On success, the method
      // also normalizes (trims) the text fields in place.
      const validationErrors = this.validateHintData(hintData);
      if (validationErrors.length > 0) {
        agentIO.verbose('triologue', `Hint round invalid fields, retrying: ${validationErrors.join('; ')}`);
        return 'retry';
      }

      // Executed semantic pre-filter: the hint LLM GUESSES a domain+query (a
      // blind suggestion). Before surfacing it we EXECUTE a real semantic
      // search so the emitted line is always verifiably helpful — a suggestion
      // that finds nothing is dropped entirely rather than handed to the main
      // agent as a dead-end. This is the enforcement layer: the manager, not
      // the main LLM's goodwill, guarantees the wiki line is actionable.
      await this.preFilterWikiSuggestion(hintData, wikiDomainNames, abortController);

      // ESC may have landed during the pre-filter's awaited search. Check
      // before injecting so the interrupt still aborts the hint (the loop top
      // only guards the next iteration, not this note).
      if (abortController.signal.aborted) {
        return 'aborted';
      }

      // Format hint data for better readability
      const hintLines: string[] = ['Problem Analysis:'];
      hintLines.push('');
      hintLines.push(`**Blocker:** ${hintData.blocker}`);
      hintLines.push(`**Next Step:** ${hintData.next_step}`);
      hintLines.push(`**Focus On:** ${hintData.focus_on}`);
      if (hintData.wiki_domain && hintData.wiki_query) {
        hintLines.push(`**Wiki Search:** call \`wiki_get(domain="${hintData.wiki_domain}", query="${hintData.wiki_query}")\` to check the knowledge base for background on this blocker.`);
      }
      if (pendingSkills && pendingSkills.length > 0) {
        hintLines.push(`**Also:** ${pendingSkills.map(s => `'${s}'`).join(', ')} ${pendingSkills.length === 1 ? 'needs' : 'need'} compiling via \`skill_compile\` before the hook system can process ${pendingSkills.length === 1 ? 'it' : 'them'}.`);
      }
      hintLines.push('');
      hintLines.push('Use the `brief` tool to post a status update.');

      this.note('HINT', hintLines.join('\n'));

      return { status: 'success', focusOn: hintData.focus_on };
    } catch (err) {
      if (err instanceof Error && err.message === 'Request aborted') {
        return 'aborted';
      }
      throw err;
    }
  }

  /** Push a note into the bound triologue (no-op when unbound). */
  private note(category: NoteCategory, message: string): void {
    this.env?.triologue.note(category, message);
  }

  /**
   * Execute the hint LLM's GUESSED wiki suggestion as a real semantic search,
   * mutating hintData so the emitted line is only kept when it verifiably hits.
   *
   * The hint LLM proposes domain+query BLIND (it cannot see document contents),
   * so the proposal is treated as a hypothesis, not an answer. This method runs
   * the actual search and reconciles the result:
   *  - If the guessed domain is registered, search THAT domain first.
   *  - Otherwise (or on zero hits) fall back to an all-domains search
   *    (WikiModule.get with no `domain` -> SEARCHABLE_PREDICATE alone).
   *  - On >=1 hit, snap wiki_domain to the top hit's REAL domain so the line
   *    can never name a domain that has no matching document.
   *  - On zero hits, clear BOTH fields -> the caller's `if (wiki_domain &&
   *    wiki_query)` guard drops the line silently.
   *
   * Never retries and never fails the hint: a search error mutes the line but
   * the hint itself still returns 'success' (the blocker/next_step guidance is
   * independently useful). The bar is HINT_WIKI_SIMILARITY_BAR — a filter-local
   * constant (NOT the skill-match threshold; see its declaration).
   *
   * @param hintData - Parsed hint data (mutated in place: domain/query may be cleared or domain re-pointed)
   * @param wikiDomainNames - Registered domain names, for validating the guessed domain
   * @param abortController - Honoured: on abort the suggestion is left UNTOUCHED (the caller aborts)
   */
  private async preFilterWikiSuggestion(
    hintData: HintData,
    wikiDomainNames: Set<string>,
    abortController: AbortController,
  ): Promise<void> {
    if (!hintData.wiki_domain || !hintData.wiki_query) return;
    const wiki = this.env?.ctx.wiki;
    if (!wiki) {
      // No wiki module wired (e.g. lite/test wiring) — keep the line as-is.
      return;
    }

    const threshold = HINT_WIKI_SIMILARITY_BAR;
    const query = hintData.wiki_query;
    const topK = 5;

    let hits: SearchResult[] = [];
    try {
      if (wikiDomainNames.has(hintData.wiki_domain)) {
        hits = await wiki.get(query, { domain: hintData.wiki_domain, topK, threshold });
      }
      if (hits.length === 0) {
        // ESC during the first search: leave hintData UNTOUCHED and bail — the
        // caller's abort path must not be turned into a mute of a valid line.
        if (abortController.signal.aborted) return;
        // Unregistered domain, or a registered one that found nothing: widen to
        // an all-domains search before giving up (domain-less get()).
        hits = await wiki.get(query, { topK, threshold });
      }
    } catch (err) {
      // A failed search must NOT fail the hint — mute the line and keep going.
      agentIO.verbose('triologue', `Hint wiki pre-filter search failed; muting suggestion: ${err instanceof Error ? err.message : String(err)}`);
      hintData.wiki_domain = '';
      hintData.wiki_query = '';
      return;
    }

    // ESC landed during the (awaited) search — leave the suggestion untouched;
    // the caller checks the signal and aborts before injecting the note.
    if (abortController.signal.aborted) return;

    if (hits.length > 0) {
      const hit = hits[0];
      // Snap to the real domain of the best hit. In the focused branch this is
      // the domain we searched (a no-op); on the all-domains fallback it is what
      // keeps the emitted line from naming a domain with no matching document.
      hintData.wiki_domain = hit.document.domain;
      const sim = typeof hit.similarity === 'number' ? hit.similarity.toFixed(3) : 'n/a';
      agentIO.verbose('triologue', `Hint wiki pre-filter hit (sim=${sim}, domain=${hit.document.domain})`);
      return;
    }

    agentIO.verbose('triologue', `Hint wiki pre-filter found no relevant hit (bar=${threshold}); muting suggestion`);
    hintData.wiki_domain = '';
    hintData.wiki_query = '';
  }

  /**
   * Validate a parsed HintData object against the HINT_SCHEMA contract.
   *
   * Per-field checks with targeted diagnostics: empty strings are rejected
   * (not just wrong types) because the system prompt mandates concrete
   * values — blocker must be "no blockers" or a real description (never
   * empty); next_step / focus_on / wiki_query must carry actual guidance.
   * A generic "missing fields" retry log wastes a debugging round; naming
   * the bad field points straight at the cause.
   *
   * On success, also normalizes (trims) the text fields IN PLACE so downstream
   * formatting / wiki search never sees stray whitespace the LLM wrapped around
   * its values. wiki_domain is allowed to be empty (the blocker may be pure
   * code logic per system-prompt instruction 3).
   *
   * @param hintData - The parsed hint data (mutated: text fields trimmed on success)
   * @returns Array of human-readable error strings; empty array means valid.
   */
  private validateHintData(hintData: HintData): string[] {
    const errors: string[] = [];
    if (typeof hintData.blocker !== 'string' || hintData.blocker.trim() === '') {
      errors.push('blocker (must be a non-empty string, use "no blockers" if none)');
    }
    if (typeof hintData.next_step !== 'string' || hintData.next_step.trim() === '') {
      errors.push('next_step (must be a non-empty string)');
    }
    if (typeof hintData.focus_on !== 'string' || hintData.focus_on.trim() === '') {
      errors.push('focus_on (must be a non-empty string)');
    }
    if (typeof hintData.wiki_domain !== 'string') {
      errors.push('wiki_domain (must be a string)');
    }
    if (typeof hintData.wiki_query !== 'string' || hintData.wiki_query.trim() === '') {
      errors.push('wiki_query (must be a non-empty string — never null/empty)');
    }
    if (errors.length > 0) {
      return errors;
    }
    // Normalize in place: trim the text fields.
    hintData.blocker = hintData.blocker.trim();
    hintData.next_step = hintData.next_step.trim();
    hintData.focus_on = hintData.focus_on.trim();
    hintData.wiki_domain = hintData.wiki_domain.trim();
    hintData.wiki_query = hintData.wiki_query.trim();
    return errors;
  }
}

/**
 * The structural shape the hint round needs from a recorded denial.
 *
 * Declared here (not imported) so the hint round stays decoupled from
 * parent/core.ts: the env's core is reached by duck-typing.
 */
interface RecordedDenial {
  tool: string;
  target: string;
  reason: string;
  kind: string;
}

/**
 * Read recorded denials from the bound env, or null when this context has no
 * recorder (child/lite contexts, test doubles that did not opt in).
 *
 * There is NO fallback classifier: an absent recorder means the section is
 * simply OMITTED. Reconstructing refusals by pattern-matching tool-result
 * prose was removed on purpose — it mis-classified any result that merely
 * QUOTED a block message (reading bash-judge.ts, grepping its tests) and
 * could not report which tool, target or rule was refused. Silence is the
 * truthful output for "no evidence available"; a fabricated label is not.
 *
 * The real recorder lives at the lead's grant chokepoint
 * (Core.requestGrant → recordDenial); see src/context/parent/core.ts.
 */
function readRecentDenials(env: MachineEnv): RecordedDenial[] | null {
  const core = env.ctx.core as unknown as { getRecentDenials?: () => RecordedDenial[] };
  if (typeof core.getRecentDenials !== 'function') return null;
  try {
    const denials = core.getRecentDenials();
    return Array.isArray(denials) ? denials : null;
  } catch {
    return null;
  }
}

/**
 * One line per denial: what was refused, and why.
 *
 * Returns null on an empty list, which makes the caller OMIT the section
 * entirely — a clean session must not pad the prompt.
 */
function formatDenials(denials: RecordedDenial[]): string | null {
  if (denials.length === 0) return null;
  const lines: string[] = [
    '## Recent Permission Blocks',
    'Recorded at the grant gate (exact tool, target and rule). Fix the REQUEST, not the goal:',
  ];
  for (const d of denials.slice(-6)) {
    lines.push(`- ${d.tool} → ${sanitizeField(d.target)} [${d.kind}]: ${sanitizeField(d.reason)}`);
  }
  return lines.join('\n');
}

/**
 * The neutral Loop Evidence line used when the recent window holds no
 * repeated-action evidence.
 *
 * This line is NOT optional filler: `getDuplicationReport()` only reports
 * pairs touching the last 5 entries, while the confusion index accumulates
 * every pair — so a round can legitimately fire on index >= 10 with an empty
 * duplication report. Without an explicit "no evidence" statement the
 * analyzer tends to invent a tool loop from conversation length alone, which
 * is exactly the failure mode the counters were removed to stop.
 */
const NO_LOOP_EVIDENCE =
  'No repeated-action evidence in the recent window — treat the current blocker as an unresolved task, not a duplicate tool loop.';

/** Hard cap applied to any user/peer-authored text spliced into the prompt. */
const INJECTED_FIELD_MAX = 60;

/**
 * Sanitize a user- or peer-authored value before splicing it into the prompt.
 *
 * The todo list echoes `note` / `preventStop` conditions, which are natural
 * language written by the user or a peer — the transcript view never had this
 * exposure because it is minimised and truncated. Flatten newlines, collapse
 * whitespace and cap the length so a crafted todo cannot smuggle a heading or
 * an instruction into the analyzer's prompt.
 */
function sanitizeField(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  // ANALYSIS_INSTRUCTION must stay unique in the prompt (retryLoop splits on
  // it), so a value containing it is defused rather than passed through.
  const safe = flat.split(ANALYSIS_INSTRUCTION).join('[gap analysis]');
  return safe.length > INJECTED_FIELD_MAX ? `${safe.slice(0, INJECTED_FIELD_MAX)}…` : safe;
}

/**
 * One held STOP guard, as read from the turn state.
 */
interface HeldGuardLine {
  id: number;
  name: string;
  condition: string;
  holds: number;
}

/**
 * Read the guards that blocked the turn, or [] when none did.
 *
 * The hold counters live on `TurnVars.preventStopHolds` (a hold does not end
 * the turn, so nothing clears it mid-turn); the names and conditions live on
 * the todo items themselves. A guard whose todo was released between the hold
 * and this round is skipped — the section reports LIVE guards only, so it can
 * never claim something the todo store no longer says.
 *
 * Duck-typed on purpose: the hint round stays decoupled from the state
 * machine's TurnVars shape (same reason `readRecentDenials` duck-types core).
 */
function readHeldGuards(env: MachineEnv): HeldGuardLine[] {
  const turn = (env as unknown as { turn?: { preventStopHolds?: Record<number, number> } }).turn;
  const holds = turn?.preventStopHolds;
  if (!holds) return [];
  const out: HeldGuardLine[] = [];
  for (const [idStr, count] of Object.entries(holds)) {
    const id = Number(idStr);
    if (!Number.isFinite(id) || !count) continue;
    const todo = env.ctx.todo.getItems().find((i) => i.id === id);
    if (!todo || !todo.preventStop) continue;
    out.push({ id, name: todo.name, condition: todo.preventStop, holds: count });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Build the OUT-OF-BAND state sections prefixed to the analysis prompt.
 *
 * The module's design rule: the prompt carries only state `minifyMessages`
 * cannot reconstruct from the transcript. Todos, the write scope and recent
 * permission blocks all qualify; counters do not, which is why the confusion
 * score / turn count / error count are absent.
 *
 * Every section self-omits when it has nothing to say, so a quiet session adds
 * little beyond `## Todo List`.
 */
function buildStateSections(env: MachineEnv): string[] {
  const parts: string[] = [];

  // ── Todo List ──
  // Rendered from getItems() rather than printTodoList(): the printer echoes
  // the raw note + preventStop bodies, which are user/peer-authored.
  let todos: ReturnType<MachineEnv['ctx']['todo']['getItems']>;
  try {
    todos = env.ctx.todo.getItems();
  } catch {
    todos = [];
  }
  const todoLines = ['## Todo List'];
  if (todos.length === 0) {
    todoLines.push('No todos — the task is not tracked; decide whether it needs one.');
  } else {
    for (const item of todos) {
      const marker = item.done ? '[x]' : '[ ]';
      const pin = item.pinned ? ' 📌' : '';
      const note = item.note ? ` — ${sanitizeField(item.note)}` : '';
      todoLines.push(`- ${marker}${pin} ${item.id}. ${sanitizeField(item.name)}${note}`);
    }
  }
  parts.push(todoLines.join('\n'));

  // ── Mode & Write Scope ──
  // Plan mode only: "normal — writes permitted" is a constant and would be the
  // no-signal padding this redesign exists to delete.
  if (env.sequence.isPlanMode()) {
    const core = env.ctx.core as unknown as { getAllowedFile?: () => string | undefined };
    let allowed: string | undefined;
    try {
      allowed = core.getAllowedFile?.();
    } catch {
      allowed = undefined;
    }
    parts.push([
      '## Mode & Write Scope',
      `plan mode — writes are blocked except: ${allowed ? sanitizeField(allowed) : '(no file allowed)'}`,
    ].join('\n'));
  }

  // ── Recent Permission Blocks ──
  // EXACT evidence only, recorded at the grant chokepoint
  // (Core.requestGrant → recordDenial). An absent recorder omits the section
  // rather than guessing from tool-output prose — see readRecentDenials().
  const permissionEvidence = formatDenials(readRecentDenials(env) ?? []);
  if (permissionEvidence) parts.push(permissionEvidence);

  // ── Stop Guards (held) ──
  // Out-of-band evidence the transcript CANNOT reconstruct: a held guard is a
  // system-side verdict that blocked the turn, and the agent's retry text does
  // not say how many times it was already bounced. Without this section the
  // analyzer sees a repeated "I`m done" and invents a generic blocker instead
  // of telling the agent what the guard is actually waiting for.
  const heldGuards = readHeldGuards(env);
  if (heldGuards.length > 0) {
    const guardLines = ['## Stop Guards (held)'];
    guardLines.push('A pinned-todo guard blocked the turn. Repeating the same claim will not release it:');
    for (const g of heldGuards) {
      guardLines.push(
        `- #${g.id} "${sanitizeField(g.name)}" — guard: ${sanitizeField(g.condition)} — held ${g.holds}×`,
      );
    }
    parts.push(guardLines.join('\n'));
  }
  // ── Loop Evidence ──
  // detectRepeatedActions() names the tool, the repeat count and the shared
  // error prefix — evidence, not a metric. It is the ONE piece of the old
  // breakdown that survives: dead loops are the hint round's documented job.
  parts.push([
    '## Loop Evidence',
    detectRepeatedActions(env.sequence.getEvents()) ?? NO_LOOP_EVIDENCE,
  ].join('\n'));

  return [...parts, ''];
}

/**
 * Process-wide singleton. Owns the COLLECT step-3 hint-round policy AND
 * mechanism (gate + state sections + ESC wiring + outcome handling + LLM
 * analysis + [HINT] injection). Carries no mutable state besides the bound
 * env — the hint flow's only dedup is the cross-cutting confusion index on
 * `ctx.core`.
 */
export const hintRound = new HintRound();
