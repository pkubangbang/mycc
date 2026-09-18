/**
 * message-key.ts - strictly-unique Vue v-for key for chat messages
 *
 * Extracted from ChatLog.vue as a PURE function so the uniqueness invariant
 * is directly unit-testable (a `.vue` SFC is not importable in node tests).
 * ChatLog.vue imports this and binds it in its v-for `:key`.
 *
 * The key shape is "<raw-timestamp> <label> #<index>" (e.g.
 * "1723391724123 assistant #3"). The raw millisecond timestamp encodes the
 * time and the label is the tool name — together they form a readable,
 * time+tool key. The index is ALWAYS appended as a tiebreaker so the key is
 * STRICTLY UNIQUE even when two messages share the exact same millisecond +
 * label (e.g. two brief() status lines emitted in the same ms, or
 * history-loaded messages with identical stamps). Vue treats v-for keys as
 * an identity invariant, not something to tolerate collisions on, so
 * uniqueness is guaranteed deterministically rather than probabilistically.
 *
 * FALLBACK: timestamp and label are both optional. When either is absent
 * (raw verbose logs, history-loaded messages predating the timestamp/label
 * scheme), the key still carries the index so it never collides.
 */
import type { ChatMessage } from './types';

/**
 * Compute a strictly-unique v-for key for a visible chat message.
 *
 * @param msg   the message (timestamp + label are optional)
 * @param index the message's position in the rendered list — always folded
 *              into the key as a deterministic tiebreaker
 * @returns a string key unique within the rendered list
 */
export function messageKey(msg: ChatMessage, index: number): string {
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