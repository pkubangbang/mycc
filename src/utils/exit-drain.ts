/**
 * exit-drain.ts - Bounded post-exit stdio drain for spawned child processes.
 *
 * WHY THIS EXISTS
 * ---------------
 * A child process's stdio EOF is NOT a reliable completion signal. Node fires
 * two different events:
 *
 *   - 'exit'  — the child PROCESS terminated. This is the real completion.
 *   - 'close' — ALL stdio streams closed (EOF). This only says "no more output
 *               can arrive".
 *
 * On Windows a command's grandchild inherits the stdio pipes (e.g.
 * `pnpm test` → vitest → worker pool, `npm run dev` → a dev server, gradle's
 * daemon). Those descendants hold the pipe WRITE END open after the direct
 * child exits, so 'close' is deferred until they exit — or never, if they
 * linger. Measured on this project: exit @453ms, close @20715ms for a command
 * whose grandchild slept 20s.
 *
 * Any caller that treats 'close' as "the command finished" therefore stalls for
 * as long as the least-diligent descendant holds the pipe. Both mycc consumers
 * hit this:
 *   - bg.ts         — the task stayed 'running' and bg_await polled to timeout.
 *   - agent-exec.ts — the bash tool blocked to its 60s timeout, then tree-killed
 *                     a process the user may have meant to leave running.
 *
 * THE CONTRACT
 * -------------
 * Completion is anchored to the PROCESS EXITING (`'exit'`). The stdio pipes are
 * then given a short grace window to deliver trailing bytes; whichever of
 * { 'close', grace deadline } fires first settles the drain. This is the same
 * shape opencode landed after four PRs (see opencode #20901 / #29106 / #42756 /
 * #46085 — "bound post-exit pipe draining on all platforms").
 *
 * DELIBERATE TRADEOFF: bytes emitted after the grace deadline are lost (and
 * writers may see EPIPE once the reader is released). In exchange, a lingering
 * descendant can never hang the caller. In the common case 'close' follows
 * 'exit' within milliseconds, so the grace window costs nothing and full output
 * is preserved.
 *
 * This module deliberately does NOT stop reading the pipes while the child is
 * alive: if the child filled the pipe buffer (64KB on Linux / 8KB on Windows) it
 * would block writing while we waited for 'exit' — a pipe-full deadlock. Both
 * callers drain with 'data' handlers, which satisfies this requirement.
 */

import type { ChildProcess } from 'child_process';

/** Default grace window: how long to wait for stdio EOF after process exit. */
export const DEFAULT_EXIT_DRAIN_GRACE_MS = 1000;

export interface ExitDrain {
  /**
   * Resolves once the drain is settled — i.e. the process has exited AND the
   * stdio pipes have either closed or exhausted the grace window. Never
   * rejects. Idempotent: safe to await from several consumers.
   */
  readonly settled: Promise<void>;
  /** True once settled. */
  isSettled(): boolean;
  /** Cancel the pending grace timer (used when the task leaves the map/killed). */
  cancel(): void;
}

/**
 * Arm a bounded post-exit drain on a spawned child.
 *
 * Arms immediately and lazily: the grace timer starts when the child's 'exit'
 * fires (never before — a long-running command must not have its drain clock
 * ticking while it is still legitimately working). 'close' settles the drain at
 * once and cancels the timer, so the ordinary path never pays the grace delay.
 *
 * @param child - the spawned ChildProcess (must be the DIRECT child mycc owns;
 *   descendants that inherit its pipes are what 'close' waits on).
 * @param graceMs - grace window after exit. Defaults to
 *   {@link DEFAULT_EXIT_DRAIN_GRACE_MS}.
 */
export function armExitDrain(
  child: ChildProcess,
  graceMs: number = DEFAULT_EXIT_DRAIN_GRACE_MS,
): ExitDrain {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveSettled!: () => void;

  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    resolveSettled();
  };

  // 'close' = all stdio closed → no further data can arrive. The normal case.
  child.on('close', settle);

  // 'exit' = the process is gone (the real completion). Arm the grace window
  // and settle if 'close' does not follow in time.
  child.on('exit', () => {
    if (settled || timer !== undefined) return;
    timer = setTimeout(settle, graceMs);
    // The grace window must never hold the host process open on its own.
    timer.unref?.();
  });

  return {
    settled: settledPromise,
    isSettled: () => settled,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
