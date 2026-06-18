/**
 * skill-dedup.ts - Check if a skill's description is already present in the triologue.
 *
 * Returns one of three statuses:
 * - 'new': skill name and description have never appeared in the conversation
 * - 'suggested': skill name/description appears in a HINT note or skill_search result
 * - 'loaded': skill name appears in a skill_load tool call (arguments or result)
 *
 * Detection strategy:
 * - 'loaded': scan for skill_load in assistant tool_calls (arguments) or tool results (content)
 * - 'suggested': scan for [HINT] notes mentioning the skill, or skill_search results
 * - 'new': neither name nor description appears anywhere in the triologue
 *
 * == Performance Note ==
 *
 * This function iterates over all messages (M) for each skill (N), giving O(N×M).
 * In practice N=1-5 and M=20-100, so the cost is negligible compared to the LLM call
 * that follows. A "compile to long text" approach (O(M+N)) was considered but rejected:
 *
 * 1. Structural information is lost — we need to distinguish skill_load results from
 *    skill_search results from [HINT] notes from random file content that happens to
 *    mention a skill name. Embedding structural markers adds complexity and parsing
 *    overhead that outweighs any gain at this scale.
 * 2. Compilation itself costs O(M) — you've already paid the iteration cost before
 *    searching begins.
 * 3. Early returns are lost — the current approach can return 'loaded' on the first
 *    matching skill_load message without scanning the rest. A compiled text forces a
 *    full scan every time.
 * 4. The real bottleneck is the LLM call (seconds), not this string matching (microseconds).
 *
 * A Set-based pre-scan (build Set<loaded> and Set<suggested> once per turn, then O(1)
 * lookups) would be genuinely faster, but the checkpoint/recap logic makes caching
 * impractical: recapMessages() mutates the triologue in-place by truncating message
 * spans and replacing them with summaries, invalidating any pre-built index. The
 * triologue content changes shape every time a checkpoint is closed, so a cached
 * "which skills appear where" would need rebuilding on every turn anyway — defeating
 * the purpose of caching.
 *
 * The current per-message iteration is the simplest correct approach at this scale.
 */

import type { Skill, Message } from '../types.js';
import type { Triologue } from '../loop/triologue.js';

export type SkillTriologueStatus = 'new' | 'suggested' | 'loaded';

/**
 * Type guard: check if a message is a tool response for a specific tool name.
 * Message extends OllamaMessage which doesn't have tool_name in its type definition,
 * but the Ollama API does return it on tool role messages.
 */
function isToolResponse(msg: Message, toolName: string): boolean {
  return msg.role === 'tool' && (msg as { tool_name?: string }).tool_name === toolName;
}

/**
 * Check if a message content contains a [HINT] note.
 * HINT notes are injected by triologue.note('HINT', ...) which formats as "[HINT] ...".
 */
function isHintNote(content: string): boolean {
  return /^\[hint\]/i.test(content.trim());
}

/**
 * Check if a message content contains a skill_search result.
 * skill_search tool returns results with skill names and descriptions.
 */
function isSkillSearchResult(content: string): boolean {
  return /Found \d+ skill\(s\) matching/i.test(content);
}

/**
 * Determine whether a skill is new, previously suggested, or already loaded
 * by scanning the triologue conversation history.
 *
 * Detection logic:
 * - 'loaded': skill name appears in a skill_load tool call (arguments or result)
 * - 'suggested': skill name/description appears in a HINT note or skill_search result
 * - 'new': neither name nor description appears anywhere in the triologue
 */
export function getSkillTriologueStatus(
  triologue: Triologue,
  skill: Skill,
): SkillTriologueStatus {
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

    // 2a. skill_search tool result — contains skill name/description in search results
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
