/**
 * bash.ts - Run shell commands with stdin inheritance for interactive commands
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 *
 * Parameters:
 * - command: The shell command to execute
 * - intent: Explain why you want to use this command (mandatory)
 * - elor: Expected line of result (default: 50)
 *   - If output exceeds elor lines, LLM will summarize the result
 *   - Set higher value to read more actual result
 *   - Setting very small numbers (like 0) to enforce summary is discouraged
 * - timeout: Seconds before killing the process (default: 3)
 */

import { execa } from 'execa';
import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';
import { retryChat, MODEL } from '../ollama.js';

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
  description: `Run a shell command (blocking). Set an expected line-of-result using "elor" before you go.`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute. Must be valid bash syntax. Paths are relative to workspace directory.',
      },
      intent: {
        type: 'string',
        description: 'REQUIRED: Explain why this command is needed. This helps the system understand context and enables smarter output summarization when needed.',
      },
      elor: {
        type: 'number',
        description: 'Expected Lines Of Result (default: 50). Output exceeding this limit is summarized. Set higher (100-500) for detailed output like logs or large file listings. Values below 10 are discouraged as they force excessive summarization.',
      },
      timeout: {
        type: 'number',
        description: 'Seconds before terminating the process (default: 3, max recommended: 300). For commands expected to run longer, use bg_create instead.',
      },
    },
    required: ['command', 'intent'],
  },
  scope: ['main', 'child', 'bg'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;
    const intent = args.intent as string;
    const elor = (args.elor as number) ?? 50;
    const timeoutSeconds = (args.timeout as number) ?? 3;

    // Block dangerous commands
    const dangerous = ['rm -rf /', 'sudo rm', 'mkfs', 'dd if=', '> /dev/sd'];
    if (dangerous.some((d) => command.includes(d))) {
      return 'Error: Dangerous command blocked';
    }

    ctx.core.brief('info', 'bash', command, intent);

    const { result, interrupted } = await agentIO.exec((signal) => {
      const subprocess = execa('bash', ['-c', command], {
        cwd: ctx.core.getWorkDir(),
        // Note: stdin defaults to 'pipe' - do NOT use 'inherit' as it causes
        // Ctrl+C to be sent to both parent and child, creating a race condition
        // that prevents reliable interruption
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

    const output = parts.join('\n');

    // Check if we need to summarize
    const lines = output.split('\n');
    const lineCount = lines.length;

    if (lineCount <= elor) {
      return output;
    }

    // Summarize the output
    const summary = await summarizeOutput(output, intent, elor, lineCount, ctx);
    return summary;
  },
};

/**
 * Summarize command output when it exceeds the expected line count
 */
async function summarizeOutput(
  output: string,
  intent: string,
  elor: number,
  totalLines: number,
  ctx: AgentContext
): Promise<string> {
  ctx.core.brief('info', 'bash', `Summarizing ${totalLines} lines (elor: ${elor})`);

  const response = await retryChat({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `Summarize this command output concisely.
User's intent: ${intent}
Total lines: ${totalLines}
Keep the summary under ${elor} lines.
Report the total line count at the start of your response.`
      },
      { role: 'user', content: output }
    ]
  });

  return `Summary of ${totalLines} lines:\n${response.message.content || 'No summary generated'}`;
}