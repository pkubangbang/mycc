/**
 * session-reset.ts — THE session-change clear, as a DOM-free function.
 *
 * Why this module exists: `fetchConfig()` in `main.ts` detects a changed
 * `sessionId` (a serve restart started a new session) and wipes the previous
 * session's state — chat arrays, teammate messages AND the todo panel. That
 * clear lived inline in `main.ts`, which is the browser entry: it calls
 * `createApp`, touches `window`/`document`, and runs a bootstrap IIFE as a
 * module side effect, so no node test could import it.
 *
 * The consequence was measured, not assumed: deleting the `store.todos.splice`
 * line from that inline block left the ENTIRE web suite green (150/150). The
 * rule that a session change must clear the panel — the SESSION-ISOLATION
 * INVARIANT the surrounding comment states in capitals — was therefore
 * unguarded, and the one bug this feature had already shipped once
 * (a stale panel) could come back silently.
 *
 * Extracting the clear here gives that rule a callable identity:
 *   - `main.ts` calls {@link resetSessionState} (no logic left inline), and
 *   - `tests/web/session-change-todos.test.ts` calls the SAME function on a
 *     real Pinia store, so a regression in either the rule or its wiring is a
 *     red test rather than a comment nobody executes.
 *
 * Keep this module free of browser globals: it is imported from both the app
 * and the node test environment.
 */
import type { ChatMessage } from './types';

/**
 * The minimal store surface a session reset touches. Structural (not the Pinia
 * type) so a plain object can be passed in tests while the real store still
 * satisfies it.
 */
export interface SessionResettable {
  messages: ChatMessage[];
  teammateMessages: ChatMessage[];
  /**
   * The authoritative todo panel rows.
   *
   * REQUIRED, not optional: making it optional is exactly what let the
   * session-change rule skip the panel in the first place. A store without a
   * todo list must pass `[]` explicitly rather than silently opt out.
   */
  todos: unknown[];
}

/**
 * Empty every piece of per-session UI state, in place.
 *
 * In-place `splice` (never reassignment) so Pinia/Vue reactivity reaches
 * mounted components — `TodoCard` and `ChatLog` must re-render to empty.
 *
 * Call this the moment a new `sessionId` is observed, BEFORE fetching that
 * session's history: otherwise new-session events layer on top of the old
 * session's rows (this file's header in `main.ts` documents the full
 * ordering invariant).
 */
export function resetSessionState(store: SessionResettable): void {
  store.messages.splice(0, store.messages.length);
  store.teammateMessages.splice(0, store.teammateMessages.length);
  store.todos.splice(0, store.todos.length);
}
