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
import { spawn, exec, execSync } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { agentIO } from '../loop/agent-io.js';
import { parseIntent } from '../context/grant/intent-parser.js';
import { retryChat, MODEL } from '../engine/chat-provider.js';

const execAsync = promisify(exec);

export const handOverTool: ToolDefinition = {
  name: 'hand_over',
  description: `⚠️ INTERRUPTS USER - Opens a popup terminal and BLOCKS until user interaction.

DO NOT USE THIS TOOL unless the user EXPLICITLY requests an interactive terminal,
or the command REQUIRES user interaction (passwords, prompts, SSH sessions).

When calling this tool, you MUST provide an \`intent\` parameter using the intent language format.
The OBJECT must indicate that user interaction is required.

See the "hand_over usage" subsection under Grant System in MYCC.md (retrievable via get_node) for the spelled-out RUN USER intent rule, the multi-line command note, and worked examples.

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
      intent: {
        type: 'string',
        description:
          'REQUIRED: Explain why this command is needed. You MUST use the intent language to show your idea.',
      },
    },
    required: ['command', 'intent'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    return handleHandOver(ctx, args);
  },
};

async function handleHandOver(ctx: AgentContext, args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  const intent = args.intent as string;
  const isWin = process.platform === 'win32';

  // 1. Validate intent: must use RUN USER to confirm user interaction is needed.
  // Socratic hint: name the wrong DIMENSION (object vs verb), withhold the correct
  // token so the LLM re-reasons from the always-on verb/object tables rather than
  // copying a spoon-fed answer.
  const parsed = parseIntent(intent);
  if (!parsed) {
    return `Intent format is: VERB OBJECT [key=value ...] TO PURPOSE. Re-read the verb/object tables and try again.`;
  }
  if (parsed.object !== 'USER') {
    return (
      `hand_over opens a terminal popup for a human to type into (e.g. a sudo password). ` +
      `Your OBJECT "${parsed.object}" doesn't match that. Reconsider which OBJECT in your table means "a human interacting with a terminal," then retry.`
    );
  }
  if (parsed.verb !== 'RUN') {
    return `hand_over executes the command in that popup. Your OBJECT is right, but your VERB "${parsed.verb}" doesn't mean "execute a command or process." Reconsider which VERB fits, then retry.`;
  }

  // 2. Prerequisites
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

  // 2b. tmux nesting self-check.
  // If mycc itself runs inside tmux ($TMUX set) and the command tries to attach
  // to / switch to another tmux session, tmux refuses ("sessions should be nested
  // with care"). Reject up front with actionable alternatives.
  // NOTE: only attach/switch-client cause nesting; new-session/kill-session/
  // send-keys are safe to run from inside tmux and are intentionally NOT blocked.
  const innerTmux = process.env.TMUX;
  if (innerTmux) {
    // Regex covers: tmux [flags] (attach|a|switch-client|switch) ...
    // including the `tmux -L <socket> attach` form (flags before the subcommand).
    const nestingMatch =
      /^\s*tmux\s+(?:-[A-Za-z]+\s+\S+\s+)?(?:attach|a|switch-client|switch)\b/.test(command);
    if (nestingMatch) {
      const targetMatch = command.match(/-t\s+(\S+)/);
      const target = targetMatch ? targetMatch[1] : '<name>';
      ctx.core.brief(
        'warn',
        'hand_over',
        'tmux nesting detected',
        `Agent is inside tmux ($TMUX set). \`tmux attach\`/` +
          `\`tmux switch-client\` would nest sessions and tmux refuses.`
      );
      return `Error: Cannot run \`${command.trim()}\` from inside a tmux session (nested sessions are rejected by tmux).

Alternatives:
1. Ask the user to run \`tmux attach -t ${target}\` in their own terminal (outside mycc).
2. Use the bash tool to drive the session remotely instead of attaching:
   - \`tmux send-keys -t ${target} '<cmd>' Enter\`
   - \`tmux capture-pane -t ${target} -p\`

$TMUX=${innerTmux}`;
    }
  }

  // 3. Create session
  const cwd = ctx.core.getWorkDir();
  const sessionName = `mycc-${Date.now()}`;

  try {
    if (isWin) {
      await execAsync(
        `tmux new-session -d -s ${sessionName} -c "${cwd}" -x 120 -y 40 ` + `"cmd /k ${command}"`
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
  ctx.todo.createTodo(`hand_over: [sessionName: ${sessionName}]`, command);

  // 4. Open popup terminal (detached, returns immediately)
  const terminalArgs = parseTerminalArgs(terminalLauncher, sessionName);
  spawn(terminalArgs[0], terminalArgs[1], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  ctx.core.brief('info', 'hand_over', `Opened: ${sessionName}`, intent);

  // 5. Wait for user confirmation and capture output
  // The prompt ends with a [y/N] bracket so the serve-mode ask() classifies it
  // as a choice card (Yes/No buttons + free-text). The trailing CLI prompt
  // marker "> " is intentionally omitted — the bracket alone drives the card
  // kind, and broadcastCard() strips ANSI/chalk from the query anyway.
  const answer = await agentIO.ask(
    'Save tmux session? [y/N]',
    { useAsPrompt: true, onEsc: 'n' } // use query as prompt (single line format)
  );

  // Parse response similar to git_commit tool
  // Strip surrounding quotes (tmux send-keys may add them)
  let normalized = answer.trim().toLowerCase();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  const keepSession = normalized === 'y' || normalized === 'yes';
  const killSession = normalized === 'n' || normalized === 'no' || normalized === '';

  // If user provided feedback (not y/n/enter), return it for LLM to handle
  if (!killSession && !keepSession) {
    agentIO.log(
      chalk.yellow(
        `✓ Session ${sessionName} kept for review. Reattach with: tmux attach -t ${sessionName}`
      )
    );

    // Capture output
    let output = '';
    try {
      const { stdout } = await execAsync(`tmux capture-pane -t ${sessionName} -p -S -3000 -E -1`);
      output = stdout;
    } catch {
      // Session may have been closed by user
    }

    const lines = output.split('\n');
    const result =
      lines.length > 100 ? await summarizeOutput(output, command, 100) : output || '(empty output)';

    return `User provided feedback: "${answer}"\n\nSession ${sessionName} is still running. Reattach with: tmux attach -t ${sessionName}\n\nOutput:\n${result}`;
  }

  // Show closing notice based on user's choice
  if (keepSession) {
    agentIO.log(
      chalk.green(`✓ Session ${sessionName} kept. Reattach with: tmux attach -t ${sessionName}`)
    );
  } else {
    agentIO.log(chalk.green(`✓ Session closed. Processing output...`));
  }

  // 6. Capture output
  let output = '';
  let sessionExists = false;

  try {
    const { stdout } = await execAsync(`tmux capture-pane -t ${sessionName} -p -S -3000 -E -1`);
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

  // 8. Summarize if needed
  const maxLines = 100;
  const lines = output.split('\n');

  const result =
    lines.length > maxLines
      ? await summarizeOutput(output, command, maxLines)
      : output || '(empty output)';

  // 9. Build and return result
  const header = `User ran: ${command}`;
  const status = keepSession
    ? `Session: ${sessionName} (kept)\nTo reattach: tmux attach -t ${sessionName}`
    : `Session: ${sessionName} (killed)`;

  // Append usage guide for kept sessions so LLM knows how to interact with it
  const guide = keepSession
    ? `\n---\nTo interact with this session, use bash with tmux commands:\n  tmux send-keys -t ${sessionName} 'your command' Enter\n  tmux capture-pane -t ${sessionName} -p\n  tmux attach -t ${sessionName} (interactive)`
    : '';

  return `${header}\n${status}\nOutput (${lines.length} lines):\n\n${result}${guide}`;
}

/**
 * Summarize long terminal output using LLM
 */
async function summarizeOutput(output: string, command: string, maxLines: number): Promise<string> {
  const response = await retryChat({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `Summarize terminal output. Keep under ${maxLines} lines. Preserve errors and exit codes.`,
      },
      {
        role: 'user',
        content: `Command: ${command}\n\n${output}`,
      },
    ],
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

/**
 * Parse terminal launcher command into executable and arguments
 * Handles launchers with built-in flags (e.g., "open -a Terminal.app --args")
 */
function parseTerminalArgs(launcher: string, sessionName: string): [string, string[]] {
  const parts = launcher.split(' ');
  // All terminal launchers use '--' to separate their args from the command
  return [parts[0], [...parts.slice(1), '--', 'tmux', 'attach', '-t', sessionName]];
}
