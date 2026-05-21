/**
 * models.ts - Model pulling via ollama
 *
 * Automatically pulls required models after configuration.
 * Only applicable when Ollama is the LLM provider. When DeepSeek
 * is selected, model pulling is skipped.
 */

import { spawn } from 'child_process';
import chalk from 'chalk';
import { isWindows } from './paths.js';
import { isModelInstalled, isOllamaInstalled } from './ollama-setup.js';

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
 * Pull all configured models (Ollama provider)
 */
async function pullOllamaModels(config: Record<string, string>): Promise<void> {
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
}

/**
 * Show informational message for DeepSeek provider
 */
function showDeepSeekInfo(): void {
  console.log(chalk.cyan('\n🔄 DeepSeek model configuration'));
  console.log(chalk.dim('  DeepSeek models are cloud-based; no local pull is needed.'));
  console.log(chalk.dim('  Make sure your DEEPSEEK_API_KEY is valid at https://platform.deepseek.com'));
  console.log();

  // Still pull the embedding model (always uses Ollama)
  console.log(chalk.dim('  Note: The embedding model for wiki/RAG still uses Ollama (if configured).\n'));
}

/**
 * Pull all configured models based on provider
 */
export async function pullConfiguredModels(
  config: Record<string, string>,
  provider?: 'ollama' | 'deepseek'
): Promise<void> {
  if (provider === 'deepseek') {
    showDeepSeekInfo();
    // Still try to pull embedding model (uses Ollama)
    const embeddingModel = config['OLLAMA_EMBEDDING_MODEL'];
    if (embeddingModel && embeddingModel !== 'none' && embeddingModel.trim() !== '') {
      const installed = await isOllamaInstalled();
      if (installed) {
        await pullModel(embeddingModel);
      } else {
        console.log(chalk.yellow('  ⚠ Ollama not found. Cannot pull embedding model.'));
        console.log(chalk.dim('    Install Ollama and pull the embedding model manually:'));
        console.log(chalk.dim(`    ollama pull ${embeddingModel}`));
      }
    }
    return;
  }

  // Ollama provider — pull all models
  await pullOllamaModels(config);
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
