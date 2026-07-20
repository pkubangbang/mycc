/**
 * activate.ts - Shared serve activation logic
 *
 * Used by both `/serve` slash command and `--serve` CLI flag to eliminate
 * duplication. Starts the server, sets up output mirroring, and notifies the
 * Coordinator that serve mode is active.
 */

import { getServeHub } from './serve-registry.js';
import { agentIO } from '../loop/agent-io.js';
import { setResultCallback } from '../utils/letter-box.js';
import chalk from 'chalk';

export async function activateServe(port: number): Promise<void> {
  const hub = getServeHub();

  if (hub.isRunning()) {
    console.log(chalk.yellow(`Web UI already running at ${hub.getUrl()}`));
    return;
  }

  // Start Express + Vite + WS. A failure here (port in use, missing Vite
  // deps, web dir missing) must NOT crash the process — the terminal REPL
  // should continue so the user can fix the issue and retry /serve.
  try {
    await hub.start(port);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`\nFailed to start Web UI: ${msg}`));
    console.log(chalk.gray('Terminal mode continues. Fix the error and try /serve again.'));
    return;
  }

  // Set up output mirroring to WebSocket (log/warn/error)
  // brief() passes its tool tag as the label so the Web UI shows the same
  // [HH:MM:SS] [tool] header as the terminal; plain verbose logs have no
  // label.
  agentIO.setOutputCallback((method, args, label) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    hub.broadcast(method, text, label);
  });
  // Set up result mirroring (final assistant response via letter-box).
  // Labeled 'assistant' so the Web UI renders the [assistant] tag, matching
  // the terminal-style header the user requested.
  setResultCallback((content) => hub.broadcast('result', content, 'assistant'));

  // Notify Coordinator that serve mode is active (filter stdin)
  if (process.send) {
    process.send({ type: 'serve_mode', active: true });
  }

  console.log(chalk.cyan(`\n🌐 Web UI started at ${hub.getUrl()}`));
  console.log(chalk.gray('Terminal input disabled. Press ESC to return to CLI, or use the exit button in the web UI.'));
}