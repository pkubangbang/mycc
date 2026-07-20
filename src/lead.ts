/**
 * lead.ts - Lead agent entry point
 *
 * The Lead process runs the agent loop:
 * - Handles user interaction
 * - Spawns teammate processes
 * - Communicates with Coordinator via IPC
 *
 * Architecture:
 *   Terminal → Coordinator → Lead (this file) → Teammates
 */

import { validateEnv, loadEnv } from './config.js';
import { main } from './loop/agent-repl.js';
import { agentIO } from './loop/agent-io.js';
import { getServeHub } from './serve/serve-registry.js';

// ---------------------------------------------------------------------------
// Terminal Title
// ---------------------------------------------------------------------------

// Set early — tsx/esbuild may have overwritten the Coordinator's title during
// import loading. Restore 'mycc' so the user sees the right label immediately.
process.title = 'mycc';
if (process.stdout.isTTY) {
  process.stdout.write('\x1b]0;mycc\x07');
}

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

loadEnv();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const envResult = validateEnv();
envResult.warnings.forEach(w => agentIO.brief('warn', 'config', w.instruction));

if (!envResult.valid) {
  envResult.missing.forEach(m => agentIO.brief('error', 'config', m.instruction));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

main().catch(async (err: Error) => {
  console.error('Fatal error:', err);
  try { await getServeHub().stop(); } catch { /* best effort */ }
  process.exit(1);
});