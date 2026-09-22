/**
 * keyword-extractor.ts - Shared LLM keyword extraction for skill discovery.
 *
 * This is the SINGLE shared keyword-extraction primitive consumed by BOTH
 * consumers of the skill-matching pipeline:
 *   - `src/tools/skill_search.ts`         (the skill_search tool: arg1 →
 *                                          extractKeywords → positional-points
 *                                          match against all loaded skills)
 *   - `src/loop/states/collect-skill.ts`  (the proactive SkillSuggester:
 *                                          composite brief+query+hint →
 *                                          extractKeywords → match + branch)
 *
 * It is a genuine un-folding: this code previously lived as a standalone
 * module here (`src/loop/keyword-extractor.ts`) before it was folded into
 * SkillSuggester as a private method (the collect-skill.ts header records
 * "Previously a standalone module (src/loop/keyword-extractor.ts); folded
 * into SkillSuggester as a private method"). The consolidation restores it
 * as the shared module so both consumers use the SAME extraction prompt,
 * tool, and result contract — instead of each owning a private copy that
 * could drift.
 *
 * Import direction is safe and precedent-backed:
 *   - `src/tools/*` already imports from `../loop/` (bg_await, bash,
 *     hand_over, git_commit import `../loop/agent-io.js`), and
 *   - `src/loop/*` never imports `src/tools/*` (no loop→tools edge exists),
 *   so tools→loop is a proven direction with zero import-cycle risk.
 *
 * EXTRACTION CONTRACT — the prompt enforces SIGNIFICANCE ORDERING.
 * The downstream positional-points scoring assigns weight [10,7,5,3,2] to
 * the 1st..5th extracted keyword respectively, so the LLM MUST emit keywords
 * in DESCENDING order of importance (the most discriminative keyword first).
 * This is the single behavior change vs the old folded copy, which emitted
 * an unordered list. The discriminated-union result shape and the
 * success/skipped/failed semantics are UNCHANGED so the SkillSuggester's
 * throttle (failed → retry-eligible; success/skipped → mark-seen + arm) is
 * preserved exactly.
 */

import type { Tool } from '../types.js';
import { retryChat, MODEL, stopSpinner } from '../engine/chat-provider.js';
import { startSpinner } from '../engine/chat-helpers.js';

/**
 * Outcome of a keyword extraction attempt.
 *
 * Three semantically distinct cases the consumer MUST distinguish:
 *  - `success` — the LLM call ran to completion. `keywords` may be empty
 *    (the model found nothing relevant), but the operation itself succeeded,
 *    so the caller MAY advance its throttle/dedup state. `keywords` is
 *    SIGNIFICANCE-ORDERED (most important first), lowercased, and deduplicated
 *    (first occurrence kept); beyond the first 5, downstream positional
 *    scoring ignores them.
 *  - `skipped` — the input was trivial (too short, or a greeting/ack). No LLM
 *    call was made. The caller SHOULD mark the Y source as seen (so a trivial
 *    "hello" doesn't re-trigger every pass) but this is NOT a failure.
 *  - `failed` — the LLM call threw (transient network error, or ESC abort).
 *    The caller MUST NOT advance throttle/dedup state: Y stays eligible for
 *    a retry on a subsequent pass.
 *
 * SkillSuggester maps `failed` → retry-eligible and `success`/`skipped` →
 * mark-seen-and-arm. skill_search only consumes `success` (uses keywords)
 * and `failed`/`skipped` (no keywords → empty result); it must NOT drop a
 * status, because SkillSuggester depends on all three.
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
    description:
      'Extract English keywords (SIGNIFICANCE-ORDERED, most important first) and a free-form search query from the conversation context for skill matching',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Extracted English keywords (2-5 words). ORDER MATTERS: list them in DESCENDING order of importance — the most discriminative keyword FIRST, the least important LAST. Downstream scoring weights the 1st keyword highest.',
        },
        freeform_query: {
          type: 'string',
          description:
            "A concise free-form search query (2-5 words) capturing the user's core intent for semantic skill search",
        },
      },
      required: ['keywords', 'freeform_query'],
    },
  },
};

/** Trivial-query patterns skipped without an LLM call (greetings / acks). */
const TRIVIAL_QUERY_PATTERN =
  /^(hi|hello|hey|ok|okay|yes|no|y|n|bye|goodbye|thanks|thank you|继续|好的|嗯|你好|谢谢|再见)$/i;

/**
 * Extract significance-ordered English keywords from arbitrary-language text
 * using LLM tool-calling.
 *
 * The LLM is forced to use the `extract_keywords` tool (`tool_choice:
 * 'required'`), guaranteeing structured JSON output without fragile text
 * parsing. The system message carries the stable extraction-workflow
 * instructions — including the SIGNIFICANCE-ORDERING requirement (the 1st
 * keyword is the most important, because downstream positional scoring
 * assigns weights [10,7,5,3,2] to the 1st..5th keyword) — AND the available
 * skill-keyword list (so the LLM selects relevant keywords FROM the actual
 * available list). The user message carries the conversation context text.
 *
 * Returns a {@link KeywordExtractionResult} so the caller can distinguish a
 * completed extraction (`success`, keywords possibly empty, but
 * significance-ordered) from a trivially-skipped input (`skipped`) and a
 * failed/aborted call (`failed`). Only `success` and `skipped` allow the
 * caller to advance its throttle/dedup state; `failed` must leave the
 * caller's state untouched so the Y source stays eligible for a retry.
 *
 * @param query - The conversation context text (in any language) to extract
 *        from. For SkillSuggester this is the brief+query+hint composite;
 *        for skill_search this is the tool's `search` arg.
 * @param availableKeywords - The list of available skill keywords (from
 *        `loader.getSkillKeywords()`), shown to the LLM so it can select from
 *        the actual available list; may be empty when no skills are loaded.
 * @param signal - Optional AbortSignal for ESC interruption. SkillSuggester
 *        passes `escAware`'s signal; skill_search omits it (no ESC context).
 * @returns A {@link KeywordExtractionResult} describing the outcome.
 */
export async function extractKeywords(
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

ORDERING IS CRITICAL: emit the keywords in DESCENDING order of importance — the
MOST discriminative / central keyword FIRST, the LEAST important LAST. The
downstream skill-matching scorer assigns positional weights [10, 7, 5, 3, 2] to
the 1st, 2nd, 3rd, 4th, and 5th keyword respectively, so putting the strongest
keyword first maximizes the match score for the right skill. Keywords beyond the
5th are ignored by the scorer.
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

    // Filter out empty strings and trim whitespace. Lowercasing matches the
    // exact-token membership test downstream (case-insensitive). The order
    // emitted by the LLM is PRESERVED — it is the significance order the
    // positional scorer consumes. Duplicates are dropped keeping first
    // occurrence, so a repeated query keyword can never earn two positional
    // weights (e.g. ["code","code"] → 10, not 10+7); first-occurrence order
    // preserves the LLM's significance ranking.
    const seen = new Set<string>();
    const cleaned = keywords
      .map((kw: unknown) => String(kw).trim().toLowerCase())
      .filter((kw: string) => kw.length > 0)
      .filter((kw: string) => {
        if (seen.has(kw)) return false;
        seen.add(kw);
        return true;
      });

    // The free-form query is a natural phrase for semantic search. It is
    // NOT lowercased (proper nouns / tool names matter for embedding match)
    // but is trimmed. An empty/whitespace value is preserved as '' so the
    // caller can detect "invalid freeformQuery" and fail fast (SkillSuggester
    // oversize branch) rather than silently degrading.
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