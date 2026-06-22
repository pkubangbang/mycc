import process from 'node:process';
import { spawn } from 'child_process';
import { execSync } from 'child_process';

/**
 * Detected environment type
 */
export type Environment = 'macos' | 'linux' | 'windows' | 'wsl';

/**
 * Terminal configuration defining how to spawn a command in a terminal
 */
interface TerminalConfig {
  id: string;
  binary: string;
  /**
   * Build spawn arguments from the command string.
   * Returns an array of arguments to pass to the terminal binary.
   *
   * The command is already wrapped with PATH export and shell setup
   * by `wrapCommand()` before being passed here.
   */
  getArgs: (cmd: string) => string[];
  /**
   * Whether this terminal requires shell: true in spawn options (e.g., cmd.exe on Windows)
   */
  shell?: boolean;
}

// ─── macOS terminals ────────────────────────────────────────────────────────

const MACOS_TERMINALS: TerminalConfig[] = [
  {
    id: 'iterm2',
    binary: 'osascript',
    getArgs: (cmd) => [
      '-e', `
        tell application "iTerm2"
          activate
          create window with default profile
          tell current session of current window
            write text "${cmd.replace(/"/g, '\\"')}"
          end tell
        end tell
      `.trim(),
    ],
  },
  {
    id: 'terminal-app',
    binary: 'osascript',
    getArgs: (cmd) => [
      '-e', `
        tell application "Terminal"
          activate
          do script "${cmd.replace(/"/g, '\\"')}"
        end tell
      `.trim(),
    ],
  },
];

// ─── Linux terminals ────────────────────────────────────────────────────────

const LINUX_TERMINALS: TerminalConfig[] = [
  {
    id: 'gnome-terminal',
    binary: 'gnome-terminal',
    getArgs: (cmd) => ['--', 'bash', '-c', cmd],
  },
  {
    id: 'konsole',
    binary: 'konsole',
    getArgs: (cmd) => ['-e', 'bash', '-c', cmd],
  },
  {
    id: 'xfce4-terminal',
    binary: 'xfce4-terminal',
    getArgs: (cmd) => ['-x', 'bash', '-c', cmd],
  },
  {
    id: 'mate-terminal',
    binary: 'mate-terminal',
    getArgs: (cmd) => ['-x', 'bash', '-c', cmd],
  },
  {
    id: 'alacritty',
    binary: 'alacritty',
    getArgs: (cmd) => ['-e', 'bash', '-c', cmd],
  },
  {
    id: 'kitty',
    binary: 'kitty',
    getArgs: (cmd) => ['bash', '-c', cmd],
  },
  {
    id: 'foot',
    binary: 'foot',
    getArgs: (cmd) => ['-e', 'bash', '-c', cmd],
  },
  {
    id: 'xterm',
    binary: 'xterm',
    getArgs: (cmd) => ['-hold', '-e', 'bash', '-c', cmd],
  },
  {
    id: 'guake',
    binary: 'guake',
    getArgs: (cmd) => ['-e', cmd],
  },
];

// ─── Windows terminals ──────────────────────────────────────────────────────

const WINDOWS_TERMINALS: TerminalConfig[] = [
  {
    id: 'windows-terminal',
    binary: 'wt.exe',
    getArgs: (cmd) => ['powershell', '-NoExit', '-Command', cmd],
  },
  {
    id: 'cmd',
    binary: 'cmd.exe',
    getArgs: (cmd) => ['/c', 'start', 'powershell', '-NoExit', '-Command', cmd],
    shell: true,
  },
  {
    id: 'powershell',
    binary: 'powershell.exe',
    getArgs: (cmd) => ['-Command', `Start-Process powershell -ArgumentList '-NoExit','-Command','${cmd.replace(/'/g, "''")}'`],
    shell: true,
  },
];

// ─── Environment detection ─────────────────────────────────────────────────

/**
 * Detect the current environment
 */
export function detectEnvironment(): Environment {
  const platform = process.platform;

  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';

  // Linux: check if running under WSL
  if (platform === 'linux') {
    try {
      const release = execSync('uname -r', { encoding: 'utf8' }).toLowerCase();
      if (release.includes('microsoft') || release.includes('wsl')) {
        return 'wsl';
      }
    } catch {
      // If uname fails, assume native Linux
    }
    return 'linux';
  }

  // Fallback: treat unknown platforms as linux-like
  return 'linux';
}

// ─── Command wrapping ───────────────────────────────────────────────────────

/**
 * Wrap a command so it inherits the current process's PATH and environment
 * when run inside a new terminal.
 *
 * Problem: When spawning a new terminal with `bash -c "cmd"`, the new shell
 * is non-interactive. This means ~/.bashrc won't fully execute (it has an
 * early-return guard for non-interactive shells), so tools like nvm won't be
 * loaded and `node` won't be on PATH.
 *
 * Solution: Explicitly export the current PATH and other critical env vars
 * at the start of the command. This ensures the spawned terminal has access
 * to the same binaries (node, tsx, etc.) as the parent mycc process.
 *
 * After the command finishes, `exec bash` starts an interactive shell so the
 * user can continue working in the terminal window.
 *
 * @param cmd - The shell command to wrap
 * @returns The wrapped command string ready for `bash -c`
 */
function wrapCommand(cmd: string): string {
  // Export the current PATH so the new terminal inherits nvm-managed binaries etc.
  // Also pass through DISPLAY/WAYLAND_DISPLAY for GUI apps.
  const pathExport = `export PATH='${process.env.PATH}'`;
  const displayExport = process.env.DISPLAY ? ` export DISPLAY='${process.env.DISPLAY}';` : '';
  const waylandExport = process.env.WAYLAND_DISPLAY ? ` export WAYLAND_DISPLAY='${process.env.WAYLAND_DISPLAY}';` : '';
  const envSetup = `${pathExport};${displayExport}${waylandExport}`;

  return `${envSetup} ${cmd}; exec bash`;
}

// ─── Terminal finding ───────────────────────────────────────────────────────

/**
 * Check if a binary is available on PATH
 */
function isBinaryAvailable(binary: string): boolean {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${whichCmd} ${binary}`, { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a display server is available (for GUI terminals on Linux)
 */
function hasDisplay(): boolean {
  if (process.env.DISPLAY) return true;
  if (process.env.WAYLAND_DISPLAY) return true;
  return false;
}

/**
 * Check if running in an SSH session
 */
function isSSHSession(): boolean {
  if (process.env.SSH_CONNECTION) return true;
  if (process.env.SSH_TTY) return true;
  return false;
}

/**
 * Get the list of terminal candidates for the current environment,
 * ordered by preference.
 */
function getTerminalCandidates(env: Environment): TerminalConfig[] {
  switch (env) {
    case 'macos':
      return MACOS_TERMINALS;
    case 'linux':
      return LINUX_TERMINALS;
    case 'wsl': {
      // In WSL, prefer Windows terminals, fall back to Linux terminals
      return [...WINDOWS_TERMINALS, ...LINUX_TERMINALS];
    }
    case 'windows':
      return WINDOWS_TERMINALS;
  }
}

/**
 * Find an available terminal on the system.
 * Tries each candidate in preference order and returns the first one found.
 */
export function findAvailableTerminal(env?: Environment): TerminalConfig {
  const detectedEnv = env ?? detectEnvironment();
  const candidates = getTerminalCandidates(detectedEnv);

  for (const terminal of candidates) {
    if (isBinaryAvailable(terminal.binary)) {
      return terminal;
    }
  }

  // Build a helpful error message
  const envLabel = {
    macos: 'macOS',
    linux: 'Linux',
    wsl: 'WSL',
    windows: 'Windows',
  }[detectedEnv];

  const triedList = candidates.map((t) => t.binary).join(', ');

  const tips: string[] = [
    `No terminal emulator found for ${envLabel} environment.`,
    `Tried: ${triedList}`,
    '',
    'Possible fixes:',
    '  1. Install a terminal emulator (e.g., gnome-terminal, konsole, xterm on Linux; iTerm2 on macOS)',
    '  2. Ensure the terminal binary is on your PATH',
  ];

  if (detectedEnv === 'linux' && !hasDisplay()) {
    tips.push('  3. No display server detected (DISPLAY/WAYLAND_DISPLAY not set). Set one if using GUI terminals.');
  }
  if (detectedEnv === 'linux' && isSSHSession()) {
    tips.push('  3. Running in SSH session. Ensure X forwarding is enabled (-X flag) for GUI terminals.');
  }

  throw new Error(tips.join('\n'));
}

// ─── Main function ───────────────────────────────────────────────────────────

/**
 * Open a new terminal window and run the given command.
 *
 * The terminal is spawned as a detached process so that it remains open
 * even after the parent process exits. The command is automatically wrapped
 * with PATH export to ensure the new terminal inherits the parent's
 * environment (critical for nvm-managed node, etc.), and `exec bash` is
 * appended so the terminal stays open after the command completes.
 *
 * @param cmd - The shell command to execute in the new terminal
 * @throws Error if no terminal emulator can be found or if spawning fails
 *
 * @example
 * ```ts
 * openTerminal('vim ~/.bashrc');
 * openTerminal('ssh user@host');
 * openTerminal('htop');
 * ```
 */
export function openTerminal(cmd: string): void {
  const env = detectEnvironment();

  // On Unix-like systems, wrap the command with PATH export so the new
  // terminal inherits the parent's environment (nvm paths, etc.)
  // and stays open with `exec bash` after the command completes.
  const isUnix = env === 'macos' || env === 'linux' || env === 'wsl';
  const finalCmd = isUnix ? wrapCommand(cmd) : cmd;

  const terminal = findAvailableTerminal(env);
  const args = terminal.getArgs(finalCmd);

  const spawnOptions: import('child_process').SpawnOptions = {
    detached: true,
    stdio: 'ignore',
  };

  // Windows terminals like cmd.exe need shell: true
  if (terminal.shell) {
    spawnOptions.shell = true;
  }

  try {
    const child = spawn(terminal.binary, args, spawnOptions);
    child.unref();
  } catch (err) {
    throw new Error(
      `Failed to open terminal "${terminal.id}" (${terminal.binary}): ${(err as Error).message}`,
      { cause: err }
    );
  }
}