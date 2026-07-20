/**
 * serve-registry.ts - Module-level singleton for ServeHub access
 *
 * Provides cross-module access to the ServeHub instance without
 * circular imports. No UserInputProvider reference needed —
 * WebInputProvider holds its own userProvider reference internally.
 */

import { ServeHub } from './serve-hub.js';

let serveHub: ServeHub | null = null;

export function getServeHub(): ServeHub {
  if (!serveHub) serveHub = ServeHub.getInstance();
  return serveHub;
}