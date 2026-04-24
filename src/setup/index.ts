/**
 * index.ts - Setup entry point
 *
 * Orchestrates the setup flow: display settings, run wizard, pull models, write config
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { getUserConfigPath, getProjectConfigPath, getUserConfigDir, getProjectConfigDir } from './paths.js';
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

  // Step 2: Run the wizard
  const existingConfig = getExistingConfig();
  const { location, config } = await runWizard(existingConfig);

  // Step 3: Determine config path
  const configPath = location === 'user' ? getUserConfigPath() : getProjectConfigPath();
  const _configDir = location === 'user' ? getUserConfigDir() : getProjectConfigDir();

  // Step 4: Ensure directory exists
  ensureConfigDir(configPath);

  // Step 5: Write config file
  writeEnvFile(configPath, config);

  // Step 6: Pull models if Ollama is available
  const ollamaAvailable = await checkOllamaAvailable();
  if (ollamaAvailable) {
    await pullConfiguredModels(config);
  }

  // Step 7: Print success message
  console.log(chalk.green('\n✅ Configuration saved successfully!'));
  console.log(chalk.dim(`   Location: ${configPath}`));
  console.log(chalk.dim(`   Type: ${location}-level\n`));
  console.log(chalk.cyan('You can now run mycc normally.'));
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