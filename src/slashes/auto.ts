/**
 * /auto command - Toggle autonomous (auto) mode for the lead process
 *
 * Usage:
 *   /auto   - Enter auto mode
 *
 * Auto mode is ORTHOGONAL to plan/normal mode: it only changes the agent
 * loop so the PROMPT stage is replaced by an AWAIT stage (block for mail /
 * teammate state changes / webui steering notes instead of prompting the
 * user), and every interactive question() auto-replies with its onEsc
 * default so the loop never blocks. Plan/normal mode stays active —
 * entering auto while in plan mode keeps code changes prohibited.
 *
 * To EXIT auto mode, press ESC (same as the "neglection" path): the STOP
 * handler clears the auto flag and the prompt resumes.
 *
 * The original motivation is "autonomous mycc": multiple mycc instances can
 * chain by writing to each other's mailbox, each blocking in AWAIT until
 * roused by an incoming mail, forming a workflow without human prompting.
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { autoState } from '../loop/auto-state.js';

export const autoCommand: SlashCommand = {
  name: 'auto',
  description: 'Enter autonomous mode (auto-reply, no prompt; press esc to exit)',
  handler: (context) => {
    const { ctx } = context;

    if (ctx.core.getAuto()) {
      console.log(chalk.gray('Already in auto mode. Press esc to exit.'));
      return;
    }

    // Single source of truth: autoState owns the flag (and streak). Core and
    // AgentIO both delegate to it, so one call flips both and mirrors to webui
    // via the onAutoChange callback. The /auto command resets the streak so
    // this manual entry doesn't immediately count toward a re-autofly.
    autoState.resetStreak();
    autoState.setAuto(true);
    console.log(chalk.cyan('auto mode is on. Mails will be auto-replied. Press esc to exit.'));
  },
};