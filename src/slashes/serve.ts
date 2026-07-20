/**
 * /serve command - Start the web chat UI
 *
 * Usage:
 *   /serve        - Start web UI on default port (3173)
 *   /serve [port] - Start web UI on the specified port
 *
 * The web UI runs on Express + Vite (middleware mode) + WebSocket, all on a
 * single port. While active, terminal input is disabled (only ESC and Ctrl+C
 * are forwarded by the Coordinator). Exit via ESC, the in-UI exit button, or
 * a 30s disconnect timeout — all are warm (no neglection, no LLM abort).
 *
 * See docs/serve-plan.md for the full design.
 */

import type { SlashCommand } from '../types.js';
import { activateServe } from '../serve/activate.js';

export const serveCommand: SlashCommand = {
  name: 'serve',
  description: 'Start web chat UI. Usage: /serve [port]',
  handler: async (context) => {
    const portArg = context.args[1];
    const port = portArg ? parseInt(portArg, 10) : 3173;
    await activateServe(Number.isFinite(port) && port > 0 && port <= 65535 ? port : 3173);
  },
};