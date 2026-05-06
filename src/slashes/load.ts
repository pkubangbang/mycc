/**
 * /load command - List or load sessions
 *
 * Usage:
 *   /load        - List available sessions
 *   /load <id>   - Load a specific session
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { openEditor } from '../utils/open-editor.js';
import { listSessions, loadSessionById, SessionNotFoundError, AmbiguousSessionError } from '../session/index.js';
import { prepareRestoration, readDosq, extractFirstQuery } from '../session/restoration.js';
import { Triologue } from '../loop/triologue.js';
import { agentIO } from '../loop/agent-io.js';
import { getSessionContext } from '../config.js';

export const loadCommand: SlashCommand = {
  name: 'load',
  description: 'List or load sessions (/load [id])',
  handler: async (context) => {
    const triologue = context.triologue as Triologue;

    // Check if session is empty
    const isEmpty = !triologue.getMessagesRaw().length;
    if (!isEmpty) {
      console.log(chalk.yellow('Cannot load session: current session already has content.'));
      console.log(chalk.gray('Use /clear to clear the current session, or start a new agent session.'));
      return;
    }

    const args = context.args;

    if (args.length === 1) {
      // List available sessions (excluding current session)
      const currentSessionId = getSessionContext();
      const sessions = listSessions().filter(s => s.id !== currentSessionId);
      if (sessions.length === 0) {
        console.log(chalk.yellow('No saved sessions found.'));
      } else {
        console.log(chalk.cyan('Available sessions:'));
        for (const s of sessions) {
          const sourceLabel = s.source === 'user' ? ' (saved)' : '';
          console.log(chalk.green(`  [${s.id.slice(0, 7)}] ${s.create_time}${sourceLabel}`));
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

      // Check working directory
      const currentDir = process.cwd();
      if (currentDir !== session.project_dir) {
        console.log(chalk.yellow(`Session belongs to a different project directory.`));
        console.log(chalk.gray(`  Current: ${currentDir}`));
        console.log(chalk.gray(`  Session expects: ${session.project_dir}`));
        console.log(chalk.cyan(`Spawning new agent in correct directory...`));

        // Request Coordinator to restart in target directory
        if (process.send) {
          process.send({ type: 'restart', sessionId: session.id, cwd: session.project_dir });
          // Wait forever - Coordinator will kill this process
          await new Promise(() => {});
        } else {
          console.log(chalk.red(`Not running under Coordinator. Please restart manually:`));
          console.log(chalk.gray(`  cd "${session.project_dir}" && mycc --session ${session.id}`));
          return;
        }
      }

      // Working directory matches - load session normally
      console.log(chalk.cyan(`Loading session ${sessionId}...`));

      // Prepare restoration
      const { pair, dosqPath } = await prepareRestoration(session);

      console.log(chalk.cyan('Session restored. DOSQ generated at:'));
      console.log(chalk.gray(`  ${dosqPath}`));

      // Try to open DOSQ in editor (will fail if $EDITOR not set, but user was warned at startup)
      try {
        openEditor([dosqPath]);
        console.log(chalk.gray('Opening DOSQ file in editor...'));
      } catch {
        console.log(chalk.yellow(`Please edit the DOSQ file manually: ${dosqPath}`));
      }

      console.log(chalk.yellow('Edit the DOSQ file if needed, then save and close to continue...'));

      // Wait for user to edit DOSQ
      await agentIO.ask(chalk.cyan('Press Enter when ready to continue > '), true);

      // Read DOSQ content
      const dosqContent = readDosq(dosqPath);
      const firstQuery = extractFirstQuery(dosqContent);

      console.log(chalk.gray('Starting restored session...\n'));

      // Load triologue with summary pairs (does not trigger onMessage)
      triologue.loadRestoration(pair);

      // Store the first query for the agent loop to process
      context.nextQuery = firstQuery;
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        console.log(chalk.red(`Session not found: ${sessionId}`));
        return;
      }
      if (err instanceof AmbiguousSessionError) {
        console.log(chalk.red(`Ambiguous session ID. Multiple matches found:`));
        for (const match of err.matches) {
          console.log(chalk.yellow(`  [${match.id.slice(0, 7)}] ${match.source} session`));
        }
        console.log(chalk.gray('Use a longer session ID prefix.'));
        return;
      }
      console.log(chalk.red(`Failed to load session: ${(err as Error).message}`));
    }
  },
};