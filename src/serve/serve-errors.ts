/**
 * serve-errors.ts - Sentinel errors for the serve lifecycle.
 *
 * Leaf module — importing it from web-input-provider.ts and agent-repl.ts
 * costs no new module edges. Kept separate from the serve stack so a thrown
 * sentinel can be caught by the REPL without pulling Express/Vite/WS types.
 */

/**
 * Thrown when serve is down and there is no terminal to fall back to.
 *
 * In a headless daemon (`process.stdin.isTTY` falsy), the terminal fallback
 * in `WebInputProvider` can never resolve — `UserInputProvider.getInput()`
 * builds a LineEditor that waits for Coordinator IPC key events that a
 * detached process never delivers. Returning `null` would be read by
 * `prompt.ts` as "autonomous skip" and run a turn with no query, so throwing
 * is the only safe signal: it unwinds to the REPL exit path so a supervisor
 * (systemd) observes a clean termination and restarts the process.
 */
export class ServeDetachedExitError extends Error {
  readonly code = 'SERVE_DETACHED_EXIT';
  constructor() {
    super('serve stopped with no terminal — exiting so a supervisor can restart');
    this.name = 'ServeDetachedExitError';
  }
}