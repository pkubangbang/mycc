/**
 * collect-skill.ts - Proactive skill discovery, owned by a singleton.
 *
 * Step 6 of the COLLECT pipeline: composite keyword extraction + branching
 * skill suggestion. Composes a composite text from three sources
 * (brief + query + hint), extracts English keywords + a free-form semantic
 * query via a single LLM call, matches keywords against loaded skills, then
 * branches:
 *  - Branch A (small match <5): injects the full keyword-matched list.
 *  - Branch B (oversize >=5): refines via a wiki semantic-search
 *    intersection (fail-fast on empty freeformQuery; no hint on empty
 *    intersection or wiki failure).
 *
 * The discovery throttle state — the query dedup cursor (`lastQuery`) and
 * the cooldown counter (`cooldown`) — lives ON THIS SINGLETON, not on
 * TurnVars. The state machine calls `skillSuggester.reset()` at each turn
 * boundary (the same lifecycle points where the fields used to be
 * re-initialized on TurnVars). This mirrors the auto-state.ts precedent:
 * centralize mutable per-process state in a dedicated singleton so there is
 * a single source of truth.
 *
 * Three sources of the composite:
 *   brief = turn.lastBriefMessage   (agent's self-reported focus, set in TOOL)
 *   query = firstSteerNote ?? turn.lastUserQuery  (the trigger source)
 *   hint  = turn.lastHintFocus      (hint round focus_on, captured in step 3)
 * Extraction is TRIGGERED only by a change in query. Brief and hint enrich
 * the composite but never trigger. A 3-pass cooldown suppresses
 * re-triggering from consecutive user messages.
 *
 * See docs/plan-composite-keyword-extraction.md for the brief+query+hint design.
 */

import type { MachineEnv, TurnVars } from '../state-machine.js';
import { getSkillMatchThreshold } from '../../config.js';
import { loader } from '../../context/shared/loader.js';
import type { Skill, Tool, Message } from '../../types.js';
import type { Triologue } from '../triologue.js';
import { retryChat, MODEL, stopSpinner } from '../../engine/chat-provider.js';
import { startSpinner } from '../../engine/chat-helpers.js';

/**
 * When the keyword-matched skill count reaches this threshold, the
 * suggestion is "oversize" — listing all matches (with descriptions) wastes
 * tokens. Instead, a semantic-search intersection refines the list to the
 * skills BOTH keyword-matched AND embedding-relevant. Below the threshold,
 * the full keyword-matched list is surfaced as before (small enough to be
 * useful inline). See runKeywordExtraction step 6, Branch B.
 */
const SKILL_OVERSIZE_THRESHOLD = 5;
/**
 * topK for the semantic wiki.get call in the oversize branch. Broader than
 * skill_search's topK=3 so the intersection with keyword matches has room
 * to be non-empty; the keyword match already acts as a precision filter.
 */
const SKILL_SEMANTIC_TOPK = 10;

// ── Baseline skill-match gate ───────────────────────────────────────────
// The match predicate is a single, readable bar:
//
//   baseline = min(Y - 1, (X / W) * Y)
//   match    = Z >= baseline        (Z = exact-token intersection count)
//
// where:
//   X = per-skill keyword count
//   W = total keyword-universe size (loader.getSkillKeywords().length)
//   Y = query keyword count, clamped to [SKILL_QUERY_KW_MIN, SKILL_QUERY_KW_MAX]
//   Z = |query keywords ∩ skill keywords| (exact, case-insensitive, NO substring)
//
// (X / W) * Y is E[Z | null] — the overlap expected by chance. Using it
// directly as the bar gives proportionality (a fat skill in a small universe
// is held to a higher bar). Y - 1 caps the bar at "all-but-one query
// keyword must hit", so the demand scales with query length and can never
// exceed Y (always satisfiable) — it also blocks vocabulary-bloat
// self-promotion (a skill with huge X pushes E[Z] up, but `min` picks Y - 1).
// min() takes the STRICTER of the two: small-skill/large-universe → E[Z] is
// tiny → permissive but still rejects zero-overlap; large-skill/small-
// universe → Y - 1 caps the demand. Exact-token intersection (not substring
// `includes`) kills the "go" ↔ "logging" false match.

/** Query-keyword-count clamp band. Y is observed query keyword count. */
const SKILL_QUERY_KW_MIN = 2;
const SKILL_QUERY_KW_MAX = 5;

// ── Keyword extraction (folded from keyword-extractor.ts) ───────────────
// LLM-based keyword extraction from arbitrary language, via tool-calling
// (tool_choice: 'required' → structured JSON, no fragile text parsing). The
// output keywords feed matchesBaselineGate above. Previously a standalone
// module (src/loop/keyword-extractor.ts); folded into SkillSuggester as a
// private method so the suggester owns the whole discovery pipeline
// (extraction + matching + branching) as a single cohesive unit.

/**
 * Outcome of a keyword extraction attempt.
 *
 * Three semantically distinct cases that the old `string[]` return value
 * conflated into a single `[]`:
 *  - `success` — the LLM call ran to completion. `keywords` may be empty
 *    (the model found nothing relevant), but the operation itself succeeded,
 *    so the caller MAY advance its throttle/dedup state.
 *  - `skipped` — the input was trivial (too short, or a greeting/ack). No LLM
 *    call was made. The caller SHOULD mark the Y source as seen (so a trivial
 *    "hello" doesn't re-trigger every pass) but this is NOT a failure.
 *  - `failed` — the LLM call threw (transient network error, or ESC abort).
 *    The caller MUST NOT advance throttle/dedup state: Y stays eligible for
 *    a retry on a subsequent pass.
 *
 * This distinction matters because runKeywordExtraction mutates a cooldown
 * and a dedup cursor (`lastQuery`) based on the extraction result. Treating
 * a `failed` or `skipped` outcome the same as `success` would either suppress
 * a retry after a transient failure (failed) or consume the discovery
 * opportunity for a trivial query (the catch-all `[]`).
 */
export type KeywordExtractionResult =
  | { status: 'success'; keywords: string[]; freeformQuery: string }
  | { status: 'skipped' }
  | { status: 'failed' };

/** Tool definition for structured keyword extraction (LLM tool-calling). */
const EXTRACT_KEYWORDS_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'extract_keywords',
    description: 'Extract English keywords and a free-form search query from the user query for skill matching',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extracted English keywords (2-5 words) describing the user intent',
        },
        freeform_query: {
          type: 'string',
          description: "A concise free-form search query (2-5 words) capturing the user's core intent for semantic skill search",
        },
      },
      required: ['keywords', 'freeform_query'],
    },
  },
};

/** Trivial-query patterns skipped without an LLM call (greetings / acks). */
const TRIVIAL_QUERY_PATTERN = /^(hi|hello|hey|ok|okay|yes|no|y|n|bye|goodbye|thanks|thank you|继续|好的|嗯|你好|谢谢|再见|hi|hello|hey)$/i;

// ── Skill triologue status (folded from utils/skill-dedup.ts) ───────────
// Classifies a skill as new / suggested / loaded by scanning the triologue
// history. Used by injectSkillHint to partition the matched skills before
// surfacing them. The 3 helpers below are module-private; the classification
// itself is a private method on SkillSuggester.

/** A skill's relationship to the current triologue history. */
type SkillTriologueStatus = 'new' | 'suggested' | 'loaded';

/**
 * Type guard: check if a message is a tool response for a specific tool
 * name. Message extends OllamaMessage which doesn't have tool_name in its
 * type definition, but the Ollama API does return it on tool role messages.
 */
function isToolResponse(msg: Message, toolName: string): boolean {
  return msg.role === 'tool' && (msg as { tool_name?: string }).tool_name === toolName;
}

/** Check if a message content contains a [HINT] note (injected by triologue.note('HINT', ...)). */
function isHintNote(content: string): boolean {
  return /^\[hint\]/i.test(content.trim());
}

/** Check if a message content contains a skill_search result (skill names + descriptions). */
function isSkillSearchResult(content: string): boolean {
  return /Found \d+ skill\(s\) matching/i.test(content);
}

/**
 * SkillSuggester - Singleton owning the proactive skill-discovery logic and
 * its throttle state.
 *
 * The discovery throttle (the query dedup cursor + cooldown) previously lived
 * on TurnVars as `lastSkillY` / `skillDiscoveryCooldown`. It now lives here
 * so the suggester is the single source of truth for its own state, matching
 * the auto-state.ts precedent (centralize mutable per-process state in a
 * dedicated singleton). The state machine calls `reset()` at each turn
 * boundary — the same lifecycle points where the fields were previously
 * re-initialized on TurnVars.
 *
 * Lifetime: process-wide. A single shared `skillSuggester` instance is
 * exported. Child processes (teammates) run their own COLLECT but never
 * share this instance (separate process = separate module = separate
 * singleton), which is correct: a teammate's discovery state must not leak
 * into the lead's.
 */
export class SkillSuggester {
  /** Query value used in the last extraction, for change detection. */
  private lastQuery = '';
  /** Cooldown counter: suppresses extraction for N COLLECT passes after firing. */
  private cooldown = 0;

  // ── State lifecycle ───────────────────────────────────────────────────

  /**
   * Reset the throttle state to a fresh-turn baseline. Called by the state
   * machine at every turn boundary (PROMPT/AWAIT from non-SLASH), mirroring
   * the old TurnVars re-initialization of `lastSkillY=''` + `cooldown=0`.
   */
  reset(): void {
    this.lastQuery = '';
    this.cooldown = 0;
  }

  /**
   * Decrement the cooldown counter by one (floored at 0). Called at the top
   * of each COLLECT pass so the cooldown naturally expires over N passes.
   */
  decrementCooldown(): void {
    if (this.cooldown > 0) this.cooldown--;
  }

  /**
   * Mark a query value as "seen" so it does not re-trigger extraction on
   * subsequent passes. Called on a success/skipped extraction outcome.
   */
  markQuerySeen(query: string): void {
    this.lastQuery = query;
  }

  /**
   * Arm the 3-pass cooldown. Called on a success/skipped extraction outcome
   * (the extraction ran, so suppress re-triggering for 3 passes).
   */
  armCooldown(): void {
    this.cooldown = 3;
  }

  /**
   * Clear the throttle state back to eligible (lastQuery='', cooldown=0).
   * Called on the Branch B fail-fast path (empty freeformQuery): the
   * extraction's success-path marking + cooldown-arming are undone so the
   * next pass re-attempts extraction. Mirrors the `failed` path: both leave
   * the query eligible and the cooldown at 0.
   */
  clearThrottle(): void {
    this.lastQuery = '';
    this.cooldown = 0;
  }

  // ── Read-only state queries ───────────────────────────────────────────

  /** Current query dedup cursor value (test-facing). */
  getLastQuery(): string {
    return this.lastQuery;
  }

  /** Current cooldown counter value (test-facing). */
  getCooldown(): number {
    return this.cooldown;
  }

  /**
   * Whether the query source changed this pass (non-null AND differs from
   * the last seen query). This is the extraction trigger condition.
   */
  queryChanged(query: string | null): boolean {
    return query !== null && query !== this.lastQuery;
  }

  /** Whether the cooldown is currently suppressing extraction. */
  cooldownActive(): boolean {
    return this.cooldown !== 0;
  }

  // ── Composite + gate logic ────────────────────────────────────────────

  /**
   * Compute the query source for a COLLECT pass. The steering note takes
   * precedence over lastUserQuery (freshest mid-task direction). Returns
   * null when neither is present.
   */
  computeQuerySource(steerNote: string | null, lastUserQuery: string): string | null {
    return steerNote ?? (lastUserQuery || null);
  }

  /**
   * Build the composite text from the three sources:
   *   brief = agent's self-reported focus (turn.lastBriefMessage)
   *   query = the trigger source (steering note ?? lastUserQuery)
   *   hint  = hint round focus_on (turn.lastHintFocus)
   * Empty sources are omitted; the remainder is joined with newlines.
   */
  buildCompositeText(brief: string, query: string | null, hint: string): string {
    const parts: string[] = [];
    if (brief) parts.push(brief);
    if (query) parts.push(query);
    if (hint) parts.push(hint);
    return parts.join('\n');
  }

  /**
   * Whether extraction should fire this pass. Requires a changed query, an
   * inactive cooldown, and a composite long enough to be meaningful (>= 4
   * chars after trim).
   */
  shouldExtract(queryChanged: boolean, cooldown: number, compositeText: string): boolean {
    return queryChanged && cooldown === 0 && compositeText.trim().length >= 4;
  }

  // ── Keyword extraction (LLM tool-calling) ─────────────────────────────

  /**
   * Extract English keywords from a user query using LLM tool-calling.
   *
   * The LLM is forced to use the extract_keywords tool (tool_choice:
   * 'required'), guaranteeing structured JSON output without fragile text
   * parsing. The system message carries the stable extraction-workflow
   * instructions AND the available skill-keyword list (so the LLM selects
   * relevant keywords FROM the actual available list). The user message
   * carries the X+Y+Z composite text composed by runKeywordExtraction.
   *
   * Returns a {@link KeywordExtractionResult} so the caller can distinguish a
   * completed extraction (`success`, keywords possibly empty) from a
   * trivially-skipped input (`skipped`) and a failed/aborted call (`failed`).
   * Only `success` and `skipped` allow the caller to advance its
   * throttle/dedup state; `failed` must leave the caller's state untouched
   * so the Y source stays eligible for a retry.
   *
   * Folded from the former standalone `src/loop/keyword-extractor.ts`; now a
   * private method so SkillSuggester owns the full discovery pipeline.
   *
   * @param query - The X+Y+Z composite text (in any language) to extract from
   * @param availableKeywords - The list of available skill keywords (from
   *        loader.getSkillKeywords()), shown to the LLM so it can select from
   *        the actual available list; may be empty when no skills are loaded
   * @param signal - Optional AbortSignal for ESC interruption
   * @returns A {@link KeywordExtractionResult} describing the outcome.
   */
  private async extractKeywords(
    query: string,
    availableKeywords: string[],
    signal?: AbortSignal,
  ): Promise<KeywordExtractionResult> {
    const trimmed = query.trim();

    // Skip extraction for very short or trivial queries. This is a deliberate
    // no-op (not a failure): the caller marks the Y source as seen so a
    // trivial "hello" doesn't re-trigger every pass, but a subsequent
    // meaningful query (which differs in content) still triggers normally.
    if (trimmed.length < 4) return { status: 'skipped' };
    if (TRIVIAL_QUERY_PATTERN.test(trimmed)) return { status: 'skipped' };

    try {
      startSpinner('Parsing');

      const response = await retryChat(
        {
          model: MODEL,
          messages: [
            {
              role: 'system',
              content: `You are a keyword extraction assistant for a skill-discovery system.
Select 2-5 English keywords relevant to the user's conversation context for skill matching.
Choose from the available skill keywords list below when possible; you may also
include multi-word concepts (e.g. "best practice") not in the list if highly relevant.
Focus on actionable concepts, tools, or objects.
Any of the following keywords must be included if the query implies: "plan, learning, collaboration, recovery".
Also provide a concise free-form search query (2-5 words) that captures the user's
core intent, suitable for semantic search against a skill database. The free-form
query should be a natural phrase (e.g. "code review automation", "pdf text extraction")
distilled from the conversation context — NOT a comma-separated keyword list.
Return ONLY via the extract_keywords tool.

Available skill keywords: ${availableKeywords.join(', ')}`,
            },
            {
              role: 'user',
              content: `Conversation context:\n${trimmed}`,
            },
          ],
          tools: [EXTRACT_KEYWORDS_TOOL],
          tool_choice: 'required' as const,
        },
        { signal, noSpinner: true, maxRetries: 1 },
      );

      stopSpinner();

      const toolCalls = response.message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // The LLM responded but produced no tool call. The operation
        // completed (no throw), so this is a successful extraction with zero
        // keywords, not a failure — the caller may advance its throttle.
        return { status: 'success', keywords: [], freeformQuery: '' };
      }

      const args = toolCalls[0].function.arguments;
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      const keywords: string[] = parsed.keywords || [];

      // Filter out empty strings and trim whitespace.
      const cleaned = keywords
        .map((kw: unknown) => String(kw).trim().toLowerCase())
        .filter((kw: string) => kw.length > 0);

      // The free-form query is a natural phrase for semantic search. It is
      // NOT lowercased (proper nouns / tool names matter for embedding match)
      // but is trimmed. An empty/whitespace value is preserved as '' so the
      // caller can detect "invalid freeformQuery" and fail fast (oversize
      // branch) rather than silently degrading.
      const freeformQuery: string =
        typeof parsed.freeform_query === 'string' ? parsed.freeform_query.trim() : '';

      return { status: 'success', keywords: cleaned, freeformQuery };
    } catch {
      stopSpinner();
      // A throw here covers both transient network errors and ESC aborts
      // (retryChat rejects with 'Request aborted' on signal abort). Either
      // way the operation did NOT complete, so the caller must NOT advance
      // its throttle/dedup state — Y stays eligible for a retry.
      return { status: 'failed' };
    }
  }

  // ── Match gate + HINT injection ───────────────────────────────────────

  /**
   * Determine whether a skill is new, previously suggested, or already
   * loaded by scanning the triologue conversation history.
   *
   * Detection logic:
   *  - 'loaded': skill name appears in a skill_load tool call (arguments or
   *    result).
   *  - 'suggested': skill name/description appears in a HINT note or a
   *    skill_search result.
   *  - 'new': neither name nor description appears anywhere in the triologue.
   *
   * Iterates over all messages (M) for each skill. In practice N=1-5 and
   * M=20-100, so the cost is negligible compared to the LLM call that
   * follows. Early returns on the first 'loaded'/'suggested' match.
   *
   * Folded from the former standalone `src/utils/skill-dedup.ts`; now a
   * private method so SkillSuggester owns the full discovery pipeline.
   */
  private getSkillTriologueStatus(triologue: Triologue, skill: Skill): SkillTriologueStatus {
    const messages = triologue.getMessagesRaw();
    const nameLower = skill.name.toLowerCase();
    const descLower = skill.description.toLowerCase();

    for (const msg of messages) {
      const content = msg.content || '';
      const contentLower = content.toLowerCase();

      // === Check for 'loaded' ===

      // 1a. skill_load tool result (role='tool', tool_name='skill_load')
      if (isToolResponse(msg, 'skill_load') && contentLower.includes(nameLower)) {
        return 'loaded';
      }

      // 1b. skill_load in assistant tool_calls
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function.name === 'skill_load') {
            const argsStr = JSON.stringify(tc.function.arguments).toLowerCase();
            if (argsStr.includes(nameLower)) {
              return 'loaded';
            }
          }
        }
      }

      // === Check for 'suggested' ===

      // 2a. skill_search tool result — contains skill name/description
      if (isToolResponse(msg, 'skill_search') && contentLower.includes(nameLower)) {
        return 'suggested';
      }

      // 2b. [HINT] note mentioning the skill name
      if (isHintNote(content) && contentLower.includes(nameLower)) {
        return 'suggested';
      }

      // 2c. [HINT] note mentioning the skill description
      if (isHintNote(content) && descLower && contentLower.includes(descLower)) {
        return 'suggested';
      }

      // 2d. skill_search result content (detected by result pattern) mentioning the skill name
      if (isSkillSearchResult(content) && contentLower.includes(nameLower)) {
        return 'suggested';
      }
    }

    return 'new';
  }

  /**
   * Baseline skill-match predicate for one skill.
   *
   * `skillKeywords` (length X) and `keywords` (the probe, length Y) are both
   * lowercased by the caller/extractor; matching is exact-token, not
   * substring. `W` is the universe size (loader.getSkillKeywords().length),
   * computed once per pass by the caller — NOT per skill.
   *
   * Edge cases:
   *  - X = 0 (keywordless skill) → Z = 0 → never matches (defers to Branch B).
   *  - W = 0 (no universe / no skills carry keywords) → falls back to the
   *    `Z > 0` floor so a single exact-token hit still surfaces the skill.
   *  - Y clamped to [2, 5]: a 1-keyword query (Y - 1 = 0) would demand
   *    nothing, so the floor Y = 2 keeps the bar meaningful; huge Y is
   *    capped so the Y - 1 term doesn't dominate small-W universes.
   *
   * Pure (no instance state) but lives on the class so SkillSuggester owns
   * the whole discovery pipeline as one cohesive unit. Accessed in tests via
   * bracket call on the singleton (`(skillSuggester as any).matchesBaselineGate`).
   */
  private matchesBaselineGate(
    skillKeywords: string[],
    keywords: string[],
    W: number,
  ): boolean {
    const kwSet = new Set(skillKeywords.map(k => k.toLowerCase()));
    const Z = keywords.filter(kw => kwSet.has(kw)).length;
    if (Z === 0) return false; // floor: rejects keywordless / zero-overlap skills

    const X = skillKeywords.length;
    if (X === 0) return false; // defensive (Z > 0 above already covers it)
    if (W <= 0) return true;   // no universe → no null model → Z > 0 floor

    const Y = Math.min(Math.max(keywords.length, SKILL_QUERY_KW_MIN), SKILL_QUERY_KW_MAX);
    const expected = (X / W) * Y;     // E[Z | null]
    const baseline = Math.min(Y - 1, expected);
    return Z >= baseline;
  }

  /**
   * Partition a list of skills into new/suggested/loaded (via
   * getSkillTriologueStatus) and inject a HINT note surfacing them.
   *
   * Shared by both branches of runKeywordExtraction step 6:
   *  - Branch A (small match): the full keyword-matched list.
   *  - Branch B (oversize): the keyword∩semantic intersection.
   *
   * New skills are listed with their description; suggested/loaded skills
   * are listed by name only. The note always ends with the skill_search
   * pointer and the silent-nudge discipline reminder.
   */
  private injectSkillHint(triologue: Triologue, skills: Skill[]): void {
    if (skills.length === 0) return;

    const newSkills: string[] = [];
    const suggestedSkills: string[] = [];
    const loadedSkills: string[] = [];

    for (const skill of skills) {
      const status = this.getSkillTriologueStatus(triologue, skill);
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
    // This is a silent nudge: either load a skill that genuinely helps the
    // current task (via skill_load), or ignore it and keep working. Do NOT
    // write a prose reply explaining why you are/aren't loading a skill —
    // that clutters the conversation and re-triggers the same nudge.
    lines.push('Discipline: this is a silent nudge. If a skill helps the current task, load it with skill_load; otherwise stay silent and continue. Do NOT narrate your decision.');

    triologue.note('HINT', lines.join('\n'));
  }

  /**
   * Strip the "<scope>:" prefix from a wiki skill title to get the bare
   * skill name. Wiki titles use the format "<scope>:<skill-name>" (e.g.
   * "project:code-review"); a title without a colon is returned as-is.
   * Mirrors the logic in skill_search.ts.
   */
  private baseSkillNameFromWikiTitle(title: string): string {
    return title.includes(':') ? title.split(':').slice(1).join(':') : title;
  }

  // ── Main entry ────────────────────────────────────────────────────────

  /**
   * Step 6: composite keyword extraction for proactive skill discovery.
   *
   * Composes a composite text from three sources:
   *   brief = turn.lastBriefMessage  (agent's self-reported focus, set in TOOL)
   *   query = firstSteerNote ?? turn.lastUserQuery  (the trigger source)
   *   hint  = turn.lastHintFocus  (hint round focus_on, captured in step 3)
   * Extraction is TRIGGERED only by a change in query. Brief and hint enrich
   * the composite but never trigger. A 3-pass cooldown suppresses
   * re-triggering from consecutive user messages.
   *
   * @param firstSteerNote - the freshest steering note drained this pass
   *        (from collectMailsAndInput), or null.
   *
   * Side effects on this singleton: `lastQuery` (query dedup cursor) and
   * `cooldown` — armed ONLY on a success/skipped outcome; a `failed`
   * outcome (ESC / transient) leaves query eligible for retry.
   */
  async runKeywordExtraction(env: MachineEnv, turn: TurnVars, firstSteerNote: string | null): Promise<void> {
    const { triologue, ctx } = env;

    this.decrementCooldown();

    const querySource = this.computeQuerySource(firstSteerNote, turn.lastUserQuery || '');
    const changed = this.queryChanged(querySource);

    // Build the composite text (brief + query + hint). Query is the trigger;
    // brief and hint enrich.
    const compositeText = this.buildCompositeText(
      turn.lastBriefMessage,
      querySource,
      turn.lastHintFocus,
    );

    if (!changed || this.cooldownActive() || compositeText.trim().length < 4) {
      return;
    }

    // Extract English keywords from the composite via LLM (ESC-safe).
    // extractKeywords returns a discriminated union so we can distinguish a
    // completed extraction (success/skipped) from a failed/aborted one:
    //   - success: the LLM ran; keywords may be empty. Arm the cooldown and
    //     mark query as seen.
    //   - skipped: the composite was trivial (greeting/ack). Mark query as
    //     seen so a trivial "hello" doesn't re-trigger every pass — but a
    //     subsequent meaningful query (different query content) still triggers.
    //   - failed: the call threw (transient network error or ESC abort).
    //     Do NOT arm the cooldown or mark query as seen: query stays
    //     eligible for a retry on a subsequent pass.
    // The escAware cleanup returns { status: 'failed' } on ESC, so the
    // abort path is handled by the same `failed` branch (preserving the
    // documented "ESC does not consume the discovery opportunity" retry
    // behavior that the old `[]`-returning API silently broke).
    const result = await ctx.core.escAware(
      async (ac) => this.extractKeywords(compositeText, loader.getSkillKeywords(), ac.signal),
      () => ({ status: 'failed' } as const),
    );

    if (result.status === 'failed') {
      // Query stays eligible for retry — do not touch lastQuery or cooldown.
      // (The cooldown was already decremented at the top of step 6, which is
      // fine: a failed attempt does not extend suppression.)
      return;
    }

    // success or skipped: mark the query source as "seen" so it doesn't
    // re-trigger. When a steering note was the trigger, ALSO mark the
    // fallback lastUserQuery as seen so it doesn't spuriously re-trigger
    // after the steering note is consumed on subsequent passes
    // (Review BUG 1 — spurious double-trigger).
    this.markQuerySeen(querySource!);
    if (firstSteerNote && turn.lastUserQuery) {
      this.markQuerySeen(turn.lastUserQuery);
    }
    this.armCooldown();

    // Only a successful extraction with real keywords can surface skills.
    // A `skipped` (trivial) outcome has no keywords, and a `success` with
    // an empty keywords array means the LLM found nothing relevant — both
    // fall through here without injecting a HINT note.
    const keywords = result.status === 'success' ? result.keywords : [];
    const freeformQuery = result.status === 'success' ? result.freeformQuery : '';
    if (keywords.length === 0) return;

    const allSkills = ctx.skill.listSkills();
    // Baseline skill-match gate (private method): exact-token intersection +
    //   baseline = min(Y - 1, (X / W) * Y)
    // W (universe size) is computed ONCE per pass, not per skill.
    const W = loader.getSkillKeywords().length;
    const matched = allSkills.filter(s => this.matchesBaselineGate(s.keywords, keywords, W));

    if (matched.length === 0) return;

    // ── Branching skill suggestion ──────────────────────────────────────
    // Branch A (small match): the keyword-matched list is small enough to
    //   surface inline with descriptions — inject it directly (the original
    //   behavior). No semantic-search refinement needed.
    // Branch B (oversize): too many keyword matches to dump inline (token
    //   bloat). Refine via a semantic-search intersection: call ctx.wiki.get
    //   with the free-form query, then keep ONLY the skills that BOTH
    //   keyword-matched AND appear in the semantic results. If the
    //   freeformQuery is invalid (empty), FAIL FAST — leave query eligible
    //   for a retry (do NOT mark lastQuery / arm cooldown) so the next pass
    //   re-attempts extraction. If the intersection is empty, no hint is
    //   injected (the signal is too weak to suggest anything).
    if (matched.length < SKILL_OVERSIZE_THRESHOLD) {
      // Branch A: small match — inject the full keyword-matched list.
      this.injectSkillHint(triologue, matched);
      return;
    }

    // Branch B: oversize — refine via semantic intersection.
    // The freeformQuery MUST be valid to start the matching; otherwise fail
    // fast and leave query eligible for retry on the next pass. Undo the
    // query-marking + cooldown-arming performed above so the next pass
    // re-attempts extraction (the LLM gets another chance to produce a
    // valid freeformQuery). This mirrors the `failed` path: both leave
    // lastQuery untouched-at-eligible and cooldown at 0.
    if (!freeformQuery || !freeformQuery.trim()) {
      this.clearThrottle();
      return;
    }

    // Semantic search via wiki (embedding-based). Graceful failure: if the
    // wiki call throws (no embedding model, transient error), no hint is
    // injected — the keyword match alone is too noisy at this scale to be
    // useful, so we stay silent rather than bloat the conversation.
    let semResults: Awaited<ReturnType<typeof ctx.wiki.get>>;
    try {
      semResults = await ctx.wiki.get(freeformQuery, {
        domain: 'skills',
        topK: SKILL_SEMANTIC_TOPK,
        threshold: getSkillMatchThreshold(),
      });
    } catch {
      // Semantic search unavailable — no hint (signal too weak to refine).
      return;
    }

    // Build a case-insensitive set of semantic skill names (strip the
    // "<scope>:" prefix from wiki titles to get bare skill names).
    const semanticNames = new Set<string>();
    for (const r of semResults) {
      const baseName = this.baseSkillNameFromWikiTitle(r.document.title).toLowerCase();
      if (baseName) semanticNames.add(baseName);
    }

    // Intersection: skills that BOTH keyword-matched AND are semantically
    // relevant. Order preserved from `matched` (deterministic).
    const intersection = matched.filter(s => semanticNames.has(s.name.toLowerCase()));

    // Empty intersection → no hint. Neither keyword matching nor semantic
    // search agree on any skill; the signal is too weak to suggest anything.
    if (intersection.length === 0) return;

    this.injectSkillHint(triologue, intersection);
  }
}

/**
 * Process-wide singleton. Owns the discovery throttle state (query dedup
 * cursor + cooldown); the state machine calls `reset()` at each turn
 * boundary. Single source of truth for skill-discovery state.
 */
export const skillSuggester = new SkillSuggester();

/**
 * Begin a fresh session after an in-process conversation clear (/clear or
 * double-Ctrl+L). This is NOT a normal turn boundary: those clears run with
 * NO state transition (double-Ctrl+L is a raw callback; /clear returns
 * PROMPT from SLASH), so the state-machine turn-boundary guard — which both
 * (a) resets the suggester and (b) rebuilds TurnVars fresh — never runs.
 *
 * Resetting the suggester ALONE is a half-reset that leaves a regression:
 * `turn.lastUserQuery` (and the brief/hint sources) still hold the OLD turn's
 * values, while `SkillSuggester.lastQuery` is now ''. On the next COLLECT the
 * query source is the stale `lastUserQuery`, which differs from the empty
 * cursor, so `queryChanged` is true and extraction re-fires on context that
 * belongs to a conversation the user just cleared (the triologue itself is
 * empty). See PR #22 review (P1).
 *
 * The fix: treat a clear as a real turn boundary by invalidating the stale
 * turn fields as well as resetting the suggester, so the next COLLECT sees
 * an empty query source and skips extraction until a genuine new query
 * arrives (a fresh prompt resets them anyway via `turn.lastUserQuery = query`).
 *
 * The other TurnVars fields (nudges, todo cursor) are harmless to carry over —
 * a clear empties todos/issues, so the todo nudge simply re-arms on its own
 * cadence. Only the three "composite source" fields drive skill discovery and
 * must match the cleared conversation.
 *
 * @param turn - the live TurnVars instance to invalidate (same object the
 *        state machine holds, so the mutation is visible to the next COLLECT).
 */
export function beginFreshSession(turn: Pick<import('../state-machine.js').TurnVars, 'lastUserQuery' | 'lastBriefMessage' | 'lastHintFocus'>): void {
  skillSuggester.reset();
  turn.lastUserQuery = '';
  turn.lastBriefMessage = '';
  turn.lastHintFocus = '';
}