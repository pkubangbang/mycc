/**
 * agent-repl.ts - Main entry point and REPL for the coding agent
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { MODEL, OLLAMA_HOST, checkHealth, classifyError } from '../ollama.js';
import type { SlashCommandContext } from '../types.js';
import { ParentContext } from '../context/parent-context.js';
import { readSession, writeSession, getSessionId } from '../session/index.js';
import { slashRegistry } from '../slashes/index.js';
import { getTokenThreshold } from '../config.js';
import { Triologue } from './triologue.js';
import { agentIO } from './agent-io.js';
import { shouldSkipHealthCheck } from '../config.js';
import { openMultilineEditor } from '../utils/multiline-input.js';
import { displayLetterBox } from '../utils/letter-box.js';
import { loader } from '../context/shared/loader.js';
import { buildSkillHint, initializeSession } from './agent-loop-helper.js';
import { agentLoop, ShutdownError } from './agent-loop.js';
import pkg from '../../package.json';

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
  // Skip if --skip-healthcheck flag is set (useful for testing)
  let modelInfo: { family?: string; parameterSize?: string; contextLength: number } | null = null;
  if (shouldSkipHealthCheck()) {
    console.log(chalk.gray('Skipping health check (test mode)'));
  } else {
    // Retry loop for health check - only exit on user request or Ctrl+C
    while (true) {
      const health = await checkHealth(tokenThreshold);
      if (health.ok) {
        if (health.modelInfo) {
          modelInfo = health.modelInfo;
        }
        break; // Success - continue with startup
      }

      // Health check failed - show error and prompt for retry
      console.error(chalk.red(`Health check failed: ${health.error}`));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(chalk.yellow('Common fixes:'));
      console.log(chalk.gray('  1. Ensure Ollama is running: ollama serve'));
      console.log(chalk.gray('  2. Check OLLAMA_HOST in ~/.mycc-store/.env'));
      console.log(chalk.gray('  3. Verify model exists: ollama list'));
      console.log();

      const answer = await agentIO.ask(chalk.cyan('Retry health check? [Y/n] > '));

      if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
        console.log(chalk.yellow('Exiting at user request.'));
        process.exit(1);
      }

      console.log(chalk.cyan('Retrying health check...'));
      console.log();
    }
  }

  // Display startup info with aligned labels
  const labelWidth = 12; // Width for label alignment
  const alignLabel = (label: string) => label.padEnd(labelWidth);

  console.log();
  console.log(chalk.cyan.bold(`Coding Agent v${version}`));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.cyan(`${alignLabel('Model:')}${MODEL}`));
  console.log(chalk.gray(`${alignLabel('Host:')}${OLLAMA_HOST}`));

  if (modelInfo) {
    if (modelInfo.family) {
      console.log(chalk.gray(`${alignLabel('Family:')}${modelInfo.family}`));
    }
    if (modelInfo.parameterSize) {
      console.log(chalk.gray(`${alignLabel('Params:')}${modelInfo.parameterSize}`));
    }
    console.log(chalk.gray(`${alignLabel('Context:')}${modelInfo.contextLength}`));
  }

  console.log(chalk.gray(`${alignLabel('Threshold:')}${tokenThreshold} tokens`));

  // Initialize session (restore or create new)
  const sessionInit = await initializeSession();
  const { sessionFilePath, triologuePath, restoredPair } = sessionInit;
  let initialQuery = sessionInit.initialQuery; // Mutable for clearing after first use

  // Display session info (after initialization so we have the session ID)
  const sessionId = getSessionId(sessionFilePath);
  console.log(chalk.gray(`${alignLabel('Session:')}${sessionId.slice(0, 7)}`));

  const commands = slashRegistry.list().map(c => `/${c}`).join(', ');
  console.log(chalk.gray(`${alignLabel('Commands:')}${commands}, /exit`));
  console.log();

  // Track first query for bookmark title
  let firstQueryCaptured = false;

  // Load tools/skills using singleton loader
  await loader.loadAll();
  loader.watchDirectories();

  // Create context
  const ctx = new ParentContext(sessionFilePath);
  ctx.initializeIpcHandlers();

  // Check if skills domain exists (warn if not)
  await ctx.wiki.checkSkillsDomain();

  // Sync worktrees with git (reconcile any orphaned worktrees from previous sessions)
  await ctx.wt.syncWorkTrees();

  const triologue = new Triologue({
    tokenThreshold,
    wiki: ctx.wiki,
    onMessage: (messages) => {
      const lastMsg = messages[messages.length - 1];
      try {
        fs.appendFileSync(triologuePath, `${JSON.stringify(lastMsg)  }\n`, 'utf-8');
      } catch {
        // Ignore write errors
      }
    },
  });

  // If restored session, load the summary pair
  if (restoredPair !== null) {
    triologue.loadRestoration(restoredPair);
  }

  // Inject project context files (best-effort: skip if not found)
  const claudePath = path.join(process.cwd(), 'CLAUDE.md');
  const readmePath = path.join(process.cwd(), 'README.md');

  if (fs.existsSync(claudePath)) {
    triologue.setClaudeMd(fs.readFileSync(claudePath, 'utf-8'));
  }
  if (fs.existsSync(readmePath)) {
    triologue.setReadmeMd(fs.readFileSync(readmePath, 'utf-8'));
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    const controller = agentIO.getLlmAbortController();
    if (controller) {
      controller.abort();
      console.log(chalk.yellow('\nInterrupting current operation...'));
      return;
    }
    // No active LLM call - safe to exit
    console.log(chalk.yellow('\nShutting down...'));
    process.send!({ type: 'exit' });
  });

  // Emit ready signal for Coordinator
  process.send({ type: 'ready' });

  // Main REPL loop
  while (true) {
    try {
      // Use initial query from restored session, or prompt for input
      let query: string;
      if (initialQuery !== null) {
        query = initialQuery;
        initialQuery = null; // Clear after first use
        console.log(chalk.gray(`Restored query: ${query.slice(0, 50)}${query.length > 50 ? '...' : ''}`));
      } else {
        query = await agentIO.ask(chalk.bgYellow.black('agent >> '), true);
      }

      // Handle multi-line input (trailing backslash)
      if (query.endsWith('\\') && query.trim() !== '\\') {
        const initialContent = query.slice(0, -1);
        const content = await openMultilineEditor(initialContent);
        if (content === null) {
          console.log(chalk.gray('Multi-line input cancelled.'));
          continue;
        }
        query = content;
      }

      // handle exit
      if (['q', 'exit', 'quit', ''].includes(query.trim().toLowerCase())) {
        break;
      }

      // Handle bang commands
      if (query.trim().startsWith('!')) {
        const command = query.trim().slice(1).trim();
        const result = await loader.execute('tmux', ctx, {
          command: command || undefined,
          reason: command ? `User runs: ${command}` : 'Open terminal',
        });
        triologue.user(`[FYI] ${result}`);
        triologue.resetHint();
        continue;
      }

      // Handle slash commands
      const trimmedQuery = query.trim();
      if (trimmedQuery.startsWith('/')) {
        const parts = trimmedQuery.split(/\s+/);
        const cmdName = parts[0].slice(1); // Remove '/'

        const slashCtx: SlashCommandContext = {
          query: trimmedQuery,
          args: parts,
          ctx,
          triologue,
          sessionFilePath,
        };

        const handled = await slashRegistry.execute(cmdName, slashCtx);
        if (handled && slashCtx.nextQuery) {
          // /load returned a first query to process
          query = slashCtx.nextQuery;
        } else {
          continue;
        }
      }

      // Add user message (reset hint flag for new query)
      triologue.user(query);
      triologue.resetHint();

      // Build and set skill hint (temporary, not in transcript)
      const skillHint = await buildSkillHint(query, ctx);
      if (skillHint) {
        triologue.setTemporaryHint(skillHint);
      }

      // Capture first query as bookmark title
      if (!firstQueryCaptured) {
        const session = readSession(sessionFilePath);
        if (session && !session.first_query) {
          session.first_query = query.slice(0, 100);
          writeSession(sessionFilePath, session);
          firstQueryCaptured = true;
        }
      }

      // Run agent loop
      await agentLoop(triologue, ctx);

      // Print final response in letter-style box
      const lastMsg = triologue.getMessagesRaw().at(-1);
      if (lastMsg?.content) {
        displayLetterBox(lastMsg.content);
      }
    } catch (err) {
      // Shutdown - exit cleanly (only Ctrl+C triggers this)
      if (err instanceof ShutdownError) {
        break;
      }

      // Readline closed (race condition on SIGINT/SIGTERM) - exit cleanly
      if (err instanceof Error && err.message === 'readline was closed') {
        break;
      }

      // All other errors - prompt user for retry instead of exiting
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorType = classifyError(err);

      console.error();
      console.error(chalk.red(`Error: ${errorMessage}`));

      // Show helpful instructions based on error type
      if (errorType === 'auth') {
        console.error(chalk.yellow('Check OLLAMA_API_KEY in ~/.mycc-store/.env file.'));
      } else if (errorType === 'model') {
        console.error(chalk.yellow(`Check OLLAMA_MODEL in ~/.mycc-store/.env file. Current: ${MODEL}`));
      } else if (errorType === 'config') {
        console.error(chalk.yellow('Check TOKEN_THRESHOLD in ~/.mycc-store/.env file.'));
      } else if (errorType === 'transient') {
        console.error(chalk.yellow('This appears to be a network/transient error.'));
      }

      // Prompt user for action
      console.log(chalk.gray('─'.repeat(40)));
      const answer = await agentIO.ask(chalk.cyan('Retry? [Y/n] > '));

      if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
        console.log(chalk.yellow('Exiting at user request.'));
        break;
      }

      // User wants to retry - continue the loop
      console.log(chalk.cyan('Retrying...'));
      continue;
    }
  }

  // Signal Coordinator to exit (which will kill this process)
  process.send({ type: 'exit' });
}