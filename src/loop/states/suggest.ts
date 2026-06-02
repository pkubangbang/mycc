/**
 * suggest.ts - Background SUGGEST task orchestrator
 *
 * Runs as a fire-and-forget background task launched from PROMPT state (at tail).
 * Gracefully stopped by next PROMPT via timestamp-based stop flag.
 *
 * Pipeline: summarizing (1 retryChat → directed summary)
 *         → searching (1 retryChat with skill_search tool, returns {name,description}[])
 *         → reranking (up to 3 retryChat attempts → brownbag JSON).
 */

import { loader } from '../../context/shared/loader.js';
import { isDebuggingSuggest } from '../../config.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import type { Message, Tool, ToolCall } from '../../types.js';
import { retryChat, MODEL, forkChat } from '../../engine/chat-provider.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_RERANK_ATTEMPTS = 3;

// ============================================================================
// Types
// ============================================================================

interface BrownBag {
  originalQuery: string;
  skills: string[];
}

/**
 * Result of trying to extract a brown bag from assistant text.
 * - ok=true: a valid brown bag was found (JSON format correct).
 * - ok=false: no valid JSON found or wrong types.
 */
type ExtractResult =
  | { ok: true; bag: BrownBag }
  | { ok: false };

// ============================================================================
// Prompts
// ============================================================================

function buildSummarizingPrompt(): string {
  return `Analyze the conversation history above and produce a concise summary of what the user is currently doing.

Focus on:
1. **User's latest query** — what did the user just ask or request?
2. **Intent** — what does the user want to accomplish? (e.g., browse web, edit code, search knowledge, run tests)
3. **Behavior** — what actions or operations would satisfy that intent? (e.g., navigating websites, reading files, searching the web)

Output text ONLY — do NOT use any tools. Format: a short paragraph (2-5 sentences). Each sentence should describe a specific behavior or capability relevant to identifying helpful skills.`;
}

function buildSearchingPrompt(summary: string, luq: string): string {
  return `You are in skill searching mode. Use the \`skill_search\` tool to find relevant skills.
- You may ONLY use: skill_search
- Use the analysis and the user's original query below to guide your searches.
- **IMPORTANT**: The \`search\` param should be short keywords/phrases (2-5 words), NOT full sentences or long descriptions.
- You have only one turn. Search as many times as needed to find all relevant skills.

Summary: ${summary}

User Query: ${luq}`;
}

function buildRerankingPrompt(): string {
  return `Based on the skill search results above, produce a brownbag JSON containing the most relevant skills found.

\`\`\`json
{ "originalQuery": "...", "skills": ["skill-name-1", "skill-name-2"] }
\`\`\`

- "originalQuery" must be a faithful paraphrase of the user's query.
- "skills" must be an array of exact skill names found via skill_search.
- Only include skills that are genuinely relevant to the user's task. Rerank and pick the best ones.
- Do NOT guess or invent skill names — only include skills you actually discovered.`;
}

// ============================================================================
// Phase 1: Summarizing
// ============================================================================

/**
 * Summarizing phase: analyze full chat history + tools to produce a directed summary.
 * Returns the summary text, or null if failed or skipped.
 */
async function runSummarizing(
  baseMessages: Message[],
  allTools: Tool[],
  stopRequested: () => boolean,
): Promise<string | null> {
  // Guard: last message must be 'user' for forkChat merging
  const lastIdx = baseMessages.length - 1;
  if (lastIdx < 0 || baseMessages[lastIdx].role !== 'user') return null;

  if (stopRequested()) return null;

  const summary = await forkChat(baseMessages, allTools, buildSummarizingPrompt());

  if (stopRequested()) return null;
  if (!summary.trim()) return null;

  return summary;
}

// ============================================================================
// Phase 2: Searching
// ============================================================================

/**
 * Searching phase: single retryChat with only skill_search tool.
 * The LLM calls skill_search 0..N times in one move.
 * Returns the search messages as context for reranking.
 */
async function runSearching(
  searchMsgs: Message[],
  skillSearchTool: Tool[],
  stopRequested: () => boolean,
  mutedCtx: MachineEnv['ctx'],
  ctx: MachineEnv['ctx'],
): Promise<Message[] | null> {
  if (stopRequested()) return null;

  const response = await retryChat(
    {
      model: MODEL,
      messages: searchMsgs,
      tools: skillSearchTool,
    },
    { noSpinner: true },
  );

  if (stopRequested()) return null;

  const assistantMsg = response.message;

  // Push the assistant message
  searchMsgs.push({
    role: 'assistant',
    content: assistantMsg.content || '',
    tool_calls: assistantMsg.tool_calls,
  } as Message);

  // Execute all tool calls and append results
  if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
    if (isDebuggingSuggest()) {
      const toolNames = assistantMsg.tool_calls.map(tc =>
        `${tc.function.name}("${(tc.function.arguments as Record<string, unknown>)?.search || ''}")`
      ).join(', ');
      ctx.core.brief('info', 'suggest', 'searching: executing skill_search calls', toolNames);
    }

    for (const tc of assistantMsg.tool_calls as ToolCall[]) {
      if (stopRequested()) return null;

      const result = await loader.execute(tc.function.name, mutedCtx, tc.function.arguments as Record<string, unknown>);
      searchMsgs.push({
        role: 'tool',
        tool_name: tc.function.name,
        content: result,
        tool_call_id: tc.id,
      } as Message);
    }

    if (isDebuggingSuggest()) {
      ctx.core.brief('info', 'suggest', 'searching', `${assistantMsg.tool_calls.length} skill_search call(s) executed`);
    }
  }

  return searchMsgs;
}

// ============================================================================
// Brown Bag Extraction & Formatting
// ============================================================================

/**
 * Try to parse a brown bag JSON from the assistant's text response.
 * Validates JSON format only (required fields and types).
 */
function tryExtractBrownBag(content: string): ExtractResult {
  const trimmed = content.trim();
  if (!trimmed) return { ok: false };

  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false };

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (typeof parsed.originalQuery !== 'string') return { ok: false };
    if (!Array.isArray(parsed.skills)) return { ok: false };
    if (!parsed.skills.every((s: unknown) => typeof s === 'string')) return { ok: false };

    return {
      ok: true,
      bag: {
        originalQuery: parsed.originalQuery,
        skills: parsed.skills,
      },
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Format a BrownBag into a human-readable mail body.
 * Returns null if the brown bag has no actionable content.
 */
function formatBrownBag(brownBag: BrownBag): string | null {
  if (brownBag.skills.length === 0) return null;

  const lines: string[] = [];
  lines.push(`Regarding the user's query: ${brownBag.originalQuery}`);
  lines.push('Consider the suggestions below:');

  lines.push('');
  lines.push('Skills to load (use skill_load with the `name` param to load by exact name):');
  for (const s of brownBag.skills) {
    lines.push(`- \`skill_load(name="${s}", search="<description>")\``);
  }

  return lines.join('\n');
}

// ============================================================================
// Phase 3: Reranking
// ============================================================================

/**
 * Reranking phase: take summary + LUQ + search results and produce a brownbag JSON.
 * Runs up to MAX_RERANK_ATTEMPTS rounds.
 * On success: format and append to suggest mailbox. After max attempts: abandon.
 */
async function runReranking(
  searchMessages: Message[],
  stopRequested: () => boolean,
  ctx: MachineEnv['ctx'],
): Promise<void> {
  const rerankMsgs: Message[] = [
    ...searchMessages,
    { role: 'user', content: buildRerankingPrompt() },
  ];

  for (let attempt = 0; attempt < MAX_RERANK_ATTEMPTS; attempt++) {
    if (stopRequested()) return;

    const response = await retryChat(
      {
        model: MODEL,
        messages: rerankMsgs,
      },
      { noSpinner: true },
    );

    if (stopRequested()) return;

    const content = response.message.content || '';
    rerankMsgs.push({ role: 'assistant', content } as Message);

    const extractResult = tryExtractBrownBag(content);

    if (!extractResult.ok) {
      // No valid JSON — continue with no feedback
      if (isDebuggingSuggest()) {
        const preview = content.length > 200 ? `${content.slice(0, 200)}...` : content;
        ctx.core.brief('warn', 'suggest', `reranking FAILURE (no valid JSON, attempt ${attempt + 1})`, preview);
      }
      continue;
    }

    // Success: format and send
    const body = formatBrownBag(extractResult.bag);
    if (body) {
      if (isDebuggingSuggest()) {
        ctx.core.brief('info', 'suggest', `reranking SUCCESS (attempt ${attempt + 1})`, body);
        ctx.core.brief('info', 'suggest', `  skills: ${extractResult.bag.skills.join(', ')}`);
      }
      ctx.core.verbose('suggest', 'skill brown bag sent');
      ctx.mail.appendMail('suggest', 'Brown Bag (skill)', body);
    } else {
      if (isDebuggingSuggest()) {
        ctx.core.brief('warn', 'suggest', 'reranking FAILURE', 'extracted but empty (no valid skills)');
      }
    }
    return;
  }

  // Max attempts exhausted — abandon
  if (isDebuggingSuggest()) {
    ctx.core.brief('warn', 'suggest', 'reranking abandoned', 'max rerank attempts exhausted, no valid brownbag');
  }
  ctx.core.verbose('suggest', 'skill brown bag abandoned (max attempts)');
}

// ============================================================================
// Direction Entry Point
// ============================================================================

/**
 * Run the skill probing pipeline: summarizing → searching → reranking.
 * Best-effort: silently catches errors.
 */
async function runSkillDirection(
  baseMessages: Message[],
  allTools: Tool[],
  env: MachineEnv,
  mutedCtx: MachineEnv['ctx'],
  stopRequested: () => boolean,
): Promise<void> {
  const { ctx } = env;

  try {
    // Extract the last user content (LUQ) from baseMessages
    const lastUserContent = extractLastUserContent(baseMessages);

    // Phase 1: Summarizing — chat history → directed summary
    const summary = await runSummarizing(baseMessages, allTools, stopRequested);
    if (!summary) {
      ctx.core.verbose('suggest', 'skipped (summarizing returned nothing)');
      return;
    }

    if (isDebuggingSuggest()) {
      ctx.core.brief('info', 'suggest', 'summary', summary);
    }

    // Phase 2: Searching — 1 retryChat with skill_search tool
    const skillSearchTool: Tool[] = allTools.filter(t => t.function.name === 'skill_search');
    if (skillSearchTool.length === 0) {
      ctx.core.verbose('suggest', 'tool "skill_search" not found');
      return;
    }

    const searchMsgs: Message[] = [
      { role: 'assistant', content: summary },
      { role: 'user', content: buildSearchingPrompt(summary, lastUserContent) },
    ];

    const searchResult = await runSearching(searchMsgs, skillSearchTool, stopRequested, mutedCtx, ctx);
    if (!searchResult || stopRequested()) {
      ctx.core.verbose('suggest', 'skipped (searching returned nothing)');
      return;
    }

    // Phase 3: Reranking — produce valid brownbag from search results
    await runReranking(searchResult, stopRequested, ctx);
  } catch (err) {
    ctx.core.verbose('suggest', `failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Extract the content of the last user message from a messages array.
 * Returns empty string if no user message is found.
 */
function extractLastUserContent(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content || '';
    }
  }
  return '';
}

// ============================================================================
// Mute Core
// ============================================================================

/**
 * Wrap a Core module to mute brief() calls.
 * All other methods pass through normally.
 */
function muteCore(core: MachineEnv['ctx']['core']): MachineEnv['ctx']['core'] {
  return new Proxy(core, {
    get(target, prop, receiver) {
      if (prop === 'brief') {
        return () => {}; // no-op — suppress background noise
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as MachineEnv['ctx']['core'];
}

// ============================================================================
// Background Task
// ============================================================================

/**
 * Run the background SUGGEST task.
 * Non-async: fires async functions without awaiting them for concurrency.
 * Called from PROMPT (at tail). Gracefully stopped by next PROMPT via stop flag.
 */
export function runSuggestBackground(env: MachineEnv): void {
  const { triologue, ctx } = env;

  // Mute brief() output from tools executed in the background suggest loop.
  const mutedCtx = isDebuggingSuggest()
    ? ctx
    : { ...ctx, core: muteCore(ctx.core) };

  // Graceful stop via timestamp-based flag.
  let stopRequestedAt: number | null = null;
  const runId = Symbol();
  env.runningSuggest = {
    stop: () => { stopRequestedAt = Date.now(); },
    id: runId,
  } as unknown as { stop: () => void };

  const stopRequested = () => stopRequestedAt !== null;

  // Fork the triologue — shallow copy, we never mutate originals
  const baseMessages: Message[] = [...triologue.getMessages()];

  // Guard: last message must be 'user' for probing to work
  const lastMsg = baseMessages[baseMessages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') {
    ctx.core.verbose('suggest', 'skipped (last message is not user)');
    env.runningSuggest = null;
    return;
  }

  // Pre-fetch tools once
  const allTools: Tool[] = loader.getToolsForScope('main');

  // Fire skill direction — handles its own errors
  runSkillDirection(baseMessages, allTools, env, mutedCtx, stopRequested)
    .catch(err => {
      ctx.core.verbose('suggest', `direction failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      if ((env.runningSuggest as { id?: symbol } | null)?.id === runId) {
        env.runningSuggest = null;
      }
    });
}

// ============================================================================
// State Handler Stub
// ============================================================================

/**
 * State handler registration stub — required for the handler map in agent-repl.
 * SUGGEST is never reached via normal state transitions; it runs as a background
 * task launched from PROMPT.
 */
export async function handleSuggest(
  _env: MachineEnv,
  _turn: TurnVars,
  _pass: PassData,
): Promise<HandlerResult> {
  return null;
}
