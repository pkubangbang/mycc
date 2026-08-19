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

export async function activateServe(port: number, host?: string | null): Promise<void> {
  const hub = getServeHub();

  if (hub.isRunning()) {
    console.log(chalk.yellow(`Web UI already running at ${hub.getUrl()}`));
    return;
  }

  // Start Express + Vite + WS. A failure here (port in use, missing Vite
  // deps, web dir missing) must NOT crash the process — the terminal REPL
  // should continue so the user can fix the issue and retry /serve.
  try {
    await hub.start(port, host);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`\nFailed to start Web UI: ${msg}`));
    console.log(chalk.gray('Terminal mode continues. Fix the error and try /serve again.'));
    // Reset serve mode on the Coordinator so the terminal accepts input
    // again. Critical for the --serve CLI flag path: the Coordinator set
    // serveMode=true at startup (index.ts), and without this IPC it stays
    // true — the stdin filter (index.ts) drops all keys except ESC/Ctrl+C,
    // locking the terminal even though the REPL is alive.
    if (process.send) process.send({ type: 'serve_mode', active: false });
    return;
  }

  // Set up output mirroring to WebSocket (log/warn/error)
  // brief() passes its tool tag as the label so the Web UI shows the same
  // [HH:MM:SS] [tool] header as the terminal; plain verbose logs have no
  // label. The detail parameter carries the tool's intent (e.g. bash command
  // description) for display in an outlined box inside the bubble.
  agentIO.setOutputCallback((method, args, label, detail) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    hub.broadcast(method, text, label, detail);
  });
  // Set up result mirroring (final assistant response via letter-box).
  // Labeled 'assistant' so the Web UI renders the [assistant] tag, matching
  // the terminal-style header the user requested.
  setResultCallback((content) => hub.broadcast('result', content, 'assistant'));

  // Notify Coordinator that serve mode is active (filter stdin)
  if (process.send) {
    process.send({ type: 'serve_mode', active: true });
  }

  console.log(chalk.cyan(`\n🌐 Web UI started`));
  const urls = hub.getUrls();
  if (urls) {
    console.log(chalk.gray(`  ➜  Local:   ${urls.local}`));
    if (urls.network.length > 0) {
      for (const u of urls.network) {
        console.log(chalk.gray(`  ➜  Network: ${u}`));
      }
    }
  }

  // Windows firewall warning — only when bound to a non-localhost interface
  // (--host passed → 0.0.0.0 or a specific LAN IP). Inbound connections from
  // other devices may be blocked by Windows Defender Firewall; surface the
  // one-line fix at the exact moment the user starts a LAN-visible server.
  // host === null means localhost-only bind (no --host) → no firewall concern.
  if (process.platform === 'win32' && host) {
    console.log(chalk.yellow(`  ⚠  Windows Firewall may block access from other devices.`));
    console.log(chalk.yellow(`     If the Web UI is unreachable from another machine, run this once`));
    console.log(chalk.yellow(`     in an elevated PowerShell (Run as Administrator):`));
    console.log(chalk.gray(`       netsh advfirewall firewall add rule name="mycc serve" dir=in action=allow protocol=TCP localport=${port}`));
  }

  console.log(chalk.gray('Terminal input disabled. Press ESC to return to CLI, or use the exit button in the web UI.'));
}