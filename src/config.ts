/**
 * config.ts - Global runtime configuration and directory helpers
 *
 * Stores CLI-derived settings accessible throughout the codebase.
 * Also contains directory helpers and session context (migrated from db.ts).
 * Uses minimist for argument parsing.
 */

import minimist from 'minimist';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Parse CLI args once at startup
const args = minimist(process.argv.slice(2), {
  boolean: ['v', 'verbose', 'skip-healthcheck'],
  string: ['session'],
  alias: { v: 'verbose' },
  default: { v: false, session: null, 'skip-healthcheck': false },
});

/**
 * Global runtime configuration singleton
 */
class GlobalConfig {
  private _verbose: boolean;

  constructor() {
    this._verbose = args.v || args.verbose || false;
  }

  /** Verbose mode - show detailed debug output */
  get verbose(): boolean {
    return this._verbose;
  }

  set verbose(value: boolean) {
    this._verbose = value;
  }
}

export const globalConfig = new GlobalConfig();

/**
 * Get session ID from CLI args (--session flag)
 */
export function getSessionArg(): string | null {
  return args.session || null;
}

/**
 * Check if health check should be skipped
 */
export function shouldSkipHealthCheck(): boolean {
  return args['skip-healthcheck'] || false;
}

/**
 * Quick check for verbose mode (convenience)
 */
export function isVerbose(): boolean {
  return globalConfig.verbose;
}

/**
 * Get token threshold for context management
 */
export function getTokenThreshold(): number {
  return parseInt(process.env.TOKEN_THRESHOLD || '50000', 10);
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
 * Get Ollama vision model name for multimodal tasks
 * @throws Error if OLLAMA_VISION_MODEL is not set
 */
export function getVisionModel(): string {
  const model = process.env.OLLAMA_VISION_MODEL;
  if (!model) {
    throw new Error('OLLAMA_VISION_MODEL is not set. Set it in your environment to enable image capabilities (e.g., OLLAMA_VISION_MODEL=gemma4:31b-cloud)');
  }
  return model;
}

/**
 * Environment variable requirements
 */
interface EnvRequirement {
  name: string;
  required: boolean;
  default?: string;
  instruction: string;
}

const ENV_REQUIREMENTS: EnvRequirement[] = [
  {
    name: 'OLLAMA_HOST',
    required: false,
    default: 'http://127.0.0.1:11434',
    instruction: 'Set OLLAMA_HOST for your Ollama server (default: http://127.0.0.1:11434)',
  },
  {
    name: 'OLLAMA_MODEL',
    required: false,
    default: 'glm-5:cloud',
    instruction: 'Set OLLAMA_MODEL to specify which model to use (default: glm-5:cloud)',
  },
  {
    name: 'OLLAMA_VISION_MODEL',
    required: false,
    instruction: 'Set OLLAMA_VISION_MODEL for vision/multimodal tasks (required for screen and read_picture tools)',
  },
  {
    name: 'OLLAMA_API_KEY',
    required: false,
    instruction: 'Set OLLAMA_API_KEY for cloud/web search features (optional)',
  },
  {
    name: 'TOKEN_THRESHOLD',
    required: false,
    default: '50000',
    instruction: 'Set TOKEN_THRESHOLD for context limit (default: 50000)',
  },
];

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

/**
 * Print environment status (for verbose mode)
 */
export function printEnvStatus(): void {
  console.log('[config] Environment status:');
  for (const req of ENV_REQUIREMENTS) {
    const value = process.env[req.name];
    if (value) {
      // Redact API key
      const display = req.name === 'OLLAMA_API_KEY' ? '****' + value.slice(-4) : value;
      console.log(`  ${req.name}: ${display}`);
    } else if (req.default) {
      console.log(`  ${req.name}: (using default: ${req.default})`);
    } else {
      console.log(`  ${req.name}: (not set)`);
    }
  }
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