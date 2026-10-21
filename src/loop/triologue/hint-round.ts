/**
 * triologue/hint-round.ts - Hint round feature domain
 *
 * The HintRoundManager is constructed by the COMPOSITION ROOT that holds both
 * the triologue and the runtime context — currently HintSuggester in
 * states/collect-hint.ts, which owns `ctx.wiki`. It is NOT owned by the
 * Triologue facade: Triologue is a conversation-state primitive, whereas the
 * hint round is an application-level feature that consults external modules
 * (the wiki now, potentially more later), so it must be built where those
 * modules are in scope. The facade exposes no hint-round methods.
 *
 * The manager is bound to a live message provider (() => Message[]) plus a note
 * injector, the wiki module, and optional duplication callbacks, so it always
 * sees the current message history (including compact/clear/restore swaps).
 *
 * Pattern mirrors triologue/wrap-up.ts: a deps interface (HintRoundManagerDeps)
 * is bound to the facade's live store via closures resolved lazily at call time.
 */

import { retryChat, MODEL } from '../../engine/chat-provider.js';
import type { Message, NoteCategory, WikiModule, SearchResult } from '../../types.js';
import { minifyMessages } from '../../utils/llm-chat-minifier.js';
import { agentIO } from '../agent-io.js';

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
    should_compact: {
      type: 'boolean',
      description: 'Set true ONLY when the agent is stuck in a dead-loop (repeating the same failed actions, or cycling the same tool calls without progress) AND a hint alone will not break it. Do NOT set it for long conversations or scattered attention — context length is handled by a separate token-based compaction, and a hint is almost always the better intervention for those. Set false for normal blockers a hint can resolve.',
    },
  },
  required: ['blocker', 'next_step', 'focus_on', 'wiki_domain', 'wiki_query', 'should_compact'],
} as const;

const HINT_SYSTEM_PROMPT = `You are a problem-analysis assistant. Your task is to analyze the gap between the user's intent and the agent's current progress, then output a structured JSON analysis.

CRITICAL INSTRUCTIONS:
1. If there are NO REAL blockers preventing progress, set blocker to exactly: "no blockers"
2. Do NOT fabricate blockers. "no blockers" means there is no real obstacle. In that case still fill next_step / focus_on / wiki_query with a genuine description of the current task. IMPORTANT: never frame next_step as a "Continue ..." or "you're fine, keep going" authorization to progress — describe what the remaining task IS (e.g. "The remaining work is completing test coverage for the compact module"), not a sanction to move past a review point. The [HINT] note is always injected when should_compact is false, so the agent will read whatever you write here. Any prior [HINT] notes in the context are your own earlier analyses; if the same advice was already given and not acted on, escalate — change the advice, widen the scope, or name why the previous suggestion failed — instead of repeating it.
3. When the blocker involves errors, unfamiliar tools, or missing knowledge, ALWAYS suggest a wiki search by setting wiki_domain and wiki_query. Pick wiki_domain ONLY from the "Available Wiki Domains" list below — copy a name exactly; NEVER invent one. Only leave both empty if the blocker is purely about code logic or syntax.
4. wiki_query construction:
   - Use 3-8 keywords extracted from the error message, tool name, or concept causing the blocker.
   - Format as space-separated keywords, NOT a full sentence. Example: "ollama timeout retry backoff" not "How does ollama handle timeout retries?"
   - GUESSING IS CORRECT BEHAVIOR. You do not need to know the exact answer — your job is to describe what knowledge is missing so a semantic search can find it. A rough but relevant query is always better than an empty string.
   - Even when there are no blockers, fill wiki_query with keywords describing the current task so the search can surface relevant how-to knowledge.
5. In the conversation context, tool calls tagged as ti[hook-name]|tool-name|args were injected by a hookish skill, NOT chosen by the agent. When diagnosing confusion, consider whether a hook is misbehaving — injecting the wrong tool, blocking spuriously, replacing incorrectly, or firing when it shouldn't. If a hook is the blocker, name the hook skill in the blocker field and describe what it is doing wrong.
6. Cautious moves: if you notice the agent is making repeated single-tool-call turns where it could have batched independent calls (e.g. reading files one at a time, pinning todos one by one, creating issues one per turn), this is not a blocker but an efficiency gap. In that case set blocker to "no blockers" and put a concrete batch encouragement in next_step — tell the agent to emit all independent, dependency-free tool calls in a single response. Do NOT encourage batching when one call's arguments depend on another's result (e.g. creating a todo then pinning it by id, reading a file then editing it) or for recap, which must be called alone.
7. Reply with ONLY a JSON object. No commentary, no markdown fences.
8. should_compact decides whether to trigger a context compaction (summarise the history to restore focus). Set it true ONLY for a genuine DEAD-LOOP — the agent is repeating the same failed actions or cycling the same tool calls without making progress (e.g. the same error 3+ times, the same edit attempted repeatedly, the same file read over and over), and a hint alone will not break the loop because the stale context keeps biasing the agent the same way.
   Do NOT set should_compact for long conversations, scattered attention, low-confidence moves, or losing track of the goal. Those are NOT dead-loops — a token-based compaction handles context length on a separate, objective path, and for scattered attention a HINT is the better intervention (it re-states the goal and next step WITHOUT discarding the working memory the agent just built). Setting should_compact on a long-but-progressing conversation throws away useful context.
   Evidence: look at the "Repeated actions" line in the breakdown (if present) — it lists the same tool called N times with the same error. If there is NO repeated-action evidence, default should_compact to false. should_compact is independent of blocker — you may have a real blocker with should_compact=false, or blocker="no blockers" with should_compact=true (only if a dead-loop is visible).

The schema is:
${JSON.stringify(HINT_SCHEMA, null, 2)}

NOTE: the examples below OMIT wiki_domain / wiki_query on purpose — the domain list is dynamic, so no fixed name may appear. Fill both fields by copying a domain from the "Available Wiki Domains" list and writing a 3-8 keyword query.

EXAMPLE A — blocker involves an unfamiliar tool error:
{"blocker":"Agent repeatedly gets 'Error: [Intent]' when calling bash","next_step":"Review the intent-language VERB/OBJECT vocabulary and reformat the bash intent","focus_on":"intent-language syntax for bash tool","should_compact":false}

EXAMPLE B — blocker is a missing API pattern:
{"blocker":"Agent doesn't know how to register a new wiki domain programmatically","next_step":"Search wiki for domain registration API and follow the documented pattern","focus_on":"wiki domain registration API","should_compact":false}

EXAMPLE C — no real blocker (describe the remaining task; do NOT frame this as a "Continue ..." authorization):
{"blocker":"no blockers","next_step":"The remaining work is completing test coverage for the compact module","focus_on":"completing test coverage","should_compact":false}

EXAMPLE D — cautious moves (single-tool turns, encourage batching):
{"blocker":"no blockers","next_step":"You are making one tool call per turn. Batch independent calls — emit all the read_file / todo_pinning / issue_create calls with no data dependency on each other in a single response to save round-trips. Do not batch calls where one needs another's result, and keep recap alone.","focus_on":"batching independent tool calls","should_compact":false}

EXAMPLE E — dead-loop (same failed edit attempted repeatedly):
{"blocker":"Agent has attempted the same edit_file 4 times and hit the same 'old_text not found' error each time","next_step":"Re-read the target file fresh to see its current content, then rebuild old_text from that","focus_on":"stale old_text vs current file content","should_compact":true}`;

/** Shape of the parsed hint data from LLM response */
interface HintData {
  blocker: string;
  next_step: string;
  focus_on: string;
  wiki_domain: string;
  wiki_query: string;
  should_compact: boolean;
}

/**
 * Dependencies the HintRoundManager needs from the facade's private state.
 *
 * Mirrors WrapUpManager's deps pattern: arrow closures over the facade's live store
 * and options, resolved lazily at call time so the manager always reflects the
 * current history (including compact/clear/restore swaps).
 */
export interface HintRoundManagerDeps {
  /** Live view of the raw message array (no system prompt / project context prepended). */
  getMessagesRaw: () => Message[];
  /** Add a system note (e.g. the formatted hint) into the conversation. */
  note: (category: NoteCategory, message: string) => void;
  /**
   * The wiki knowledge module, injected at CONSTRUCTION by the composition
   * root (HintSuggester, which holds `ctx`). The manager derives the domain
   * list AND runs its own semantic pre-filter search from it — neither is wired
   * per call, and no domain-list callback is passed through the Triologue
   * options.
   */
  wiki?: WikiModule;
  /** Optional duplication report from the embedding tracker. */
  getDuplicationReport?: () => string;
}

/**
 * Delegate for the hint-round feature domain.
 * Constructed by the composition root (HintSuggester) and driven via
 * generate(); the manager owns ALL hint-round concerns (problem analysis +
 * HINT note injection + the executed wiki pre-filter).
 *
 * The manager is bound to the live message store so it always reflects the
 * current history.
 */
export class HintRoundManager {
  private deps: HintRoundManagerDeps;

  constructor(deps: HintRoundManagerDeps) {
    this.deps = deps;
  }

  /**
   * Generate a hint round and inject it into the conversation.
   *
   * Extracts focused context from the triologue's messages, queries the LLM
   * for structured problem analysis, formats it, and injects it via
   * deps.note('HINT', ...). Supports abort via AbortController for ESC.
   *
   * @param abortController - Abort controller for ESC handling
   * @param confusionScore - Current confusion score
   * @param confusionBreakdown - Human-readable breakdown of confusion factors
   * @param pendingSkills - Skills with 'when' but no compiled condition
   * @returns 'aborted' if ESC was pressed, 'compact' when compaction is requested,
   *   'failed' after bounded malformed-output retries, or a success object.
   */
  async generate(
    abortController: AbortController,
    confusionScore: number,
    confusionBreakdown: string,
    pendingSkills?: string[],
  ): Promise<'aborted' | 'compact' | 'failed' | { status: 'success'; focusOn: string }> {
    if (agentIO.isNeglectedMode()) return 'aborted';

    // Build compact conversation context for analysis
    const messages = this.deps.getMessagesRaw();

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

    // Derive wiki domains from the injected wiki module (construction-site DI).
    // Guarded: in a child process listDomains() is an IPC round-trip that can
    // reject — a failed domain list must degrade to 'No domains available',
    // not fail the whole hint round.
    let domains: Awaited<ReturnType<WikiModule['listDomains']>> = [];
    if (this.deps.wiki) {
      try {
        domains = await this.deps.wiki.listDomains();
      } catch (err) {
        agentIO.verbose('triologue', `Hint wiki listDomains failed; proceeding with no domains: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const wikiDomainNames = new Set(domains.map(d => d.domain_name));
    const domainInfo = domains.length > 0
      ? domains.map(d => `- ${d.domain_name}${d.description ? `: ${d.description}` : ''}`).join('\n')
      : 'No domains available';

    const userPrompt = [
      '## Conversation Context',
      compactContext,
      '',
      `## Confusion Score: ${confusionScore}`,
      confusionBreakdown,
      '',
      '## Available Wiki Domains',
      domainInfo,
      '',
      this.deps.getDuplicationReport ? this.deps.getDuplicationReport() : '',
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
   * injects it via deps.note('HINT', ...).
   *
   * @param abortController - Abort handling
   * @param userPrompt - The fully assembled analysis prompt (context + score + domains)
   * @param wikiDomainNames - Set of registered wiki domain names (for pre-filter validation)
   * @param pendingSkills - Skills with 'when' but no compiled condition (for notification)
   * @returns 'aborted' if ESC was pressed, 'success' if the hint was injected,
   *   'compact' if the LLM signalled should_compact (caller triggers compaction),
   *   'retry' if the response was malformed/unparseable and the caller should loop.
   *   Any non-abort error is rethrown to the caller.
   */
  private async retryLoop(
    abortController: AbortController,
    userPrompt: string,
    wikiDomainNames: Set<string>,
    pendingSkills?: string[],
  ): Promise<'aborted' | 'retry' | 'compact' | { status: 'success'; focusOn: string }> {
    try {
      agentIO.verbose('triologue', 'Hint round request');
      const truncatedPrompt = `${userPrompt.split(ANALYSIS_INSTRUCTION)[0]}${ANALYSIS_INSTRUCTION}\n...`;
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

      // Compaction path: when the LLM signals should_compact (dead-loop or
      // context stress), a HINT note would be thrown away by the imminent
      // compact(), so do NOT inject it. Return 'compact' and let the caller
      // (collect.ts via the facade) trigger triologue.compact(). next_step /
      // focus_on still ride along inside hintData but are not surfaced as a
      // note — compaction itself is the intervention.
      if (hintData.should_compact) {
        agentIO.verbose('triologue', `Hint round signalled compaction: ${hintData.blocker}`);
        return 'compact';
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

      this.deps.note('HINT', hintLines.join('\n'));

      return { status: 'success', focusOn: hintData.focus_on };
    } catch (err) {
      if (err instanceof Error && err.message === 'Request aborted') {
        return 'aborted';
      }
      throw err;
    }
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
    if (!this.deps.wiki) {
      // No wiki module wired (e.g. lite/test wiring) — keep the line as-is.
      return;
    }

    const threshold = HINT_WIKI_SIMILARITY_BAR;
    const query = hintData.wiki_query;
    const topK = 5;

    let hits: SearchResult[] = [];
    try {
      if (wikiDomainNames.has(hintData.wiki_domain)) {
        hits = await this.deps.wiki.get(query, { domain: hintData.wiki_domain, topK, threshold });
      }
      if (hits.length === 0) {
        // ESC during the first search: leave hintData UNTOUCHED and bail — the
        // caller's abort path must not be turned into a mute of a valid line.
        if (abortController.signal.aborted) return;
        // Unregistered domain, or a registered one that found nothing: widen to
        // an all-domains search before giving up (domain-less get()).
        hits = await this.deps.wiki.get(query, { topK, threshold });
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
    if (typeof hintData.should_compact !== 'boolean') {
      errors.push('should_compact (must be a boolean)');
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