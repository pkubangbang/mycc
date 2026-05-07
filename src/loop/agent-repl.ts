/**
 * agent-repl.ts - Main entry point for the coding agent
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { MODEL, OLLAMA_HOST, classifyError } from '../ollama.js';
import { checkHealth } from '../setup/ollama-health-check.js';
import { ParentContext } from '../context/parent-context.js';
import { getSessionId } from '../session/index.js';
import { slashRegistry } from '../slashes/index.js';
import { getTokenThreshold } from '../config.js';
import { Triologue } from './triologue.js';
import { agentIO } from './agent-io.js';
import { shouldSkipHealthCheck } from '../config.js';
import { loader } from '../context/shared/loader.js';
import { initializeSession } from '../session/index.js';
import { ConditionRegistry } from '../hook/conditions.js';
import { Sequence } from '../hook/sequence.js';
import { HookExecutor } from '../hook/hook-executor.js';
import { Core } from '../context/parent/core.js';
import { AgentStateMachine } from './state-machine.js';
import type { StateHandler } from './state-machine.js';
import { UserInputProvider } from './input-provider.js';
import { handlePrompt, setInitialQuery } from './states/prompt.js';
import { handleSlash } from './states/slash.js';
import { handleCollect } from './states/collect.js';
import { handleLlm } from './states/llm.js';
import { handleHook } from './states/hook.js';
import { handleTool } from './states/tool.js';
import { handleStop } from './states/stop.js';
import pkg from '../../package.json';
import { get_default_mindmap_path, load_mindmap, validate_mindmap } from '../mindmap/index.js';
import type { Node } from '../mindmap/types.js';

const version = pkg.version;

export async function main(): Promise<void> {
  // Guard: Must run under Coordinator
  if (!process.send) {
    console.error(chalk.red('Error: Lead process must be started via Coordinator (mycc command)'));
    console.error(chalk.gray('Run: mycc'));
    process.exit(1);
  }

  // Force colors since stdout is piped through Coordinator (not a TTY)
  chalk.level = 1;

  // Get token threshold once (env value, doesn't change during execution)
  const tokenThreshold = getTokenThreshold();

  // Initialize AgentIO early (needed for ask() during health check and session restoration)
  agentIO.initMain();

  // Health check: validate Ollama connectivity and model availability
  let modelInfo: { family?: string; parameterSize?: string; contextLength: number } | null = null;
  if (shouldSkipHealthCheck()) {
    console.log(chalk.gray('Skipping health check (test mode)'));
  } else {
    while (true) {
      const health = await checkHealth(tokenThreshold);
      if (health.ok) {
        if (health.modelInfo) modelInfo = health.modelInfo;
        if (health.warnings && health.warnings.length > 0) {
          console.log();
          for (const warning of health.warnings) {
            console.log(chalk.yellow(`[warning] ${warning}`));
          }
        }
        break;
      }

      console.error(chalk.red(`Health check failed: ${health.error}`));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(chalk.yellow('Common fixes:'));
      console.log(chalk.gray('  1. Ensure Ollama is running: ollama serve'));
      console.log(chalk.gray('  2. Check OLLAMA_HOST in ~/.mycc-store/.env'));
      console.log(chalk.gray('  3. Verify model exists: ollama list'));
      console.log();

      const answer = await agentIO.ask(chalk.cyan('Retry health check? [Y/n] > '), true);
      if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
        console.log(chalk.yellow('Exiting at user request.'));
        process.exit(1);
      }

      console.log(chalk.cyan('Retrying health check...'));
      console.log();
    }
  }

  // Display startup info
  const labelWidth = 12;
  const alignLabel = (label: string) => label.padEnd(labelWidth);

  console.log();
  console.log(chalk.cyan.bold(`Coding Agent v${version}`));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.cyan(`${alignLabel('Model:')}${MODEL}`));
  console.log(chalk.gray(`${alignLabel('Host:')}${OLLAMA_HOST}`));

  if (modelInfo) {
    if (modelInfo.family) console.log(chalk.gray(`${alignLabel('Family:')}${modelInfo.family}`));
    if (modelInfo.parameterSize) console.log(chalk.gray(`${alignLabel('Params:')}${modelInfo.parameterSize}`));
    console.log(chalk.gray(`${alignLabel('Context:')}${modelInfo.contextLength}`));
  }

  console.log(chalk.gray(`${alignLabel('Threshold:')}${tokenThreshold} tokens`));

  // Initialize session (restore or create new)
  const sessionInit = await initializeSession();
  const { sessionFilePath, triologuePath, restoredPair, initialQuery } = sessionInit;

  // Pass initial query to prompt handler
  setInitialQuery(initialQuery);

  // Display session info
  const sessionId = getSessionId(sessionFilePath);
  console.log(chalk.gray(`${alignLabel('Session:')}${sessionId.slice(0, 7)}`));

  const commands = slashRegistry.list().map((c) => `/${c}`).join(', ');
  console.log(chalk.gray(`${alignLabel('Commands:')}${commands}, /exit`));
  console.log();

  // Load tools/skills
  await loader.loadAll();
  loader.watchDirectories();

  // Create context
  const ctx = new ParentContext(sessionFilePath);
  ctx.initializeIpcHandlers();

  await ctx.wiki.checkSkillsDomain();
  await ctx.wt.syncWorkTrees();

  // Load mindmap
  const workDir = process.cwd();
  const mindmapPath = get_default_mindmap_path(workDir);
  let mindmapLoaded = false;

  if (!fs.existsSync(mindmapPath)) {
    // No mindmap.json - show warning
    console.log(chalk.yellow('[mindmap] No mindmap found. LLM will read CLAUDE.md directly.'));
  } else {
    try {
      const mindmap = load_mindmap(mindmapPath);

      // Validate against CLAUDE.md
      const claudeMdPath = path.join(workDir, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath) && !validate_mindmap(mindmap, claudeMdPath)) {
        // Validation failed - show warning but continue loading
        console.log(chalk.yellow('[mindmap] Validation failed (outdated). Loading anyway.'));
      } else {
        // Success
        console.log(chalk.gray(`[mindmap] Loaded: ${countNodes(mindmap.root)} nodes`));
      }

      ctx.core.setMindmap(mindmap);
      mindmapLoaded = true;
    } catch (err) {
      console.log(chalk.red(`[mindmap] Failed to load: ${(err as Error).message}`));
    }
  }

  const triologue = new Triologue({
    tokenThreshold,
    wiki: ctx.wiki,
    onMessage: (messages) => {
      const lastMsg = messages[messages.length - 1];
      try {
        fs.appendFileSync(triologuePath, `${JSON.stringify(lastMsg)}\n`, 'utf-8');
      } catch {
        // Ignore write errors
      }
    },
  });

  // Restore session if available
  if (restoredPair !== null) {
    triologue.loadRestoration(restoredPair);
  }

  // Inject project context based on mindmap availability
  if (mindmapLoaded) {
    // Mindmap available - instruct LLM to use recall tool
    triologue.setMindmapInstruction();
  } else {
    // No mindmap - instruct LLM to read CLAUDE.md and NOT use recall
    triologue.setNoMindmapInstruction();
  }

  // Always load README.md if available (for general project context)
  const readmePath = path.join(process.cwd(), 'README.md');
  if (fs.existsSync(readmePath)) triologue.setReadmeMd(fs.readFileSync(readmePath, 'utf-8'));

  // Initialize hook system (machine lifetime)
  const conditions = new ConditionRegistry();
  await conditions.load();
  const core = ctx.core as Core;
  const sequence = new Sequence(triologue, () => core.getMode());
  const hookExecutor = new HookExecutor(conditions, sequence);

  // ── Build state handlers ──
  const handlers: Record<string, StateHandler> = {
    prompt: handlePrompt as StateHandler,
    slash: handleSlash as StateHandler,
    collect: handleCollect as StateHandler,
    llm: handleLlm as StateHandler,
    hook: handleHook as StateHandler,
    tool: handleTool as StateHandler,
    stop: handleStop as StateHandler,
  };

  // ── Create state machine ──
  const inputProvider = new UserInputProvider(() => (ctx.core as Core).getMode());
  const machine = new AgentStateMachine(
    triologue,
    ctx,
    'main',
    conditions,
    sequence,
    hookExecutor,
    inputProvider,
    sessionFilePath,
    handlers,
  );

  // ── SIGINT handler ──
  process.on('SIGINT', () => {
    const controller = agentIO.getLlmAbortController();
    if (controller) {
      controller.abort();
      console.log(chalk.yellow('\nInterrupting current operation...'));
      return;
    }
    console.log(chalk.yellow('\nShutting down...'));
    process.send!({ type: 'exit' });
  });

  // Ready
  process.send({ type: 'ready' });

  // ── Run state machine (REPL loop) ──
  try {
    await machine.run();
  } catch (err) {
    // Readline closed (race condition on SIGINT/SIGTERM) — clean exit
    if (err instanceof Error && err.message === 'readline was closed') {
      // clean exit
    } else {
      const errorType = classifyError(err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error();
      console.error(chalk.red(`Error: ${errorMessage}`));

      if (errorType === 'auth') {
        console.error(chalk.yellow('Check OLLAMA_API_KEY in ~/.mycc-store/.env file.'));
      } else if (errorType === 'model') {
        console.error(chalk.yellow(`Check OLLAMA_MODEL in ~/.mycc-store/.env file. Current: ${MODEL}`));
      } else if (errorType === 'config') {
        console.error(chalk.yellow('Check TOKEN_THRESHOLD in ~/.mycc-store/.env file.'));
      }
    }
  }

  // Signal Coordinator to exit
  process.send({ type: 'exit' });
}

/**
 * Count nodes in mindmap tree
 */
function countNodes(node: Node): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}
