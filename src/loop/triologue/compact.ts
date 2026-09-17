/**
 * triologue/compact.ts - Compaction layer for the Triologue facade
 *
 * Auto-compact pipeline: transcript persistence (JSONL), summary prompt
 * construction, concurrent working-memory extraction via forkChat, and the
 * post-compact summary pair shape (user + assistant bridge).
 *
 * Extracted from triologue.ts (Phase 4 of the layered refactor).
 * Prompt text is preserved VERBATIM — it shapes LLM output and prompt-cache
 * behavior; do not "tidy" it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { retryChat, MODEL, forkChat } from '../../engine/chat-provider.js';
import type { Message, Tool, ToolCall } from '../../types.js';
import { minifyMessages } from '../../utils/llm-chat-minifier.js';
import { getSessionContext, getSessionDir } from '../../config.js';

export interface CompactDeps {
  /** Raw (defensively filtered) conversation messages for transcript + minification. */
  getRawMessages(): Message[];
  /** Full view (system + projectContext + conversation) for the forkChat working-memory call. */
  getFullMessages(): Message[];
  /** The last real user query, or '' if none. Preserved verbatim in the summary. */
  lastUserQuery(): string;
  /** Called with the transcript path once it is written. */
  onCompact(transcriptPath: string): void;
  /** Optional wiki domains for the knowledge-persistence instruction. */
  getWikiDomains?: () => Promise<Array<{ domain_name: string; description?: string }>>;
}

/**
 * Build the summary prompt (sections preserved verbatim from triologue.ts).
 */
export function buildSummaryPrompt(conversationText: string, deps: CompactDeps, domains: Array<{ domain_name: string; description?: string }>, focus?: string): string {
  const domainList = domains.length > 0
    ? domains.map(d => `- ${d.domain_name}${d.description ? `: ${d.description}` : ''}`).join('\n')
    : '';

  const knowledgeInstruction = domains.length > 0
    ? `### Knowledge Persistence\n` +
    `Available wiki domains:\n${domainList}\n\n` +
    `IMPORTANT: Only persist knowledge that matches one of the available domains above.\n` +
    `For knowledge worth remembering, note as: "Knowledge: [domain] - [fact/rule]"\n` +
    `Skip opinions, temporary details, or knowledge that does not fit any domain.\n\n`
    : '';

  const focusInstruction = focus
    ? `\n**Focus Area:** Pay special attention to information related to "${focus}" and ensure the summary captures all relevant details about this topic.\n`
    : '';

  const lastUserQuery = deps.lastUserQuery();
  const userQueryInstruction = lastUserQuery
    ? `\n**User's Last Instruction:** "${lastUserQuery}"\nEnsure the summary preserves ALL constraints, pending tasks, and requests from this instruction. The agent should continue working on this after the compact.\n`
    : '';

  return (
    `Summarize this conversation for continuity. Cover the following sections:\n\n` +
    `### 1) What Was Accomplished\n` +
    `Key actions taken, files created/modified, findings made.\n\n` +
    `### 2) Current State\n` +
    `What the agent now knows — be specific enough that subsequent turns do NOT need to re-verify findings already made.\n` +
    `Include any pending or unfinished tasks.\n\n` +
    `### 3) Key Decisions Made\n` +
    `Design choices, fix strategies, or workflow decisions.\n\n` +
    `${knowledgeInstruction}` +
    `${focusInstruction}` +
    `${userQueryInstruction}` +
    `${conversationText}`
  );
}

/**
 * Build the working-memory focus extraction prompt (verbatim).
 */
export function buildFocusExtractionPrompt(): string {
  return (
    `Extract the current working memory from the conversation above. Focus on:\n` +
    `- The immediate task the agent is working on\n` +
    `- Recent tool results that are still relevant (file contents, command outputs, search results)\n` +
    `- Current file(s) being edited or examined\n` +
    `- In-progress decisions or next steps\n\n` +
    `Be concise but preserve specific details (function names, line numbers, file paths, exact values).\n` +
    `This working memory will be combined with a broader summary to maintain continuity after compaction.\n` +
    `Output TEXT ONLY — do NOT use any tools.`
  );
}

/**
 * Persist the full transcript to the session dir as JSONL.
 * Returns the transcript path.
 */
export function saveTranscript(messages: Message[]): string {
  const sessionId = getSessionContext();
  const transcriptDir = getSessionDir(sessionId);
  if (!fs.existsSync(transcriptDir)) {
    fs.mkdirSync(transcriptDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = path.join(transcriptDir, `transcript-lead-${timestamp}.jsonl`);

  const writeStream = fs.createWriteStream(transcriptPath);
  for (const msg of messages) {
    writeStream.write(`${JSON.stringify(msg)}\n`);
  }
  writeStream.end();

  return transcriptPath;
}

/**
 * Run auto-compact: save transcript, summarize with LLM, and (optionally)
 * extract working memory concurrently via forkChat on the FULL un-minified
 * messages. Returns the 2-message compact summary pair.
 *
 * @param focus - Optional focus topic to emphasize in summary
 * @param signal - Optional AbortSignal passed to retryChat/forkChat so a stuck
 *   summarization can be aborted (e.g. by the teammate turn watchdog).
 * @param tools - Optional full tool list for forkChat-based working-memory
 *   extraction. When provided (and non-empty), a concurrent forkChat forks
 *   from the full un-minified messages (with this tools schema, preserving
 *   the prompt cache) and extracts recent working memory, appended to the
 *   summary as a `### Recent Working Memory` section. When omitted or empty,
 *   falls back to summary-only (the historical behavior). Callers at the LLM
 *   stage pass `loader.getToolsForScope(scope)` so the fork hits the exact
 *   cache prefix the next LLM call will use.
 */
export async function runAutoCompact(deps: CompactDeps, focus?: string, signal?: AbortSignal, tools?: Tool[]): Promise<Message[]> {
  // Save full transcript to disk
  const transcriptPath = saveTranscript(deps.getRawMessages());
  deps.onCompact(transcriptPath);

  // Get wiki domains for knowledge persistence instruction
  const domains = deps.getWikiDomains ? await deps.getWikiDomains() : [];

  // Ask LLM to summarize
  const conversationText = minifyMessages(deps.getRawMessages());
  const summaryPrompt = buildSummaryPrompt(conversationText, deps, domains, focus);

  // Working-memory focus prompt — runs concurrently with the summary via
  // forkChat on the FULL un-minified messages (with the complete tools schema
  // so the fork hits the prompt cache the main loop already paid for).
  // toolChoice:'none' constrains output to text-only without invalidating the
  // cached prefix (it's a sampling parameter, not part of the cached tokens).
  // The two calls are independent: the summary sees minified text; the focus
  // sees the real conversation. Neither sees the other's output.
  const focusExtractionPrompt = buildFocusExtractionPrompt();

  // Run summary + focus concurrently. The summary uses a fresh retryChat
  // (no cache — minified text differs from the cached prefix by design). The
  // focus uses forkChat on the full messages with tools (cache hit when
  // called from the LLM stage). When tools is omitted/empty, skip the focus
  // call and fall back to summary-only (historical behavior).
  const useFocus = !!(tools && tools.length > 0);
  const fullMessages = useFocus ? deps.getFullMessages() : [];

  const [summaryResponse, focusText] = await Promise.all([
    retryChat(
      { model: MODEL, messages: [{ role: 'user', content: summaryPrompt }] },
      { signal, noSpinner: true },
    ),
    useFocus
      ? forkChat(fullMessages, tools!, focusExtractionPrompt, signal, 'none')
      : Promise.resolve(''),
  ]);

  const summary = summaryResponse.message.content || '(no summary)';

  // Build a compact summary pair that includes user intent preservation.
  // The focus (when extracted) is appended as a `### Recent Working Memory`
  // section inside the SAME user message — the post-compact shape stays two
  // messages, preserving the historical contract.
  const focusPrefix = focus ? `Focus: ${focus}. ` : '';
  const lastUserQuery = deps.lastUserQuery();
  const userQueryNote = lastUserQuery
    ? `\n\n**Previous user instruction:** ${lastUserQuery}`
    : '';
  const focusSection = focusText
    ? `\n\n### Recent Working Memory\n${focusText}`
    : '';

  const summaryPrefix = `[Conversation compressed. ${focusPrefix}Transcript: ${transcriptPath}]\n\n`;

  // Resume instruction appended to the user summary so the agent re-engages
  // with the unfinished work recorded there rather than blandly affirming.
  const reorientInstruction =
    '\n\n--- Resume: review "Current State" and "Recent Working Memory" above to re-orient on the in-flight task and decide the next step.';

  // The post-compact sequence is a 3-message brief tool-call round-trip:
  //
  //   user      → [summary + resume instruction]
  //   assistant → (empty content + brief tool_call)
  //   tool      → (brief tool result)
  //
  // This ends the store with lastRole === 'tool', so the NEXT agent() (the
  // real LLM response in the LLM→HOOK stage) is a natural tool → assistant
  // transition — the same transition every TOOL→COLLECT→LLM→HOOK cycle uses.
  // No TP violation, no dependence on the duplicate_assistant auto-fixer.
  //
  // Why a brief tool call instead of a synthetic assistant "Continuing." /
  // "re-orient..." text: a synthetic assistant message is infrastructure
  // pretending to be a model turn — it reads as authorization to drift
  // forward, and (worse) it leaves lastRole === 'assistant', so the next
  // real agent() trip the duplicate_assistant TP fixer, making normal
  // control flow depend on structural-violation recovery. The brief tool
  // call instead gives the LLM its established thinking step (the same
  // pattern llm.ts uses for empty-output recovery and hook.ts uses for
  // crossroad), and the round-trip ends in 'tool' — the cleanest possible
  // handoff to the next real assistant turn. The model's next response is
  // then a genuine reaction to its own brief + the summary, not a
  // continuation of a fabricated assertion.
  const briefCallId = `compact_resume_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return [
    {
      role: 'user',
      content: `${summaryPrefix}${summary}${focusSection}${userQueryNote}${reorientInstruction}`,
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: briefCallId,
          function: {
            name: 'brief',
            arguments: {
              message: 'Re-orienting on the compacted summary to resume the in-flight task.',
              confidence: 7,
            },
          },
        },
      ] as ToolCall[],
    },
    {
      role: 'tool',
      tool_name: 'brief',
      content: 'OK',
      tool_call_id: briefCallId,
    },
  ];
}