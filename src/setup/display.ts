/**
 * display.ts - Current settings display with redaction
 *
 * Shows current environment configuration before prompting
 */

import fs from 'fs';
import chalk from 'chalk';
import { getUserConfigPath, getProjectConfigPath } from './paths.js';
import { ENV_REQUIREMENTS } from './prompts.js';

/**
 * Setting display information
 */
interface SettingDisplay {
  name: string;
  value: string;
  source: 'user' | 'project' | 'default' | 'not-set';
  sensitive: boolean;
}

/**
 * Check if a variable name is sensitive (should be redacted)
 */
function isSensitive(name: string): boolean {
  // Only redact specific sensitive fields
  const sensitiveFields = ['OLLAMA_API_KEY'];
  return sensitiveFields.some((f) => name === f);
}

/**
 * Redact a sensitive value for display
 */
export function redactSensitive(value: string): string {
  if (!value || value === '') return '(not set)';
  if (value.length < 4) return '****';
  return `****${value.slice(-4)}`;
}

/**
 * Parse .env file into key-value pairs
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};

  const content = fs.readFileSync(filePath, 'utf8');
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Get setting display info for a single variable
 */
function getSettingDisplay(
  name: string,
  userConfig: Record<string, string>,
  projectConfig: Record<string, string>,
  defaultValue?: string
): SettingDisplay {
  // Check project-level first (takes precedence)
  if (projectConfig[name]) {
    return {
      name,
      value: projectConfig[name],
      source: 'project',
      sensitive: isSensitive(name),
    };
  }

  // Then user-level
  if (userConfig[name]) {
    return {
      name,
      value: userConfig[name],
      source: 'user',
      sensitive: isSensitive(name),
    };
  }

  // Then default
  if (defaultValue) {
    return {
      name,
      value: defaultValue,
      source: 'default',
      sensitive: false,
    };
  }

  return {
    name,
    value: '',
    source: 'not-set',
    sensitive: isSensitive(name),
  };
}

/**
 * Print a single setting line
 */
function printSetting(setting: SettingDisplay): void {
  const displayValue = setting.sensitive
    ? redactSensitive(setting.value)
    : setting.value || '(not set)';

  const sourceLabel = {
    user: chalk.dim(' [user]'),
    project: chalk.dim(' [project]'),
    default: chalk.dim(' [default]'),
    'not-set': chalk.yellow(' (not set)'),
  }[setting.source];

  console.log(`  ${chalk.white(setting.name)}: ${chalk.green(displayValue)}${sourceLabel}`);
}

/**
 * Display current settings from config files
 */
export function displayCurrentSettings(): void {
  const userConfigPath = getUserConfigPath();
  const projectConfigPath = getProjectConfigPath();

  const userConfig = parseEnvFile(userConfigPath);
  const projectConfig = parseEnvFile(projectConfigPath);

  console.log(chalk.cyan('\n📋 Current Settings\n'));
  console.log(chalk.dim('─'.repeat(50)));

  for (const req of ENV_REQUIREMENTS) {
    const display = getSettingDisplay(req.name, userConfig, projectConfig, req.default);
    printSetting(display);
  }

  console.log(chalk.dim('─'.repeat(50)));
}

/**
 * Get existing config merged from user and project levels
 * Project-level takes precedence
 */
export function getExistingConfig(): Record<string, string> {
  const userConfigPath = getUserConfigPath();
  const projectConfigPath = getProjectConfigPath();

  const userConfig = parseEnvFile(userConfigPath);
  const projectConfig = parseEnvFile(projectConfigPath);

  // Merge: project overrides user
  return { ...userConfig, ...projectConfig };
}

/**
 * Check if any config exists
 */
export function hasExistingConfig(): boolean {
  return fs.existsSync(getUserConfigPath()) || fs.existsSync(getProjectConfigPath());
}