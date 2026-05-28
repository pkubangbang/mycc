/**
 * ollama.ts - Ollama binary detection and service checks
 *
 * Handles cross-platform Ollama detection and connectivity testing
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';
import { isWindows } from './paths.js';

const execAsync = promisify(exec);

/**
 * Get the default Ollama binary path based on platform.
 * On Windows, checks known install locations and returns the absolute path
 * if found. Returns 'ollama' (relying on PATH) as fallback.
 */
export function getOllamaBinaryPath(): string {
  if (isWindows()) {
    // Windows: Check common install locations
    const windowsPaths = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Ollama', 'ollama.exe'),
    ];
    for (const p of windowsPaths) {
      if (p && existsSync(p)) return p;
    }
    return 'ollama'; // Fallback to PATH
  }

  // macOS and Linux: Use PATH
  return 'ollama';
}

/**
 * Check if Ollama is installed and accessible.
 * On Windows, checks known install locations via filesystem first,
 * then falls back to PATH-based detection.
 */
export async function isOllamaInstalled(): Promise<boolean> {
  // First, check via filesystem (handles Windows where ollama is installed
  // but not added to PATH — the installer doesn't always do this)
  const ollamaPath = getOllamaBinaryPath();
  if (ollamaPath !== 'ollama' && existsSync(ollamaPath)) {
    return true;
  }

  // Fall back to PATH-based detection
  try {
    const command = isWindows() ? 'where ollama' : 'which ollama';
    await execAsync(command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of installed models from Ollama.
 * Uses the discovered binary path so it works even when
 * ollama is not on PATH (common on Windows).
 */
async function getInstalledModels(): Promise<string[]> {
  try {
    const ollamaPath = getOllamaBinaryPath();
    const { stdout } = await execAsync(`"${ollamaPath}" list`);
    // Parse output: lines like "NAME\tID\tSIZE\tMODIFIED"
    const lines = stdout.trim().split('\n').slice(1); // Skip header
    return lines
      .map((line) => line.split('\t')[0]?.trim())
      .filter((name): name is string => !!name);
  } catch {
    return [];
  }
}

/**
 * Check if a specific model is installed
 */
export async function isModelInstalled(modelName: string): Promise<boolean> {
  const models = await getInstalledModels();
  return models.some((m) => m === modelName || m.startsWith(`${modelName}:`));
}
