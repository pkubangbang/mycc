/**
 * help.ts - `--help` / `-h` output for the mycc CLI.
 *
 * Printed by index.ts before any side effects (env load, spawn, raw mode).
 * Kept in a standalone module so index.ts stays focused on coordination.
 *
 * The flag list mirrors README.md "Configuration Flags" + "Debug Flags".
 * Update both places together when adding/removing a flag.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read the installed version from package.json (best-effort). */
function readVersion(): string {
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface FlagRow {
  flag: string;
  env?: string;
  desc: string;
}

const CONFIG_FLAGS: FlagRow[] = [
  { flag: '--ollama-host <url>', env: 'OLLAMA_HOST', desc: 'Ollama server URL (default: http://127.0.0.1:11434)' },
  { flag: '--ollama-api-key <key>', env: 'OLLAMA_API_KEY', desc: 'Ollama API key for cloud features' },
  { flag: '--ollama-model <model>', env: 'OLLAMA_MODEL', desc: 'Ollama chat model (default: glm-5:cloud)' },
  { flag: '--ollama-vision-model <model>', env: 'OLLAMA_VISION_MODEL', desc: 'Ollama vision model for screen/image tools' },
  { flag: '--ollama-embedding-model <model>', env: 'OLLAMA_EMBEDDING_MODEL', desc: 'Embedding model for semantic search/RAG' },
  { flag: '--deepseek-host <url>', env: 'DEEPSEEK_HOST', desc: 'DeepSeek API endpoint (default: https://api.deepseek.com)' },
  { flag: '--deepseek-api-key <key>', env: 'DEEPSEEK_API_KEY', desc: 'DeepSeek API key' },
  { flag: '--deepseek-model <model>', env: 'DEEPSEEK_MODEL', desc: 'DeepSeek model name (default: deepseek-chat)' },
  { flag: '--api-provider <ollama|deepseek>', env: 'API_PROVIDER', desc: 'API provider (default: ollama)' },
  { flag: '--token-threshold <n>', env: 'TOKEN_THRESHOLD', desc: 'Context limit threshold (default: 50000)' },
  { flag: '--editor <cmd>', env: 'EDITOR', desc: 'Text editor for file editing' },
  { flag: '--skill-match-threshold <0-1>', env: 'SKILL_MATCH_THRESHOLD', desc: 'Skill similarity threshold (default: 0.5)' },
  { flag: '--max-upload-mb <n>', env: 'MYCC_MAX_UPLOAD_MB', desc: 'Max single-file upload size (MB) for /serve Web UI (default: 50)' },
];

const STARTUP_FLAGS: FlagRow[] = [
  { flag: '--setup', desc: 'Run the interactive setup wizard, then exit' },
  { flag: '--serve [port]', desc: 'Start the Web UI (bare flag = default port; --serve 9000 = port 9000)' },
  { flag: '--port <n>', desc: 'Port for the Web UI (used when --serve has no value)' },
  { flag: '--host [addr]', desc: 'Bind host for the Web UI (bare = 0.0.0.0; --host 1.2.3.4 = specific)' },
  { flag: '--from <session-id>', desc: 'Branch a NEW session pre-filled from an old session' },
  { flag: '--skip-healthcheck', desc: 'Skip the startup health check (faster startup)' },
  { flag: '--auto', desc: 'Start in autonomous mode (no prompt; auto-reply questions; press esc to exit)' },
  { flag: '-v, --verbose', desc: 'Show detailed debug output' },
  { flag: '-h, --help', desc: 'Show this help message and exit' },
];

const DEBUG_FLAGS: FlagRow[] = [
  { flag: '--debug-tp', desc: 'Triologue Parity: throw on role-transition violations instead of auto-recovering' },
  { flag: '--debug-suggest', desc: 'Log the SUGGEST background task (LLM response + feedback)' },
  { flag: '--debug-eval', desc: 'Print the parsed jsep AST for each hook condition expression' },
  { flag: '--debug-prompt', desc: 'Show extracted keywords + "Parsing..." spinner in the PROMPT state' },
];

/** Pad a flag column to a fixed width for aligned columns. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function renderTable(rows: FlagRow[]): string {
  const flagWidth = Math.max(...rows.map(r => r.flag.length)) + 2;
  const envWidth = Math.max(...rows.map(r => (r.env ?? '').length), 4) + 2;
  return rows.map(r => {
    const env = r.env ? pad(r.env, envWidth) : pad('', envWidth);
    return `  ${pad(r.flag, flagWidth)}${env}${r.desc}`;
  }).join('\n');
}

/**
 * Print the full `mycc --help` usage to stdout.
 * Pure output — no process.exit (the caller decides to exit).
 */
export function printHelp(): void {
  const version = readVersion();
  const out: string[] = [];

  out.push(`mycc ${version} — a CLI coding agent using Ollama / DeepSeek for LLM inference.`);
  out.push('');
  out.push(chalkTitle('Usage:'));
  out.push('  mycc [flags]');
  out.push('  mycc --setup             # configure environment, then exit');
  out.push('  mycc --serve [port]      # start the Web UI');
  out.push('  mycc --from <session-id> # branch a session from an old one');
  out.push('  mycc --auto               # start in autonomous mode');
  out.push('  mycc --help | -h         # show this help and exit');
  out.push('');

  out.push(chalkTitle('Startup flags:'));
  out.push(renderTable(STARTUP_FLAGS));
  out.push('');

  out.push(chalkTitle('Configuration flags (override .env files & system env vars):'));
  out.push(renderTable(CONFIG_FLAGS));
  out.push('');

  out.push(chalkTitle('Debug flags (combine with -v for max detail):'));
  out.push(renderTable(DEBUG_FLAGS));
  out.push('');

  out.push(chalkTitle('Examples:'));
  out.push('  mycc --ollama-model gemma4:31b-cloud --token-threshold 80000');
  out.push('  mycc --skip-healthcheck -v');
  out.push('  mycc -v --debug-tp --debug-suggest');
  out.push('  mycc --serve 9000 --host');
  out.push('');

  out.push('Docs: https://github.com/pkubangbang/mycc');
  out.push('Run `mycc --setup` first if you have not configured your environment.');

  process.stdout.write(`${out.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Coloring — chalk is a hard dependency of mycc, used directly (synchronous).
// ---------------------------------------------------------------------------

const chalkTitle = (s: string): string => chalk.bold.cyan(s);