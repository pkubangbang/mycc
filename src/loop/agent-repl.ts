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
import { getTokenThreshold, isDebuggingEval, shouldServe, getServePort, getServeHost, getEmbeddingModel, shouldAuto, getAutoflyThresholdArg } from '../config.js';
import { Triologue } from './triologue.js';
import { agentIO } from './agent-io.js';
import { autoState } from './auto-state.js';
import { shouldSkipHealthCheck } from '../config.js';
import { loader } from '../context/shared/loader.js';
import { getLayerBaseDir } from '../utils/skill-path-resolver.js';
import { initializeSession } from '../session/index.js';
import { ConditionRegistry } from '../hook/conditions.js';
import { Sequence } from '../hook/sequence.js';
import { HookExecutor } from '../hook/hook-executor.js';
import { Core } from '../context/parent/core.js';
import { AgentStateMachine } from './state-machine.js';
import { RequestEmbeddingTracker } from './request-embedding.js';
import type { StateHandler } from './state-machine.js';
import { UserInputProvider } from './input-provider.js';
import { WebInputProvider } from '../serve/web-input-provider.js';
import { getServeHub } from '../serve/serve-registry.js';
import { activateServe } from '../serve/activate.js';
import { handlePrompt, setInitialQuery } from './states/prompt.js';
import { handleSlash } from './states/slash.js';
import { handleCollect } from './states/collect.js';
import { handleLlm } from './states/llm.js';
import { handleHook } from './states/hook.js';
import { handleTool } from './states/tool.js';
import { handleStop } from './states/stop.js';
import { handleWait } from './states/wait.js';
import { clearWrapUp } from './esc-wrap-up.js';
import pkg from '../../package.json';
import { get_default_mindmap_path, load_mindmap, validate_mindmap, applyPatchAction, readAllPatches, getPatchPath } from '../mindmap/index.js';
import type { Node, Mindmap } from '../mindmap/types.js';
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

      const answer = agentIO.getAuto() ? 'y' : await agentIO.ask(chalk.cyan('Retry health check? [Y/n] > '), { useAsPrompt: true, onEsc: 'n', onEnter: 'y' });
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
  console.log(chalk.gray(`${alignLabel('Embedding:')}${getEmbeddingModel()}`));

  // Initialize session (restore or create new)
  const sessionInit = await initializeSession();
  const { sessionFilePath, triologuePath, restoredPair, initialQuery, sourceSessionId } = sessionInit;

  // Wire the durable transcript path into ServeHub so the /history endpoint
  // can read the on-disk triologue JSONL (survives serve stop/restart and
  // page closes) instead of the ephemeral in-memory messageLog.
  getServeHub().setTranscriptPath(triologuePath);
  // Wire the user-log path (same session directory) so real user submissions
  // (prompt queries + steering notes) are persisted and reconstructed as
  // right-side bubbles on refresh, instead of mapping every role:'user'
  // from the triologue (which includes injected system notes).
  getServeHub().setUserLogPath(path.join(path.dirname(triologuePath), 'user.jsonl'));

  // Pass initial query to prompt handler
  setInitialQuery(initialQuery);

  // Display session info
  const sessionId = getSessionId(sessionFilePath);
  // When this session was branched from a sealed source (--from / /fork), show
  // the lineage so the user understands "Session: <new> (forked from <old>)"
  // — the source's files are read-only; this instance writes only to its own
  // new files. For a genuinely fresh session, sourceSessionId is null and we
  // show just the id.
  const sessionLabel = sourceSessionId
    ? `${sessionId.slice(0, 7)} (forked from ${sourceSessionId.slice(0, 7)})`
    : sessionId.slice(0, 7);
  console.log(chalk.gray(`${alignLabel('Session:')}${sessionLabel}`));

  console.log(chalk.redBright(`${alignLabel('WorkDir:')}${process.cwd()}`));

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

  // Start peer discovery protocol: register identity + begin heartbeat + channel poll
  ctx.peer.start();

  await loader.indexAllSkillsToWiki(ctx.wiki);

  // Load mindmap (mindmap.json + replay patches from mindmap-patch.jsonl)
  const workDir = process.cwd();
  const mindmapPath = get_default_mindmap_path(workDir);
  let mindmapLoaded = false;

  if (!fs.existsSync(mindmapPath)) {
    // No mindmap.json - show warning
    console.log(chalk.yellow('[mindmap] No mindmap found. LLM will read MYCC.md directly.'));
  } else {
    try {
      const mindmap = loadMindmapWithPatches(mindmapPath, workDir);

      // Validate against MYCC.md (existing hash-check logic preserved)
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

  const requestEmbeddingTracker = new RequestEmbeddingTracker();

  const triologue = new Triologue({
    tokenThreshold,
    wiki: ctx.wiki,
    getDuplicationReport: () => requestEmbeddingTracker.getDuplicationReport(),
    onMessage: (messages) => {
      const lastMsg = messages[messages.length - 1];
      try {
        // Attach a timestamp so readHistory() can merge triologue entries
        // with user-log entries chronologically. The timestamp is a
        // display-only field; readTriologue() (restoration.ts) strips it
        // when loading messages back into Message objects so it never
        // leaks into LLM summarization (minifyMessages).
        const entry = { ...lastMsg, timestamp: Date.now() };
        fs.appendFileSync(triologuePath, `${JSON.stringify(entry)}\n`, 'utf-8');
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
    ctx.todo.clear();
    ctx.issue.clearAll();
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

  // Wire the runtime ConditionRegistry into the Loader so that
  // skill_compile (via ctx.skill.compileCondition) can update the in-memory
  // conditions directly — no throwaway registry, no broken IPC, no restart.
  // Lead process only; child processes leave the loader's registry null and
  // fall back to disk write + 'condition_replace' IPC.
  loader.setConditionRegistry(conditions);

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

  // ── --auto CLI flag: enter autonomous mode at startup ──
  // Auto mode is orthogonal to plan/normal. Setting the flag here means the
  // state machine's initial PROMPT hits the auto safety-net guard and jumps
  // straight to WAIT (block for mail/teammate/steering events, no user
  // prompt). The user can exit by pressing ESC, same as /auto mid-session.
  if (shouldAuto()) {
    autoState.resetStreak();
    autoState.setAuto(true);
    console.log(chalk.cyan('auto mode is on (--auto). Mails will be auto-replied. Press esc to exit.'));
  }

  // ── --autofly=N CLI arg: seed the autofly threshold into the singleton ──
  // When --autofly=N is provided (a positive integer), override the singleton's
  // default threshold so the PROMPT autofly trigger (gated by --debug-autofly)
  // compares streak > N. When the arg is absent, the singleton keeps its
  // built-in default (currently 3). Seeded once at startup; the threshold is
  // not meant to change mid-session.
  const autoflyThresholdArg = getAutoflyThresholdArg();
  if (autoflyThresholdArg !== null) {
    autoState.setAutoflyThreshold(autoflyThresholdArg);
  }

  // Wire the webui mirror into the autoState singleton's onAutoChange
  // callback. Previously agentIO.setAuto() called getServeHub().broadcastAuto
  // directly; now the singleton owns the flag and fires this callback on a
  // real flip, so the webui chat input box stays enabled for steering and the
  // 停止 button stays visible+spinning while the lead is in WAIT. Registered
  // here (where ServeHub is in scope) to keep AutoState free of any
  // serve-hub import and avoid the module-load cycle. Best-effort: broadcastAuto
  // is a no-op when serve isn't running.
  autoState.onAutoChange = (value: boolean) => {
    try {
      getServeHub().broadcastAuto(value);
    } catch {
      // serve-hub import cycle or serve not running — best-effort, no throw
    }
  };

  // Wire the channel-join event into the agent loop. When a peer channel
  // joins (the 5s poll sweep calls joinChannel, or /channel does directly),
  // ChannelManager fires the onChannelJoin callback registered here. This
  // covers the mid-PROMPT case: a channel joining AFTER the Layer A gate was
  // checked but WHILE ask()/waitForInput() is blocked. The callback:
  //   1. Engages auto mode (setAuto(true)) — the channel is a live automation
  //      feed; the loop should run autonomously now. Subsequent PROMPT entries
  //      take the Layer A hasActiveChannel() path.
  //   2. Aborts a blocked terminal PROMPT wait (agentIO.abortAsk) — rejects the
  //      blocked ask() Promise with a PromptAbortError, which propagates as a
  //      thrown exception through getInput() to the try/catch in prompt.ts
  //      (Layer B), returning AgentState.WAIT. No-op if no ask() is blocked.
  //   3. Aborts a blocked serve PROMPT wait (getServeHub().rejectInput) — same
  //      rejection path for the webui's waitForInput(). No-op if not blocked.
  // Both aborts are unconditional no-ops when nothing is blocked, so calling
  // both is safe regardless of which mode is active. Registered here (where
  // agentIO + ServeHub are in scope) to keep the peer module a pure file+mail
  // layer with no loop/autoState imports. Best-effort: each call swallows its
  // own errors so a failure in one path doesn't block the other.
  ctx.peer.setOnChannelJoin(() => {
    autoState.setAuto(true);
    try { agentIO.abortAsk(); } catch { /* best-effort */ }
    try { getServeHub().rejectInput(); } catch { /* best-effort */ }
  });

  // Register the combined auto-mode ENTRY callback for the webui. The
  // /serve "enter auto" lightning-bolt button sends an 'auto' WS message;
  // ServeHub calls this provider to flip autoState (which both Core and
  // AgentIO delegate to) — exactly the /auto slash path. Returns false when
  // already in auto mode so the hub can surface "已经是自动模式了".
  getServeHub().setEnterAutoProvider(() => {
    if (autoState.getAuto()) return false;
    autoState.resetStreak();
    autoState.setAuto(true);
    console.log(chalk.cyan('auto mode is on (webui). Mails will be auto-replied. Press esc to exit.'));
    return true;
  });

  // ── Build state handlers ──
  const handlers: Record<string, StateHandler> = {
    prompt: handlePrompt as StateHandler,
    slash: handleSlash as StateHandler,
    collect: handleCollect as StateHandler,
    llm: handleLlm as StateHandler,
    hook: handleHook as StateHandler,
    tool: handleTool as StateHandler,
    stop: handleStop as StateHandler,
    wait: handleWait as StateHandler,
  };

  // ── Create state machine ──
  // WebInputProvider is the sole InputProvider. It checks hub.isRunning()
  // internally to route between WebSocket (serve mode) and the terminal
  // (UserInputProvider). No runtime swap needed.
  const userInputProvider = new UserInputProvider(() => (ctx.core as Core).getMode());
  const inputProvider = new WebInputProvider(getServeHub(), userInputProvider);
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
    requestEmbeddingTracker,
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
    ctx.peer.stop(); // Stop heartbeat + channel poll + unregister identity
    process.send!({ type: 'exit' });
  });

  // ── SIGTERM handler ──
  // Coordinator sends SIGTERM to the process group on Ctrl+C, and to the
  // previous Lead on restart() (cwd change via /load). Gracefully dismiss
  // teammates and stop the ServeHub so the Vite dev-server child and bound
  // HTTP port are released before the process exits — otherwise restart()
  // orphans them and the next /serve hits EADDRINUSE.
  process.on('SIGTERM', async () => {
    ctx.team.dismissTeam(false);
    ctx.peer.stop(); // Stop heartbeat + channel poll + unregister identity
    try { await getServeHub().stop(); } catch { /* stop() already best-effort internally */ }
    process.exit(0);
  });

  // Ready
  process.send({ type: 'ready' });

  // ── Serve mode (--serve CLI flag): start web UI before the REPL loop ──
  // The /serve slash command path activates serve mid-session instead.
  if (shouldServe()) {
    try {
      await activateServe(getServePort(), getServeHost());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`Failed to start web UI: ${msg}`));
      console.log(chalk.gray('Continuing in terminal mode.'));
    }
  }

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

      // Always prompt for retry — only 'n'/'no' exits. In auto mode, skip
      // the prompt and always retry (autonomous operation never blocks).
      console.log(chalk.gray('─'.repeat(40)));
      const answer = agentIO.getAuto() ? 'y' : await agentIO.ask(chalk.cyan('Retry? [Y/n] > '), { useAsPrompt: true, onEsc: 'n', onEnter: 'y' });
      if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
        console.log(chalk.yellow('Exiting at user request.'));
        break;
      }

      console.log(chalk.cyan('Retrying...'));
      console.log();
      // Loop back — machine.run() will be called again
    }
  }

  // Normal exit: shut down the serve hub (Vite dev server + HTTP port)
  // so no child processes are orphaned when the Lead process exits.
  await getServeHub().stop();
  ctx.peer.stop(); // Stop heartbeat + channel poll + unregister identity

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

/**
 * Load mindmap.json then replay hash-matched patches from mindmap-patch.jsonl.
 *
 * Two independent on-disk lines merge only in memory at load time:
 * 1. mindmap.json — MYCC.md isomorph (load_mindmap sets is_mycc=true, is_patch=false)
 * 2. mindmap-patch.jsonl — append-only patch log from recap
 *
 * Patches are hash-gated: only those whose mindmap_hash matches the loaded
 * mindmap.json hash are applied (others are skipped — created against an older
 * version). See docs/mindmap-redesign.md Part 3.
 *
 * @param mindmapPath - Path to mindmap.json
 * @param workDir - Project working directory (for locating the patch jsonl)
 * @returns The merged in-memory mindmap (base + replayed patches)
 */
function loadMindmapWithPatches(mindmapPath: string, workDir: string): Mindmap {
  const mindmap = load_mindmap(mindmapPath);

  // Replay patches from jsonl (hash-gated)
  const patchPath = getPatchPath(workDir);
  if (fs.existsSync(patchPath)) {
    const patches = readAllPatches(patchPath);
    let applied = 0;
    let skipped = 0;
    for (const patch of patches) {
      // Skip patches created against a different mindmap.json version
      if (patch.mindmap_hash !== mindmap.hash) {
        skipped++;
        continue;
      }
      if (applyPatchAction(mindmap, patch)) {
        applied++;
      } else {
        skipped++;
      }
    }
    if (applied > 0 || skipped > 0) {
      console.log(chalk.gray(`[mindmap] Replayed ${applied} patches (${skipped} skipped)`));
    }
  }

  return mindmap;
}
