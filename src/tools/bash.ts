/**
 * bash.ts - Run shell commands with stdin inheritance for interactive commands
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 */

import { execa } from 'execa';
import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';

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
      timeout: 300000, // 5 min max
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
      timeout: {
        type: 'number',
        description: 'Seconds before killing the process (default: 3)',
      },
    },
    required: ['command'],
  },
  scope: ['main', 'child', 'bg'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;
    const timeoutSeconds = (args.timeout as number) ?? 3;

    // Block dangerous commands
    const dangerous = ['rm -rf /', 'sudo rm', 'mkfs', 'dd if=', '> /dev/sd'];
    if (dangerous.some((d) => command.includes(d))) {
      return 'Error: Dangerous command blocked';
    }

    ctx.core.brief('info', 'bash', command);

    const { result, interrupted } = await agentIO.exec((signal) => {
      const subprocess = execa('bash', ['-c', command], {
        cwd: ctx.core.getWorkDir(),
        stdin: 'inherit',
        stdout: 'pipe',
        stderr: 'pipe',
        encoding: 'utf8',
        cancelSignal: signal,
        gracefulCancel: true,
        reject: false,
        timeout: timeoutSeconds * 1000,
      });

      // Pipe output to console in real-time while capturing
      subprocess.stdout?.pipe(process.stdout);
      subprocess.stderr?.pipe(process.stderr);

      return subprocess;
    });

    if (interrupted) {
      // Only ask about popup terminal in main process
      if (agentIO.isMainProcess()) {
        const response = await agentIO.ask('Command interrupted. Retry in popup terminal? (y/n)');
        if (response.toLowerCase() === 'y') {
          return await runInPopupTerminal(ctx, command);
        }
      }
      return 'Command interrupted by user.';
    }

    // Check if command failed
    if (result instanceof Error) {
      if ((result as any).timedOut) {
        return `${timeoutSeconds} seconds passed and the command did not finish. Set a longer timeout or use bg tools`;
      }
      return `Error: ${result.message}`;
    }

    // Build LLM-friendly output
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const exitCode = result.exitCode ?? 0;

    const parts: string[] = [];

    // Status line
    if (exitCode === 0) {
      parts.push(`Command completed successfully (exit: ${exitCode})`);
    } else {
      parts.push(`Command failed (exit: ${exitCode})`);
    }

    // Output sections with clear labels
    if (stdout.trim()) {
      parts.push(`\n[stdout]\n${stdout.trim()}`);
    }

    if (stderr.trim()) {
      parts.push(`\n[stderr]\n${stderr.trim()}`);
    }

    return parts.join('\n');
  },
};