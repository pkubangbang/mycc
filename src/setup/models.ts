/**
 * models.ts - Model pulling via ollama
 *
 * Automatically pulls required models after configuration
 */

import { spawn } from 'child_process';
import chalk from 'chalk';
import { isWindows } from './paths.js';
import { isModelInstalled, isOllamaInstalled } from './ollama.js';

/**
 * Model info for pulling
 */
interface ModelInfo {
  name: string;
  envVar: string;
  required: boolean;
}

/**
 * Models to pull based on configuration
 */
const MODELS_TO_PULL: ModelInfo[] = [
  { name: 'general', envVar: 'OLLAMA_MODEL', required: true },
  { name: 'vision', envVar: 'OLLAMA_VISION_MODEL', required: false },
  { name: 'embedding', envVar: 'OLLAMA_EMBEDDING_MODEL', required: false },
];

/**
 * Pull a single model via ollama
 */
async function pullModel(modelName: string): Promise<{ success: boolean; error?: string }> {
  console.log(chalk.cyan(`\n📥 Pulling model: ${modelName}`));

  try {
    // Check if model already exists
    if (await isModelInstalled(modelName)) {
      console.log(chalk.dim(`  ✓ Model ${modelName} already exists, skipping pull`));
      return { success: true };
    }

    // Pull the model with progress output
    await new Promise((resolve, reject) => {
      const pull = spawn('ollama', ['pull', modelName], {
        stdio: 'inherit',
        // On Windows, shell: true helps with PATH resolution
        shell: isWindows(),
      });

      pull.on('close', (code) => {
        if (code === 0) resolve(true);
        else reject(new Error(`ollama pull exited with code ${code}`));
      });
      pull.on('error', reject);
    });

    console.log(chalk.green(`  ✓ Successfully pulled ${modelName}`));
    return { success: true };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`  ⚠ Failed to pull ${modelName}: ${errMsg}`));
    return { success: false, error: errMsg };
  }
}

/**
 * Pull all configured models
 */
export async function pullConfiguredModels(config: Record<string, string>): Promise<void> {
  console.log(chalk.cyan('\n🔄 Checking and pulling required models...\n'));

  for (const model of MODELS_TO_PULL) {
    const modelName = config[model.envVar];

    // Skip if not configured
    if (!modelName || modelName === 'none' || modelName.trim() === '') {
      if (model.required) {
        console.log(chalk.yellow(`  ⚠ ${model.name} model not configured (required)`));
      } else {
        console.log(chalk.dim(`  - ${model.name} model not configured, skipping`));
      }
      continue;
    }

    const result = await pullModel(modelName);

    if (!result.success && model.required) {
      console.log(
        chalk.yellow(
          `  ⚠ Could not pull required model ${modelName}. You may need to pull it manually later.`
        )
      );
    }
  }

  console.log(chalk.dim('\n  Model pull complete.\n'));
}

/**
 * Check if Ollama is installed before attempting to pull
 */
export async function checkOllamaAvailable(): Promise<boolean> {
  const installed = await isOllamaInstalled();

  if (!installed) {
    console.log(chalk.yellow('\n⚠ Warning: Ollama is not installed or not in PATH.'));
    console.log(chalk.dim('  Models will not be pulled automatically.'));
    console.log(chalk.dim('  Please install Ollama from https://ollama.ai\n'));
    return false;
  }

  return true;
}