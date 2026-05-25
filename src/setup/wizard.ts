/**
 * wizard.ts - Interactive readline prompts for setup
 *
 * Uses Node.js readline for cross-platform interactive input.
 * Supports provider selection (ollama-cloud vs DeepSeek) with
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
async function promptChatProvider(
  rl: readline.ReadLine,
  existingConfig: Record<string, string>
): Promise<'ollama' | 'deepseek'> {
  return new Promise((resolve) => {
    const currentProvider = existingConfig['API_PROVIDER'] || 'ollama';
    const currentLabel = currentProvider === 'deepseek' ? 'DeepSeek' : 'Ollama';

    console.log(chalk.cyan('\n🤖 Chat Provider Selection'));
    console.log(chalk.dim('  Choose your chat model provider:'));
    console.log('  [1] Ollama   - Local or cloud LLM (requires API key for cloud)');
    console.log('  [2] DeepSeek - DeepSeek Cloud API (requires API key)');
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
async function promptConfigLocation(rl: readline.ReadLine): Promise<'user' | 'project' | 'delete'> {
  return new Promise((resolve) => {
    console.log(chalk.cyan('\n📁 Configuration Location'));
    console.log('  [1] User-level   (~/.mycc-store/.env) - Global, applies to all projects');
    console.log('  [2] Project-level (./.mycc/.env) - Local, applies only to current project');
    console.log('  [3] Delete project config - Remove local config, inherit from user config');

    rl.question(chalk.white('\nChoice [1-3, default: 1]: '), (answer) => {
      const trimmed = answer.trim();
      if (trimmed === '2' || trimmed.toLowerCase() === 'project' || trimmed.toLowerCase() === 'local') {
        resolve('project');
      } else if (trimmed === '3' || trimmed.toLowerCase() === 'delete') {
        resolve('delete');
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
): Promise<{ location: 'user' | 'project' | 'delete'; config: Record<string, string> }> {
  const rl = createRL();
  const config: Record<string, string> = {};

  try {
    // Step 1: Choose config location
    const location = await promptConfigLocation(rl);

    // Handle delete case
    if (location === 'delete') {
      return { location: 'delete', config: {} };
    }

    // Step 2: Get existing config for the selected location only (not merged)
    const locationConfig = getLocationConfig(location);

    // Step 3: Prompt for Ollama connection (common to all providers)
    console.log(chalk.cyan('\n🔌 Ollama Connection (used for embeddings)\n'));
    console.log(chalk.dim('  Press Enter to accept the default or keep existing value.\n'));
    const ollamaConnectionPrompts = getPrompts('ollama').slice(0, 2); // OLLAMA_HOST, OLLAMA_EMBEDDING_MODEL
    for (const promptConfig of ollamaConnectionPrompts) {
      const currentValue = locationConfig[promptConfig.name] || existingConfig[promptConfig.name];
      const value = await prompt(rl, promptConfig, currentValue);
      if (value !== undefined && value !== '') {
        config[promptConfig.name] = value;
      }
    }

    // Step 4: Choose chat provider
    const provider = await promptChatProvider(rl, existingConfig);
    config['API_PROVIDER'] = provider;

    // Step 5: Prompt for provider-specific values
    const providerLabel = provider === 'deepseek' ? 'DeepSeek' : 'Ollama';
    console.log(chalk.cyan(`\n⚙️  ${providerLabel} Configuration\n`));
    console.log(chalk.dim('  Press Enter to accept the default or keep existing value.\n'));

    // Get provider-specific prompts (skip Ollama connection prompts)
    const allPrompts = getPrompts(provider);
    const providerPrompts = allPrompts.slice(2); // Skip OLLAMA_HOST, OLLAMA_EMBEDDING_MODEL
    for (const promptConfig of providerPrompts) {
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
  console.log(chalk.dim('  [1] Ollama   - Local or cloud LLM'));
  console.log(chalk.dim('  [2] DeepSeek - DeepSeek Cloud API (requires API key)\n'));
  console.log(chalk.cyan('Environment variables (Ollama connection - always required):'));
  console.log(chalk.dim('  OLLAMA_HOST            - Ollama server URL (for embeddings)'));
  console.log(chalk.dim('  OLLAMA_EMBEDDING_MODEL - Embedding model name\n'));
  console.log(chalk.cyan('Environment variables (Ollama):'));
  console.log(chalk.dim('  OLLAMA_API_KEY      - API key for cloud features'));
  console.log(chalk.dim('  OLLAMA_MODEL        - Chat model name'));
  console.log(chalk.dim('  OLLAMA_VISION_MODEL - Vision model (or "none")\n'));
  console.log(chalk.cyan('Environment variables (DeepSeek):'));
  console.log(chalk.dim('  DEEPSEEK_HOST      - DeepSeek API endpoint'));
  console.log(chalk.dim('  DEEPSEEK_API_KEY   - DeepSeek API key'));
  console.log(chalk.dim('  DEEPSEEK_MODEL     - DeepSeek model name\n'));
  console.log(chalk.cyan('Environment variables (shared):'));
  console.log(chalk.dim('  TOKEN_THRESHOLD    - Context limit threshold'));
  console.log(chalk.dim('  EDITOR             - Text editor\n'));
  console.log(chalk.dim('  API_PROVIDER       - Set automatically based on your choice\n'));
}
