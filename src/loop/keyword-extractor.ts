/**
 * keyword-extractor.ts - LLM-based keyword extraction from arbitrary language
 *
 * Uses LLM tool-calling to extract standardized English keywords from user
 * queries in any language (Chinese, Japanese, English, mixed, etc.).
 * The output keywords are used to match against skill names/keywords
 * in the COLLECT stage for proactive skill discovery.
 *
 * Uses tool_choice: 'required' to ensure structured JSON output via
 * the extract_keywords tool, avoiding fragile text parsing.
 */

import { retryChat, MODEL, stopSpinner } from '../engine/chat-provider.js';
import { startSpinner } from '../engine/chat-helpers.js';
import type { Tool } from '../types.js';

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
 * This distinction matters because the COLLECT state mutates a cooldown and a
 * dedup cursor (`lastSkillY`) based on the extraction result. Treating a
 * `failed` or `skipped` outcome the same as `success` would either suppress a
 * retry after a transient failure (failed) or — in the old code — consume the
 * discovery opportunity for a trivial query (the catch-all `[]`).
 */
export type KeywordExtractionResult =
  | { status: 'success'; keywords: string[]; freeformQuery: string }
  | { status: 'skipped' }
  | { status: 'failed' };

/** Tool definition for structured keyword extraction */
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

/**
 * Extract English keywords from a user query using LLM tool-calling.
 *
 * The LLM is forced to use the extract_keywords tool (tool_choice: 'required'),
 * guaranteeing structured JSON output without fragile text parsing.
 *
 * The prompt is split into a system + user message pair. The system message
 * carries the stable extraction-workflow instructions AND the available
 * skill-keyword list (so the LLM selects relevant keywords FROM the actual
 * available list, replacing the separate buildSkillKeywordsMessages
 * project-context populator that used to inject the full keyword list into
 * the system prompt). The user message carries the X+Y+Z composite text
 * (the variable per-call input composed by runKeywordExtraction in COLLECT).
 *
 * Returns a discriminated union so the caller can distinguish a completed
 * extraction (`success`, keywords possibly empty) from a trivially-skipped
 * input (`skipped`) and a failed/aborted call (`failed`). Only `success` and
 * `skipped` allow the caller to advance its throttle/dedup state; `failed`
 * must leave the caller's state untouched so the Y source stays eligible for
 * a retry (e.g. after a transient network error or an ESC abort).
 *
 * @param query - The X+Y+Z composite text (in any language) to extract from
 * @param availableKeywords - The list of available skill keywords (from
 *        loader.getSkillKeywords()), shown to the LLM so it can select from
 *        the actual available list; may be empty when no skills are loaded
 * @param signal - Optional AbortSignal for ESC interruption
 * @returns A {@link KeywordExtractionResult} describing the outcome.
 */
export async function extractKeywords(
  query: string,
  availableKeywords: string[],
  signal?: AbortSignal,
): Promise<KeywordExtractionResult> {
  const trimmed = query.trim();

  // Skip extraction for very short or trivial queries. This is a deliberate
  // no-op (not a failure): the caller marks the Y source as seen so a trivial
  // "hello" doesn't re-trigger every pass, but a subsequent meaningful query
  // (which differs in content) still triggers normally.
  if (trimmed.length < 4) return { status: 'skipped' };

  // Skip extraction for common greetings and simple acknowledgments.
  const trivialPatterns = /^(hi|hello|hey|ok|okay|yes|no|y|n|bye|goodbye|thanks|thank you|继续|好的|嗯|你好|谢谢|再见|hi|hello|hey)$/i;
  if (trivialPatterns.test(trimmed)) return { status: 'skipped' };

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
      // The LLM responded but produced no tool call. The operation completed
      // (no throw), so this is a successful extraction with zero keywords,
      // not a failure — the caller may advance its throttle state.
      return { status: 'success', keywords: [], freeformQuery: '' };
    }

    const args = toolCalls[0].function.arguments;
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    const keywords: string[] = parsed.keywords || [];

    // Filter out empty strings and trim whitespace
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
    // (retryChat rejects with 'Request aborted' on signal abort). Either way
    // the operation did NOT complete, so the caller must NOT advance its
    // throttle/dedup state — Y stays eligible for a retry.
    return { status: 'failed' };
  }
}
