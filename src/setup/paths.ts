/**
 * paths.ts - Cross-platform path resolution for setup routine
 *
 * Handles path differences between Linux, macOS, and Windows
 */

import os from 'os';
import path from 'path';

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Check if running on macOS
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * Get the user-level config directory
 * - Unix/Linux/macOS: ~/.mycc-store
 * - Windows: %USERPROFILE%\.mycc-store
 */
export function getUserConfigDir(): string {
  return path.join(os.homedir(), '.mycc-store');
}

/**
 * Get the user-level config file path
 */
export function getUserConfigPath(): string {
  return path.join(getUserConfigDir(), '.env');
}

/**
 * Get the project-level config directory
 * Works the same across all platforms (relative to cwd)
 */
export function getProjectConfigDir(): string {
  return path.join(process.cwd(), '.mycc');
}

/**
 * Get the project-level config file path
 */
export function getProjectConfigPath(): string {
  return path.join(getProjectConfigDir(), '.env');
}
