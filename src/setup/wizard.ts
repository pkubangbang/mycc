/**
 * wizard.ts - Interactive readline prompts for setup
 *
 * Uses Node.js readline for cross-platform interactive input
 */

import readline from 'readline';
import chalk from 'chalk';
import { getPrompts, PromptConfig } from './prompts.js';
import { redactSensitive } from './display.js';

/**
 * Create a readline interface
 */
function createRL(): readline.ReadLine {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Prompt for a single value
 */
async function prompt(
  rl: readline.ReadLine,
  config: PromptConfig,
  existingValue?: string
): Promise<string> {
  return new Promise((resolve) => {
    let promptText = chalk.white(`${config.message}`);

    // Show default or existing value
    if (existingValue && existingValue.trim() !== '') {
      const displayValue = config.sensitive
        ? redactSensitive(existingValue)
        : existingValue;
      promptText += chalk.dim(` [current: ${displayValue}]`);
    } else if (config.default !== undefined) {
      promptText += chalk.dim(` [default: ${config.default}]`);
    }

    promptText += ': ';

    rl.question(promptText, (answer) => {
      const trimmed = answer.trim();

      // Empty input - use existing or default
      if (trimmed === '') {
        if (existingValue && existingValue.trim() !== '') {
          resolve(existingValue);
        } else if (config.default !== undefined) {
          resolve(config.default);
        } else {
          resolve('');
        }
        return;
      }

      // Validate if validator exists
      if (config.validate) {
        const result = config.validate(trimmed);
        if (result !== true) {
          console.log(chalk.red(`  ✗ ${result}`));
          // Re-prompt
          prompt(rl, config, existingValue).then(resolve);
          return;
        }
      }

      // Transform if transformer exists
      const finalValue = config.transform ? config.transform(trimmed) : trimmed;
      resolve(finalValue);
    });
  });
}

/**
 * Prompt for config location
 */
async function promptConfigLocation(rl: readline.ReadLine): Promise<'user' | 'project'> {
  return new Promise((resolve) => {
    console.log(chalk.cyan('\n📁 Where do you want to store the configuration?'));
    console.log('  [1] User-level (~/.mycc-store/.env) - Global, applies to all projects');
    console.log('  [2] Project-level (./.mycc/.env) - Local, applies only to current project');

    rl.question(chalk.white('\nChoice [1-2, default: 1]: '), (answer) => {
      const trimmed = answer.trim();
      if (trimmed === '2' || trimmed.toLowerCase() === 'project' || trimmed.toLowerCase() === 'local') {
        resolve('project');
      } else {
        resolve('user'); // Default to user-level
      }
    });
  });
}

/**
 * Check if terminal is interactive
 */
export function isInteractiveTerminal(): boolean {
  // Check if stdin is a TTY
  if (!process.stdin.isTTY) {
    return false;
  }

  // Check if running in CI
  if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) {
    return false;
  }

  return true;
}

/**
 * Run the interactive wizard
 */
export async function runWizard(
  existingConfig: Record<string, string>
): Promise<{ location: 'user' | 'project'; config: Record<string, string> }> {
  const rl = createRL();
  const prompts = getPrompts();
  const config: Record<string, string> = {};

  try {
    // Step 1: Choose config location
    const location = await promptConfigLocation(rl);

    // Step 2: Prompt for each configuration value
    console.log(chalk.cyan('\n⚙️  Configuration\n'));
    console.log(chalk.dim('  Press Enter to accept the default or keep existing value.\n'));

    for (const promptConfig of prompts) {
      const value = await prompt(rl, promptConfig, existingConfig[promptConfig.name]);
      if (value !== undefined && value !== '') {
        config[promptConfig.name] = value;
      }
    }

    return { location, config };
  } finally {
    rl.close();
  }
}

/**
 * Display help text for setup
 */
export function displaySetupHelp(): void {
  console.log(chalk.cyan('\nmycc --setup'));
  console.log(chalk.dim('  Launch interactive setup wizard to configure environment variables.\n'));
  console.log(chalk.cyan('Config locations:'));
  console.log(chalk.dim('  User-level:   ~/.mycc-store/.env (global)'));
  console.log(chalk.dim('  Project-level: ./.mycc/.env (local)\n'));
  console.log(chalk.cyan('Environment variables:'));
  console.log(chalk.dim('  OLLAMA_HOST          - Ollama server URL'));
  console.log(chalk.dim('  OLLAMA_MODEL         - General/chat model'));
  console.log(chalk.dim('  OLLAMA_VISION_MODEL  - Vision model (or "none")'));
  console.log(chalk.dim('  OLLAMA_EMBEDDING_MODEL - Embedding model'));
  console.log(chalk.dim('  OLLAMA_API_KEY       - API key for cloud features'));
  console.log(chalk.dim('  TOKEN_THRESHOLD      - Context limit threshold'));
  console.log(chalk.dim('  EDITOR               - Text editor\n'));
}