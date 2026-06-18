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

/** Tool definition for structured keyword extraction */
const EXTRACT_KEYWORDS_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'extract_keywords',
    description: 'Extract English keywords from the user query for skill matching',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extracted English keywords (2-5 words) describing the user intent',
        },
      },
      required: ['keywords'],
    },
  },
};

/**
 * Extract English keywords from a user query using LLM tool-calling.
 *
 * The LLM is forced to use the extract_keywords tool (tool_choice: 'required'),
 * guaranteeing structured JSON output without fragile text parsing.
 *
 * @param query - User query in any language
 * @param signal - Optional AbortSignal for ESC interruption
 * @returns Array of extracted English keywords, or empty array on failure
 */
export async function extractKeywords(
  query: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const trimmed = query.trim();

  // Skip extraction for very short or trivial queries
  if (trimmed.length < 4) return [];

  // Skip extraction for common greetings and simple acknowledgments
  const trivialPatterns = /^(hi|hello|hey|ok|okay|yes|no|y|n|bye|goodbye|thanks|thank you|继续|好的|嗯|你好|谢谢|再见|hi|hello|hey)$/i;
  if (trivialPatterns.test(trimmed)) return [];

  try {
    startSpinner('Parsing');

    const response = await retryChat(
      {
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: `Extract 2-5 English keywords from this query for skill matching.
Focus on actionable concepts, tools, or objects.
Keywords can be multi-word like "best practice".
Any of the following keywords must be included if the query implies: "plan, learning, collaboration, recovery".
Return ONLY via the extract_keywords tool.

Query: ${trimmed}`,
          },
        ],
        tools: [EXTRACT_KEYWORDS_TOOL],
        tool_choice: 'required' as const,
      },
      { signal, noSpinner: true, maxRetries: 1 },
    );

    stopSpinner();

    const toolCalls = response.message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) return [];

    const args = toolCalls[0].function.arguments;
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    const keywords: string[] = parsed.keywords || [];

    // Filter out empty strings and trim whitespace
    return keywords
      .map((kw: unknown) => String(kw).trim().toLowerCase())
      .filter((kw: string) => kw.length > 0);
  } catch {
    stopSpinner();
    // Silent degradation — empty result means "no keywords extracted"
    return [];
  }
}
