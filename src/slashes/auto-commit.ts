/**
 * /auto-commit command - inspect and edit the auto-commit branch allow-list.
 *
 * Usage:
 *   /auto-commit                          - show the live list and why a commit
 *                                           on the current branch would (not)
 *                                           be auto-approved
 *   /auto-commit on <b1,b2,...>           - ADD branches to the allow-list
 *   /auto-commit off <b1,b2,...>          - REMOVE branches from the allow-list
 *   /auto-commit off --all                - CLEAR the whole allow-list
 *
 * USER-ONLY BY CONSTRUCTION. Slash commands are dispatched from
 * `src/loop/states/slash.ts`, which is reached only when the human types a `/`
 * at the PROMPT. No tool in the agent's registry can call
 * `slashRegistry.execute`, so the model can never grant itself a commit
 * authorization — the same principle as the `--allow-auto-commit` launch flag.
 *
 * THE LAUNCH FLAG IS THE SEED. `--allow-auto-commit <branches>` (or
 * MYCC_ALLOW_AUTO_COMMIT) seeds the live list at startup; this command edits
 * that live copy for the rest of the session. The flag itself is never mutated,
 * so `/reload` — which respawns the Lead with its original argv — restores the
 * ORIGINAL value and discards every session edit. `off --all` clears the seed
 * too: the live list is the state, and `--all` means everything.
 *
 * GATE SEMANTICS (see src/tools/git_commit.ts):
 *   - a plain `branch` entry authorizes a commit only while auto mode is ON
 *     (auto mode would otherwise auto-DENY the prompt);
 *   - a `branch:autoAdd` entry authorizes regardless of auto mode — that is
 *     what `--allow-auto-commit` has always meant, so the seed carries it;
 *   - plan mode always overrides every grant.
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { agentIO } from '../loop/agent-io.js';
import { autoState, parseAutoCommitEntry, AUTO_ADD_SUFFIX } from '../loop/auto-state.js';

/** Split `/auto-commit on a,b c` into `['a','b','c']`. */
function parseBranchArgs(args: readonly string[]): string[] {
  return args
    .join(',')
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** True when the token list contains the `--all` flag. */
function hasAllFlag(args: readonly string[]): boolean {
  return args.some((a) => a === '--all' || a === '-a');
}

/** Human-readable one-line rendering of an entry, for the report. */
function describeEntry(entry: string): string {
  const { branch, autoAdd } = parseAutoCommitEntry(entry);
  return autoAdd
    ? `${branch}${chalk.gray(` (${AUTO_ADD_SUFFIX}: also skips the prompt outside auto mode)`)}`
    : `${branch}${chalk.gray(' (auto mode only)')}`;
}

/**
 * Resolve the current git branch, or null (detached HEAD / not a repo / git
 * missing). Best-effort: the report must still print when git is unavailable.
 */
async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await agentIO.exec({
      cwd,
      command: 'git rev-parse --abbrev-ref HEAD',
      timeout: 5,
    });
    const branch = stdout.trim();
    if (!branch || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}

/** Print the live list plus the verdict for the current branch. */
async function report(ctx: {
  core: { getWorkDir(): string; getAuto(): boolean; getMode(): string };
}): Promise<void> {
  const entries = autoState.getAutoCommitBranches();
  const autoMode = autoState.getAuto();
  const planMode = ctx.core.getMode() === 'plan';

  console.log(chalk.cyan('\n=== Auto-commit allow-list ===\n'));

  // Provenance + seed state, so "why is this empty?" is answerable from here.
  console.log(
    chalk.gray(
      `Launch seed (--allow-auto-commit): ${autoState.isAutoCommitSeeded() ? 'applied' : 'NOT applied'}`
    )
  );
  console.log(
    chalk.gray(
      `Auto mode: ${autoMode ? chalk.green('ON') : chalk.yellow('off')}   Mode: ${planMode ? chalk.yellow('PLAN') : chalk.green('NORMAL')}`
    )
  );
  console.log();

  if (entries.length === 0) {
    console.log(chalk.gray('  (empty) — no branch is authorized.'));
  } else {
    for (const entry of entries) {
      console.log(`  ${describeEntry(entry)}`);
    }
  }

  // Verdict: name the exact reason a commit would or would not bypass the
  // prompt, so the user can see the effect of the two independent switches
  // (list membership and auto mode) without reading the tool source.
  const branch = await currentBranch(ctx.core.getWorkDir());
  console.log();
  if (branch === null) {
    console.log(chalk.yellow('Current branch: (detached HEAD or not a git repo)'));
    console.log(chalk.gray('  A detached HEAD never matches — commits would prompt normally.'));
    return;
  }

  const authorized = entries
    .map(parseAutoCommitEntry)
    .find((e) => e.branch === branch && (e.autoAdd || autoMode));

  console.log(chalk.white(`Current branch: ${branch}`));
  if (planMode) {
    console.log(
      chalk.yellow('  Verdict: plan mode is ON — every grant is overridden; the commit would ask.')
    );
  } else if (authorized) {
    const why = authorized.autoAdd
      ? `allow-listed with ${AUTO_ADD_SUFFIX}`
      : 'allow-listed and auto mode is on';
    console.log(chalk.green(`  Verdict: auto-approved (${why}) — git_commit skips the prompt.`));
  } else if (entries.some((e) => parseAutoCommitEntry(e).branch === branch)) {
    console.log(
      chalk.yellow(
        '  Verdict: listed, but only a plain entry and auto mode is off — git_commit would ask.'
      )
    );
    console.log(
      chalk.gray(
        `           Add it with autoAdd to skip the prompt now: /auto-commit on ${branch}:${AUTO_ADD_SUFFIX}`
      )
    );
  } else {
    console.log(chalk.yellow('  Verdict: not listed — git_commit would ask.'));
    console.log(
      chalk.gray(
        `           Grant it with: /auto-commit on ${branch} (or ${branch}:${AUTO_ADD_SUFFIX})`
      )
    );
  }

  console.log();
  console.log(chalk.gray('Matching is exact branch names — no globs.'));
  console.log();
}

export const autoCommitCommand: SlashCommand = {
  name: 'auto-commit',
  description: 'View or edit the auto-commit branch allow-list (on <b>|off <b>|off --all)',
  handler: async (context) => {
    const { ctx, args } = context;
    // args[0] is the command itself ('/auto-commit').
    const rest = args.slice(1);
    const sub = (rest[0] || '').toLowerCase();

    // No subcommand: report only.
    if (!sub) {
      await report(ctx);
      return;
    }

    if (sub === 'on') {
      const branches = parseBranchArgs(rest.slice(1));
      if (branches.length === 0) {
        console.log(chalk.red('Usage: /auto-commit on <branch[,branch...]>[:autoAdd]'));
        console.log(
          chalk.gray(
            `  A ":"${AUTO_ADD_SUFFIX} suffix (or "/auto-commit on --auto-add <b>") makes the branch bypass the prompt even outside auto mode.`
          )
        );
        return;
      }
      // `--auto-add` as a standalone flag is sugar for appending the suffix to
      // every listed branch, so the user does not have to repeat it per branch.
      const autoAddFlag = rest.includes('--auto-add') || rest.includes('-a');
      const cleaned = branches.filter((b) => b !== '--auto-add' && b !== '-a');
      if (cleaned.length === 0) {
        console.log(chalk.red('Usage: /auto-commit on <branch[,branch...]>'));
        return;
      }
      const added = ctx.core.addAutoCommitBranches(cleaned, autoAddFlag);
      if (added.length === 0) {
        console.log(chalk.gray('Nothing changed — those branches were already in the list.'));
      } else {
        for (const e of added) {
          console.log(
            chalk.green(
              `Added: ${e.branch}${e.autoAdd ? ` (${AUTO_ADD_SUFFIX})` : ' (auto mode only)'}`
            )
          );
        }
      }
      await report(ctx);
      return;
    }

    if (sub === 'off') {
      if (hasAllFlag(rest.slice(1))) {
        const cleared = ctx.core.clearAutoCommitBranches();
        if (cleared.length === 0) {
          console.log(chalk.gray('The allow-list was already empty.'));
        } else {
          console.log(
            chalk.yellow(`Cleared ${cleared.length} entr${cleared.length === 1 ? 'y' : 'ies'}:`)
          );
          for (const e of cleared) console.log(chalk.gray(`  - ${e}`));
          console.log(
            chalk.gray(
              'Launch-seeded branches are cleared too. /reload restores the original --allow-auto-commit value.'
            )
          );
        }
        return;
      }
      const branches = parseBranchArgs(rest.slice(1));
      if (branches.length === 0) {
        console.log(
          chalk.red('Usage: /auto-commit off <branch[,branch...]> | /auto-commit off --all')
        );
        return;
      }
      const removed = ctx.core.removeAutoCommitBranches(branches);
      if (removed.length === 0) {
        console.log(chalk.gray('Nothing removed — none of those branches were listed.'));
      } else {
        for (const b of removed) console.log(chalk.yellow(`Removed: ${b}`));
      }
      await report(ctx);
      return;
    }

    console.log(chalk.red(`Unknown argument: ${sub}`));
    console.log(
      chalk.gray(
        'Usage: /auto-commit | /auto-commit on <b[,b...]>[:autoAdd] | /auto-commit off <b[,b...]> | /auto-commit off --all'
      )
    );
  },
};
