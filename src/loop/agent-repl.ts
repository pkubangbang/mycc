/**
 * agent-repl.ts - Main entry point for the coding agent
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { MODEL } from '../engine/chat-provider.js';
import { classifyError } from '../engine/chat-helpers.js';
import { ParentContext } from '../context/parent-context.js';
import { getSessionId } from '../session/index.js';
import { slashRegistry } from '../slashes/index.js';
import { getTokenThreshold, shouldServe, getServePort, getServeHost, shouldAuto, getAutoflyThresholdArg, getDiscoveryDir } from '../config.js';
import { Triologue } from './triologue.js';
import { agentIO } from './agent-io.js';
import { autoState } from './auto-state.js';
import { runHealthCheck, displayStartupBanner } from './startup.js';
import { loader } from '../context/shared/loader.js';
import { getLayerBaseDir } from '../utils/skill-path-resolver.js';
import { initializeSession } from '../session/index.js';
import { Sequence } from '../hook/sequence.js';
import { HookExecutor } from '../hook/hook-executor.js';
import { Core } from '../context/parent/core.js';
import { AgentStateMachine } from './state-machine.js';
import { RequestEmbeddingTracker } from './request-embedding.js';
import type { StateHandler } from './state-machine.js';
import { UserInputProvider } from './input-provider.js';
import { WebInputProvider } from '../serve/web-input-provider.js';
import { getServeHub } from '../serve/serve-registry.js';
import { loopEvents } from './loop-events.js';
import type { StateTransitionPayload } from './loop-events.js';
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
import { loadProjectMindmap } from './mindmap-loader.js';
import { registerSignalHandlers } from './signal-handlers.js';
import { initDaemonMode } from './daemon-init.js';
import { initHookSystem, buildHookInfoMessages } from './hook-bootstrap.js';
import { buildPlatformCalendarMessages } from './prompt-populators.js';
import { wireServeCallbacks } from './serve-wiring.js';

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

  // Health check: validate provider connectivity and model availability.
  // Returns model info for the banner (null when skipped). Exits the process
  // if the user declines to retry a failed check.
  const modelInfo = await runHealthCheck();

  // Display startup info banner (version, model, host, provider, threshold).
  displayStartupBanner(version, modelInfo);

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

  // Display session info (Session/WorkDir/Commands lines, aligned with the
  // startup banner's label width — see startup.displayStartupBanner).
  const labelWidth = 12;
  const alignLabel = (label: string) => label.padEnd(labelWidth);

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

  // Auto-grant read+write access to the peer-discovery directory
  // (~/.mycc-store/discovery) so every mycc instance can freely read and
  // write identity.json, heartbeats, and channel files to coordinate
  // cross-instance discovery and messaging — no per-access user prompts.
  // Teammates (child processes) inherit this via the IPC external_path_access
  // handler, which checks the parent's session-scoped grants.
  ctx.core.addExternalAutoGrant(getDiscoveryDir(), true);

  // Start peer discovery protocol: register identity + begin heartbeat + channel poll
  ctx.peer.start();

  // Index all skills into wiki at startup. The loader builds PURE-DATA
  // SkillIndexEntry[] (no wiki reference); we hand it to ctx.wiki.indexSkills,
  // which owns the wiki-DB re-index + reindex lock. This keeps the loader
  // (skill-loading layer) decoupled from the wiki module (RAG layer).
  await ctx.wiki.indexSkills(loader.buildAllSkillEntries());

  // Load mindmap (mindmap.json + replay patches from mindmap-patch.jsonl).
  // loadProjectMindmap installs the mindmap on ctx.core and returns whether
  // a mindmap is available (drives the project-context injection path below).
  const workDir = process.cwd();
  const mindmapLoaded = loadProjectMindmap(workDir, ctx.core);

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

  // ── Register project-context populators ──
  // Each populator is a () => Message[] closure registered ONCE here. The
  // triologue calls rebuildProjectContext() (clear + re-invoke all populators)
  // at compact()/clear() boundaries, so dynamic context (README, mindmap
  // instruction, hook info) stays fresh without external rebuild calls and
  // without extra cache penalty (the conversation prefix already changes at
  // those boundaries). Registration order = projectContext order.

  // (1) Mindmap instruction — depends on mindmapLoaded (captured now; the
  //     mindmap is not reloaded mid-session, so this is stable).
  if (mindmapLoaded) {
    triologue.registerProjectContextPopulator(() => [
      { role: 'user', content: '[System] A mindmap (knowledge tree) is available. Use the `recall` tool to explore it. Start with `recall("/")` to see top-level nodes, then drill down into children. The mindmap contains compiled project knowledge and guidance.' },
      { role: 'assistant', content: 'Understood. I will use the recall tool to explore the mindmap. Starting with recall("/") to see the top-level structure.' },
    ]);
  } else {
    triologue.registerProjectContextPopulator(() => [
      { role: 'user', content: '[System] No mindmap found. Please read MYCC.md to understand the project context and structure. IMPORTANT: The recall tool will not work without a mindmap, so do NOT use it. Use read_file tool to explore MYCC.md instead.' },
      { role: 'assistant', content: 'Understood. I will read MYCC.md using read_file to understand the project. I will NOT use the recall tool since no mindmap is available.' },
    ]);
  }

  // (2) README.md — re-reads from disk on every rebuild so edits to README
  //     surface after the next compact/clear. Skips when too large or absent.
  triologue.registerProjectContextPopulator(() => {
    const readmePathPop = path.join(process.cwd(), 'README.md');
    if (!fs.existsSync(readmePathPop)) return [];
    const content = fs.readFileSync(readmePathPop, 'utf-8');
    const maxChars = Math.floor(getTokenThreshold() * 4 * 0.1);
    if (content.length > maxChars) {
      agentIO.brief('info', 'triologue', 'README.md is too large to load, skipping');
      return [];
    }
    return [
      { role: 'user', content: `[Project Context - README.md from project root, FYI]\n\n${content}` },
      { role: 'assistant', content: 'Understood. I have read the project context from README.md.' },
    ];
  });

  // Initialize hook system (machine lifetime): load the ConditionRegistry,
  // report errors/warnings, wire IPC reload, sync pending skills, wire the
  // registry into the loader. Returns the registry for Sequence/HookExecutor.
  // (Legacy/pending hook info is no longer injected here — it is produced by
  // the buildHookInfoMessages populator registered below.)
  const conditions = await initHookSystem(ctx, loader, triologue);

  // (3) Platform + Calendar (live environment) — delivered as project-context
  //     messages so the system prompt stays byte-stable between compact/clear
  //     boundary (keeping the prompt-cache prefix hot) while still refreshing
  //     when the prefix changes anyway. Registered after README, before hooks.
  triologue.registerProjectContextPopulator(() => buildPlatformCalendarMessages());

  // (4) Hook info (pending + legacy) — registered AFTER initHookSystem so the
  //     closure can capture `conditions` and `loader`. Each rebuild re-queries
  //     the registry, so newly-compiled hooks drop out and newly-loaded legacy
  //     ones appear without a restart.
  triologue.registerProjectContextPopulator(() => buildHookInfoMessages(conditions, loader));

  // Initial build: populate projectContext from all registered populators.
  // (compact()/clear() will call rebuildProjectContext() internally thereafter.)
  triologue.rebuildProjectContext();

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

  // ── --daemon CLI arg: headless daemon mode ──
  // Daemon mode = auto mode + no terminal. initDaemonMode forces auto on,
  // dedups against an existing daemon with the same role+workDir, auto-loads
  // the named skill, and starts the croner timer from the skill's
  // service_cron. Returns the cron job (null when not in daemon mode or the
  // skill has no service_cron) so the signal handlers + final cleanup can
  // stop it. Only daemon mode activates the cron timer — a non-daemon lead
  // loading a skill with service_cron does NOT start cron.
  const daemonCronJob = initDaemonMode(ctx, loader, triologue);

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

  // ── Wire the serve/webui integration ──
  // Groups the three serve callbacks: autoState.onAutoChange (mirror to
  // webui), the channel-join callback (engage auto + abort a blocked PROMPT
  // when a peer channel joins mid-flight), and the webui "enter auto"
  // provider. Registered here to keep AutoState/ChannelManager free of any
  // serve-hub import (avoids the module-load cycle).
  wireServeCallbacks(ctx);

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

  // ── Register global signal/error handlers ──
  // Registered AFTER daemon mode has started its cron timer so the handlers
  // can stop it on shutdown. uncaughtException/unhandledRejection keep the
  // lead alive; SIGINT/SIGTERM tear down (cron, teammates, peer, serve hub).
  registerSignalHandlers(ctx, daemonCronJob);

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

  // ── Wire running state to web UI ──
  // The state machine emits state_transition on every state change. Idle
  // states (PROMPT/WAIT) mean the agent is waiting for input/events;
  // everything else means the agent is actively processing. The web UI
  // mirrors this as `isRunning` so the rocket button's warp background
  // appears only during actual work, not during auto-mode WAIT idle.
  loopEvents.on('state_transition', (payload) => {
    const { to } = payload as StateTransitionPayload;
    const running = to !== 'prompt' && to !== 'wait';
    try {
      getServeHub().setAgentRunning(running);
    } catch {
      // serve not running — best-effort
    }
  });

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

      // ── Enhanced diagnostics for the recurring "reading 'role'" crash ──
      // The error "Cannot read properties of undefined (reading 'role')"
      // surfaces intermittently after /compact under both Ollama and DeepSeek,
      // but its call site was never identified (the retry loop swallows the
      // stack trace). When the message matches, dump the full stack trace
      // (pinpoints the exact file:line) plus a structural scan of the current
      // triologue messages array — flagging any entry that is undefined,
      // null, non-object, or missing a `role` field — so the real crash site
      // can be identified from one reproduction instead of code-guessing.
      const isRoleReadCrash = /reading ['"]role['"]/.test(errorMessage);
      if (isRoleReadCrash) {
        if (err instanceof Error && err.stack) {
          console.error(chalk.gray('── stack trace ──'));
          console.error(chalk.gray(err.stack));
          console.error(chalk.gray('────────────────'));
        }
        try {
          const raw = (triologue as unknown as {
            messages?: unknown[];
            getMessagesRaw?: () => unknown[];
          });
          const arr = raw.messages ?? [];
          const issues: string[] = [];
          for (let i = 0; i < arr.length; i++) {
            const m = (arr as unknown[])[i];
            if (m === undefined) issues.push(`[${i}] undefined`);
            else if (m === null) issues.push(`[${i}] null`);
            else if (typeof m !== 'object') issues.push(`[${i}] non-object: ${typeof m}`);
            else if (!(m as { role?: unknown }).role) issues.push(`[${i}] object missing .role: ${JSON.stringify(Object.keys(m as object))}`);
          }
          console.error(chalk.gray(`messages array: length=${arr.length}`));
          if (issues.length > 0) {
            console.error(chalk.yellow(`malformed entries (${issues.length}):`));
            for (const it of issues) console.error(chalk.yellow(`  ${it}`));
          } else {
            console.error(chalk.gray('no malformed entries found in this.messages (crash may be in a derived/copied array)'));
          }
        } catch (diagErr) {
          console.error(chalk.gray(`(diagnostic scan failed: ${diagErr instanceof Error ? diagErr.message : String(diagErr)})`));
        }
      }

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
  if (daemonCronJob) daemonCronJob.stop();
  ctx.peer.stop(); // Stop heartbeat + channel poll + unregister identity

  // Signal Coordinator to exit
  process.send({ type: 'exit' });
}
