/**
 * gates.ts — shared condition helpers for conditional test suites.
 *
 * Two gates, both of which let a suite SKIP silently instead of carrying a
 * paired "we skipped because …" describe block that only exists to report
 * why the real suite did not run:
 *
 *   describeIfLiveTmux(name, fn) — runs only when a live tmux SERVER is
 *     reachable AND the global `mycc` command resolves on PATH. The live
 *     serve/peer suites boot the real CLI inside tmux; without either
 *     prerequisite they cannot run, so they skip at collection time.
 *
 *   describeIfOs(platforms, name, fn) — runs only on the named
 *     process.platform value(s). Use for suites whose subject is
 *     OS-specific shell/terminal behaviour.
 *
 * Probes are cheap, execute once per worker, and never throw. The tmux probe
 * creates and kills a throwaway session because `tmux -V` only proves the
 * binary is on PATH — a machine can have tmux installed but no server
 * running, and `tmux kill-session` against no server throws.
 */

import { describe } from 'vitest';
import { execSync } from 'child_process';

/** The null-redirection token for this platform. `2>nul` is Windows-only; on
 *  Unix it creates a stray file named `nul` and does NOT suppress stderr. */
const DEVNULL = process.platform === 'win32' ? '2>nul' : '2>/dev/null';

function sh(cmd: string, timeoutMs = 5000): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

let tmuxProbe: boolean | undefined;

/** True when a usable tmux SERVER round-trips (not merely `tmux` on PATH). */
export function hasLiveTmux(): boolean {
  if (tmuxProbe !== undefined) return tmuxProbe;
  tmuxProbe = probeTmux();
  return tmuxProbe;
}

function probeTmux(): boolean {
  try { sh('tmux -V', 3000); } catch { return false; }
  try {
    sh(`tmux new-session -d -s __mycc_gate_probe__ ${DEVNULL}`, 3000);
    sh(`tmux kill-session -t __mycc_gate_probe__ ${DEVNULL}`, 3000);
    return true;
  } catch {
    return false;
  }
}

let myccProbe: boolean | undefined;

/** True when the global `mycc` command resolves (npm link present). Uses
 *  `where`/`which` rather than spawning `mycc`: on Windows the global shim is
 *  a .cmd/.ps1 that spawnSync without shell:true cannot resolve. */
export function hasGlobalMycc(): boolean {
  if (myccProbe !== undefined) return myccProbe;
  myccProbe = probeMycc();
  return myccProbe;
}

function probeMycc(): boolean {
  try {
    return sh(process.platform === 'win32' ? 'where mycc' : 'which mycc', 5000).trim().length > 0;
  } catch {
    return false;
  }
}

/** Both live-tmux prerequisites at once: tmux server reachable + mycc on PATH. */
export function liveTmuxReady(): boolean {
  return hasLiveTmux() && hasGlobalMycc();
}

/**
 * describe() that runs only when a live tmux server + global mycc are both
 * available. When they are not, the suite is reported as skipped (no
 * placeholder test, no failure).
 */
export function describeIfLiveTmux(name: string, fn: () => void): void {
  describe.skipIf(!liveTmuxReady())(name, fn);
}

/**
 * describe() that runs only on the given platform(s).
 *
 * @example describeIfOs('win32', 'taskkill paths', () => { … });
 * @example describeIfOs(['linux', 'darwin'], 'posix signal paths', () => { … });
 */
export function describeIfOs(
  platforms: NodeJS.Platform | NodeJS.Platform[],
  name: string,
  fn: () => void,
): void {
  const wanted = Array.isArray(platforms) ? platforms : [platforms];
  describe.skipIf(!wanted.includes(process.platform))(name, fn);
}
