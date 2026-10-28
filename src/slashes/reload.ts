/**
 * /reload command - Restart mycc with fresh code, reusing the coordinator
 *
 * Usage:
 *   /reload   - Restart the lead process only (coordinator is reused)
 *
 * Unlike /fork (which opens a parallel mycc in a new terminal window) and
 * unlike /load (which branches a pre-populated context from a sealed session
 * via --from), /reload:
 *   1. Does NOT pre-populate context — the new lead starts with a fresh,
 *      empty session (no --from flag), so the conversation is cleared.
 *   2. Reuses the coordinator — only the lead process is killed and
 *      respawned. Teammates are child processes of the lead, so they are
 *      naturally killed when the lead exits.
 *   3. Preserves web UI availability — when /serve is active, the lead sends
 *      the current serve port/host to the coordinator in the IPC message.
 *      The coordinator respawns the lead with `--serve <port> --host <host>`,
 *      so the web UI rebinds to the same port. From the user's perspective
 *      the web UI disconnects briefly (the old Vite/HTTP server is torn down
 *      and the new one comes up), then the browser's WebSocket auto-reconnect
 *      kicks in and the UI resumes with a cleared context.
 *
 * Flow:
 *   1. Read serve state (active? port? host?) from the ServeHub singleton,
 *      and this lead's own launch argv (process.argv.slice(2), flags only)
 *   2. Send a 'reload' IPC message to the coordinator carrying both
 *   3. Block forever — the coordinator SIGTERMs this lead process and
 *      respawns a fresh one, REPLAYING the forwarded argv (minus --from) so
 *      every launch flag survives, with the live serve state merged in.
 *
 * Effect boundary:
 *   /reload only restarts the LEAD process (src/lead.ts + everything it
 *   imports — the agent loop, tools, slash commands, skills, serve, etc.).
 *   The COORDINATOR (src/index.ts) and the modules it loads directly at
 *   startup — src/config.ts (parses CLI args once at module load),
 *   src/loop/agent-io.ts, src/utils/key-parser.ts, src/utils/tsx-run.ts,
 *   src/help.ts — stay in the coordinator process and are NOT reloaded.
 *   Editing any of those requires a FULL mycc restart (exit + relaunch).
 *   Because config.ts is a coordinator-process module, CLI flags are frozen
 *   for the coordinator's lifetime — /reload cannot change --token-threshold,
 *   --ollama-model, etc.; only a full restart can.
 *
 * Design reference: the coordinator-side handler lives in src/index.ts
 * (reloadLead, mirroring the existing restart() used by /load). See also
 * docs/session/reload-design.md for the full design and effect boundary.
 */

import type { SlashCommand } from '../types.js';
import { tryGetServeHub } from '../serve/serve-registry.js';
import { shouldDaemon } from '../config.js';
import { sendToParent } from '../utils/parent-ipc.js';
import chalk from 'chalk';

/**
 * The dispatch-time transformation applied to this Lead's own launch argv
 * before it is sent to the Coordinator in the 'reload' IPC message.
 *
 * IDENTITY on purpose, and exported so a test can pin it: every launch token
 * must be forwarded — including the SEPARATE value of a `--flag value` pair,
 * which does not itself start with '-'. All positional/`--from`/serve filtering
 * belongs to the Coordinator-side buildReloadArgs(), which parses `--flag value`
 * correctly; a lossy pre-filter here silently turned `--max-upload-mb 20` into
 * a bare flag (minimist `true` → 1 MB).
 */
export function collectReloadLeadArgs(argv: readonly string[]): string[] {
  return argv.slice(2);
}

/**
 * True when a PRE-SLICED launch-token list carries the compose-managed `--name`
 * flag (either `--name <value>` or `--name=<value>` form).
 *
 * Callers pass tokens ALREADY stripped of `node <script>`: the slash site
 * passes nothing (default = process.argv.slice(2)) and the coordinator passes
 * its own pre-sliced `leadArgs`. The default MUST stay in the parameter, never
 * a body-level slice — a second slice would drop a leading `--name` and
 * silently defeat this guard (pinned by the double-slice regression test).
 *
 * Only the launcher injects `--name` (mycc-compose spawns
 * `['--name', peer.name, ...argv]`), so its presence reliably marks this Lead
 * as compose-managed, which must not be /reload-ed.
 */
export function hasNameFlag(tokens: readonly string[] = process.argv.slice(2)): boolean {
  return tokens.some((a) => a === '--name' || a.startsWith('--name='));
}

export const reloadCommand: SlashCommand = {
  name: 'reload',
  description: 'Restart mycc with fresh code (reuses coordinator, clears context). Web UI auto-reconnects if active.',
  handler: async () => {
    // Guard: compose-managed Leads refuse /reload. Respawn would bypass the
    // compose launcher, orphan the channel files it materialized and desync its
    // durable name↔sid mapping. Refuse EARLY with a visible message and send NO
    // IPC — renewal is compose's job.
    if (hasNameFlag()) {
      console.log(chalk.yellow(
        'This instance is managed by mycc-compose (launched with --name). ' +
        '/reload is disabled here — it would orphan its channels. ' +
        'Renew it via: mycc-compose up <spec>',
      ));
      return;
    }

    // In --daemon mode the Coordinator has already exited (startDaemonLead →
    // child.unref() → process.exit(0)), so there is nothing to reuse. Worse,
    // on Unix the daemon Lead still receives an IPC channel
    // (stdio ['ignore','ignore','ignore','ipc']), so process.send is truthy
    // while no listener exists — the `await new Promise(() => {})` below
    // would hang FOREVER. Guard early and return instead.
    if (shouldDaemon()) {
      console.log(chalk.yellow('Not available in daemon mode (no coordinator to reuse).'));
      return;
    }

    const hub = tryGetServeHub();
    const wasServeActive = hub?.isRunning() ?? false;
    const servePort = hub?.getPort() ?? 0;
    const serveHost = hub?.getHost() ?? null;

      console.log(chalk.cyan('\nReloading mycc...'));

    if (wasServeActive && servePort > 0) {
      console.log(chalk.gray(`  Web UI will resume on port ${servePort} after restart.`));
    }
    console.log(chalk.gray('  Context will be cleared. Coordinator is reused; teammates will be killed.'));

    // Send reload IPC to coordinator with the current serve state so the
    // respawned lead can re-activate the web UI on the same port, PLUS this
    // lead's own original launch argv so the coordinator can RESPWAN an
    // identically-configured lead. Without the argv the coordinator could only
    // rebuild serve flags, silently dropping every other launch flag
    // (--auto, --allow-auto-commit, --token-threshold, --model, --editor, …).
    //
    // Forward the COMPLETE process.argv.slice(2) — positionals included — and
    // let buildReloadArgs() (coordinator side) do the positional/--from/serve
    // filtering. See collectReloadLeadArgs() for why the value tokens MUST
    // survive this seam (the historical `startsWith('-')` filter here dropped
    // every SEPARATE flag value, turning `--max-upload-mb 20` into a bare flag →
    // getMaxUploadMb() === 1).
    const leadArgs = collectReloadLeadArgs(process.argv);
    if (sendToParent({
      type: 'reload',
      serveActive: wasServeActive,
      servePort,
      serveHost,
      leadArgs,
    })) {
      // Wait forever — the Coordinator will SIGTERM this process.
      // Same pattern as /load (src/slashes/load.ts line 69-71).
      await new Promise(() => {});
    } else {
      // Not running under a coordinator — nothing to reuse. Instruct the user
      // to restart manually (a plain `mycc` starts a fresh coordinator+lead).
      console.log(chalk.red('Not running under Coordinator. Cannot reload in-place.'));
      console.log(chalk.gray('Restart manually: mycc'));
    }
  },
};