/**
 * /token command - Show the FULL context budget (used vs allowed)
 *
 * Usage:
 *   /token   - Print an estimate of everything the next LLM call will carry
 *              (system prompt + projectContext + conversation + tools schema)
 *              against the configured context threshold, with a breakdown.
 *
 * IMPORTANT — why this is not just triologue.getTokenCount():
 *   The tracked token counter (getTokenCount) accounts ONLY for the
 *   conversation `messages` slice. The provider actually receives much more on
 *   every call:
 *
 *       system prompt + projectContext + conversation + tool schema
 *
 *   (llm.ts sends `retryChat({ messages: triologue.getMessages(), tools })`,
 *    and getMessages() = system + projectContext + conversation.)
 *
 *   So a fresh session shows a near-zero conversation count while the real
 *   per-call payload already occupies tens of thousands of tokens. This command
 *   uses triologue.getContextBudget(tools) to report the honest total and the
 *   per-part breakdown.
 *
 * Nothing is written back into the conversation, so running /token does not
 * itself consume context.
 */

import type { SlashCommand } from '../types.js';
import { loader } from '../context/shared/loader.js';
import { buildNormalModePrompt, buildPlanModePrompt, isInPlanMode } from '../loop/prompts/lead.js';
import chalk from 'chalk';

interface BudgetTriologue {
  getContextBudget(
    tools?: unknown[],
    systemPromptOverride?: string
  ): {
    total: number;
    system: number;
    projectContext: number;
    conversation: number;
    tools: number;
  };
  getTokenThreshold(): number;
  /** The system prompt currently set on the store (null before the first LLM
   *  call of a session, since llm.ts builds it lazily per turn). */
  getSystemPrompt?(): string | null;
  /** Legacy/conversation-only counter, shown for reference. */
  getTokenCount?(): number;
  getMessagesRaw?(): unknown[];
}

/**
 * Build a 24-cell bar visualizing the used/allowed ratio, with the used
 * portion split into its two character classes:
 *
 *   [ reserved (system+tools) | dynamic (context+chat) | free ]
 *
 * The reserved segment is drawn in a distinct colour so the model's FIXED
 * per-call floor reads apart from the dynamic tokens.
 */
function renderBar(ratio: number, reservedRatio: number, width = 24): string {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const used = Math.round(clamp(ratio) * width);
  const reserved = Math.min(used, Math.round(clamp(reservedRatio) * width));
  const dynamic = used - reserved;
  const free = width - used;
  return (
    chalk.hex('#e5c07b')('█'.repeat(reserved)) +
    chalk.cyan('█'.repeat(dynamic)) +
    chalk.gray('░'.repeat(free))
  );
}

/** Colour a token number by how much of the budget it consumes. */
function tint(value: number, ratio: number): string {
  const text = value.toLocaleString();
  if (ratio >= 0.8) return chalk.red.bold(text);
  if (ratio >= 0.5) return chalk.yellow.bold(text);
  return chalk.green.bold(text);
}

export const tokenCommand: SlashCommand = {
  name: 'token',
  description: 'Show full context budget (system + context + tools + chat vs allowed)',
  aliases: ['tokens'],
  handler: (context) => {
    const triologue = context.triologue as BudgetTriologue;

    // Defensive: a non-triologue context (tests / odd wiring) shouldn't crash
    // the SLASH state. Report clearly instead of throwing.
    if (
      !triologue ||
      typeof triologue.getContextBudget !== 'function' ||
      typeof triologue.getTokenThreshold !== 'function'
    ) {
      console.log(
        chalk.yellow('Token info unavailable: triologue does not expose context-budget stats.')
      );
      return;
    }

    // /token runs in the lead's main loop, so the tool set the next LLM call
    // will send is the 'main' scope schema.
    let tools: unknown[];
    try {
      tools = loader.getToolsForScope('main');
    } catch {
      tools = [];
    }

    // The system prompt is built LAZILY inside the LLM stage (llm.ts), so the
    // store's copy is null before a session's first call. For an accurate
    // pre-first-call estimate, build the same prompt here and pass it as an
    // override when the store has none.
    let systemPromptOverride: string | undefined;
    const stored =
      typeof triologue.getSystemPrompt === 'function' ? triologue.getSystemPrompt() : null;
    if (!stored) {
      try {
        const workDir = context.ctx.core.getWorkDir();
        const hasTeam = context.ctx.team.printTeam() !== 'No teammates.';
        systemPromptOverride = isInPlanMode(context.ctx)
          ? buildPlanModePrompt(workDir, hasTeam)
          : buildNormalModePrompt(workDir, undefined, hasTeam);
      } catch {
        systemPromptOverride = undefined;
      }
    }

    const budget = triologue.getContextBudget(tools, systemPromptOverride);
    const allowed = triologue.getTokenThreshold();
    const ratio = allowed > 0 ? budget.total / allowed : 0;
    const percent = (ratio * 100).toFixed(1);
    const reserved = budget.system + budget.tools;
    const reservedRatio = allowed > 0 ? reserved / allowed : 0;

    console.log(chalk.cyan('\n=== Context Budget ===\n'));
    console.log(
      `  ${tint(budget.total, ratio)}${chalk.gray(' / ')}${chalk.white(allowed.toLocaleString())}${chalk.gray(` tokens  (${percent}%)`)}`
    );
    console.log(`  ${renderBar(ratio, reservedRatio)}`);
    console.log(
      `  ${chalk.hex('#e5c07b')('▄')}${chalk.gray(' reserved (system+tools)  ')}${chalk.cyan('▄')}${chalk.gray(' dynamic (context+chat)')}`
    );
    console.log();

    // Per-part breakdown — the four contributors the provider receives.
    // Kept in the default colour; the reserved/dynamic split is carried by the
    // BAR above, not by tinting the numbers.
    const row = (label: string, value: number) =>
      console.log(
        `  ${chalk.gray(label.padEnd(16))}${chalk.white(value.toLocaleString().padStart(10))}`
      );
    row('system prompt', budget.system);
    row('project context', budget.projectContext);
    row('conversation', budget.conversation);
    row(`tools (${tools.length})`, budget.tools);

    const messages =
      typeof triologue.getMessagesRaw === 'function'
        ? triologue.getMessagesRaw().length
        : undefined;
    if (messages !== undefined) {
      console.log(
        chalk.gray(`  ${'messages'.padEnd(16)}${messages.toLocaleString().padStart(10)}`)
      );
    }

    console.log(
      chalk.gray(
        `\n  remaining: ${Math.max(0, allowed - budget.total).toLocaleString()} tokens before auto-compact`
      )
    );
    console.log(
      chalk.gray('  note: estimates (heuristic), and excludes per-call overhead the provider adds.')
    );
    console.log();
  },
};
