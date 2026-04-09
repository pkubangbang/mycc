/**
 * /save command - Save session to user directory
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { saveToUserDir, getSessionId } from '../session/index.js';

export const saveCommand: SlashCommand = {
  name: 'save',
  description: 'Save current session to ~/.mycc/sessions',
  handler: (context) => {
    try {
      const destPath = saveToUserDir(context.sessionFilePath);
      const sessionId = getSessionId(destPath);
      console.log(chalk.green(`Session saved to ~/.mycc/sessions`));
      console.log(chalk.gray(`Use /load ${sessionId} to restore this session.`));
    } catch (err) {
      console.log(chalk.red(`Failed to save session: ${(err as Error).message}`));
    }
  },
};