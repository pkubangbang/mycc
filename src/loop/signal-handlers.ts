/**
 * signal-handlers.ts - Global process signal/error handlers for the Lead
 *
 * Extracted from agent-repl.ts to isolate shutdown/error wiring from the
 * REPL entry-point orchestration. Registered AFTER daemon mode has started
 * its cron timer so the handlers can stop it on shutdown.
 */

import chalk from 'chalk';
import { agentIO } from './agent-io.js';
import { tryGetServeHub } from '../serve/serve-registry.js';
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
 * @returns The shared {@link gracefulTeardown} function, so the caller can also
 *   wire it as the tombstone reaction (§6.7) — the peer's own heartbeat carries
 *   a `tombstone` written by a stopper, and the reaction must run the SAME
 *   ordered teardown as SIGTERM.
 */
export function registerSignalHandlers(ctx: AgentContext, daemonCronJob: Cron | null): (trigger: string) => Promise<void> {
  /**
   * Graceful teardown shared by SIGTERM and the tombstone reaction (§6.7).
   * Ordered, each step best-effort, verbose-logged so "which step is stuck" is
   * diagnosable under -v. Runs the SAME path whether the stop arrived as an OS
   * signal or as a tombstone the peer noticed on its own beat.
   */
  async function gracefulTeardown(trigger: string): Promise<void> {
    if (daemonCronJob) {
      agentIO.verbose('signal', `${trigger}: stopping daemon cron job`);
      daemonCronJob.stop();
    }
    agentIO.verbose('signal', `${trigger}: dismissing team`);
    ctx.team.dismissTeam(false);
    // Kill any still-running bg tasks before exit — they are spawned with
    // unref() and otherwise orphan, holding their PIDs after the Lead exits.
    agentIO.verbose('signal', `${trigger}: killing background tasks`);
    await ctx.bg.killAllRunning(); // best-effort tree-kill of running tasks
    agentIO.verbose('signal', `${trigger}: stopping peer (heartbeat + channel poll)`);
    ctx.peer.stop(); // Stop heartbeat + channel poll + unregister identity
    agentIO.verbose('signal', `${trigger}: stopping ServeHub (Vite + HTTP port)`);
    try { await tryGetServeHub()?.stop(); } catch { /* stop() already best-effort internally */ }
    agentIO.verbose('signal', `${trigger}: teardown complete, exiting`);
    process.exit(0);
  }

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
  process.on('SIGINT', async () => {
    const controller = agentIO.getLlmAbortController();
    if (controller) {
      controller.abort();
      console.log(chalk.yellow('\nInterrupting current operation...'));
      return;
    }
    console.log(chalk.yellow('\nShutting down...'));
    if (daemonCronJob) daemonCronJob.stop();
    ctx.team.dismissTeam(false); // Graceful shutdown of all teammates
    // Kill any still-running bg tasks before exit — they are spawned with
    // unref() and otherwise orphan, holding their PIDs after the Lead exits.
    // Awaited (not void) so all kills complete before the exit IPC message;
    // a fire-and-forget would race the Coordinator termination and could
    // leave 2+ bg tasks un-killed — the exact leak this fix targets.
    agentIO.verbose('signal', 'SIGINT: killing background tasks');
    await ctx.bg.killAllRunning(); // best-effort tree-kill of running tasks
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
    // Coordinator sends SIGTERM to the process group on Ctrl+C, and to the
    // previous Lead on restart() (cwd change via /load). Run the same ordered
    // graceful teardown the tombstone reaction uses (§6.7), so the Vite
    // dev-server child and bound HTTP port are released before exit.
    await gracefulTeardown('SIGTERM');
  });

  return gracefulTeardown;
}