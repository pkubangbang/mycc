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
 * 4. User presses Enter to capture & kill, or 'y' to keep
 * 5. Capture and summarize output
 * 6. Kill or keep session based on user choice
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { spawn, execSync } from 'child_process';
import chalk from 'chalk';
import { agentIO } from '../loop/agent-io.js';
import { parseIntent } from '../context/grant/intent-parser.js';
import { retryChat, MODEL } from '../engine/chat-provider.js';
import { getShellInfo } from '../utils/shell-detect.js';


/**
 * Spawn `tmux` with an explicit arg array (NOT via a shell). This is the
 * escaping-safe delivery path: each argument is passed verbatim to tmux
 * without cmd.exe/PowerShell re-interpreting metacharacters (&, >, |, quotes).
 * Critical for `send-keys`, where the command must reach the pane byte-for-byte.
 */
function spawnTmux(args: string[], cwd: string, captureStdout = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tmux', args, {
      cwd,
      stdio: captureStdout ? ['ignore', 'pipe', 'ignore'] : 'ignore',
    });
    let out = '';
    if (captureStdout) {
      proc.stdout?.on('data', (chunk: Buffer | string) => { out += chunk.toString(); });
    }
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`tmux exited with code ${code}`));
      }
    });
  });
}

/**
 * Capture the popup pane's recent scrollback. The ONE capture path (row
 * lead-042): array argv → tmux, never a shell string, so a future session-name
 * scheme with a user-supplied or channel-derived part cannot inject through
 * cmd.exe/PowerShell.
 */
function capturePane(sessionName: string): Promise<string> {
  return spawnTmux(['capture-pane', '-t', sessionName, '-p', '-S', '-3000', '-E', '-1'], process.cwd(), true);
}

export const handOverTool: ToolDefinition = {
  name: 'hand_over',
  description: `Opens a popup terminal and BLOCKS until the user finishes interacting, then captures and returns the terminal output. Use ONLY when the task REQUIRES a human at the terminal — e.g. entering a password (sudo, SSH passphrase, 2FA), an interactive TUI (vim, htop, less), an SSH session, or anything reading from a TTY. For non-interactive commands use bash; for background jobs use bg_create; to drive a persistent terminal programmatically use bash with tmux send-keys/capture-pane. hand_over OWNS the tmux framing: pass the INNER foreground command only (e.g. \`sudo apt install X\`, \`vim file\`) — do NOT prefix it with \`tmux ...\` (that would nest a tmux client inside hand_over's own session).`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The single foreground command to hand to the user to type/run in the popup (e.g. `sudo apt install X`, `ssh user@host`, `vim notes.txt`). It is typed into the popup shell verbatim; do NOT prefix it with `tmux`, and do NOT chain background/detached constructs (`&&`, `&`, `> file`) — pass one interactive command the user must drive to completion.',
      },
      intent: {
        type: 'string',
        description:
          'REQUIRED: Explain why this command is needed (use intent language). The OBJECT must be USER and the VERB must be RUN: hand_over executes a command by having a human interact with the terminal.',
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
  // session (the `send-keys` call below types it into the pane). A `command`
  // that itself starts with `tmux` therefore nests a tmux client inside
  // hand_over's session — `attach`/`switch-client` refuse to nest, and
  // `new-session`/`send-keys` create a session the agent never wanted. Reject
  // any leading `tmux` and point at the bash tool for tmux management.
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
    // Create a BARE session whose default shell is the one detected at startup
    // (shell-detect.ts), then type the command into the pane. Passing the
    // command as the session's initial shell-command argument would make the
    // platform shell re-interpret it (metacharacters, spaces-in-paths), so the
    // pane's own shell must parse it — delivered byte-for-byte by send-keys.
    const shellName = getShellInfo().shell_cmd;
    await spawnTmux(
      ['new-session', '-d', '-s', sessionName, '-c', cwd, '-x', '120', '-y', '40', shellName],
      cwd,
    );

    // Type the command into the pane. The leading space is harmless and guards
    // against a command starting with `-` being mistaken for a tmux option.
    // No fixed sleep is needed — the pty buffers the input before the shell
    // prompt is even ready.
    //
    // An empty command (the user typed just "!" at the prompt, or the agent
    // called hand_over with command="") means "open an interactive shell with
    // no initial command". Skip the send-keys so the pane stays at a clean
    // shell prompt — typing the literal "undefined" (from a coerced
    // command || undefined) was the old bug.
    if (command.length > 0) {
      await spawnTmux(
        ['send-keys', '-t', sessionName, ` ${command}`, 'Enter'],
        cwd,
      );
    }
  } catch (e) {
    return `Error: Failed to create session: ${e}`;
  }

  // 3. Track session in todo
  // For an empty command (interactive shell), label it "(interactive shell)"
  // instead of leaving the todo body blank / showing "undefined".
  ctx.todo.createTodo(`hand_over: [sessionName: ${sessionName}]`, command || '(interactive shell)');

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
      const stdout = await capturePane(sessionName);
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
    const stdout = await capturePane(sessionName);
    output = stdout;
    sessionExists = true;
  } catch {
    // Session may have been closed by user
  }

  // 7. Cleanup if not keeping
  if (sessionExists && !keepSession) {
    try {
      await spawnTmux(['kill-session', '-t', sessionName], process.cwd());
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

  // 9. Build and return result.
  //
  // The return value is the LLM's only window into what happened in the popup,
  // so it must (a) state clearly whether the session still lives, (b) surface
  // the captured output, and (c) tell the LLM HOW to act on it next — not just
  // dump a session name and leave the LLM to guess. The "Next action" line is
  // the guidance: if the session is kept, the LLM should continue driving it
  // via bash + tmux send-keys/capture-pane; if killed, the output here is
  // final and the task should be assessed from it.
  const header = `User ran: ${command || '(interactive shell)'}`;
  const status = keepSession
    ? `Status: session still open (kept)\nSession name: ${sessionName}`
    : `Status: session closed (output captured below)\nSession name: ${sessionName}`;

  const nextAction = keepSession
    ? `Next action: continue this interactive session with the bash tool —\n` +
      `  tmux send-keys -t ${sessionName} '<command>' Enter   (type a command)\n` +
      `  tmux capture-pane -t ${sessionName} -p               (read the screen)`
    : `Next action: the session is closed; read the captured output below and continue (or ask the user for guidance if the human reported something).`;

  return (
    `${header}\n` +
    `${status}\n` +
    `${nextAction}\n` +
    `\n` +
    `Output (${lines.length} lines):\n\n${result}`
  );
}

/**
 * Summarize long terminal output using LLM.
 *
 * An LLM failure must never cost the captured bytes: on error we return a
 * head-truncated copy of the RAW output (same maxLines cap) with a marker,
 * so the agent still sees errors and exit codes instead of a placeholder.
 */
async function summarizeOutput(output: string, command: string, maxLines: number): Promise<string> {
  try {
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
    return response.message.content || '(summarization returned empty)';
  } catch {
    // LLM summarization failed — fall back to a head-truncated copy of the
    // raw output rather than dropping it. Preserves real bytes (errors,
    // exit codes) up to maxLines, with a marker so the agent knows the
    // summary was skipped.
    const truncated = output.split('\n').slice(0, maxLines).join('\n');
    return `(summarization failed — showing raw output, first ${maxLines} lines)\n${truncated}`;
  }
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
 * Parse terminal launcher command into executable and arguments.
 *
 * Invariant: the launcher string is a KEY into a typed per-launcher dispatch
 * table, never whitespace-split — a launcher path may contain spaces, so
 * splitting would guess the exe/args boundary wrong. Every launcher then gets
 * `-- tmux attach -t <sessionName>` appended (all supported launchers use `--`
 * to separate their own args from the command to run).
 *
 * Exported for direct unit testing (the launcher spawn is a detached
 * fire-and-forget, hard to observe from the handler).
 */
export function parseTerminalArgs(launcher: string, sessionName: string): [string, string[]] {
  // Per-launcher typed dispatch: [exe, ...launcher-specific args].
  const dispatch: Record<string, [string, ...string[]]> = {
    'open -a Terminal.app --args': ['open', '-a', 'Terminal.app', '--args'],
    'wt': ['wt'],
    'cmd /c start cmd /k': ['cmd', '/c', 'start', 'cmd', '/k'],
  };
  const known = dispatch[launcher];
  // Linux launchers (gnome-terminal, konsole, xfce4-terminal, mate-terminal,
  // xterm) are bare single-token executables with no built-in flags.
  const [exe, ...fixedArgs] = known ?? [launcher];
  return [exe, [...fixedArgs, '--', 'tmux', 'attach', '-t', sessionName]];
}
