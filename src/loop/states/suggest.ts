/**
 * suggest.ts - Background SUGGEST task
 *
 * Runs a fire-and-forget exploration loop in parallel with COLLECT.
 * Follows the explorer-agent pattern:
 *   if tool_calls → execute (with restricted executor returning errors for disallowed tools)
 *   if no tool_calls → try to extract brown bag → mail on success / loop on failure
 *
 * Gracefully stopped by PROMPT state on next user input via timestamp-based stop flag.
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
  formatWarning,
  validateIntent,
} from '../../context/grant/intent-parser.js';

const MAX_TURNS = 10;

/** Tools allowed in suggest mode */
const ALLOWED_TOOLS = new Set([
  'read_file', 'bash', 'wiki_get', 'skill_load', 'recall',
]);

// ============================================================================
// Brown Bag
// ============================================================================

interface BrownBag {
  originalQuery: string;
  wikiNotes: string[];
  skills: string[];
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
      const validation = validateIntent(parsed);
      return 'Error: bash calls in suggest mode require a valid READ intent. ' +
        `READ SOURCE TO ... or READ CONFIG TO ... etc.${formatWarning(validation)}`;
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

    // All elements must be strings
    if (!parsed.wikiNotes.every((s: unknown) => typeof s === 'string')) return null;
    if (!parsed.skills.every((s: unknown) => typeof s === 'string')) return null;

    return {
      originalQuery: parsed.originalQuery,
      wikiNotes: parsed.wikiNotes,
      skills: parsed.skills,
    };
  } catch {
    return null;
  }
}

/**
 * Format a BrownBag into a human-readable mail body.
 */
function formatBrownBag(brownBag: BrownBag): string {
  const lines: string[] = [];
  lines.push('[Brown Bag]');
  lines.push('');
  lines.push(`Original query: ${brownBag.originalQuery}`);

  if (brownBag.wikiNotes.length > 0) {
    lines.push('');
    lines.push('Wiki notes to search:');
    for (const q of brownBag.wikiNotes) {
      lines.push(`- "${q}"`);
    }
  }

  if (brownBag.skills.length > 0) {
    lines.push('');
    lines.push(`Skills to load: ${brownBag.skills.join(', ')}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Background Task
// ============================================================================

/**
 * Run the background SUGGEST task.
 * Called as fire-and-forget from COLLECT. Gracefully stopped by PROMPT.
 */
export async function runSuggestBackground(env: MachineEnv): Promise<void> {
  const { triologue, ctx } = env;

  // Graceful stop via timestamp-based flag.
  // Each new SUGGEST run creates a fresh closure with its own stopRequestedAt = null.
  // When stop() is called, stopRequestedAt is set to Date.now().
  // The loop captures the value at iteration start; if it's non-null and has changed,
  // the loop exits. This handles rapid stop/restart cycles.
  let stopRequestedAt: number | null = null;
  env.runningSuggest = { stop: () => { stopRequestedAt = Date.now(); } };

  try {
    // 1. Fork the triologue — deep copy raw messages (latest is user's query)
    const rawMessages = triologue.getMessagesRaw();
    const messages: Message[] = JSON.parse(JSON.stringify(rawMessages));

    // 2. Append "[REMINDER] you are in the suggest mode"
    messages.push({
      role: 'user',
      content: '[REMINDER] you are in the suggest mode',
    });

    // 3. Get the existing system prompt (suggest-mode rules baked in statically)
    const fullMessages = triologue.getMessages();
    const systemMsg = fullMessages[0]; // first message is always system prompt

    // 4. Build the message array: system prompt + forked messages
    const chatMessages: Message[] = [systemMsg, ...messages];

    // 5. Get the FULL tool list (preserves prompt cache — no tool filtering)
    const allTools: Tool[] = loader.getToolsForScope('main');

    // 6. Explorer-style loop
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
          env.ctx.mail.appendMail('suggest', 'Brown Bag', formatBrownBag(brownBag));
          return;
        }
        // No brown bag yet — loop again (LLM will continue exploring)
        continue;
      }

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
          ctx,
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
            env.ctx.mail.appendMail('suggest', 'Brown Bag', formatBrownBag(brownBag));
          }
          break;
        }
      }
    }
  } catch (err) {
    // Silently fail — SUGGEST is best-effort
    ctx.core.verbose('suggest', `SUGGEST failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    env.runningSuggest = null;
  }
}

// ============================================================================
// State Handler Stub
// ============================================================================

/**
 * State handler registration stub — required for the handler map in agent-repl.
 * SUGGEST is never reached via normal state transitions; it runs as a background
 * task launched from COLLECT.
 */
export async function handleSuggest(
  _env: MachineEnv,
  _turn: TurnVars,
  _pass: PassData,
): Promise<HandlerResult> {
  return null;
}
