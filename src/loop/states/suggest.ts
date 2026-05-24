/**
 * suggest.ts - Background SUGGEST task orchestrator
 *
 * Runs a single probing direction (skill) as a fire-and-forget background task.
 * Launched from PROMPT state (at tail). Gracefully stopped by next PROMPT via timestamp-based stop flag.
 *
 * Pipeline: probe (summarize triologue) → solve (use skill_load to find relevant skills) → format (brownbag).
 */

import { loader } from '../../context/shared/loader.js';
import { isDebuggingSuggest } from '../../config.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import type { Message, Tool, ToolCall } from '../../types.js';
import { retryChat, MODEL } from '../../engine/chat-provider.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_SOLVE_TURNS = 5;

// ============================================================================
// Types
// ============================================================================

interface BrownBag {
  originalQuery: string;
  skills: string[];
}

/**
 * Result of trying to extract a brown bag from assistant text.
 * - ok=true: a valid, actionable brown bag was found.
 * - ok=false, feedback != null: the JSON was structurally close but had issues
 *   (e.g., hallucinated skill names). The feedback string can be injected back
 *   into the conversation to guide the LLM.
 * - ok=false, feedback == null: no usable JSON found at all.
 */
type ExtractResult =
  | { ok: true; bag: BrownBag }
  | { ok: false; feedback: string | null };

// ============================================================================
// Prompts
// ============================================================================

function buildProbePrompt(): string {
  return `Analyze the conversation history above and produce a concise signal for skill probing. Include:
- Keywords that capture the user's mindflow — the conceptual thread of what they are thinking about or trying to accomplish.

IMPORTANT: Output text ONLY — do NOT use any tools. Signal format: a short paragraph of keywords and phrases (2-4 sentences).`;
}

function buildSolvePrompt(signal: string): string {
  return `You are in skill probing mode. Use the \`skill_load\` tool (with \`search\` param, do NOT specify \`name\`) to find relevant skills.
- You may ONLY use: skill_load
- Use the signal below to guide your searches.
- **IMPORTANT**: The \`search\` param should be short keywords/phrases (2-5 words), NOT full sentences or long descriptions.
- Once you have found useful skills, produce a brownbag JSON:
\`\`\`json
{ "originalQuery": "...", "skills": ["skill-name-1", "skill-name-2"] }
\`\`\`

Signal: ${signal}`;
}

// ============================================================================
// Probe Utilities
// ============================================================================

/**
 * Merge a prompt into the last user message (copy-on-write).
 * Returns a new message array; does NOT mutate the original.
 * Returns null if the last message is not a user role (direction skipped).
 */
function mergeIntoLastUserMessage(msgs: Message[], prompt: string): Message[] | null {
  const lastIdx = msgs.length - 1;
  if (lastIdx < 0 || msgs[lastIdx].role !== 'user') return null;
  const result = [...msgs];
  result[lastIdx] = { ...result[lastIdx], content: `${result[lastIdx].content}\n\n${prompt}` };
  return result;
}

/**
 * Run one probe step: summarize triologue into a focused signal.
 * Returns the signal text, or null if the probe failed or was skipped.
 */
async function runProbe(
  baseMessages: Message[],
  probePrompt: string,
  allTools: Tool[],
  stopRequested: () => boolean,
): Promise<string | null> {
  const probeMsgs = mergeIntoLastUserMessage(baseMessages, probePrompt);
  if (!probeMsgs) return null;

  if (stopRequested()) return null;

  const response = await retryChat(
    {
      model: MODEL,
      messages: probeMsgs,
      tools: allTools, // preserve prompt cache
    },
    { noSpinner: true },
  );

  if (stopRequested()) return null;

  const signal = response.message.content || '';
  if (!signal.trim()) return null;

  return signal;
}

// ============================================================================
// Brown Bag Extraction & Formatting
// ============================================================================

/**
 * Try to parse a brown bag JSON from the assistant's text response.
 * Validates skill names against the loaded skill registry.
 */
function tryExtractBrownBag(content: string): ExtractResult {
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, feedback: null };

  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, feedback: null };

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (typeof parsed.originalQuery !== 'string') return { ok: false, feedback: null };
    if (!Array.isArray(parsed.skills)) return { ok: false, feedback: null };
    if (!parsed.skills.every((s: unknown) => typeof s === 'string')) return { ok: false, feedback: null };

    // Validate skills against loaded registry (hallucination detection)
    const valid: string[] = [];
    const hallucinated: string[] = [];
    for (const s of parsed.skills as string[]) {
      if (loader.getSkill(s) !== undefined) {
        valid.push(s);
      } else {
        hallucinated.push(s);
      }
    }

    if (hallucinated.length > 0) {
      return {
        ok: false,
        feedback: `Skill(s) "${hallucinated.join('", "')}" do not exist. Use skill_load with search to find relevant skills, rather than guessing skill names.`,
      };
    }

    return {
      ok: true,
      bag: {
        originalQuery: parsed.originalQuery,
        skills: valid,
      },
    };
  } catch {
    return { ok: false, feedback: null };
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
// Solve Loop
// ============================================================================

async function runSolveLoop(
  solveMsgs: Message[],
  directionTool: Tool[],
  stopRequested: () => boolean,
  env: MachineEnv,
  mutedCtx: MachineEnv['ctx'],
): Promise<void> {
  const { ctx } = env;

  for (let turn = 0; turn < MAX_SOLVE_TURNS; turn++) {
    if (stopRequested()) return;

    const response = await retryChat(
      {
        model: MODEL,
        messages: solveMsgs,
        tools: directionTool,
      },
      { noSpinner: true },
    );

    if (stopRequested()) return;

    const assistantMsg = response.message;
    solveMsgs.push({
      role: 'assistant',
      content: assistantMsg.content || '',
      tool_calls: assistantMsg.tool_calls,
    } as Message);

    if (isDebuggingSuggest() && assistantMsg.content) {
      const preview = assistantMsg.content.length > 500
        ? `${assistantMsg.content.slice(0, 500)}...`
        : assistantMsg.content;
      ctx.core.brief('info', 'suggest', `skill solve (turn ${turn + 1})`, preview);
    }

    // Tool calls → execute
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const tc of assistantMsg.tool_calls as ToolCall[]) {
        if (stopRequested()) return;

        const result = await loader.execute(tc.function.name, mutedCtx, tc.function.arguments as Record<string, unknown>);
        solveMsgs.push({
          role: 'tool',
          tool_name: tc.function.name,
          content: result,
          tool_call_id: tc.id,
        } as Message);
      }
      continue;
    }

    // No tool calls → try to extract brownbag (with skill validation)
    const content = assistantMsg.content || '';
    const extractResult = tryExtractBrownBag(content);

    if (extractResult.ok) {
      // Phase 3: Format
      const body = formatBrownBag(extractResult.bag);
      if (body) {
        if (isDebuggingSuggest()) {
          ctx.core.brief('info', 'suggest', `brown bag SUCCESS`, body);
          ctx.core.brief('info', 'suggest', `  skills: ${extractResult.bag.skills.join(', ')}`);
        }
        ctx.core.verbose('suggest', 'skill brown bag sent');
        env.ctx.mail.appendMail('suggest', 'Brown Bag (skill)', body);
      } else {
        if (isDebuggingSuggest()) {
          ctx.core.brief('warn', 'suggest', 'brown bag FAILURE', 'extracted but empty (no valid skills)');
        }
      }
      return;
    }

    // Has actionable feedback (hallucinated skills)
    if (extractResult.feedback) {
      if (isDebuggingSuggest()) {
        ctx.core.brief('warn', 'suggest', 'brown bag FAILURE (hallucinated skills)', extractResult.feedback);
      }
      solveMsgs.push({ role: 'user', content: extractResult.feedback });
      continue;
    }

    // No brown bag yet — just continue the loop
    if (isDebuggingSuggest()) {
      const preview = content.length > 200 ? `${content.slice(0, 200)}...` : content;
      ctx.core.brief('warn', 'suggest', `brown bag FAILURE (no JSON at turn ${turn + 1})`, preview);
    }
  }

  // Max turns exhausted — try final extraction
  if (!stopRequested()) {
    for (let i = solveMsgs.length - 1; i >= 0; i--) {
      if (solveMsgs[i].role === 'assistant' && solveMsgs[i].content) {
        const extractResult = tryExtractBrownBag(solveMsgs[i].content!);
        if (extractResult.ok) {
          const body = formatBrownBag(extractResult.bag);
          if (body) {
            if (isDebuggingSuggest()) {
              ctx.core.brief('info', 'suggest', 'brown bag SUCCESS (max turns)', body);
            }
            ctx.core.verbose('suggest', 'skill brown bag sent (max turns)');
            env.ctx.mail.appendMail('suggest', 'Brown Bag (skill)', body);
          } else {
            if (isDebuggingSuggest()) {
              ctx.core.brief('warn', 'suggest', 'brown bag FAILURE (max turns)', 'extracted but empty');
            }
          }
        } else {
          if (isDebuggingSuggest()) {
            ctx.core.brief('warn', 'suggest', 'brown bag FAILURE (max turns)', 'no valid brownbag found after all turns');
          }
        }
        break;
      }
    }
  }
}

// ============================================================================
// Direction Entry Point
// ============================================================================

/**
 * Run the skill probing direction (probe → solve → format).
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
    // Phase 1: Probe
    const signal = await runProbe(
      baseMessages,
      buildProbePrompt(),
      allTools,
      stopRequested,
    );
    if (!signal) {
      ctx.core.verbose('suggest', 'skill: skipped (probe returned nothing)');
      return;
    }

    if (isDebuggingSuggest()) {
      ctx.core.brief('info', 'suggest', 'skill signal', signal);
    }

    // Phase 2: Solve
    const directionTool: Tool[] = allTools.filter(t => t.function.name === 'skill_load');
    if (directionTool.length === 0) {
      ctx.core.verbose('suggest', 'skill: tool "skill_load" not found');
      return;
    }

    const solveMsgs: Message[] = [
      { role: 'assistant', content: signal },
      { role: 'user', content: buildSolvePrompt(signal) },
    ];

    await runSolveLoop(solveMsgs, directionTool, stopRequested, env, mutedCtx);
  } catch (err) {
    ctx.core.verbose('suggest', `skill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
 * Run the background SUGGEST task — single probing direction (skill).
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
      ctx.core.verbose('suggest', `skill direction failed: ${err instanceof Error ? err.message : String(err)}`);
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
