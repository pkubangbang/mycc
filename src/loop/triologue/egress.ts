/**
 * triologue/egress.ts - The provider-facing projection of the conversation.
 *
 * TWO PURE FILTERS applied on the way OUT to a provider, in this order:
 *
 *     ageOut(messages) → coalesce(messages)
 *
 * The store is the AUDIT RECORD and the source of truth for everything that
 * reasons about history: hook conditions (sequence.ts), the skill dedup ledger
 * (collect-skill.ts), the hint analyzer's self-escalation (hint-round.ts), the
 * compact summary prompt. None of them may observe a shortened conversation,
 * so this module NEVER mutates — it returns a new array for the provider only.
 *
 * WHY THE ORDER IS FORCED: coalescing first would bake notes into a blob and
 * then drop some of them from the middle of it, which is impossible to undo.
 * Age out first, then merge what survived.
 *
 * WHAT "PHANTOM" MEANS: a phantom note (types.ts Message.phantom) is a
 * superseded STATE RE-SNAPSHOT — its own later instance makes it redundant
 * (the todo list, the team roster, the brief nudge). Contrast an EVENT — mail,
 * a steering note, an ESC directive, an upload path — which no later message
 * repeats, so evicting one loses information permanently. Only the producer
 * knows which is which, so only the producer marks it.
 */

import type { Message } from '../../types.js';

/**
 * True when the message is a system-generated note.
 *
 * PROVENANCE, NOT CONTENT. This used to test the `[CATEGORY] ` content prefix,
 * which the user can type: a genuine query beginning with "[SYSTEM] …" was then
 * classified as a note and merged into the preceding blob, breaking the
 * "a real query is never absorbed" guarantee. `note_category` is stamped by
 * `triologue.note()` — the only producer — so a user-authored message can never
 * carry it.
 *
 * The marker is the SOLE authority — there is deliberately no second check
 * against the content prefix. `note()` bakes the prefix in itself, so a message
 * carrying the marker but not the prefix is a producer bug, not a case worth
 * silently reclassifying as user text.
 */
export function isNoteMessage(m: Message): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.note_category !== undefined;
}

/**
 * Drop phantom notes that have aged out.
 *
 * The clock is ASSISTANT TURNS after the note's own position, walked from the
 * tail: a note survives while fewer than `ttl` assistant messages follow it.
 * Position — not wall time — because it is exact, replayable, and needs no new
 * plumbing; a wall clock would make the prompt depend on when it was rendered
 * and defeat the prompt cache for reasons unrelated to the conversation.
 *
 * `ttl` absent means never expires. That is a live case, not a placeholder:
 * mail is marked `{ family: 'mail' }` with no ttl — it is recoverable from
 * readmail.jsonl, but each item is a one-shot directive whose value is
 * arriving in attention exactly once, so it stays.
 *
 * `ttl: 0` drops the note from its own turn onward.
 */
export function ageOut(messages: Message[]): Message[] {
  const out: Message[] = [];
  let assistantTurns = 0;
  // Walk backwards so "how many assistant turns follow this message" is a
  // running count instead of an O(n^2) scan.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const mark = m.phantom;
    if (mark && typeof mark.ttl === 'number' && assistantTurns >= mark.ttl) {
      continue; // aged out — the provider never sees it
    }
    out.push(m);
    if (m.role === 'assistant') assistantTurns++;
  }
  return out.reverse();
}

/**
 * Merge each run of adjacent note messages into ONE user message.
 *
 * WHY: `note()` stores every note as its own `role: 'user'` message, and that
 * invariant is load-bearing (readers anchor on the `[CATEGORY] ` prefix, and a
 * merged message would make lastUserQuery ambiguous). But the WIRE does not
 * need N consecutive user turns — triologue parity is a property of the
 * outbound shape, so it belongs here, at the projection, not in the store.
 *
 * Each `[CATEGORY] ` prefix is preserved inside the merged content, so
 * attribution is unambiguous to the model and the reader.
 *
 * A message that is NOT a note (a real query, an assistant turn, a tool
 * result) ends the run, so a genuine query can never be swept into a blob.
 * Single notes pass through untouched (same object, no allocation).
 */
export function coalesce(messages: Message[]): Message[] {
  const out: Message[] = [];
  let run: Message[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      // Keep the FIRST message's runtime metadata (phantom marker if any) as
      // the blob's identity; the content is the only field that changes.
      const head = run[0];
      out.push({
        ...head,
        content: run.map((m) => m.content).join('\n\n')
      });
    }
    run = [];
  };

  for (const m of messages) {
    if (isNoteMessage(m)) {
      run.push(m);
    } else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
}

/**
 * The full provider-facing projection: age out phantom notes, then merge each
 * adjacent run of notes into one user message.
 */
export function projectForProvider(messages: Message[]): Message[] {
  return coalesce(ageOut(messages));
}
