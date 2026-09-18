/**
 * message-key.ts - stable, strictly-unique Vue v-for key for chat messages
 *
 * Extracted from ChatLog.vue as a PURE function so the key invariant is
 * directly unit-testable (a `.vue` SFC is not importable in node tests).
 * ChatLog.vue imports this and binds it in its v-for `:key`.
 *
 * STABILITY (the primary requirement): the key for a given message must NOT
 * change when the rendered window shifts. ChatLog's collapse window can
 * prepend older messages via loadMore(), which shifts every message's
 * viewport-relative index — an index-based key would make Vue see the same
 * message as a brand-new keyed component and recreate it, losing MessageItem
 * local state (copied flag, timers, ...). So the STABLE ChatMessage.id is the
 * PRIMARY key whenever it is present (live messages always carry an id from
 * main.ts's nextId() counter; history-loaded messages get one assigned once
 * in fetchHistory when missing — see main.ts).
 *
 * FALLBACK (strict uniqueness, no id): for history-loaded messages that
 * predate the id scheme and have no assigned id, the key falls back to
 * "<timestamp> <label> #<index>". The index is ALWAYS appended as a
 * deterministic tiebreaker so two messages sharing the same ms + label
 * (rare but possible) still get distinct keys. This fallback path is
 * window-relative by nature (no stable id exists), so it is only used when
 * no stable id is available — the common case (live + newly-loaded
 * messages) is fully stable.
 */
import type { ChatMessage } from './types';

/**
 * Compute a stable, strictly-unique v-for key for a visible chat message.
 *
 * @param msg   the message (id is preferred; timestamp + label are fallback)
 * @param index the message's position in the rendered list — used ONLY as a
 *              fallback tiebreaker when no stable id is available
 * @returns a string key: "id:<id>" when id is present, else a
 *          timestamp+label+index fallback that is unique within the list
 */
export function messageKey(msg: ChatMessage, index: number): string {
  // Primary: the stable, window-independent message id. Live messages always
  // carry one (main.ts nextId()); history-loaded messages get one assigned in
  // fetchHistory when missing. This keeps the key constant across loadMore()
  // prepends / collapse-window shifts → Vue reuses the component + its state.
  if (typeof msg.id === 'number') {
    return `id:${msg.id}`;
  }
  // Fallback: no stable id (history-loaded message predating the id scheme
  // with no assigned id). Use timestamp + label + index — the index tiebreaker
  // guarantees uniqueness within the rendered list even for identical
  // ts+label pairs. This path is inherently window-relative, but it is only
  // reached when no stable id exists.
  const ts = msg.timestamp;
  const label = msg.label ?? '';
  if (ts && label) {
    return `${ts} ${label} #${index}`;
  }
  if (ts) {
    return `${ts} #${index}`;
  }
  if (label) {
    return `${label} #${index}`;
  }
  return `#${index}`;
}