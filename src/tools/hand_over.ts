/**
 * hand_over.ts - Interactive terminal popup
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

export const handOverTool: ToolDefinition = {
  name: 'hand_over',
  description: `⚠️ INTERRUPTS USER - Opens a popup terminal and BLOCKS until user interaction.

DO NOT USE THIS TOOL unless the user EXPLICITLY requests an interactive terminal,
or the command REQUIRES user interaction (passwords, prompts, SSH sessions).

For MOST commands, use 'bash' tool instead - it runs non-interactively without interrupting the user.

Use ONLY when:
- User explicitly asks for a terminal/shell/SSH session
- Command requires interactive input (password prompts, y/n confirmations, menu selections)
- Interactive programs: vim, htop, watch, tmux, screen, mc, ranger
- SSH sessions with password authentication
- Interactive git operations (rebase -i, add -p, commit with editor)

NEVER use for:
- Running tests, builds, npm commands
- File operations (ls, cat, cp, mv, rm)
- Git automation (status, log, push, pull, clone)
- Package management (npm install, pip install)
- Any command that CAN run non-interactively

When in doubt, use 'bash' tool with appropriate timeout.`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Initial command to run in the terminal.',
      },
      justification: {
        type: 'string',
        description: 'REQUIRED: Justify why this command MUST be interactive and cannot use bash tool instead. What user input is expected?',
      },
    },
    required: ['command', 'justification'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    return handleHandOver(ctx, args);
  },
};

async function handleHandOver(ctx: AgentContext, args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  const justification = args.justification as string;
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
    ctx.core.brief('error', 'hand_over', 'tmux not found', installInstructions);
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
  } catch (e) {
    return `Error: Failed to create session: ${e}`;
  }

  // 3. Track session in todo
  ctx.todo.patchTodoList([{
    name: `hand_over: ${sessionName}`,
    done: false,
    note: command,
  }]);

  // 4. Open popup terminal
  try {
    await execAsync(`${terminalLauncher} -- tmux attach -t ${sessionName}`);
  } catch {
    // Terminal launcher may exit immediately, that's fine
  }

  ctx.core.brief('info', 'hand_over', `Opened: ${sessionName}`, justification);

  // 5. Wait for user confirmation and capture output
  const answer = await agentIO.ask(
    chalk.cyan(`Save tmux session? [y/N] > `)
  );
  const keepSession = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';

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
    name: `hand_over: ${sessionName}`,
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
  const header = `User ran: ${command}`;
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
  command: string,
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
        content: `Command: ${command}\n\n${output}`
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