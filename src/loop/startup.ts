/**
 * startup.ts - Health-check + startup banner for the Lead
 *
 * Extracted from agent-repl.ts to isolate the pre-session connectivity
 * validation and the aligned-label status banner from the REPL orchestration.
 */

import chalk from 'chalk';
import { MODEL } from '../engine/chat-provider.js';
import { healthCheck } from '../engine/chat-provider.js';
import { getOllamaHost, getApiProvider, getEmbeddingModel, getTokenThreshold, shouldSkipHealthCheck, isDebuggingEval } from '../config.js';
import { agentIO } from './agent-io.js';

/** Model info surfaced by a successful health check (for the banner). */
export interface ModelInfo {
  family?: string;
  parameterSize?: string;
  contextLength: number;
}

/**
 * Run the Ollama/DeepSeek health check with a retry prompt. Returns the
 * provider's model info on success (null when skipped). On user refusal to
 * retry, exits the process.
 */
export async function runHealthCheck(): Promise<ModelInfo | null> {
  const tokenThreshold = getTokenThreshold();

  if (shouldSkipHealthCheck()) {
    console.log(chalk.gray('Skipping health check (test mode)'));
  }

  if (isDebuggingEval()) {
    console.log(chalk.yellow('Debug-eval mode enabled: expression AST trees will be printed'));
  }

  if (shouldSkipHealthCheck()) {
    return null;
  }

  let modelInfo: ModelInfo | null = null;
  while (true) {
    const health = await healthCheck(tokenThreshold);
    if (health.ok) {
      if (health.modelInfo) modelInfo = health.modelInfo;
      if (health.warnings && health.warnings.length > 0) {
        console.log();
        for (const warning of health.warnings) {
          console.log(chalk.yellow(`[warning] ${warning}`));
        }
      }
      return modelInfo;
    }

    console.error(chalk.red(`Health check failed: ${health.error}`));
    console.log(chalk.gray('─'.repeat(40)));
    console.log(chalk.yellow('Common fixes:'));
    if (getApiProvider() === 'deepseek') {
      console.log(chalk.gray('  1. Check DEEPSEEK_API_KEY in .mycc/.env'));
      console.log(chalk.gray('  2. Verify DEEPSEEK_MODEL is correct'));
      console.log(chalk.gray('  3. Check network connectivity to api.deepseek.com'));
    } else {
      console.log(chalk.gray('  1. Ensure Ollama is running: ollama serve'));
      console.log(chalk.gray('  2. Check OLLAMA_HOST in ~/.mycc-store/.env'));
      console.log(chalk.gray('  3. Verify model exists: ollama list'));
    }
    console.log();

    const answer = agentIO.getAuto() ? 'y' : await agentIO.ask(chalk.cyan('Retry health check? [Y/n] > '), { useAsPrompt: true, onEsc: 'n', onEnter: 'y' });
    if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
      console.log(chalk.yellow('Exiting at user request.'));
      process.exit(1);
    }

    console.log(chalk.cyan('Retrying health check...'));
    console.log();
  }
}

/**
 * Display the aligned-label startup banner (version, model, host, provider,
 * model info, threshold, embedding). Pass the modelInfo returned by
 * runHealthCheck (null when the check was skipped).
 */
export function displayStartupBanner(version: string, modelInfo: ModelInfo | null): void {
  const tokenThreshold = getTokenThreshold();
  const labelWidth = 12;
  const alignLabel = (label: string) => label.padEnd(labelWidth);

  const apiProvider = getApiProvider();
  const providerLabel = apiProvider === 'deepseek' ? 'DeepSeek' : 'Ollama';
  const hostUrl = apiProvider === 'deepseek'
    ? process.env.DEEPSEEK_HOST || 'https://api.deepseek.com'
    : getOllamaHost();

  console.log();
  console.log(chalk.cyan.bold(`Coding Agent v${version}`));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.cyan(`${alignLabel('Model:')}${MODEL}`));
  console.log(chalk.gray(`${alignLabel('Host:')}${hostUrl}`));
  console.log(chalk.gray(`${alignLabel('Provider:')}${providerLabel}`));

  if (modelInfo) {
    if (modelInfo.family) console.log(chalk.gray(`${alignLabel('Family:')}${modelInfo.family}`));
    if (modelInfo.parameterSize) console.log(chalk.gray(`${alignLabel('Params:')}${modelInfo.parameterSize}`));
    console.log(chalk.gray(`${alignLabel('Context:')}${modelInfo.contextLength}`));
  }

  console.log(chalk.gray(`${alignLabel('Threshold:')}${tokenThreshold} tokens`));
  console.log(chalk.gray(`${alignLabel('Embedding:')}${getEmbeddingModel()}`));
}