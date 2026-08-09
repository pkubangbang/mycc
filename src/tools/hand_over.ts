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
  description: `Opens a popup terminal and BLOCKS until user interaction. Use ONLY for commands that require interactive input (passwords, prompts, SSH, vim, htop) or when the user explicitly requests a terminal. For all non-interactive commands, use the bash tool instead. hand_over owns the tmux framing — pass the INNER interactive command (e.g. \`ssh\`, \`vim\`, \`sudo\`), NOT a \`tmux ...\` command (which would nest a tmux client inside hand_over's own session); use the bash tool for any \`tmux ...\` invocation instead.`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The foreground interactive command to hand to the user (e.g. `ssh host`, `vim file`, `sudo apt install ...`). hand_over wraps this in its own tmux session, so do NOT prefix it with `tmux` — pass the inner command only.',
      },
      intent: {
        type: 'string',
        description:
          'REQUIRED: Explain why this command is needed (use intent language). The OBJECT must be USER.',
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

  // Auto mode: hand_over opens an interactive terminal popup and blocks on
  // the user — incompatible with autonomous operation. Reject up front so
  // the loop stays non-blocking; the LLM should use the bash tool instead.
  if (agentIO.getAuto()) {
    return 'Error: hand_over is disabled in auto mode (no interactive terminal available). Use the bash tool for non-interactive commands, or ask the user to exit auto mode.';
  }

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

  // 2b. tmux nesting self-check (UNCONDITIONAL).
  // hand_over wraps `command` as the INNER shell command of its own fresh tmux
  // session (see the `tmux new-session ... "<command>"` call below). If `command`
  // itself starts with `tmux`, it nests a tmux client inside hand_over's session:
  //   - `tmux attach`/`switch-client` → tmux refuses ("sessions should be nested
  //     with care, unset $TMUX to force") and the popup sits dead at a shell
  //     prompt with no error reaching the agent;
  //   - `tmux new-session`/`send-keys`/etc. → a genuine nested session is
  //     created, which is never what the agent wants from hand_over.
  // Reject ANY leading `tmux` regardless of $TMUX (the old check was
  // $TMUX-gated AND only matched attach/switch, leaving two holes: $TMUX-unset
  // rejected nothing, and new-session/send-keys slipped through). Tell the agent
  // the contract (hand_over owns the tmux framing; pass the inner command) and
  // point it at the bash tool for tmux management.
  if (/^\s*tmux\s+/.test(command)) {
    ctx.core.brief(
      'warn',
      'hand_over',
      'tmux command rejected (would nest)',
      `hand_over wraps command in its own tmux session; a leading \`tmux\` would nest. Pass the inner command, or use bash for tmux.`
    );
    return `Error: \`${command.trim()}\` starts with \`tmux\`, but hand_over already runs the command inside its own tmux session; pass the INNER interactive command (e.g. the ssh/vim/sudo), not \`tmux ...\`. To run a nested tmux session use \`bash\` instead (e.g. bash \`tmux new-session -d -s name ...\` or \`tmux send-keys\`).`;
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
