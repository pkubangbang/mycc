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

main().catch((err: Error) => {
  console.error('Fatal error:', err);
  process.exit(1);
});