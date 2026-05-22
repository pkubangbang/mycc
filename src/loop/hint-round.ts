/**
 * hint-round.ts - Hint round generation for problem analysis
 *
 * When the agent shows signs of confusion (repeated tool calls, errors,
 * high turn count), this module generates a structured problem analysis
 * via LLM and injects it as a HINT note into the conversation.
 */

import { retryChat, MODEL } from '../engine/chat-provider.js';
import type { Message, WikiModule, NoteCategory } from '../types.js';
import { minifyMessages } from '../utils/llm-chat-minifier.js';
import { agentIO } from './agent-io.js';

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
      description: 'Concrete, actionable next step. If no blockers, suggest continuing current work.',
    },
    focus_on: {
      type: 'string',
      description: 'Key area or priority to focus on.',
    },
    wiki_domain: {
      type: 'string',
      description: 'Domain name from available domains. Leave empty if no wiki search needed.',
    },
    wiki_query: {
      type: 'string',
      description: 'Search query for the wiki. Leave empty if no wiki search needed.',
    },
  },
  required: ['blocker', 'next_step', 'focus_on', 'wiki_domain', 'wiki_query'],
} as const;

const HINT_SYSTEM_PROMPT = `You are a problem-analysis assistant. Your task is to analyze the gap between the user's intent and the agent's current progress, then output a structured JSON analysis.

CRITICAL INSTRUCTIONS:
1. If there are NO REAL blockers preventing progress, set blocker to exactly: "no blockers"
2. Do NOT fabricate blockers. "no blockers" means the agent should simply continue with the current task.
3. Only suggest wiki_domain and wiki_query if there's genuine knowledge gap. Leave empty strings if no wiki search needed.
4. Reply with ONLY a JSON object. No commentary, no markdown fences. The schema is:
${JSON.stringify(HINT_SCHEMA, null, 2)}`;

/** Minimal triologue surface needed by hint round generation */
export interface HintRoundContext {
  /** The raw messages array (no system prompt / project context prepended) */
  getMessagesRaw(): Message[];
  /** Add a system note (e.g. the formatted hint) into the conversation */
  note(category: NoteCategory, message: string): void;
  /** Optional wiki module for domain-aware knowledge suggestions */
  getWiki(): WikiModule | undefined;
}

/** Shape of the parsed hint data from LLM response */
interface HintData {
  blocker: string;
  next_step: string;
  focus_on: string;
  wiki_domain: string;
  wiki_query: string;
}

/**
 * Generate a hint round and inject it into the conversation.
 *
 * Extracts focused context from the triologue's messages, queries the LLM
 * for structured problem analysis, formats it, and injects it via
 * ctx.note('HINT', ...). Supports abort via AbortController for ESC.
 *
 * @param ctx - The triologue (or compatible context) providing messages and note()
 * @param abortController - Abort controller for ESC handling
 * @param confusionScore - Current confusion score
 * @param confusionBreakdown - Human-readable breakdown of confusion factors
 * @param pendingSkills - Skills with 'when' but no compiled condition
 * @returns 'aborted' if ESC was pressed, 'success' if completed
 */
export async function generateHintRound(
  ctx: HintRoundContext,
  abortController: AbortController,
  confusionScore: number,
  confusionBreakdown: string,
  pendingSkills?: string[],
): Promise<'aborted' | 'success'> {
  if (agentIO.isNeglectedMode()) return 'aborted';

  // Build compact conversation context for analysis
  const messages = ctx.getMessagesRaw();

  // Filter out system noise messages that would distract hint analysis
  const filteredMessages = messages.filter(msg => {
    if (msg.role === 'system') return false;
    if (msg.role === 'user' && msg.content) {
      if (/^\[(?:REMINDER|HINT|CONTINUE|FYI|WRAP_UP)\]/.test(msg.content)) return false;
    }
    return true;
  });

  const compactContext = minifyMessages(filteredMessages, { maxContentLength: 300, maxArgsLength: 100, truncateToolOutput: true });

  // Get wiki domains for knowledge search suggestion
  const wiki = ctx.getWiki();
  const domains = wiki ? await wiki.listDomains() : [];
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
    ANALYSIS_INSTRUCTION,
  ].join('\n');

  // Retry loop: parse JSON until success or abort
  while (true) {
    if (abortController.signal.aborted) {
      return 'aborted';
    }

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
          continue;
        }
        hintData = JSON.parse(jsonMatch[0]);
        agentIO.verbose('triologue', `Hint round parsed result: ${JSON.stringify(hintData, null, 2)}`);
      } catch {
        agentIO.verbose('triologue', 'JSON parse failed in hint response, retrying...');
        continue;
      }

      if (
        typeof hintData.blocker !== 'string' ||
        typeof hintData.next_step !== 'string' ||
        typeof hintData.focus_on !== 'string' ||
        typeof hintData.wiki_domain !== 'string' ||
        typeof hintData.wiki_query !== 'string'
      ) {
        console.log('[hint round] Missing required fields, retrying...');
        continue;
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

      ctx.note('HINT', hintLines.join('\n'));

      return 'success';
    } catch (err) {
      if (err instanceof Error && err.message === 'Request aborted') {
        return 'aborted';
      }
      throw err;
    }
  }
}
