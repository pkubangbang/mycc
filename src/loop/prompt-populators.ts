/**
 * prompt-populators.ts - Project-context populators delivering live environment
 * sections (platform + calendar) to the LLM.
 *
 * These two sections (## Platform and ## Calendar) were historically baked into
 * the system prompt by agent-prompts.ts via buildCommonSections() and rebuilt on
 * EVERY LLM call. But the system prompt is the FIRST tokens of the prompt-cache
 * prefix (system + projectContext + conversation + tools), so any change to it
 * mid-session (e.g. the date rolling over at midnight, or the coordinator PID)
 * invalidated the entire DeepSeek/Ollama prompt cache every turn.
 *
 * Moving them into a project-context populator (the pattern introduced in commit
 * ab73acc "refactor(projectContext): rebuild via populator registry on
 * compact/clear") freezes them between compact()/clear() boundaries — where the
 * conversation prefix already changes, so refreshing costs no cache penalty —
 * while keeping them delivered to the LLM in full. Between boundaries the
 * projectContext is byte-identical, so the cached prefix stays hot.
 *
 * This module exports ONE pure function, buildPlatformCalendarMessages()
 * (following the buildHookInfoMessages pattern from hook-bootstrap.ts), so both
 * the lead (agent-repl.ts) and teammate children (teammate-worker.ts) can
 * register it as a projectContext populator closure.
 */

import * as os from 'os';
import { getShellInfo, type ShellKind } from '../utils/shell-detect.js';
import type { Message } from '../types.js';

// ============================================================================
// Platform Detection
// ============================================================================

function getPlatformInfo(): {
  platform: string;
  shell: string;
  pathSep: string;
  home: string;
  escapeChar: string;
  /** The detected shell kind, for per-shell prompt tailoring. */
  shellKind: ShellKind;
} {
  const info = getShellInfo();

  // Exhaustive per-shell labels — no catch-all default. If a new ShellKind is
  // added without a branch here, this throws loudly instead of silently
  // emitting a wrong/generic label.
  let shellLabel: string;
  if (info.shell === 'pwsh7') {
    shellLabel = 'PowerShell 7 (pwsh)';
  } else if (info.shell === 'powershell5') {
    shellLabel = 'PowerShell 5.1 (powershell)';
  } else if (info.shell === 'zsh') {
    shellLabel = 'zsh';
  } else if (info.shell === 'bash') {
    shellLabel = 'bash';
  } else {
    throw new Error(`getPlatformInfo: unknown shell kind '${info.shell as string}'`);
  }

  return {
    platform: info.platform,
    shell: shellLabel,
    pathSep: info.isWin ? 'backslash (\\)' : 'forward slash (/)',
    home: os.homedir(),
    escapeChar: info.isWin ? 'backtick (`)' : 'backslash (\\)',
    shellKind: info.shell,
  };
}

// ============================================================================
// Calendar Section
// ============================================================================

function buildCalendarSection(): string {
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentYear = now.getFullYear();
  return `## Calendar\nCurrent date: ${currentDate} (year: ${currentYear})`;
}

// ============================================================================
// Platform Section
// ============================================================================

function buildPlatformSection(): string {
  const info = getPlatformInfo();

  // Exhaustive per-shell guidance — no catch-all default. Each known ShellKind
  // gets its own branch; an unknown kind throws so a new shell added without a
  // prompt branch fails loudly instead of emitting generic/wrong guidance.
  let shellCommands: string;
  if (info.shellKind === 'pwsh7') {
    shellCommands = '- Use PowerShell 7 (pwsh) syntax: `Get-Content file`, `Copy-Item src dest`\n- The bash tool executes commands via pwsh (not cmd). Multiple commands should be concatenated using ";"; `&&`/`||` chaining also works in pwsh 7.\n- pwsh 7 defaults to UTF-8 without BOM for both file reads and writes, so `Get-Content`/`Set-Content`/`Out-File` are UTF-8-safe by default (no mojibake, no BOM). Prefer the built-in `read_file`/`edit_file` tools which handle UTF-8 automatically.';
  } else if (info.shellKind === 'powershell5') {
    shellCommands = '- Use Windows PowerShell 5.1 syntax: `Get-Content file`, `Copy-Item src dest`\n- The bash tool executes commands via Windows PowerShell 5.1 (not cmd). Note that multiple commands should be concatenated using ";", not "&&" (5.1 lacks `&&`/`||` pipeline operators).\n- **File encoding (avoid mojibake):** `Get-Content`/`Set-Content` default to the system ANSI codepage on Windows PowerShell 5.1, garbling UTF-8 files with non-ASCII chars. ALWAYS pass `-Encoding UTF8` when reading/writing source files (e.g. `Get-Content file -Encoding UTF8`). Prefer the built-in `read_file`/`edit_file` tools which handle UTF-8 automatically.\n- **BOM trap (PowerShell 5.1):** `Set-Content -Encoding UTF8` prepends a UTF-8 BOM (EF BB BF) that corrupts formats needing pure ASCII headers (e.g. `jar cfm` fails with `invalid header field name`). For no-BOM writes use `[IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))`. The `write_file` tool already writes UTF-8 without a BOM (pass `bom: true` only when needed).\n- Note: the bash tool already sets the default write encoding of `Set-Content`/`Add-Content`/`Out-File` to no-BOM UTF-8 via `$PSDefaultParameterValues`; an explicit `-Encoding UTF8` still writes a BOM, so prefer `[IO.File]::WriteAllText` or the built-in tools for no-BOM writes.';
  } else if (info.shellKind === 'zsh' || info.shellKind === 'bash') {
    shellCommands = '- Use bash/zsh syntax: `cat file`, `cp src dest`';
  } else {
    throw new Error(`buildPlatformSection: unknown shell kind '${info.shellKind as string}'`);
  }

  let escaping: string;
  if (info.shellKind === 'pwsh7' || info.shellKind === 'powershell5') {
    escaping = '- In PowerShell: use backtick ` to escape special chars (e.g., `$ for literal $)';
  } else if (info.shellKind === 'zsh' || info.shellKind === 'bash') {
    escaping = '- In bash/zsh: use backslash \\ to escape (e.g., \\$ for $)';
  } else {
    throw new Error(`buildPlatformSection: unknown shell kind '${info.shellKind as string}'`);
  }

  // --- Process PIDs ---
  // Expose the lead's own PID and the coordinator (parent) PID so the LLM
  // can avoid killing them when stopping dev servers or running broad kill
  // commands. The coordinator PID is injected by index.ts via env var; the
  // lead's own PID is available via process.pid.
  const coordinatorPid = process.env.MYCC_COORDINATOR_PID;
  const pidLines: string[] = [
    '',
    '### Process PIDs',
    `Your own process PID: ${process.pid}`,
  ];
  if (coordinatorPid) {
    pidLines.push(
      `Coordinator (parent) PID: ${coordinatorPid}`,
      '',
      '**WARNING**: Never kill the coordinator PID or your own PID. Killing the coordinator',
      'will terminate your own process as well. When stopping dev servers or running broad',
      'kill commands (e.g. `taskkill /F`, `kill $(lsof -t -i:PORT)`), always exclude these PIDs.',
    );
  } else {
    pidLines.push(
      '',
      'NOTE: Coordinator PID is not available. Be cautious when running broad kill commands',
      '— avoid killing processes you did not start.',
    );
  }

  return [
    '## Platform',
    `Platform: ${info.platform}`,
    `Shell: ${info.shell}`,
    `Path separator: ${info.pathSep}`,
    `Escape character: ${info.escapeChar}`,
    `Home: ${info.home}`,
    '',
    '### Shell Commands',
    shellCommands,
    '- Always use forward slashes (/) in file paths for cross-platform compatibility',
    '- Prefer relative paths. If you must use absolute paths, use forward slashes.',
    '',
    '### Escaping',
    escaping,
    '- For JSON/strings: use double quotes and escape inner quotes with backslash',
    '- When in doubt: use single quotes for literal strings in bash/zsh, double quotes in PowerShell',
    ...pidLines,
  ].join('\n');
}

// ============================================================================
// Public populator
// ============================================================================

/**
 * Build the platform + calendar projectContext deliverable as a user/assistant
 * pair. Register this via triologue.registerProjectContextPopulator(() =>
 * buildPlatformCalendarMessages()). The content is held steady between rebuilds
 * by the populator registry, so the prompt-cache prefix stays hot.
 *
 * Section order matches the original inline prompt composition: Platform before
 * Calendar.
 */
export function buildPlatformCalendarMessages(): Message[] {
  const content =
    `[System - Platform & Calendar]\n\n` +
    `${buildPlatformSection()}\n\n` +
    `${buildCalendarSection()}`;
  return [
    { role: 'user', content },
    {
      role: 'assistant',
      content:
        'Understood. I have noted the current date and platform/shell environment.',
    },
  ];
}
