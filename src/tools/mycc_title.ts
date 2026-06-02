/**
 * mycc_title.ts - Change the terminal window/tab title
 *
 * Sets the terminal title using ANSI OSC escape sequences,
 * with a Windows fallback for legacy console hosts.
 * Also prints a prominent banner to stdout so users can
 * quickly identify the session among multiple terminal windows.
 */

import chalk from 'chalk';
import stringWidth from 'string-width';
import type { ToolDefinition, AgentContext } from '../types.js';

/**
 * Get terminal width, defaulting to 80 if unavailable
 */
function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

/**
 * Print a prominent banner to stdout showing the new terminal title.
 * Uses a bright yellow background bar that spans the full terminal width
 * for maximum visibility — the user can instantly spot it when scrolling.
 */
function printBanner(title: string): void {
  const width = Math.min(getTerminalWidth(), 80);

  // Truncate title if too long (leave room for padding, respecting CJK width)
  const maxTitleLen = width - 6; // 3 chars padding on each side
  let displayTitle = title;
  if (stringWidth(title) > maxTitleLen) {
    // Build title char by char to respect fullwidth characters
    let built = '';
    for (const ch of title) {
      if (stringWidth(`${built + ch  }...`) > maxTitleLen) break;
      built += ch;
    }
    displayTitle = `${built  }...`;
  }

  // Center the title text within the full-width bar
  const label = `  ${displayTitle}  `;
  // eslint-disable-next-line no-control-regex
  const stripped = label.replace(/\x1b\[[0-9;]*m/g, '');
  const labelWidth = stringWidth(stripped);
  const padLeft = Math.floor((width - labelWidth) / 2);
  const padRight = width - labelWidth - padLeft;
  const centered = ' '.repeat(padLeft) + label + ' '.repeat(padRight);

  // Build a 3-line bright yellow banner:
  // 1. blank yellow bar (top padding)
  // 2. centered title on yellow background, black bold text
  // 3. blank yellow bar (bottom padding)
  const bar = chalk.bgYellow.black;
  const text = chalk.bgYellow.black.bold;

  process.stdout.write(
    `\n${ 
    bar(' '.repeat(width))  }\n${ 
    text(centered)  }\n${ 
    bar(' '.repeat(width))  }\n` +
    `\n`
  );
}

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

    // Print prominent banner so user can quickly identify the session
    printBanner(title);

    return 'OK';
  },
};
