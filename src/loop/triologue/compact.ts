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
import { briefToolCall, newBriefCallId } from './brief.js';
import { briefResultLine } from './recap-note.js';

export interface CompactDeps {
  /** Raw (defensively filtered) conversation messages for transcript + minification. */
  getRawMessages(): Message[];
  /** Full view (system + projectContext + conversation) for the forkChat working-memory call. */
  getFullMessages(): Message[];
  /** The last real user query, or '' if none. Preserved verbatim in the summary. */
  lastUserQuery(): string;
  /** Called with the transcript path once it is written. */
  onCompact(transcriptPath: string): void;
  /**
   * Wiki domains to advertise in the knowledge-persistence instruction of the
   * summary prompt. Supplied BY THE CALLER (the composition root that holds the
   * wiki module) rather than pulled from a module here — the compaction layer
   * must stay a conversation-state primitive and must not depend on the RAG
   * layer. Empty → the instruction section is omitted.
   */
  domains: Array<{ domain_name: string; description?: string }>;
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

  // NOTE: no recap guidance here. "When/how to call recap" is taught in ONE
  // place — the lead system prompt (buildBriefRecapSection). Repeating it in
  // the compaction summary prompt pollutes the injected context with a second,
  // drifting copy of the same policy.

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

  // Wiki domains for the knowledge-persistence instruction come from the
  // CALLER (composition root), keeping this layer wiki-agnostic.
  const domains = deps.domains;

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
  // The call itself is built by the shared writer (triologue/brief.ts), the
  // same one llm.ts recovery and hook.ts crossroad use, so this producer's
  // shape cannot drift from theirs.
  // A SYNTHESIZED call id, minted like every other synthetic producer (no
  // hand-invented id scheme): opaque and unique is all it must be — recap reads
  // the anchor's message, never its id.
  const briefCall = briefToolCall(
    COMPACT_RESUME_BRIEF_MESSAGE,
    7,
    newBriefCallId('compact_resume'),
  );
  return buildResumeRoundTrip({
    briefCall,
    summaryPrefix,
    summary,
    focusSection,
    userQueryNote,
  });
}

/**
 * The resume instruction appended to the summary so the agent re-engages with
 * the unfinished work recorded there rather than blandly affirming.
 */
export const COMPACT_RESUME_INSTRUCTION =
  '\n\n--- Resume: review "Current State" and "Recent Working Memory" above to re-orient on the in-flight task and decide the next step.';

export const COMPACT_RESUME_BRIEF_MESSAGE =
  'Re-orienting on the compacted summary to resume the in-flight task.';

/**
 * Build the post-compact 3-message round-trip that `replaceAll` installs.
 *
 * Extracted from runAutoCompact so tests can exercise the REAL producer. This
 * brief is the recap FLOOR: compact() replaces the entire conversation with
 * this round-trip, making it the ONLY brief left, so anything that made it
 * ineligible as an anchor would leave recap with no anchor at all after every
 * compaction — a hand-built fixture cannot catch that; it silently tests a
 * shape production no longer produces (exactly the P1 this extraction exists
 * to prevent recurring).
 *
 * THE RULE: `MessageStore.briefIndices` / `Triologue.currentAnchorIndex` skip assistant messages marked
 * `synthetic: true` (types.ts Message.synthetic). Those are the INCIDENTAL
 * briefs — llm.ts empty-output recovery and hook.ts crossroad — whose text is
 * boilerplate the model should not be rewound to. This floor brief is
 * deliberately left UNMARKED: no marker means "anchors", which is exactly what
 * the floor needs. Never set `synthetic` on this message.
 *
 * The function OWNS the user-message assembly (prefix, body, focus, query note
 * and the resume instruction) rather than taking a pre-joined string: an
 * earlier signature took `userContent` from the caller, which let the
 * extraction itself drop the resume instruction and still type-check — the
 * invariant it exists to protect, lost to the refactor that created it. It
 * also owns WHERE the brief call lands (the assistant message's `tool_calls`
 * and the matching tool result's `tool_call_id`) so the two can never
 * disagree about the id.
 */
export function buildResumeRoundTrip(args: {
  briefCall: ToolCall;
  summaryPrefix: string;
  summary: string;
  focusSection: string;
  userQueryNote: string;
}): Message[] {
  const { briefCall, summaryPrefix, summary, focusSection, userQueryNote } = args;
  return [
    {
      role: 'user',
      content: `${summaryPrefix}${summary}${focusSection}${userQueryNote}${COMPACT_RESUME_INSTRUCTION}`,
    },
    {
      role: 'assistant',
      content: '',
      // NOTE: this assistant message carries NO `synthetic` marker —
      // deliberately. `synthetic: true` marks an INCIDENTAL brief (llm.ts
      // empty-output recovery, hook.ts crossroad) that recap must skip,
      // because its text is boilerplate. This one is the FLOOR: after a
      // compaction it is the only brief left, so marking it would leave recap
      // with no anchor at all. The call id is an opaque unique id and carries
      // no meaning.
      tool_calls: [briefCall],
    },
    {
      role: 'tool',
      tool_name: 'brief',
      // The pristine success result - WITH its anchor hash, so the floor brief
      // is addressable by recap(target_brief=...) from the first moment. Rendered by
      // recap-note.ts briefResultLine (the same writer the TOOL stage stamps),
      // never hand-assembled. This brief is NOT synthetic — it is the only
      // anchor left after a compaction — so the invitation is truthful here.
      // recap REWRITES this in place with the span summary, keeping line 1.
      content: briefResultLine(briefCall.id),
      tool_call_id: briefCall.id,
    },
  ];
}
