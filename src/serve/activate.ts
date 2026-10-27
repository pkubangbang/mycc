/**
 * activate.ts - Shared serve activation logic
 *
 * Used by both `/serve` slash command and `--serve` CLI flag to eliminate
 * duplication. Starts the server, sets up output mirroring, and notifies the
 * Coordinator that serve mode is active.
 */

import { ensureServeHub } from './serve-registry.js';
import { agentIO } from '../loop/agent-io.js';
import { setWebUiUp } from '../loop/loop-events.js';
import { setResultCallback } from '../utils/letter-box.js';
import { sendToParent } from '../utils/parent-ipc.js';
import chalk from 'chalk';

// ─── WebUI serve-state holder ──────────────────────────────────────────────
//
// The `isWebUiUp`/`setWebUiUp` pull-holder lives in src/loop/loop-events.ts, NOT
// here. It was briefly merged into this file, but importing activate.ts from
// the loop layer (core.ts, collect.ts) transitively drags in
// web-input-provider → agent-io → esc-wrap-up → serve-hub → express/vite/ws,
// defeating the whole lazy-load effort. Measured: importing this module adds
// 13 express/vite/ws modules to a non-serving boot. loop-events.ts is a
// zero-import leaf the loop already depends on, so the boolean costs nothing
// there.
//
// The serve layer remains the sole WRITER; see loop-events.ts for the holder
// and the three write points (activateServe, ServeHub.stop, restartServe).

/**
 * Structural hub slices — deliberately declared here instead of importing the
 * ServeHub class. A static `import { ServeHub } from './serve-hub.js'` would
 * defeat the lazy registry and drag express/vite/ws into every boot; these
 * types erase at compile time and cost nothing at runtime.
 */
type OutputMirroringHub = {
  broadcast(type: string, content: string, label?: string, detail?: string, synthetic?: boolean): void;
};

type ActivateHub = OutputMirroringHub & {
  isRunning(): boolean;
  getUrl(): string | null;
  getUrls(): { local: string; network: string[] } | null;
  start(port: number, host?: string | null): Promise<void>;
};

/**
 * Wire output + result mirroring to the WebSocket clients. Shared by
 * `activateServe()` (initial start) and `ServeHub.restartServe()` (in-process
 * recycle) so both paths mirror identically without duplicating the wiring.
 *
 * brief() passes its tool tag as the label so the Web UI shows the same
 * [HH:MM:SS] [tool] header as the terminal; plain verbose logs have no
 * label. The detail parameter carries the tool's intent (e.g. bash command
 * description) for display in an outlined box inside the bubble. The result
 * callback is labeled 'assistant' so the Web UI renders the [assistant] tag,
 * matching the terminal-style header the user requested.
 */
export function wireOutputMirroring(hub: OutputMirroringHub): void {
  agentIO.setOutputCallback((method, args, label, detail, synthetic) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    hub.broadcast(method, text, label, detail, synthetic);
  });
  setResultCallback((content) => hub.broadcast('result', content, 'assistant'));
}

export async function activateServe(port: number, host?: string | null): Promise<void> {
  // Materialize the serve layer HERE — this is the one genuine entry point
  // (`/serve` slash command, `--serve` CLI flag, and ServeHub.restartServe's
  // recycle). Dynamic-importing serve-hub.ts (express/vite/ws) at this moment
  // instead of at process boot is the whole point of the lazy registry: a
  // plain terminal session never evaluates that chain at all.
  const hub: ActivateHub = await ensureServeHub();

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
    // locking the terminal even though the REPL is alive. In --daemon mode
    // there is no Coordinator (it has exited), so sendToParent no-ops.
    sendToParent({ type: 'serve_mode', active: false });
    return;
  }

  // Set up output + result mirroring to WebSocket (shared with restartServe).
  wireOutputMirroring(hub);

  // Record the WebUI as up for every loop/context consumer. This is the
  // serve layer's START seam — the ONLY writer family of this flag (see the
  // holder in src/loop/loop-events.ts). COLLECT picks the flip up on its next
  // pass and reports it to the LLM.
  setWebUiUp(true);

  // Notify Coordinator that serve mode is active (filter stdin). In --daemon
  // mode there is no Coordinator (it has exited), so sendToParent no-ops;
  // a daemon Lead runs headless with no terminal stdin to lock anyway.
  sendToParent({ type: 'serve_mode', active: true });

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