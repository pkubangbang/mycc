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
 * Get the default Ollama binary path based on platform
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
 * Check if Ollama is installed and accessible
 */
export async function isOllamaInstalled(): Promise<boolean> {
  try {
    const ollamaPath = getOllamaBinaryPath();
    const command = isWindows() ? `where ${ollamaPath}` : `which ${ollamaPath}`;
    await execAsync(command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Ollama service is running
 */
export async function isOllamaRunning(host: string): Promise<boolean> {
  try {
    const response = await fetch(`${host}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get list of installed models from Ollama
 */
export async function getInstalledModels(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('ollama list');
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