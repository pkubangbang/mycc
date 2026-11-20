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
 * Hard ceiling on any phantom note's `ttl`, enforced at the one place that reads
 * it.
 *
 * WHY GLOBAL AND NOT PER-PRODUCER: this used to be asserted only over the
 * reminder registry, which made it a promise about one producer rather than a
 * property of the projection. `collect-skill.ts` writes `skill-hint` at `ttl: 6`
 * — a value the registry test never saw, quietly exceeding a ceiling the docs
 * called "hard". Clamping here covers every producer, present and future,
 * without each one having to remember.
 *
 * WHY 5: a live note keeps its neighbourhood of the history mutable — every
 * re-emission and every splice rewrites what precedes it, so the provider's
 * prefix cache misses across the whole ttl window instead of just the chat that
 * emitted it. Five is deep enough for the widest cadence to hand off with zero
 * gap and short enough that the cache churn stays local.
 */
export const MAX_PHANTOM_TTL = 5;

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
    if (mark && typeof mark.ttl === 'number') {
      // Clamp, don't trust: a producer that asks for more than the ceiling gets
      // the ceiling (see MAX_PHANTOM_TTL). `Math.min` also turns a negative or
      // fractional ttl into "already expired" rather than a never-expiring note.
      const ttl = Math.max(0, Math.min(mark.ttl, MAX_PHANTOM_TTL));
      if (assistantTurns >= ttl) continue; // aged out — the provider never sees it
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
      // The blob's ttl is the SHORTEST ttl among the merged notes, not the
      // head's. A merged run is one message on the wire, so it can only expire
      // as a unit — and expiring when the most perishable part would have is
      // the only choice that never keeps a note past its own lifetime. Keeping
      // the head's value silently promoted a ttl:1 hint to a ttl:6 skill-hint's
      // lifetime whenever they landed on the same pass (they share the [HINT]
      // category, so this was the normal case, not an edge case).
      const head = run[0];
      const ttls = run.map((m) => m.phantom?.ttl).filter((t): t is number => typeof t === 'number');
      const blobPhantom = head.phantom
        ? { ...head.phantom, ...(ttls.length > 0 ? { ttl: Math.min(...ttls) } : {}) }
        : undefined;
      out.push({
        ...head,
        ...(blobPhantom ? { phantom: blobPhantom } : {}),
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
