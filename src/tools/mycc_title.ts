/**
 * mycc_title.ts - Change the terminal window/tab title
 *
 * Sets the terminal title using ANSI OSC escape sequences,
 * with a Windows fallback for legacy console hosts.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const myccTitleTool: ToolDefinition = {
  name: 'mycc_title',
  description: `Change the terminal window/tab title. Sets a descriptive title to help identify this mycc session among multiple terminal windows.

Uses ANSI OSC escape sequences supported by most terminal emulators (GNOME Terminal, iTerm2, Windows Terminal, tmux, etc.), with a Windows fallback via process.title.`,
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'The new title for the terminal window. Keep it concise and descriptive.',
      },
    },
    required: ['title'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const title = args.title as string;

    if (!title || typeof title !== 'string') {
      return 'Error: title parameter is required and must be a string';
    }

    // ANSI OSC 0 escape sequence — sets both window title and icon/tab title
    // Format: ESC ] 0 ; <title> BEL
    // Supported by: GNOME Terminal, iTerm2, Windows Terminal, tmux, screen, etc.
    process.stdout.write(`\x1b]0;${title}\x07`);

    // Windows fallback for legacy conhost without VT support
    // process.title also changes the title shown in task manager
    if (process.platform === 'win32') {
      process.title = title;
    }

    ctx.core.brief('info', 'mycc_title', `terminal title set to: "${title}"`);
    return 'OK';
  },
};
