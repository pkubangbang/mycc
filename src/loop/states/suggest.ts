/**
 * suggest.ts - Background SUGGEST task
 *
 * Runs a fire-and-forget exploration loop in parallel with user's next prompt.
 * Follows the explorer-agent pattern:
 *   if tool_calls → execute (with restricted executor returning errors for disallowed tools)
 *   if no tool_calls → try to extract brown bag → mail on success / loop on failure
 *
 * Launched from PROMPT state (at tail). Gracefully stopped by next PROMPT via timestamp-based stop flag.
 */

import { retryChat, MODEL } from '../../ollama.js';
import { loader } from '../../context/shared/loader.js';
import { agentIO } from '../agent-io.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import type { Message, ToolCall, Tool } from '../../types.js';
import {
  parseIntent,
  isReadOnlyVerb,
  isMutationVerb,
} from '../../context/grant/intent-parser.js';

const MAX_TURNS = 10;

/** Tools allowed in suggest mode */
const ALLOWED_TOOLS = new Set([
  'read_file', 'bash', 'wiki_get', 'skill_load', 'recall',
]);

// ============================================================================
// Brown Bag
// ============================================================================

interface WikiNote {
  domain: string;
  query: string;
}

interface BrownBag {
  originalQuery: string;
  wikiNotes: WikiNote[];
  skills: string[];
  /** Optional: a suggested terminal title reflecting the user's current intent */
  title?: string;
}

/**
 * Execute a tool call in suggest mode.
 * - Disallowed tool names get an error immediately.
 * - For 'bash' calls, the intent is parsed and mutation verbs (WRITE, EDIT,
 *   DELETE, BUILD, INSTALL, RUN) are blocked. Only READ and TEST pass through.
 *   This prevents the real grant system from approving write intents.
 * - All other allowed tools execute normally.
 */
async function executeSuggestTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MachineEnv['ctx'],
): Promise<string> {
  if (!ALLOWED_TOOLS.has(name)) {
    return `Error: Tool "${name}" is not available in suggest mode. ` +
      `You may only use: ${[...ALLOWED_TOOLS].join(', ')}. ` +
      `Continue exploring with allowed tools.`;
  }

  // For bash calls, validate intent BEFORE delegating to the real handler.
  // The real ctx's grant system may approve mutations (depends on mode/scope),
  // so we must block non-read verbs here.
  if (name === 'bash') {
    const rawIntent = (args.intent as string) || '';
    const parsed = parseIntent(rawIntent);

    // No intent or unparseable intent → block
    if (!parsed) {
      return 'Error: bash calls in suggest mode require a valid READ intent. ' +
        `READ SOURCE TO ... or READ CONFIG TO ... etc.`;
    }

    // Mutation verbs → block
    if (isMutationVerb(parsed.verb)) {
      return `Error: "${parsed.verb}" is not allowed in suggest mode (mutation). ` +
        `Only READ and TEST intents are permitted. ` +
        `Use: READ SOURCE TO explore ..., READ CONFIG TO check ..., etc.`;
    }

    // RUN is ambiguous — block it too (not explicitly read-only)
    if (!isReadOnlyVerb(parsed.verb)) {
      return `Error: "${parsed.verb}" is not allowed in suggest mode. ` +
        `Only READ and TEST intents are permitted.`;
    }
  }

  return await loader.execute(name, ctx, args);
}

/**
 * Try to parse a brown bag JSON from the assistant's text response.
 * Returns the parsed BrownBag or null.
 */
function tryExtractBrownBag(content: string): BrownBag | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    // Find JSON object in the content (may be wrapped in markdown code blocks)
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (typeof parsed.originalQuery !== 'string') return null;
    if (!Array.isArray(parsed.wikiNotes)) return null;
    if (!Array.isArray(parsed.skills)) return null;

    // wikiNotes: each entry must be { domain: string, query: string }
    if (!parsed.wikiNotes.every((w: unknown) =>
      typeof w === 'object' && w !== null &&
      typeof (w as Record<string, unknown>).domain === 'string' &&
      typeof (w as Record<string, unknown>).query === 'string'
    )) return null;

    // skills: all elements must be strings
    if (!parsed.skills.every((s: unknown) => typeof s === 'string')) return null;

    // title is optional but must be a string if present
    const title = parsed.title;
    if (title !== undefined && typeof title !== 'string') return null;

    return {
      originalQuery: parsed.originalQuery,
      wikiNotes: parsed.wikiNotes,
      // Filter out hallucinated skill names — only suggest skills that actually exist
      skills: parsed.skills.filter((s: string) => loader.getSkill(s) !== undefined),
      title,
    };
  } catch {
    return null;
  }
}

/**
 * Format a BrownBag into a human-readable mail body.
 * Returns null if the brown bag has no actionable content (no wiki notes, no skills, no title).
 */
function formatBrownBag(brownBag: BrownBag): string | null {
  if (brownBag.wikiNotes.length === 0 && brownBag.skills.length === 0) {
    return null; // nothing actionable — don't send noise
  }

  const lines: string[] = [];
  lines.push(`Regarding the user's query: ${brownBag.originalQuery}`);
  lines.push('Consider the suggestions below:');

  if (brownBag.wikiNotes.length > 0) {
    lines.push('');
    lines.push('Wiki notes to search (use wiki_get tool):');
    for (const w of brownBag.wikiNotes) {
      lines.push(`- domain="${w.domain}" query="${w.query}"`);
    }
  }

  if (brownBag.skills.length > 0) {
    lines.push('');
    lines.push(`Skills to load (use skill_load tool): ${brownBag.skills.join(', ')}`);
  }

  if (brownBag.title) {
    lines.push('');
    lines.push(`Title suggestion (use mycc_title tool): ${brownBag.title}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Background Task
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

/**
 * Run the background SUGGEST task.
 * Called as fire-and-forget from PROMPT (at tail). Gracefully stopped by next PROMPT.
 */
export async function runSuggestBackground(env: MachineEnv): Promise<void> {
  const { triologue, ctx } = env;

  // Mute brief() output from tools executed in the background suggest loop.
  // NOTE: mutedCtx is a shallow copy — wiki, mail, todo, team, etc. share references
  // with the live ctx. This is currently safe because executeSuggestTool only passes
  // mutedCtx to allowed tools (read_file, bash, wiki_get, skill_load, recall) which
  // are read-only. If new mutation-capable tools are added to the allowlist, this
  // must be hardened (deep copy or explicit deny of mutation modules).
  const mutedCtx = { ...ctx, core: muteCore(ctx.core) };

  // Graceful stop via timestamp-based flag.
  // Each new SUGGEST run creates a fresh closure with its own stopRequestedAt = null.
  // When stop() is called, stopRequestedAt is set to Date.now().
  // The loop captures the value at iteration start; if it's non-null and has changed,
  // the loop exits. This handles rapid stop/restart cycles.
  //
  // runId guards against handle corruption: if a new SUGGEST is launched before
  // this one finishes, the new run will overwrite env.runningSuggest. The finally
  // block must NOT null out the new run's handle — it only clears its own.
  let stopRequestedAt: number | null = null;
  const runId = Symbol();
  env.runningSuggest = {
    stop: () => { stopRequestedAt = Date.now(); },
    id: runId,
  } as unknown as { stop: () => void };

  try {
    // 1. Fork the triologue — deep copy raw messages (latest is user's query)
    const rawMessages = triologue.getMessagesRaw();
    const messages: Message[] = JSON.parse(JSON.stringify(rawMessages));

    // 2. Fetch available wiki domains for the suggest prompt
    const domains = ctx.wiki ? await ctx.wiki.listDomains() : [];
    const domainList = domains.length > 0
      ? domains.map(d => `- ${d.domain_name}${d.description ? `: ${d.description}` : ''}`).join('\n')
      : '(no domains registered)';

    // 3. Append "[REMINDER] you are in the suggest mode" with full instructions
    messages.push({
      role: 'user',
      content: `[REMINDER] you are in the suggest mode. Your goal is to explore the codebase and discover
relevant wiki notes and skills for the user's query.

In suggest mode:
- You may use: read_file, bash (READ intents only: cat/ls/grep/find/head/tail), wiki_get,
  skill_load, recall
- You may NOT: edit files, run destructive bash commands, use web_search, web_fetch,
  create teammates, or take any action beyond discovery

For wiki notes, use wiki_get tool, specify the domain from one of below:
${domainList}

For skills, use skill_load tool, specify intent using the intent lang, but DO NOT specify the name param, to search relavent skills.

- After exploration, produce a "brown bag" as JSON:
  \`\`\`json
  {"originalQuery": "the user's original query", "wikiNotes": [{"domain": "project", "query": "keyword1 keyword2"}], "skills": ["skill-name-1"], "title": "optional brief title"}
  \`\`\`
  All fields are required except "title". wikiNotes and skills are arrays (may be empty).
  Try search in different aspects to get complete results.
  Include "title" only if the user's query suggests a substantial topic change.`,
    });

    // 4. Get the existing system prompt
    const fullMessages = triologue.getMessages();
    const systemMsg = fullMessages[0]; // first message is always system prompt

    // 5. Build the message array: system prompt + forked messages
    const chatMessages: Message[] = [systemMsg, ...messages];

    // 6. Get the FULL tool list
    const allTools: Tool[] = loader.getToolsForScope('main');

    // 7. Explorer-style loop
    let noBagStreak = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Check graceful stop BEFORE this iteration
      const stopAtIterStart = stopRequestedAt;
      if (stopAtIterStart !== null) return;

      if (agentIO.isNeglectedMode()) return;

      const response = await retryChat(
        {
          model: MODEL,
          messages: chatMessages,
          tools: allTools,
        },
        { noSpinner: true },
      );

      // Re-check after LLM call — stop may have been requested during the call
      if (stopRequestedAt !== null && (stopAtIterStart === null || stopRequestedAt > stopAtIterStart)) {
        return;
      }

      const assistantMsg = response.message;
      chatMessages.push({
        role: 'assistant',
        content: assistantMsg.content || '',
        tool_calls: assistantMsg.tool_calls,
      } as Message);

      // No tool calls → try to extract brown bag
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const content = assistantMsg.content || '';
        const brownBag = tryExtractBrownBag(content);
        if (brownBag) {
          const body = formatBrownBag(brownBag);
          if (body) {
            ctx.core.verbose('suggest', `Brown bag sent: wikiNotes=${brownBag.wikiNotes.length}, skills=${brownBag.skills.length}`);
            env.ctx.mail.appendMail('suggest', 'Brown Bag', body);
            return;
          }
          // Brown bag had no actionable content — silently drop it
          ctx.core.verbose('suggest', 'Brown bag produced no actionable content');
          return;
        }
        // No brown bag yet — track streak and bail if LLM is stuck
        noBagStreak++;
        if (noBagStreak >= 3) {
          ctx.core.verbose('suggest', `Bailing out after ${noBagStreak} consecutive no-brown-bag responses`);
          return;
        }
        continue;
      }

      // Tool calls were emitted → reset noBagStreak
      noBagStreak = 0;

      // Execute tool calls with restricted executor
      for (const tc of assistantMsg.tool_calls as ToolCall[]) {
        // Check stop before each tool execution
        if (stopRequestedAt !== null && (stopAtIterStart === null || stopRequestedAt > stopAtIterStart)) {
          return;
        }
        if (agentIO.isNeglectedMode()) return;

        const result = await executeSuggestTool(
          tc.function.name,
          tc.function.arguments as Record<string, unknown>,
          mutedCtx,
        );
        chatMessages.push({
          role: 'tool',
          tool_name: tc.function.name,
          content: result,
          tool_call_id: tc.id,
        } as Message);
      }
    }

    // Max turns exhausted — try one final extraction from the last assistant message
    if (stopRequestedAt === null) {
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role === 'assistant' && chatMessages[i].content) {
          const brownBag = tryExtractBrownBag(chatMessages[i].content!);
          if (brownBag) {
            const body = formatBrownBag(brownBag);
            if (body) {
              ctx.core.verbose('suggest', `Brown bag sent (max turns): wikiNotes=${brownBag.wikiNotes.length}, skills=${brownBag.skills.length}`);
              env.ctx.mail.appendMail('suggest', 'Brown Bag', body);
            }
          }
          break;
        }
      }
    }
  } catch (err) {
    // Silently fail — SUGGEST is best-effort
    ctx.core.verbose('suggest', `SUGGEST failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Only clear the stop handle if we still own it (prevent corrupting a newer suggest's handle)
    if ((env.runningSuggest as { id?: symbol } | null)?.id === runId) {
      env.runningSuggest = null;
    }
  }
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
