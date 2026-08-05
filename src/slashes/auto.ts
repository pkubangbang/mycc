/**
 * /auto command - Toggle autonomous (auto) mode for the lead process
 *
 * Usage:
 *   /auto   - Enter auto mode
 *
 * Auto mode is ORTHOGONAL to plan/normal mode: it only changes the agent
 * loop so the PROMPT stage is replaced by a WAIT stage (block for mail /
 * teammate state changes / webui steering notes instead of prompting the
 * user), and every interactive question() auto-replies with its onEsc
 * default so the loop never blocks. Plan/normal mode stays active —
 * entering auto while in plan mode keeps code changes prohibited.
 *
 * To EXIT auto mode, press ESC (same as the "neglection" path): the STOP
 * handler clears the auto flag and the prompt resumes.
 *
 * The original motivation is "autonomous mycc": multiple mycc instances can
 * chain by writing to each other's mailbox, each blocking in WAIT until
 * roused by an incoming mail, forming a workflow without human prompting.
 */

import type { SlashCommand } from '../types.js';
import type { Core } from '../context/parent/core.js';
import chalk from 'chalk';
import { agentIO } from '../loop/agent-io.js';

export const autoCommand: SlashCommand = {
  name: 'auto',
  description: 'Enter autonomous mode (auto-reply, no prompt; press esc to exit)',
  handler: (context) => {
    const { ctx } = context;
    const core = ctx.core as Core;

    if (core.getAuto()) {
      console.log(chalk.gray('Already in auto mode. Press esc to exit.'));
      return;
    }

    core.setAuto(true);
    agentIO.setAuto(true);
    console.log(chalk.cyan('auto mode is on. Mails will be auto-replied. Press esc to exit.'));
  },
};