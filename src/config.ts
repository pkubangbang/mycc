/**
 * config.ts - Global runtime configuration
 *
 * Stores CLI-derived settings accessible throughout the codebase.
 * Uses minimist for argument parsing.
 */

import minimist from 'minimist';

// Parse CLI args once at startup
const args = minimist(process.argv.slice(2), {
  boolean: ['v', 'verbose'],
  string: ['session'],
  alias: { v: 'verbose' },
  default: { v: false, session: null },
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
 * Quick check for verbose mode (convenience)
 */
export function isVerbose(): boolean {
  return globalConfig.verbose;
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
        'Neither EDITOR nor VISUAL is set. The open-editor tool will fail. Add to ~/.mycc/.env:\n  export EDITOR=code   # VS Code\n  export EDITOR=vim    # Vim',
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