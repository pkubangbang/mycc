/**
 * agent-repl.ts - Main entry point for the coding agent
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { MODEL } from '../engine/chat-provider.js';
import { getOllamaHost, getApiProvider } from '../config.js';

const OLLAMA_HOST = getOllamaHost();
import { classifyError } from '../engine/chat-helpers.js';
import { healthCheck } from '../engine/chat-provider.js';
import { ParentContext } from '../context/parent-context.js';
import { getSessionId } from '../session/index.js';
import { slashRegistry } from '../slashes/index.js';
import { getTokenThreshold, isDebuggingEval } from '../config.js';
import { Triologue } from './triologue.js';
import { agentIO } from './agent-io.js';
import { shouldSkipHealthCheck } from '../config.js';
import { loader } from '../context/shared/loader.js';
import { getLayerBaseDir } from '../utils/skill-path-resolver.js';
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
import { clearWrapUp } from './esc-wrap-up.js';
import pkg from '../../package.json';
import { get_default_mindmap_path, load_mindmap, validate_mindmap } from '../mindmap/index.js';
import type { Node } from '../mindmap/types.js';
import type { Skill } from '../types.js';

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
  }

  if (isDebuggingEval()) {
    console.log(chalk.yellow('Debug-eval mode enabled: expression AST trees will be printed'));
  }

  if (!shouldSkipHealthCheck()) {
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
        break;
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

  const apiProvider = getApiProvider();
  const providerLabel = apiProvider === 'deepseek' ? 'DeepSeek' : 'Ollama';
  const hostUrl = apiProvider === 'deepseek'
    ? process.env.DEEPSEEK_HOST || 'https://api.deepseek.com'
    : OLLAMA_HOST;

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

  // Auto-grant read access to skill directories so the LLM can read
  // skill asset files (cheat sheets, scripts, etc.) without permission prompts.
  // Project skills (.mycc/skills/) are already inside the workspace — no grant needed.
  ctx.core.addExternalAutoGrant(getLayerBaseDir('built-in'));
  ctx.core.addExternalAutoGrant(getLayerBaseDir('user'));

  await loader.indexAllSkillsToWiki(ctx.wiki);
  await ctx.wt.syncWorkTrees();

  // Load mindmap
  const workDir = process.cwd();
  const mindmapPath = get_default_mindmap_path(workDir);
  let mindmapLoaded = false;

  if (!fs.existsSync(mindmapPath)) {
    // No mindmap.json - show warning
    console.log(chalk.yellow('[mindmap] No mindmap found. LLM will read MYCC.md directly.'));
  } else {
    try {
      const mindmap = load_mindmap(mindmapPath);

      // Validate against MYCC.md
      const claudeMdPath = path.join(workDir, 'MYCC.md');
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

  // Set up double Ctrl+L callback for clearing conversation history
  agentIO.setDoubleCtrlLCallback(() => {
    triologue.clear();
    sequence.clear();
    clearWrapUp();
    // Use setWhisper if we have access to activeLineEditor, but we don't here.
    // However, the logic in agent-io.ts is where the whisper line is managed.
    // The callback just performs the clear logic.
  });

  // Inject project context based on mindmap availability
  if (mindmapLoaded) {
    // Mindmap available - instruct LLM to use recall tool
    triologue.setMindmapInstruction();
  } else {
    // No mindmap - instruct LLM to read MYCC.md and NOT use recall
    triologue.setNoMindmapInstruction();
  }

  // Always load README.md if available (for general project context)
  const readmePath = path.join(process.cwd(), 'README.md');
  if (fs.existsSync(readmePath)) triologue.setReadmeMd(fs.readFileSync(readmePath, 'utf-8'));

  // Initialize hook system (machine lifetime)
  const conditions = new ConditionRegistry();
  const loadResult = await conditions.load();
  // Report load errors/warnings
  for (const error of loadResult.errors) {
    console.error(chalk.red(`[conditions] Error: ${error}`));
  }
  for (const warning of loadResult.warnings) {
    console.log(chalk.yellow(`[conditions] Warning: ${warning}`));
  }

  // Wire up IPC-based condition reload: skill_compile sends IPC message
  // to refresh runtime conditions without restarting the agent
  agentIO.setConditionReloadCallback(async () => {
    const reloadResult = await conditions.load();
    // Report reload errors/warnings
    for (const error of reloadResult.errors) {
      console.error(chalk.red(`[conditions] Error: ${error}`));
    }
    for (const warning of reloadResult.warnings) {
      console.log(chalk.yellow(`[conditions] Warning: ${warning}`));
    }
  });

  // Sync pending skills (skills with 'when' but no compiled condition)
  // Will be notified during hint round
  conditions.syncPending(loader);

  // Inject pending hook info into project context so the LLM knows
  // which hooks are available but not yet compiled (closes the gap
  // on fresh installations where hooks are loaded but inactive).
  const pendingSkillNames = conditions.getPending();
  if (pendingSkillNames.length > 0) {
    const pendingSkills = pendingSkillNames
      .map(name => loader.getSkill(name))
      .filter((s): s is Skill => !!s);
    triologue.setPendingHooksInfo(pendingSkills);
  }

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

  // ── Global error handlers — keep lead alive on unexpected errors ──
  // Only Ctrl+C (SIGINT), empty input, 'exit'/'q'/'quit', or 'n'/'no'
  // at the Retry prompt will shut down the agent.
  process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error();
    console.error(chalk.red(`Uncaught exception: ${msg}`));
    console.error(chalk.gray('The agent will continue. Press Ctrl+C or type exit to quit.'));
    // Do NOT exit — keep the agent alive
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error();
    console.error(chalk.red(`Unhandled rejection: ${msg}`));
    console.error(chalk.gray('The agent will continue. Press Ctrl+C or type exit to quit.'));
    // Do NOT exit — keep the agent alive
  });

  // ── SIGINT handler ──
  process.on('SIGINT', () => {
    const controller = agentIO.getLlmAbortController();
    if (controller) {
      controller.abort();
      console.log(chalk.yellow('\nInterrupting current operation...'));
      return;
    }
    console.log(chalk.yellow('\nShutting down...'));
    ctx.team.dismissTeam(false); // Graceful shutdown of all teammates
    process.send!({ type: 'exit' });
  });

  // ── SIGTERM handler ──
  // Coordinator sends SIGTERM to process group on Ctrl+C.
  // Gracefully dismiss all teammates so they don't become orphans.
  process.on('SIGTERM', () => {
    ctx.team.dismissTeam(false);
    process.exit(0);
  });

  // Ready
  process.send({ type: 'ready' });

  // ── Run state machine (REPL loop) with resilient retry ──
  // Only Ctrl+C (handled by Coordinator), empty input, 'exit'/'q'/'quit',
  // or 'n'/'no' at the Retry prompt will shut down the agent.
  // All other errors (e.g., Internal Server Error, tool failures) trigger
  // a Retry [Y/n] prompt and the agent continues.
  while (true) {
    try {
      await machine.run();
      // machine.run() returned normally — user typed exit/empty/q/quit
      break;
    } catch (err) {
      // Readline closed (race condition on SIGINT/SIGTERM) — clean exit
      if (err instanceof Error && err.message === 'readline was closed') {
        break;
      }

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

      // Always prompt for retry — only 'n'/'no' exits
      console.log(chalk.gray('─'.repeat(40)));
      const answer = await agentIO.ask(chalk.cyan('Retry? [Y/n] > '), true);
      if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
        console.log(chalk.yellow('Exiting at user request.'));
        break;
      }

      console.log(chalk.cyan('Retrying...'));
      console.log();
      // Loop back — machine.run() will be called again
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
