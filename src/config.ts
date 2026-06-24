/**
 * config.ts - Global runtime configuration and directory helpers
 *
 * Stores CLI-derived settings accessible throughout the codebase.
 * Also contains directory helpers and session context (migrated from db.ts).
 * Uses minimist for argument parsing.
 *
 * Environment loading:
 * - User-level: ~/.mycc-store/.env (global, applies to all projects)
 * - Project-level: ./.mycc/.env (local, overrides user-level)
 */

import minimist from 'minimist';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getUserConfigPath, getProjectConfigPath } from './setup/paths.js';

// ============================================================================
// Inline .env File Parser
// ============================================================================

/**
 * Parse a .env file and return key-value pairs.
 * Handles: comments (#), empty lines, KEY=VALUE, quoted values,
 * export KEY=VALUE prefix, UTF-8 BOM on first line.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const result: Record<string, string> = {};

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // Strip UTF-8 BOM from the first line
    if (i === 0 && line.codePointAt(0) === 0xfeff) {
      line = line.slice(1).trim();
    }

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    // Strip optional 'export ' prefix
    if (line.startsWith('export ')) {
      line = line.slice(7).trim();
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue; // no '=', skip

    const key = line.slice(0, eqIdx).trim();
    if (!key) continue; // empty key, skip

    let value = line.slice(eqIdx + 1).trim();

    // Unwrap matching quotes
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    result[key] = value;
  }

  return result;
}

// ============================================================================
// Environment Loading
// ============================================================================

/**
 * Load environment variables from .env files and merge into process.env.
 *
 * Priority (lowest to highest): user .env → project .env → system env → cmd-args
 * Encoded directly via Object.assign argument order.
 */
export function loadEnv(): void {
  const userConfig = fs.existsSync(getUserConfigPath())
    ? parseEnvFile(getUserConfigPath()) : {};
  const projConfig = fs.existsSync(getProjectConfigPath())
    ? parseEnvFile(getProjectConfigPath()) : {};

  // Later arguments override earlier ones
  const result = Object.assign({}, userConfig, projConfig, process.env, cmdArgsEnv);
  Object.assign(process.env, result);
}

// Parse CLI args once at startup
const args = minimist(process.argv.slice(2), {
  boolean: ['v', 'verbose', 'skip-healthcheck', 'setup', 'debug-eval', 'debug-tp', 'debug-prompt'],
  string: ['session'],
  alias: { v: 'verbose' },
  default: { v: false, session: null, 'skip-healthcheck': false, setup: false, 'debug-eval': false, 'debug-tp': false, 'debug-prompt': false },
});

/**
 * Build a plain object mapping cmd-args to MYCC_* env vars.
 * Modules can read process.env.MYCC_* without knowing about minimist.
 */
function buildCmdArgsEnv(parsed: typeof args): Record<string, string> {
  const env: Record<string, string> = {};
  const map: Record<string, string> = {
    'verbose': 'MYCC_VERBOSE',
    'session': 'MYCC_SESSION',
    'skip-healthcheck': 'MYCC_SKIP_HEALTHCHECK',
    'setup': 'MYCC_SETUP',
    'debug-eval': 'MYCC_DEBUG_EVAL',
    'debug-tp': 'MYCC_DEBUG_TP',
    'debug-prompt': 'MYCC_DEBUG_PROMPT',
  };
  for (const [argKey, envKey] of Object.entries(map)) {
    const value = parsed[argKey];
    if (value !== undefined && value !== null && value !== false) {
      env[envKey] = String(value);
    }
  }
  return env;
}

// Built once at module load — used by loadEnv() to merge into process.env
const cmdArgsEnv = buildCmdArgsEnv(args);

/**
 * Global runtime configuration singleton
 */
class GlobalConfig {
  /** Verbose mode - show detailed debug output */
  get verbose(): boolean {
    return process.env.MYCC_VERBOSE === 'true';
  }

  set verbose(value: boolean) {
    process.env.MYCC_VERBOSE = String(value);
  }
}

const globalConfig = new GlobalConfig();

/**
 * Get session ID from CLI args (--session flag).
 * Reads from parsed minimist args directly (not process.env) to avoid
 * inheriting a stale MYCC_SESSION env var from a parent process.
 */
export function getSessionArg(): string | null {
  return args.session || null;
}

/**
 * Check if health check should be skipped
 */
export function shouldSkipHealthCheck(): boolean {
  return process.env.MYCC_SKIP_HEALTHCHECK === 'true';
}

/**
 * Check if setup mode is requested.
 * Reads the parsed CLI args directly (not process.env) because this is called
 * at module top-level, before loadEnv() merges cmd-args into process.env.
 * Setup is a pre-agent wizard, not part of the agent lifecycle.
 */
export function shouldRunSetup(): boolean {
  return args.setup === true;
}

/**
 * Quick check for verbose mode (convenience)
 */
export function isVerbose(): boolean {
  return globalConfig.verbose;
}

/**
 * Check if debug-eval mode is enabled (--debug-eval flag)
 * When enabled, expression evaluation prints AST trees via agentIO.brief.
 */
export function isDebuggingEval(): boolean {
  return process.env.MYCC_DEBUG_EVAL === 'true';
}

/**
 * Check if debug-tp mode is enabled (--debug-tp flag)
 * When enabled, TP violations print the call site stack trace.
 */
export function isDebuggingTp(): boolean {
  return process.env.MYCC_DEBUG_TP === 'true';
}

/**
 * Check if debug-prompt mode is enabled (--debug-prompt flag)
 * When enabled, extracted keywords are printed to the console during prompt stage.
 */
export function isDebuggingPrompt(): boolean {
  return process.env.MYCC_DEBUG_PROMPT === 'true';
}

/**
 * Get token threshold for context management
 */
export function getTokenThreshold(): number {
  return parseInt(process.env.TOKEN_THRESHOLD || '50000', 10);
}

/**
 * Get skill matching similarity threshold (0-1)
 */
export function getSkillMatchThreshold(): number {
  const val = process.env.SKILL_MATCH_THRESHOLD;
  return val ? parseFloat(val) : 0.5;
}

/**
 * Get Ollama host URL
 */
export function getOllamaHost(): string {
  return process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
}

/**
 * Get Ollama API key (optional)
 */
export function getOllamaApiKey(): string | undefined {
  return process.env.OLLAMA_API_KEY;
}

/**
 * Get Ollama model name
 */
export function getOllamaModel(): string {
  return process.env.OLLAMA_MODEL || 'glm-5:cloud';
}

/**
 * Get DeepSeek API host
 */
export function getDeepSeekHost(): string {
  return process.env.DEEPSEEK_HOST || 'https://api.deepseek.com';
}

/**
 * Get DeepSeek API key
 */
export function getDeepSeekApiKey(): string | undefined {
  return process.env.DEEPSEEK_API_KEY;
}

/**
 * Get DeepSeek model name
 */
export function getDeepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
}

/**
 * Get the active API provider
 */
export function getApiProvider(): 'ollama' | 'deepseek' {
  return process.env.API_PROVIDER === 'deepseek' ? 'deepseek' : 'ollama';
}

/**
 * Check if vision model is enabled
 * Returns true if OLLAMA_VISION_MODEL is set and not "none"
 */
export function isVisionEnabled(): boolean {
  const model = process.env.OLLAMA_VISION_MODEL;
  return !!model && model !== 'none';
}

/**
 * Get Ollama vision model name for multimodal tasks
 * @throws Error if OLLAMA_VISION_MODEL is not set or set to "none"
 */
export function getVisionModel(): string {
  const model = process.env.OLLAMA_VISION_MODEL;
  if (!model) {
    throw new Error('OLLAMA_VISION_MODEL is not set. Set it to a vision model or "none" to disable vision features.');
  }
  if (model === 'none') {
    throw new Error('Vision features are disabled (OLLAMA_VISION_MODEL=none). Set a vision model to enable screen and read_picture tools.');
  }
  return model;
}

interface EnvValidationResult {
  valid: boolean;
  missing: Array<{ var: string; instruction: string }>;
  warnings: Array<{ var: string; instruction: string }>;
}

/**
 * Validate environment variables and return results
 * Returns missing required vars and warnings for optional ones
 */
export function validateEnv(): EnvValidationResult {
  const missing: Array<{ var: string; instruction: string }> = [];
  const warnings: Array<{ var: string; instruction: string }> = [];

  for (const req of ENV_REQUIREMENTS) {
    const value = process.env[req.name];

    // Check if required and missing
    if (req.required && !value) {
      missing.push({ var: req.name, instruction: req.instruction });
    }
  }

  // Special check: EDITOR or VISUAL (optional but useful)
  if (!process.env.EDITOR && !process.env.VISUAL) {
    warnings.push({
      var: 'EDITOR',
      instruction:
        'Neither EDITOR nor VISUAL is set. The open-editor tool will fail. Add to ~/.mycc-store/.env:\n  export EDITOR=code   # VS Code\n  export EDITOR=vim    # Vim',
    });
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
  };
}

// ============================================================================
// Constants
// ============================================================================

export const MYCC_DIR = '.mycc';

// ============================================================================
// Session Context
// ============================================================================

let currentSessionId: string | null = null;

export function setSessionContext(sessionId: string): void {
  currentSessionId = sessionId;
}

export function getSessionContext(): string {
  if (!currentSessionId) {
    throw new Error('Session context not initialized. Call setSessionContext() first.');
  }
  return currentSessionId;
}

// ============================================================================
// Directory Helpers
// ============================================================================

export function getMyccDir(): string {
  return path.resolve(MYCC_DIR);
}

export function getMailDir(): string {
  return path.join(MYCC_DIR, 'mail');
}

export function getToolsDir(): string {
  return path.join(MYCC_DIR, 'tools');
}

export function getSkillsDir(): string {
  return path.join(MYCC_DIR, 'skills');
}

export function getSessionsDir(): string {
  return path.join(MYCC_DIR, 'sessions');
}

export function getLongtextDir(): string {
  return path.join(MYCC_DIR, 'longtext');
}

export function getUserToolsDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'tools');
}

export function getUserSkillsDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'skills');
}

export function getWikiDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'wiki');
}

export function getWikiLogsDir(): string {
  return path.join(getWikiDir(), 'logs');
}

export function getWikiDbDir(): string {
  return path.join(getWikiDir(), 'db');
}

export function getWikiDomainsFile(): string {
  return path.join(getWikiDir(), 'domains.json');
}

// ============================================================================
// Directory Initialization
// ============================================================================

export function ensureDirs(): void {
  const dirs = [
    MYCC_DIR,
    getMailDir(),
    getToolsDir(),
    getSkillsDir(),
    getSessionsDir(),
    getLongtextDir(),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Wiki directories are in ~/.mycc-store, not project .mycc
  const wikiDirs = [getWikiDir(), getWikiLogsDir(), getWikiDbDir()];
  for (const dir of wikiDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ============================================================================
// Tool Type Imports
// ============================================================================

import chalk from 'chalk';
import { ENV_REQUIREMENTS } from './setup/prompts.js';

/**
 * Ensure mycc is linked in a directory for type imports.
 * Creates a direct symlink to the mycc project root — no npm involved,
 * so it's fast and never times out. MYCC_ROOT is set by bin/mycc.js.
 */
function ensureMyccLink(dir: string, label: string): void {
  const nodeModules = path.join(dir, 'node_modules');
  const myccLink = path.join(nodeModules, 'mycc');

  // Create node_modules if needed
  if (!fs.existsSync(nodeModules)) {
    fs.mkdirSync(nodeModules, { recursive: true });
  }

  // Symlink mycc directly to the project root (resolved by bin/mycc.js)
  if (!fs.existsSync(myccLink)) {
    const myccRoot = process.env.MYCC_ROOT;
    if (!myccRoot) {
      console.warn(chalk.yellow(`[config] MYCC_ROOT not set — cannot link mycc for ${label}`));
      return;
    }
    try {
      const isWin = process.platform === 'win32';
      // 'junction' on Windows doesn't require admin; 'dir' on Unix resolves cleanly
      fs.symlinkSync(myccRoot, myccLink, isWin ? 'junction' : 'dir');
    } catch (err) {
      console.warn(chalk.yellow(`[config] Could not link mycc in ${dir}: ${(err as Error).message}`));
    }
  }
}

/**
 * Ensure type imports work for both user and project tools
 * - User tools: ~/.mycc-store/
 * - Project tools: current working directory (if .mycc exists)
 */
export function ensureToolTypeImports(): void {
  // User tools directory
  const userStore = path.join(os.homedir(), '.mycc-store');
  ensureMyccLink(userStore, 'user tools');

  // Project tools directory (if .mycc exists)
  const projectDir = process.cwd();
  const projectMycc = path.join(projectDir, MYCC_DIR);
  if (fs.existsSync(projectMycc)) {
    ensureMyccLink(projectDir, 'project tools');
  }
}