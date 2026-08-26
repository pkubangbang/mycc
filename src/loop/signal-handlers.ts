/**
 * signal-handlers.ts - Global process signal/error handlers for the Lead
 *
 * Extracted from agent-repl.ts to isolate shutdown/error wiring from the
 * REPL entry-point orchestration. Registered AFTER daemon mode has started
 * its cron timer so the handlers can stop it on shutdown.
 */

import chalk from 'chalk';
import { agentIO } from './agent-io.js';
import { getServeHub } from '../serve/serve-registry.js';
import type { AgentContext } from '../types.js';
import type { Cron } from 'croner';

/**
 * Register uncaughtException / unhandledRejection / SIGINT / SIGTERM handlers.
 *
 * - uncaughtException & unhandledRejection: log and KEEP THE LEAD ALIVE (only
 *   Ctrl+C, empty input, or explicit exit shuts it down).
 * - SIGINT: if an LLM stream is in flight, abort it (first Ctrl+C interrupts);
 *   otherwise tear down (stop cron, dismiss teammates, stop peer) and signal
 *   the Coordinator to exit.
 * - SIGTERM: the Coordinator sends this on Ctrl+C (process group) and on
 *   restart() (cwd change via /load). Gracefully stop the cron, teammates,
 *   peer, and the ServeHub (Vite dev server + HTTP port) so a restart does
 *   not orphan them / hit EADDRINUSE.
 *
 * @param ctx - Agent context (team + peer modules for graceful teardown)
 * @param daemonCronJob - The daemon cron timer to stop on shutdown (null when
 *   not in daemon mode or no service_cron was declared).
 */
export function registerSignalHandlers(ctx: AgentContext, daemonCronJob: Cron | null): void {
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
    if (daemonCronJob) daemonCronJob.stop();
    ctx.team.dismissTeam(false); // Graceful shutdown of all teammates
    ctx.peer.stop(); // Stop heartbeat + channel poll + unregister identity
    process.send?.({ type: 'exit' });
  });

  // ── SIGTERM handler ──
  // Coordinator sends SIGTERM to the process group on Ctrl+C, and to the
  // previous Lead on restart() (cwd change via /load). Gracefully dismiss
  // teammates and stop the ServeHub so the Vite dev-server child and bound
  // HTTP port are released before the process exits — otherwise restart()
  // orphans them and the next /serve hits EADDRINUSE.
  process.on('SIGTERM', async () => {
    if (daemonCronJob) daemonCronJob.stop();
    ctx.team.dismissTeam(false);
    ctx.peer.stop(); // Stop heartbeat + channel poll + unregister identity
    try { await getServeHub().stop(); } catch { /* stop() already best-effort internally */ }
    process.exit(0);
  });
}