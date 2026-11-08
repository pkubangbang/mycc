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
      if (stringWidth(`${built + ch}...`) > maxTitleLen) break;
      built += ch;
    }
    displayTitle = `${built}...`;
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

  process.stdout.write(`\n${bar(' '.repeat(width))}\n${text(centered)}\n${bar(' '.repeat(width))}\n` + `\n`);
}

/**
 * Strip any "mycc" prefix variant from the title so we can apply the
 * canonical "mycc: " prefix. Handles:
 *   "mycc: foo"     → "foo"
 *   "mycc foo"      → "foo"
 *   "mycc - foo"    → "foo"
 *   "mycc : foo"    → "foo"
 *   "MyCC: foo"     → "foo"   (case-insensitive)
 *   "  mycc: foo  " → "foo"   (whitespace-tolerant)
 *   "fixing bash"   → "fixing bash"  (no prefix, passed through)
 */
function normalizeTitle(raw: string): string {
  // Strip leading "mycc" prefix (case-insensitive) with optional separator.
  // The alternation |\s*mycc\s+ is NOT anchored — it would match "mycc" mid-title
  // and corrupt content like "fix mycc bug" → "fixbug".
  const stripped = raw
    .trim()
    .replace(/^\s*mycc\s*(?:[-:]\s*)?/i, '')
    .trim();
  return stripped ? `mycc: ${stripped}` : 'mycc';
}

export const myccTitleTool: ToolDefinition = {
  name: 'mycc_title',
  description: [
    'Mark the end of a paragraph so the human can navigate the work by chapter.',
    '',
    'A call does two things at once:',
    '',
    '  1. It DRAWS A LINE. Everything before this point closes as one paragraph — the',
    '     transcript up to the previous title is archived into a single summary heading,',
    '     and the title you pass is the heading for the work now in progress.',
    '  2. It PAINTS THE SIGN. A bright banner across the terminal plus a new window/tab',
    '     title, so each mycc window is identifiable at a glance.',
    '',
    'The same title twice is a no-op for the reader. The "mycc:" prefix is added for',
    'you. Returns "OK". See the `set-title` skill for when to place a title and how to',
    'phrase it.'
  ].join('\n'),
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'The heading for the paragraph you are closing — under 40 chars, e.g. "fixing the bash timeout" or "peer wire reconnect". The "mycc: " prefix is added automatically.'
      }
    },
    required: ['title']
  },
  // MAIN-ONLY: every side effect of this tool lands on the terminal channel
  // (OSC title sequence on process.stdout, process.title on win32, printBanner).
  // Teammates are spawned with stdio ['pipe','pipe','pipe','ipc']
  // (context/parent/team.ts), so none of that ever reaches the user's view —
  // exposing the tool to a child is pure noise in its schema.
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const rawTitle = args.title as string;

    if (!rawTitle || typeof rawTitle !== 'string') {
      return 'Error: title parameter is required and must be a string';
    }

    // Normalize: strip any "mycc" prefix variant the agent may have included,
    // then apply the canonical "mycc: " prefix consistently.
    const title = normalizeTitle(rawTitle);

    // Decoration gate: the plain-output verdict is relayed through the context
    // (ctx.core.isPlainOutput()) instead of reading config's env predicate
    // directly, so the tool depends only on its declared ctx contract and stays
    // testable with a stub context. When plain, skip the OSC escape and the
    // banner — but `process.title` below is still set, because it is process
    // state (what Task Manager shows), not terminal output.
    const plain = ctx.core.isPlainOutput();

    if (!plain) {
      // ANSI OSC 0 escape sequence — sets both window title and icon/tab title
      // Format: ESC ] 0 ; <title> BEL
      // Supported by: GNOME Terminal, iTerm2, Windows Terminal, tmux, screen, etc.
      process.stdout.write(`\x1b]0;${title}\x07`);
    }

    // Windows fallback for legacy conhost without VT support
    // process.title also changes the title shown in task manager
    if (process.platform === 'win32') {
      process.title = title;
    }

    // Print prominent banner so user can quickly identify the session
    if (!plain) {
      printBanner(title);
    }

    return 'OK';
  }
};
