/**
 * slow-suite.ts - opt-out gate for RELATIVELY STABLE, environment-bound suites.
 *
 * Some suites are dominated by wall-clock cost that is NOT the behaviour under
 * test: spawning a real `rg` over the whole tree, booting real child processes
 * that pay the tsx ESM loader, sitting out a production lock TTL, or launching
 * a real tmux session. Those suites verify the same contract on every run and
 * change rarely, so they are MUTED in the default `pnpm test` run to keep fast
 * feedback. They still run — on demand or in CI — via:
 *
 *     RUN_SLOW=1 pnpm test
 *     pnpm test:slow
 *
 * Use it ONLY at the TOP LEVEL of a stable suite, and NEVER in a suite that
 * exercises the main loop (src/tests/loop/**), the state machine, triologue,
 * the agent-io layer or any turn lifecycle: those are the parts under active
 * development, and muting them would hide a regression exactly when it matters.
 * The gate refuses a loop-owned file at import time (see assertMuteAllowed).
 */
import * as path from 'path';
import { fileURLToPath } from 'url';

/** Topic areas that must never be muted — active development surface. */
const FORBIDDEN_SEGMENTS = ['/tests/loop/', '/tests/agent-io/', '/tests/state-machine/', '/tests/hook/', '/tests/engine/'];

/**
 * True when the current run should SKIP a relatively stable, environment-bound
 * suite. False when RUN_SLOW=1 (or CI) asked for the full set.
 */
export function mutedSlowSuite(testFileUrl: string): boolean {
  assertMuteAllowed(testFileUrl);
  if (process.env.RUN_SLOW === '1' || process.env.CI === 'true') return false;
  return true;
}

/**
 * Guard: a main-loop / turn-lifecycle suite must never be muted. Throws when a
 * test file under one of FORBIDDEN_SEGMENTS imports this gate, so the mistake
 * fails loudly at collection time instead of shrinking coverage silently.
 */
export function assertMuteAllowed(testFileUrl: string): void {
  const p = fileURLToPath(testFileUrl).replace(/\\/g, '/');
  for (const seg of FORBIDDEN_SEGMENTS) {
    if (p.includes(seg)) {
      throw new Error(
        `slow-suite: refusing to mute ${path.basename(p)} — suites under ${seg} exercise the ` +
          `main loop and must run on every pass.`,
      );
    }
  }
}

/** Convenience: the canonical call site. `describe.skipIf(mutedSlowSuite(import.meta.url))`. */
export const RUN_SLOW_HINT = 'muted stable suite — run with RUN_SLOW=1 to execute';
