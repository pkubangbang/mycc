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
import { isVerbose } from './config.js';
import { main } from './loop/agent-repl.js';
import { agentIO } from './loop/agent-io.js';
import { getServeHub } from './serve/serve-registry.js';
import { detectShell } from './utils/shell-detect.js';
import { installVerboseLog } from './utils/verbose-log.js';

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
// Verbose File Logging (-v)
// ---------------------------------------------------------------------------
// When -v is set, tee everything written to stdout/stderr into
// .mycc/verbose-lead-<timestamp>.log. This captures the Lead's output even
// when it runs headless under `--daemon` (where stdio is 'ignore' and the
// terminal shows nothing). Installed here — before main() — so the tee is
// active for the entire agent loop, including the daemon's silent-exit case.
if (isVerbose()) {
  const logPath = installVerboseLog('lead');
  if (logPath) {
    console.log(`[verbose] lead log → ${logPath}`);
  }
}

// ---------------------------------------------------------------------------
// Windows Shell Detection (single source of truth)
// ---------------------------------------------------------------------------
// Detected ONCE here in the Lead process (where both the system prompt in
// agent-prompts.ts and exec() in agent-io.ts live). PowerShell 7 (pwsh) is
// required on Windows — 5.1 is NOT a compatible fallback, so if pwsh 7 is
// missing we warn loudly and exec() will throw a clear error rather than
// silently running commands through an incompatible shell. See
// shell-detect.ts and the windows-shell-strategy skill.
const shellInfo = detectShell();
if (shellInfo.isWin && shellInfo.shell === 'powershell5') {
  agentIO.brief('warn', 'config',
    'pwsh 7 not found (using Windows PowerShell 5.1). Install for best bash-tool reliability: winget install --id Microsoft.PowerShell --scope user');
}

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