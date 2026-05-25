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
import { displayCurrentSettings, getExistingConfig, hasExistingConfig } from './display.js';
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
    console.log(chalk.cyan('\n📋 No existing configuration found.\n'));
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
      console.log(chalk.green('\n✅ Project configuration deleted.'));
      console.log(chalk.dim('   Will inherit from user-level config if it exists.\n'));
    } else {
      console.log(chalk.yellow('\n⚠️  No project configuration found to delete.'));
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

  // Step 5: Write config file
  writeEnvFile(configPath, config);

  // Step 6: Pull models (provider-aware)
  if (provider === 'ollama') {
    const ollamaAvailable = await checkOllamaAvailable();
    if (ollamaAvailable) {
      await pullConfiguredModels(config, provider);
    }
  } else {
    // DeepSeek: always run (shows info + pulls embedding model if Ollama available)
    await pullConfiguredModels(config, provider);
  }

  // Step 7: Print success message
  const providerLabel = provider === 'deepseek' ? 'DeepSeek' : 'Ollama';
  console.log(chalk.green(`\n✅ Configuration saved successfully!`));
  console.log(chalk.dim(`   Location: ${configPath}`));
  console.log(chalk.dim(`   Provider: ${providerLabel}`));
  console.log(chalk.dim(`   Type: ${location}-level\n`));
  console.log(chalk.cyan(`You can now run mycc normally.`));
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
