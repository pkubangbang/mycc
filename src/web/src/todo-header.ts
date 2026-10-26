/**
 * todo-header.ts - the collapsed todo-panel header line.
 *
 * WHY THIS IS A SEPARATE MODULE: the header used to be a `computed` inside
 * `TodoCard.vue`, where no test could reach it — there is no component-mount
 * harness in this repo. That meant the user-visible string was asserted
 * nowhere and could only be verified by reading the template, which is how a
 * format request gets "fixed" and silently regresses. The formatter is pure, so
 * it lives here and `TodoCard.vue` calls it; the component keeps only the
 * collapse state.
 *
 * FORMAT (user-specified, 2026-10-26): `TODO 2/6 done (pinned x1)`
 *   - uppercase `TODO`, not `Todo`
 *   - `done` is a bare `n/m` fraction of the WHOLE list
 *   - the pinned suffix appears ONLY when at least one item is pinned, and
 *     reads `(pinned xN)` — the glyph form `1 📌` was explicitly rejected
 *   - no `·` separators, no leading icon (the 📋 glyph is a separate
 *     `span.todo-icon` in the template, so it must not be duplicated here)
 */
import type { TodoListEntry } from './types';

/** The pinned-count suffix, or '' when nothing is pinned. */
function pinnedSuffix(pinned: number): string {
  // `x1`, not `x 1`: the user's requested spelling. Zero is omitted entirely
  // rather than rendered as `(pinned x0)`.
  return pinned > 0 ? ` (pinned x${pinned})` : '';
}

/**
 * Build the collapsed header for `todos`.
 *
 * `0/0 done` is deliberate for an empty list: the card is `v-if="hasRows"`, so
 * this string is only reachable in tests or during the transition where the
 * last row is removed — it must not claim progress that does not exist, and it
 * must not throw.
 */
export function todoHeader(todos: readonly TodoListEntry[]): string {
  const total = todos.length;
  const done = todos.filter((t) => t.done).length;
  const pinned = todos.filter((t) => t.pinned).length;
  return `TODO ${done}/${total} done${pinnedSuffix(pinned)}`;
}
