/**
 * tmux.ts - Interactive terminal popup
 *
 * Scope: ['main'] - Lead agent only (requires GUI terminal)
 *
 * Composes: todo + bash(tmux) + question + LLM summarize
 *
 * Flow:
 * 1. Create tmux session in cwd
 * 2. Open external terminal
 * 3. Wait for user to work
 * 4. User presses Enter to capture & kill, or 'k' to keep
 * 5. Capture and summarize output
 * 6. Kill or keep session based on user choice
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { agentIO } from '../loop/agent-io.js';
import { retryChat, MODEL } from '../ollama.js';

const execAsync = promisify(exec);

export const tmuxTool: ToolDefinition = {
  name: 'tmux',
  description: `Open an interactive terminal popup for user work.

User can run commands, SSH to servers, use interactive programs (vim, htop).
When done, user returns to mycc and presses Enter to capture result.

Use when:
- Commands need user interaction (prompts, passwords)
- SSH sessions to remote servers
- Interactive programs (vim, htop, watch)
- Any task needing direct terminal access`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Initial command (optional). Opens shell if not provided.',
      },
      reason: {
        type: 'string',
        description: 'REQUIRED: Why open terminal? Helps user understand expectations.',
      },
    },
    required: ['reason'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    return handleTmux(ctx, args);
  },
};

async function handleTmux(ctx: AgentContext, args: Record<string, unknown>): Promise<string> {
  const command = args.command as string | undefined;
  const reason = args.reason as string;
  const isWin = process.platform === 'win32';

  // 1. Prerequisites
  if (!hasTmux()) {
    const installInstructions = isWin
      ? 'Windows: Install psmux and ensure it is in PATH'
      : 'Installation:\n' +
        '  Ubuntu/Debian: sudo apt install tmux\n' +
        '  macOS: brew install tmux\n' +
        '  Fedora: sudo dnf install tmux\n' +
        '  Arch Linux: sudo pacman -S tmux';
    ctx.core.brief('error', 'tmux', 'tmux not found', installInstructions);
    return `Error: tmux is required but not installed. See brief output for installation instructions.`;
  }

  const terminalLauncher = detectTerminalLauncher();
  if (!terminalLauncher) {
    return `Error: No external terminal. Use bash tool for non-interactive commands.`;
  }

  // 2. Create session
  const cwd = ctx.core.getWorkDir();
  const sessionName = `mycc-${Date.now()}`;

  try {
    if (command) {
      if (isWin) {
        await execAsync(
          `tmux new-session -d -s ${sessionName} -c "${cwd}" -x 120 -y 40 ` +
          `"cmd /k ${command}"`
        );
      } else {
        // Encode command to avoid shell escaping issues
        const encoded = Buffer.from(command).toString('base64');
        await execAsync(
          `tmux new-session -d -s ${sessionName} -c "${cwd}" -x 120 -y 40 ` +
          `"bash -c 'eval \\$(echo ${encoded} | base64 -d); exec bash'"`
        );
      }
    } else {
      if (isWin) {
        await execAsync(`tmux new-session -d -s ${sessionName} -c "${cwd}" -x 120 -y 40 "cmd"`);
      } else {
        await execAsync(`tmux new-session -d -s ${sessionName} -c "${cwd}" -x 120 -y 40`);
      }
    }
  } catch (e) {
    return `Error: Failed to create session: ${e}`;
  }

  // 3. Track session in todo
  ctx.todo.patchTodoList([{
    name: `tmux: ${sessionName}`,
    done: false,
    note: command || '(shell)',
  }]);

  // 4. Open popup terminal
  try {
    await execAsync(`${terminalLauncher} -- tmux attach -t ${sessionName}`);
  } catch {
    // Terminal launcher may exit immediately, that's fine
  }

  ctx.core.brief('info', 'tmux', `Opened: ${sessionName}`, reason);

  // 5. Wait for user confirmation and capture output
  const answer = await agentIO.ask(
    chalk.cyan(`Press Enter to capture & kill, or 'k' to keep session > `)
  );
  const keepSession = answer.toLowerCase() === 'k' || answer.toLowerCase() === 'keep';

  // 6. Capture output
  let output = '';
  let sessionExists = false;

  try {
    const { stdout } = await execAsync(
      `tmux capture-pane -t ${sessionName} -p -S -3000 -E -1`
    );
    output = stdout;
    sessionExists = true;
  } catch {
    // Session may have been closed by user
  }

  // 7. Cleanup if not keeping
  if (sessionExists && !keepSession) {
    try {
      await execAsync(`tmux kill-session -t ${sessionName}`);
    } catch {
      // Already dead
    }
  }

  // 8. Update todo
  ctx.todo.patchTodoList([{
    name: `tmux: ${sessionName}`,
    done: true,
    note: keepSession ? 'kept' : 'killed',
  }]);

  // 9. Summarize if needed
  const maxLines = 100;
  const lines = output.split('\n');
  const result = lines.length > maxLines
    ? await summarizeOutput(output, command, maxLines)
    : output || '(empty output)';

  // 10. Build and return result
  const header = command ? `User ran: ${command}` : `User worked in terminal`;
  const status = keepSession
    ? `Session: ${sessionName} (kept)\nTo reattach: tmux attach -t ${sessionName}`
    : `Session: ${sessionName} (killed)`;

  return `${header}\n${status}\nOutput (${lines.length} lines):\n\n${result}`;
}

/**
 * Summarize long terminal output using LLM
 */
async function summarizeOutput(
  output: string,
  command: string | undefined,
  maxLines: number
): Promise<string> {
  const response = await retryChat({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `Summarize terminal output. Keep under ${maxLines} lines. Preserve errors and exit codes.`
      },
      {
        role: 'user',
        content: `${command ? `Command: ${command}\n\n` : ''}${output}`
      }
    ]
  });
  return response.message.content || '(summarization failed)';
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Detect available terminal launcher for the current platform
 */
function detectTerminalLauncher(): string | null {
  // macOS
  if (process.platform === 'darwin') {
    return 'open -a Terminal.app --args';
  }

  // Linux - check common terminals
  const terminals = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'mate-terminal', 'xterm'];
  for (const term of terminals) {
    if (whichSync(term)) {
      return term;
    }
  }

  // Windows
  if (process.platform === 'win32') {
    if (whichSync('wt')) return 'wt';
    if (whichSync('cmd')) return 'cmd /c start cmd /k';
  }

  return null;
}

/**
 * Check if tmux is available
 */
function hasTmux(): boolean {
  return whichSync('tmux');
}

/**
 * Synchronous which/where command
 */
function whichSync(cmd: string): boolean {
  const isWin = process.platform === 'win32';
  try {
    execSync(isWin ? `where ${cmd}` : `which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}