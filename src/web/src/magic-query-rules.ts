/**
 * magic-query-rules.ts — which 魔法查询 rows are runnable on THIS backend.
 *
 * A magic-query row submits slash text through the ordinary input path, so its
 * availability is a property of the BACKEND, not of the composer. `/reload`
 * restarts the Lead by asking the Coordinator to respawn it — and a headless
 * `--daemon` Lead has no Coordinator left (it exited right after spawning the
 * Lead). The backend refuses it outright (src/slashes/reload.ts prints "Not
 * available in daemon mode"); in the Web UI that refusal would otherwise be a
 * button that appears to work and then does nothing visible.
 *
 * Hence a row carries `unavailable`: a reason string computed HERE, so the
 * dialog (rendering + click handler) and the shell (runMagicQuery) share ONE
 * decision and cannot drift apart.
 *
 * DOM-free and dependency-free: unit-tested in node.
 */

/** What a row must tell us before we may judge it. */
export interface MagicQueryAvailabilityInput {
  /** The slash text the row submits, e.g. '/reload'. */
  query: string;
  /** Whether the serving Lead is a headless `--daemon` instance. */
  persistent: boolean;
  /**
   * Whether the server's answer has been received. Before that, `persistent`
   * is only the store's default (`false`, the safe 退出-button fallback), so a
   * gate keyed on it would claim "available" for a daemon page's first frames.
   */
  persistentKnown: boolean;
}

/** Slash commands that need the interactive Coordinator (they respawn the Lead). */
const COORDINATOR_BOUND_QUERIES = new Set(['/reload']);

/**
 * The reason `query` cannot run here, or `null` when it is runnable.
 *
 * Returns `null` while the backend's identity is still unknown: an unknown
 * backend is not a reason to disable, and the row's own `runnable` gate already
 * blocks execution until the page is interactive.
 */
export function resolveUnavailable(input: MagicQueryAvailabilityInput): string | null {
  if (!COORDINATOR_BOUND_QUERIES.has(input.query)) return null;
  if (!input.persistentKnown) return null;
  if (!input.persistent) return null;
  return '不可用：当前是 daemon 模式（没有 Coordinator 可复用），请在终端 / 前台会话执行 /reload';
}

/**
 * Whether the row may be executed now.
 *
 * The single predicate both sides call: the template binds `:disabled` to it and
 * the shell refuses on it, so a stale click (or a keyboard activation racing a
 * backend change) cannot send a command the backend will reject.
 */
export function isMagicQueryRunnable(input: MagicQueryAvailabilityInput): boolean {
  return resolveUnavailable(input) === null;
}
