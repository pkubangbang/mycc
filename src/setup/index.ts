/**
 * index.ts - Setup entry point
 *
 * Orchestrates the setup flow: display settings, run wizard, pull models, write config
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { getUserConfigPath, getProjectConfigPath } from './paths.js';
import { displayCurrentSettings, getExistingConfig, hasExistingConfig, parseEnvFile } from './display.js';
import { runWizard, isInteractiveTerminal, displaySetupHelp } from './wizard.js';
import { pullConfiguredModels, checkOllamaAvailable } from './models.js';

/**
 * Write config to .env file
 */
function writeEnvFile(filePath: string, config: Record<string, string>): void {
  const lines: string[] = ['# MyCC Configuration', `# Generated on ${new Date().toISOString()}`, ''];

  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && value !== '') {
      lines.push(`${key}=${value}`);
    }
  }

  lines.push(''); // Final newline

  const content = lines.join(os.EOL);
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Ensure directory exists for config file
 */
function ensureConfigDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Main setup entry point
 */
export async function runSetup(): Promise<void> {
  // Check if terminal is interactive
  if (!isInteractiveTerminal()) {
    console.log(chalk.red('Error: Setup requires an interactive terminal.'));
    console.log(chalk.dim('Please run `mycc --setup` in a terminal.'));
    console.log(chalk.dim('\nAlternatively, create the config file manually:'));
    console.log(chalk.dim('  User-level:   ~/.mycc-store/.env'));
    console.log(chalk.dim('  Project-level: ./.mycc/.env'));
    process.exit(1);
  }

  // Display help
  displaySetupHelp();

  // Step 1: Display current settings
  if (hasExistingConfig()) {
    displayCurrentSettings();
  } else {
    console.log(chalk.cyan('\nNo existing configuration found.\n'));
    console.log(chalk.dim('  This appears to be a fresh installation.'));
    console.log(chalk.dim('  Let\'s configure your environment.\n'));
  }

  // Step 2: Run the wizard (includes provider selection)
  const existingConfig = getExistingConfig();
  const { location, config } = await runWizard(existingConfig);

  // Handle delete case
  if (location === 'delete') {
    const projectConfigPath = getProjectConfigPath();
    const fs = await import('fs');
    if (fs.existsSync(projectConfigPath)) {
      fs.unlinkSync(projectConfigPath);
      console.log(chalk.green('\nProject configuration deleted.'));
      console.log(chalk.dim('   Will inherit from user-level config if it exists.\n'));
    } else {
      console.log(chalk.yellow('\nNo project configuration found to delete.'));
      console.log(chalk.dim('   Already using user-level config.\n'));
    }
    return;
  }

  // Determine the selected provider
  const provider = config['API_PROVIDER'] === 'deepseek' ? 'deepseek' : 'ollama';

  // Step 3: Determine config path
  const configPath = location === 'user' ? getUserConfigPath() : getProjectConfigPath();

  // Step 4: Ensure directory exists
  ensureConfigDir(configPath);

  // Step 5: Merge with existing config to preserve untouched variables
  let existingFileConfig: Record<string, string> = {};
  if (fs.existsSync(configPath)) {
    existingFileConfig = parseEnvFile(configPath);
  }
  const mergedConfig = { ...existingFileConfig, ...config };

  // Step 6: Write config file
  writeEnvFile(configPath, mergedConfig);

  // Step 7: Pull models (provider-aware)
  if (provider === 'ollama') {
    const ollamaAvailable = await checkOllamaAvailable();
    if (ollamaAvailable) {
      await pullConfiguredModels(config, provider);
    }
  } else {
    // DeepSeek: always run (shows info + pulls embedding model if Ollama available)
    await pullConfiguredModels(config, provider);
  }

  // Step 8: Print success message with next steps
  const providerLabel = provider === 'deepseek' ? 'DeepSeek' : 'Ollama';
  console.log(chalk.green(`\nConfiguration saved successfully!`));
  console.log(chalk.dim(`   Location: ${configPath}`));
  console.log(chalk.dim(`   Provider: ${providerLabel}`));
  console.log(chalk.dim(`   Type: ${location}-level\n`));

  // Provider-specific next steps
  // Resolve the host from what the user typed, falling back to the written config
  // and finally the default — pressing Enter on OLLAMA_HOST leaves `config` without it.
  const ollamaHost = (
    config['OLLAMA_HOST'] || mergedConfig['OLLAMA_HOST'] || 'http://127.0.0.1:11434'
  ).toLowerCase();
  const isLocalOllama = ollamaHost.includes('127.0.0.1') || ollamaHost.includes('localhost');

  if (provider === 'ollama' && isLocalOllama) {
    console.log(chalk.cyan('Next steps for local Ollama:'));
    console.log('  1. Start Ollama: ollama serve');
    console.log('  2. Pull a model: ollama pull llama3.1');
    console.log('  3. Run mycc: mycc');
  } else if (provider === 'ollama') {
    console.log(chalk.cyan('Next steps for Ollama Cloud:'));
    console.log('  1. Ensure OLLAMA_API_KEY is set in your .env');
    console.log('  2. Run mycc: mycc');
  } else {
    console.log(chalk.cyan('Next steps for DeepSeek:'));
    console.log('  1. Verify API key at https://platform.deepseek.com');
    console.log('  2. Run mycc: mycc');
  }
}

// Export for CLI
export { displaySetupHelp } from './wizard.js';
export { displayCurrentSettings } from './display.js';
export { getExistingConfig } from './display.js';

// Auto-run when executed as main module (via spawn)
runSetup().catch((err) => {
  console.error(chalk.red('Setup failed:'), err);
  process.exit(1);
});
