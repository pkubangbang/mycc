/**
 * /load command - List or load sessions
 *
 * Usage:
 *   /load        - List available sessions
 *   /load <id>   - Load a specific session
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { listSessions, loadSessionById } from '../session/index.js';
import { prepareRestoration, readDosq, extractFirstQuery } from '../session/restoration.js';
import { Triologue } from '../loop/triologue.js';
import { agentIO } from '../loop/agent-io.js';

export const loadCommand: SlashCommand = {
  name: 'load',
  description: 'List or load sessions (/load [id])',
  handler: async (context) => {
    const triologue = context.triologue as Triologue;

    // Check if session is empty
    const isEmpty = !triologue.getMessagesRaw().length;
    if (!isEmpty) {
      console.log(chalk.yellow('Cannot load session: current session already has content.'));
      console.log(chalk.gray('Start a new agent session to load a saved session.'));
      return;
    }

    const args = context.args;

    if (args.length === 1) {
      // List available sessions
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log(chalk.yellow('No saved sessions found.'));
      } else {
        console.log(chalk.cyan('Available sessions:'));
        for (const s of sessions) {
          console.log(chalk.green(`  [${s.id.slice(0, 7)}] ${s.create_time}`));
          console.log(`    workdir: ${s.project_dir}`);
          console.log(`    teammates: ${s.teammates.join(', ') || 'none'}`);
          console.log(`    first words: ${s.first_query || '(none)'}`);
          console.log();
        }
      }
      return;
    }

    // Load specific session
    const sessionId = args[1];
    try {
      const session = loadSessionById(sessionId);
      if (!session) {
        console.log(chalk.red(`Session not found: ${sessionId}`));
        return;
      }

      console.log(chalk.cyan(`Loading session ${sessionId}...`));

      // Prepare restoration
      const { pair, dosqPath } = await prepareRestoration(session);

      console.log(chalk.cyan('Session restored. DOSQ generated at:'));
      console.log(chalk.gray(`  ${dosqPath}`));
      console.log(chalk.yellow('Edit the DOSQ file if needed, then press Enter to continue...'));

      // Wait for user to edit DOSQ
      await agentIO.ask(chalk.cyan('Press Enter when ready to continue > '));

      // Read DOSQ content
      const dosqContent = readDosq(dosqPath);
      const firstQuery = extractFirstQuery(dosqContent);

      console.log(chalk.gray('Starting restored session...\n'));

      // Load triologue with summary pairs (does not trigger onMessage)
      triologue.loadRestoration(pair);

      // Store the first query for the agent loop to process
      context.nextQuery = firstQuery;
    } catch (err) {
      console.log(chalk.red(`Failed to load session: ${(err as Error).message}`));
    }
  },
};