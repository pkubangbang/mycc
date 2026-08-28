/**
 * triologue/hint-round.ts - Hint round feature domain for the Triologue facade
 *
 * The HintRoundManager is the delegate returned by Triologue.getHintRoundManager().
 * Callers talk to THIS object instead of reaching out to the facade for
 * hint-round generation. It is bound to a live message provider (() => Message[])
 * plus a note injector and optional wiki/duplication callbacks, so it always
 * sees the facade's current message history (including compact/clear/restore
 * swaps).
 *
 * Pattern mirrors triologue/checkpoint.ts: a deps interface (HintRoundManagerDeps)
 * is bound to the facade's private store via closures resolved lazily at call
 * time. The facade keeps no hint-round logic of its own; generateHintRound()
 * on the facade is a thin delegation to getHintRoundManager().generate(...).
 */

import { retryChat, MODEL } from '../../engine/chat-provider.js';
import type { Message, NoteCategory } from '../../types.js';
import { minifyMessages } from '../../utils/llm-chat-minifier.js';
import { agentIO } from '../agent-io.js';

const ANALYSIS_INSTRUCTION = 'Analyze the gap between the user\'s intent and current progress.';

const HINT_SCHEMA = {
  type: 'object',
  properties: {
    blocker: {
      type: 'string',
      description: 'What is preventing progress. Use "no blockers" if there are no real blockers. Be specific and concise.',
    },
    next_step: {
      type: 'string',
      description: 'Concrete, actionable next step. If no blockers, suggest continuing current work. May also carry efficiency guidance (e.g. batch independent tool calls) when the agent is making cautious single-tool turns.',
    },
    focus_on: {
      type: 'string',
      description: 'Key area or priority to focus on.',
    },
    wiki_domain: {
      type: 'string',
      description: 'Domain name from available domains (see list below). Set this when the blocker involves errors, unfamiliar tools, or missing knowledge.',
    },
    wiki_query: {
      type: 'string',
      description: 'Search query for the wiki knowledge base. Use 3-8 keywords describing the specific knowledge gap, NOT a full sentence. Base the query on the actual error messages, tool names, or concepts visible in the conversation. Examples: "intent language verb object table", "ollama retry timeout configuration", "worktree branch switching git". Guessing is encouraged — a rough keyword query is far better than leaving this empty. Never output null or an empty string.',
    },
    should_compact: {
      type: 'boolean',
      description: 'Set true when the agent is stuck in a dead-loop (repeating the same failed actions, or cycling the same tool calls without progress) OR when the conversation context is degraded (very long, stale, attention scattered). Compaction summarises the history and restores focus — set this to trigger a context compaction instead of (or in addition to) a hint. Set false for normal blockers a hint can resolve.',
    },
  },
  required: ['blocker', 'next_step', 'focus_on', 'wiki_domain', 'wiki_query', 'should_compact'],
} as const;

const HINT_SYSTEM_PROMPT = `You are a problem-analysis assistant. Your task is to analyze the gap between the user's intent and the agent's current progress, then output a structured JSON analysis.

CRITICAL INSTRUCTIONS:
1. If there are NO REAL blockers preventing progress, set blocker to exactly: "no blockers"
2. Do NOT fabricate blockers. "no blockers" means the agent should simply continue with the current task.
3. When the blocker involves errors, unfamiliar tools, or missing knowledge, ALWAYS suggest a wiki search by setting wiki_domain and wiki_query. The available domains are listed below. Only leave both empty if the blocker is purely about code logic or syntax.
4. wiki_query construction:
   - Use 3-8 keywords extracted from the error message, tool name, or concept causing the blocker.
   - Format as space-separated keywords, NOT a full sentence. Example: "ollama timeout retry backoff" not "How does ollama handle timeout retries?"
   - GUESSING IS CORRECT BEHAVIOR. You do not need to know the exact answer — your job is to describe what knowledge is missing so a semantic search can find it. A rough but relevant query is always better than an empty string.
   - Even when there are no blockers, fill wiki_query with keywords describing the current task so the search can surface relevant how-to knowledge.
5. In the conversation context, tool calls tagged as ti[hook-name]|tool-name|args were injected by a hookish skill, NOT chosen by the agent. When diagnosing confusion, consider whether a hook is misbehaving — injecting the wrong tool, blocking spuriously, replacing incorrectly, or firing when it shouldn't. If a hook is the blocker, name the hook skill in the blocker field and describe what it is doing wrong.
6. Cautious moves: if you notice the agent is making repeated single-tool-call turns where it could have batched independent calls (e.g. reading files one at a time, pinning todos one by one, creating issues one per turn), this is not a blocker but an efficiency gap. In that case set blocker to "no blockers" and put a concrete batch encouragement in next_step — tell the agent to emit all independent, dependency-free tool calls in a single response. Do NOT encourage batching when one call's arguments depend on another's result (e.g. creating a todo then pinning it by id, reading a file then editing it) or for checkpoint/recap which must be called alone.
7. Reply with ONLY a JSON object. No commentary, no markdown fences.
8. should_compact decides whether to trigger a context compaction (summarise the history to restore focus). Set it true when EITHER:
   (a) DEAD-LOOP — the agent is repeating the same failed actions or cycling the same tool calls without making progress (e.g. the same error 3+ times, the same edit attempted repeatedly, the same file read over and over). A hint alone will not break a true loop because the stale context keeps biasing the agent the same way; compaction clears that bias.
   (b) CONTEXT STRESS — the conversation is very long and the agent's attention is scattered (low-confidence or off-topic moves, lost track of the original goal). Compaction recentres on the user's intent and recent state.
   Set it false for ordinary blockers a hint can resolve (an unfamiliar tool error, a missing API pattern, a misbehaving hook). should_compact is independent of blocker — you may have a real blocker with should_compact=false, or blocker="no blockers" with should_compact=true.

The schema is:
${JSON.stringify(HINT_SCHEMA, null, 2)}

EXAMPLE A — blocker involves an unfamiliar tool error:
{"blocker":"Agent repeatedly gets 'Error: [Intent]' when calling bash","next_step":"Review the intent-language VERB/OBJECT vocabulary and reformat the bash intent","focus_on":"intent-language syntax for bash tool","wiki_domain":"project","wiki_query":"intent language verb object bash tool","should_compact":false}

EXAMPLE B — blocker is a missing API pattern:
{"blocker":"Agent doesn't know how to register a new wiki domain programmatically","next_step":"Search wiki for domain registration API and follow the documented pattern","focus_on":"wiki domain registration API","wiki_domain":"api","wiki_query":"wiki domain register create API","should_compact":false}

EXAMPLE C — no real blocker (agent should continue, query still non-empty):
{"blocker":"no blockers","next_step":"Continue implementing the remaining test cases","focus_on":"completing test coverage","wiki_domain":"project","wiki_query":"test coverage remaining cases","should_compact":false}

EXAMPLE D — cautious moves (single-tool turns, encourage batching):
{"blocker":"no blockers","next_step":"You are making one tool call per turn. Batch independent calls — emit all the read_file / todo_pinning / issue_create calls with no data dependency on each other in a single response to save round-trips. Do not batch calls where one needs another's result, and keep checkpoint/recap alone.","focus_on":"batching independent tool calls","wiki_domain":"project","wiki_query":"parallel tool calls batch independent","should_compact":false}

EXAMPLE E — dead-loop (same failed edit attempted repeatedly):
{"blocker":"Agent has attempted the same edit_file 4 times and hit the same 'old_text not found' error each time","next_step":"Re-read the target file fresh to see its current content, then rebuild old_text from that","focus_on":"stale old_text vs current file content","wiki_domain":"project","wiki_query":"edit_file old_text not found re-read","should_compact":true}

EXAMPLE F — context stress (very long conversation, scattered attention):
{"blocker":"no blockers","next_step":"Re-establish the original goal from the summary and continue the next concrete step","focus_on":"recentring on the user's original intent","wiki_domain":"project","wiki_query":"context length attention scattered goal","should_compact":true}`;

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
 * Mirrors CheckpointManagerDeps: arrow closures over the facade's live store
 * and options, resolved lazily at call time so the manager always reflects the
 * current history (including compact/clear/restore swaps).
 */
export interface HintRoundManagerDeps {
  /** Live view of the raw message array (no system prompt / project context prepended). */
  getMessagesRaw: () => Message[];
  /** Add a system note (e.g. the formatted hint) into the conversation. */
  note: (category: NoteCategory, message: string) => void;
  /** Optional callback to retrieve wiki domains for knowledge suggestions. */
  getWikiDomains?: () => Promise<Array<{ domain_name: string; description?: string }>>;
  /** Optional duplication report from the embedding tracker. */
  getDuplicationReport?: () => string;
}

/**
 * Delegate for the hint-round feature domain.
 * Returned by Triologue.getHintRoundManager(); callers interact with this
 * object for ALL hint-round concerns (problem analysis + HINT note injection).
 *
 * The manager is bound to the live message store so it always reflects the
 * current history. It is memoized on the facade — repeated calls return the
 * same instance.
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
   * @returns 'aborted' if ESC was pressed, 'success' if the hint was injected,
   *   'compact' if the LLM signalled should_compact (caller triggers compaction).
   */
  async generate(
    abortController: AbortController,
    confusionScore: number,
    confusionBreakdown: string,
    pendingSkills?: string[],
  ): Promise<'aborted' | 'success' | 'compact'> {
    if (agentIO.isNeglectedMode()) return 'aborted';

    // Build compact conversation context for analysis
    const messages = this.deps.getMessagesRaw();

    // Filter out system noise messages that would distract hint analysis.
    // REMINDER now covers what was previously CONTINUE/FYI (merged into REMINDER).
    // WRAP_UP remains a hardcoded string prefix (no longer a NoteCategory, but
    // the literal "[WRAP_UP] ..." still appears in the triologue from beginWrapUp()).
    const filteredMessages = messages.filter(msg => {
      if (msg.role === 'system') return false;
      if (msg.role === 'user' && msg.content) {
        if (/^\[(?:REMINDER|HINT|WRAP_UP)\]/.test(msg.content)) return false;
      }
      return true;
    });

    const compactContext = minifyMessages(filteredMessages, { maxContentLength: 300, maxArgsLength: 100, truncateToolOutput: true });

    // Get wiki domains for knowledge search suggestion
    const getWikiDomains = this.deps.getWikiDomains;
    const domains = getWikiDomains ? await getWikiDomains() : [];
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

    // Retry loop: parse JSON until success or abort. The per-iteration body
    // (LLM call + JSON parse + validation + hint formatting + note injection)
    // lives in retryLoop(); generate() owns the loop control and the abort
    // guard so the retry contract is explicit ('retry' → loop again).
    while (true) {
      if (abortController.signal.aborted) {
        return 'aborted';
      }
      const outcome = await this.retryLoop(abortController, userPrompt, pendingSkills);
      if (outcome !== 'retry') {
        return outcome;
      }
    }
  }

  /**
   * One iteration of the hint-round retry loop.
   *
   * Issues a single retryChat call with the assembled user prompt, parses the
   * JSON response, validates the required fields, formats the HINT note, and
   * injects it via deps.note('HINT', ...).
   *
   * @param abortController - Abort controller for ESC handling
   * @param userPrompt - The fully assembled analysis prompt (context + score + domains)
   * @param pendingSkills - Skills with 'when' but no compiled condition (for notification)
   * @returns 'aborted' if ESC was pressed, 'success' if the hint was injected,
   *   'compact' if the LLM signalled should_compact (caller triggers compaction),
   *   'retry' if the response was malformed/unparseable and the caller should loop.
   *   Any non-abort error is rethrown to the caller.
   */
  private async retryLoop(
    abortController: AbortController,
    userPrompt: string,
    pendingSkills?: string[],
  ): Promise<'aborted' | 'success' | 'retry' | 'compact'> {
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

      // Format hint data for better readability
      const hintLines: string[] = ['Problem Analysis:'];
      hintLines.push('');
      hintLines.push(`**Blocker:** ${hintData.blocker}`);
      hintLines.push(`**Next Step:** ${hintData.next_step}`);
      hintLines.push(`**Focus On:** ${hintData.focus_on}`);
      if (hintData.wiki_domain && hintData.wiki_query) {
        hintLines.push(`**Wiki Search:** Domain="${hintData.wiki_domain}", Query="${hintData.wiki_query}"`);
      } else {
        hintLines.push('**Wiki Search:** None');
      }
      if (pendingSkills && pendingSkills.length > 0) {
        hintLines.push('');
        hintLines.push(`**Pending Skill Compilation:** ${pendingSkills.map(s => `'${s}'`).join(', ')}`);
        hintLines.push('Use `skill_compile` to compile these skills so the hook system can process them.');
      }
      hintLines.push('');
      hintLines.push('Use `ctx.core.brief()` to provide status updates as needed.');

      this.deps.note('HINT', hintLines.join('\n'));

      return 'success';
    } catch (err) {
      if (err instanceof Error && err.message === 'Request aborted') {
        return 'aborted';
      }
      throw err;
    }
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