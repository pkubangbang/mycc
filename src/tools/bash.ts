/**
 * bash.ts - Run shell commands with SIGINT handling and popup terminal support
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 */

import { execa } from 'execa';
import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';

/**
 * Find available terminal emulator on the system
 */
function findTerminal(): { cmd: string; args: string[] } | null {
  const terminals = [
    { cmd: 'gnome-terminal', args: ['--', 'bash', '-c'] },
    { cmd: 'xterm', args: ['-e', 'bash', '-c'] },
    { cmd: 'konsole', args: ['-e', 'bash', '-c'] },
    { cmd: 'xfce4-terminal', args: ['-e', 'bash', '-c'] },
    { cmd: 'alacritty', args: ['-e', 'bash', '-c'] },
    { cmd: 'kitty', args: ['bash', '-c'] },
  ];

  for (const term of terminals) {
    try {
      execSync(`which ${term.cmd}`, { stdio: 'pipe' });
      return term;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Run command in a popup terminal for interactive commands
 */
async function runInPopupTerminal(ctx: AgentContext, command: string): Promise<string> {
  const terminal = findTerminal();

  if (!terminal) {
    return `⚠️ No terminal emulator found. Please run directly:\n  ! ${command}`;
  }

  ctx.core.brief('info', 'bash', `Opening popup terminal: ${command}`);

  const cmdWithPause = `${command}; echo ''; echo 'Press Enter to close...'; read`;

  try {
    execSync(`${terminal.cmd} ${terminal.args.join(' ')} "${cmdWithPause}"`, {
      cwd: ctx.core.getWorkDir(),
      encoding: 'utf-8',
      timeout: 300000,
    });
    return `✓ Command completed in popup terminal: ${command}`;
  } catch (err) {
    return `Error in popup: ${(err as Error).message}`;
  }
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Run a shell command (blocking). Press Ctrl+C to interrupt if stuck.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
    },
    required: ['command'],
  },
  scope: ['main', 'child', 'bg'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;

    // Block dangerous commands
    const dangerous = ['rm -rf /', 'sudo rm', 'mkfs', 'dd if=', '> /dev/sd'];
    if (dangerous.some((d) => command.includes(d))) {
      return 'Error: Dangerous command blocked';
    }

    ctx.core.brief('info', 'bash', command);

    // Use AbortController for SIGINT handling
    const abortController = new AbortController();
    let interrupted = false;

    const onSigint = () => {
      interrupted = true;
      abortController.abort();
    };

    process.on('SIGINT', onSigint);

    try {
      const result = await execa('bash', ['-c', command], {
        cwd: ctx.core.getWorkDir(),
        encoding: 'utf8',
        cancelSignal: abortController.signal,
        gracefulCancel: true,
        reject: false, // Don't throw on non-zero exit
      });

      process.off('SIGINT', onSigint);

      if (interrupted) {
        // Ask user if they want popup terminal
        const response = await ctx.core.question(
          `Command was interrupted. Retry in popup terminal? (y/n)`
        );

        if (response.toLowerCase() === 'y') {
          return await runInPopupTerminal(ctx, command);
        }
        return `Command interrupted by user. Output so far:\n${result.stdout}\n${result.stderr}`.slice(0, 50000);
      }

      // Combine stdout and stderr
      const output = result.stdout || result.stderr || '(no output)';
      return output.slice(0, 50000);
    } catch (err) {
      process.off('SIGINT', onSigint);

      if (interrupted) {
        const response = await ctx.core.question(
          `Command was interrupted. Retry in popup terminal? (y/n)`
        );

        if (response.toLowerCase() === 'y') {
          return await runInPopupTerminal(ctx, command);
        }
        return `Command interrupted by user.`;
      }

      return `Error: ${(err as Error).message}`.slice(0, 50000);
    }
  },
};