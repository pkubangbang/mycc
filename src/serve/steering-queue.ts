/**
 * steering-queue.ts - pure, framework-free steering queue logic
 *
 * Extracted from serve-hub.ts so the boomerang resolution semantics can be
 * unit-tested in the existing node-environment Vitest suite WITHOUT importing
 * the heavy serve-hub.ts module graph (Express + Vite + agent-io). This module
 * has no side effects and no imports beyond a plain string array.
 *
 * The queue is an ordered list of notes, each with a stable monotonic id so
 * duplicate text can be individually targeted.
 */

export interface SteeringNote {
  id: number;
  text: string;
}

/**
 * Resolve a steering queue with positive "boomerang" semantics:
 *
 * - `sendIds` declares which note ids to SEND.
 * - Every note NOT in `sendIds` is implicitly DISCARDED.
 * - The WHOLE queue is drained atomically (returned notes are the selected
 *   subset in queue order), so a later peek sees an empty queue and cannot
 *   re-synthesize the same notes.
 *
 * @param queue - the current ordered queue (caller replaces it with `[]`).
 * @param sendIds - ids to send; empty/omitted means "discard all".
 * @returns the selected notes in queue order (empty when nothing selected).
 */
export function resolveSteeringQueue(
  queue: SteeringNote[],
  sendIds: number[] = [],
): SteeringNote[] {
  return queue.filter((n) => sendIds.includes(n.id));
}

/**
 * Join selected steering notes for submission. Blank-line separated so each
 * note remains visually distinct in the synthesized/echoed text.
 */
export function joinSteeringNotes(notes: SteeringNote[]): string {
  return notes.map((n) => n.text).join('\n\n');
}
