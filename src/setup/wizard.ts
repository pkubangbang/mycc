/**
 * wizard.ts - Interactive readline prompts for setup
 *
 * Uses Node.js readline for cross-platform interactive input.
 * Supports provider selection (Ollama vs DeepSeek) with
 * conditional prompting based on the choice.
 */

import readline from 'readline';
import chalk from 'chalk';
import { getPrompts, PromptConfig } from './prompts.js';
import { redactSensitive, parseEnvFile } from './display.js';
import { getUserConfigPath, getProjectConfigPath } from './paths.js';

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
 * Prompt for API provider choice (Ollama or DeepSeek)
 */
async function promptProviderChoice(
  rl: readline.ReadLine,
  existingConfig: Record<string, string>
): Promise<'ollama' | 'deepseek'> {
  return new Promise((resolve) => {
    const currentProvider = existingConfig['API_PROVIDER'] || 'ollama';
    const currentLabel = currentProvider === 'deepseek' ? 'DeepSeek' : 'Ollama';

    console.log(chalk.cyan('\n🔌 API Provider Selection'));
    console.log(chalk.dim('  mycc supports two LLM providers:'));
    console.log('  [1] Ollama  - Local LLM inference (default). Requires Ollama installed.');
    console.log('  [2] DeepSeek - Cloud API. Requires an API key. Supports web_search/web_fetch/vision? No.');
    console.log();
    console.log(chalk.dim('  Note: Embeddings (wiki/RAG) always use Ollama regardless of provider choice.'));
    console.log();

    const promptText = currentProvider
      ? chalk.white(`Provider [1-2, current: ${currentLabel}] [default: ${currentLabel}]: `)
      : chalk.white('Provider [1-2, default: 1]: ');

    rl.question(promptText, (answer) => {
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '2' || trimmed === 'deepseek') {
        resolve('deepseek');
      } else {
        resolve('ollama');
      }
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
  const config: Record<string, string> = {};

  try {
    // Step 1: Choose API provider
    const provider = await promptProviderChoice(rl, existingConfig);
    config['API_PROVIDER'] = provider;

    // Step 2: Choose config location
    const location = await promptConfigLocation(rl);

    // Step 3: Get existing config for the selected location only (not merged)
    const locationConfig = getLocationConfig(location);

    // Step 4: Prompt for provider-specific values
    const providerLabel = provider === 'deepseek' ? 'DeepSeek' : 'Ollama';
    console.log(chalk.cyan(`\n⚙️  ${providerLabel} Configuration\n`));
    console.log(chalk.dim('  Press Enter to accept the default or keep existing value.\n'));

    const prompts = getPrompts(provider);
    for (const promptConfig of prompts) {
      // Check existing config in order: location-specific, then merged
      const currentValue = locationConfig[promptConfig.name] || existingConfig[promptConfig.name];
      const value = await prompt(rl, promptConfig, currentValue);
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
 * Get config from the specific location (not merged)
 */
function getLocationConfig(location: 'user' | 'project'): Record<string, string> {
  if (location === 'user') {
    return parseEnvFile(getUserConfigPath());
  } else {
    return parseEnvFile(getProjectConfigPath());
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
  console.log(chalk.cyan('Providers:'));
  console.log(chalk.dim('  [1] Ollama (default)'));
  console.log(chalk.dim('  [2] DeepSeek\n'));
  console.log(chalk.cyan('Environment variables (Ollama):'));
  console.log(chalk.dim('  OLLAMA_HOST          - Ollama server URL'));
  console.log(chalk.dim('  OLLAMA_MODEL         - General/chat model'));
  console.log(chalk.dim('  OLLAMA_VISION_MODEL  - Vision model (or "none")'));
  console.log(chalk.dim('  OLLAMA_API_KEY       - API key for cloud features'));
  console.log(chalk.cyan('Environment variables (DeepSeek):'));
  console.log(chalk.dim('  DEEPSEEK_HOST        - DeepSeek API endpoint'));
  console.log(chalk.dim('  DEEPSEEK_API_KEY     - DeepSeek API key'));
  console.log(chalk.dim('  DEEPSEEK_MODEL       - DeepSeek model name'));
  console.log(chalk.cyan('Environment variables (shared):'));
  console.log(chalk.dim('  OLLAMA_EMBEDDING_MODEL - Embedding model (always uses Ollama)'));
  console.log(chalk.dim('  TOKEN_THRESHOLD      - Context limit threshold'));
  console.log(chalk.dim('  EDITOR               - Text editor\n'));
  console.log(chalk.dim('  API_PROVIDER         - Set automatically based on your choice\n'));
}
