/**
 * /auto-commit command - Inspect and edit the runtime auto-commit allow-list
 *
 * Usage:
 *   /auto-commit                 - Show the current allow-list
 *   /auto-commit on <branch>     - Add one branch to the allow-list
 *   /auto-commit off <branch>    - Remove one branch from the allow-list
 *   /auto-commit off --all       - Clear the allow-list (feature OFF)
 *
 * WHERE THE STATE LIVES: on the agent context — `ctx.core.*` (BaseCore), right
 * next to `workDir`. That is deliberate: the allow-list is runtime, session
 * state, not configuration. `src/config.ts` only PARSES the launch flag
 * (`getAllowAutoCommitArg()`), and the context seeds its list from it once at
 * construction. This command is the only writer afterwards.
 *
 * Nothing is persisted: a runtime change lives for this session only, and a
 * restart re-seeds the list from the launch flag.
 *
 * `/reload` DOES NOT INHERIT RUNTIME EDITS. The slash respawns the lead by
 * REPLAYING its original launch argv (`collectReloadLeadArgs` in
 * src/slashes/reload.ts), so the new process re-seeds the list from
 * `--allow-auto-commit` alone — a runtime `on` is lost, and a runtime
 * `off --all` is undone back to the launch list.
 *
 * WHY THIS IS SAFE: the grant is consumed by `git_commit` only when auto mode
 * is on, plan mode is off, and the current branch matches an entry exactly.
 * Slash commands are typed by the HUMAN, never invocable by the LLM, so
 * exposing a runtime toggle here keeps the original "the agent can never
 * self-grant" guarantee.
 */

import type { SlashCommand, SlashCommandContext } from '../types.js';
import chalk from 'chalk';

/** Render the allow-list, or an explicit OFF line when empty. */
function printList(context: SlashCommandContext): void {
  const branches = context.ctx.core.getAllowAutoCommitBranches();
  if (branches.length === 0) {
    console.log(chalk.gray('auto-commit allow-list is empty (feature OFF).'));
    console.log(chalk.gray('Use /auto-commit on <branch> to pre-authorize a branch.'));
    return;
  }
  console.log(chalk.cyan(`auto-commit allow-list (${branches.length} branch${branches.length === 1 ? '' : 'es'}):`));
  for (const b of branches) {
    console.log(chalk.white(`  - ${b}`));
  }
  console.log(chalk.gray('Exact match, no globs. Applies only in auto mode outside plan mode.'));
}

/** Print the full command usage (used for every malformed invocation). */
function printUsage(): void {
  console.log(chalk.gray('Usage:'));
  console.log(chalk.white('  /auto-commit              ') + chalk.gray('- show the current allow-list'));
  console.log(chalk.white('  /auto-commit on <branch>  ') + chalk.gray('- add a branch'));
  console.log(chalk.white('  /auto-commit off <branch> ') + chalk.gray('- remove a branch'));
  console.log(chalk.white('  /auto-commit off --all    ') + chalk.gray('- clear the list'));
}

export const autoCommitCommand: SlashCommand = {
  name: 'auto-commit',
  description: 'Show or edit the runtime auto-commit allow-list (on <branch> / off <branch> / off --all)',
  handler: (context: SlashCommandContext) => {
    const { args, ctx } = context;
    const core = ctx.core;
    // args[0] is the command itself ('/auto-commit'); the rest are operands.
    const rest = args.slice(1);

    // ── no operand: display current state ────────────────────────────────
    if (rest.length === 0) {
      printList(context);
      return;
    }

    const sub = rest[0].toLowerCase();

    // ── on <branch> ──────────────────────────────────────────────────────
    if (sub === 'on') {
      const branch = rest[1];
      if (!branch) {
        console.log(chalk.red('Missing branch for /auto-commit on <branch>.'));
        printUsage();
        return;
      }
      const added = core.addAllowAutoCommitBranch(branch);
      if (added) {
        console.log(chalk.green(`Added '${branch.trim()}' to the auto-commit allow-list.`));
      } else {
        console.log(chalk.gray(`'${branch.trim()}' is already in the auto-commit allow-list.`));
      }
      printList(context);
      return;
    }

    // ── off <branch> | off --all ─────────────────────────────────────────
    if (sub === 'off') {
      const target = rest[1];
      if (!target) {
        console.log(chalk.red('Missing branch (or --all) for /auto-commit off.'));
        printUsage();
        return;
      }
      if (target === '--all') {
        const cleared = core.clearAllowAutoCommitBranches();
        if (cleared.length === 0) {
          console.log(chalk.gray('auto-commit allow-list was already empty.'));
        } else {
          console.log(chalk.yellow(`Cleared the auto-commit allow-list (${cleared.join(', ')}).`));
        }
        printList(context);
        return;
      }
      const removed = core.removeAllowAutoCommitBranch(target);
      if (removed) {
        console.log(chalk.green(`Removed '${target.trim()}' from the auto-commit allow-list.`));
      } else {
        console.log(chalk.gray(`'${target.trim()}' was not in the auto-commit allow-list.`));
      }
      printList(context);
      return;
    }

    console.log(chalk.red(`Unknown /auto-commit subcommand: ${rest[0]}`));
    printUsage();
  },
};
