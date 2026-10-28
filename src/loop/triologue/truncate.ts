/**
 * triologue/truncate.ts - the SHARED message-truncation primitive.
 *
 * One operation, two callers: wrap-up rollback (rollbackWrapUp) and the
 * (now removed) recap rewind. Both had to do it identically, so there is exactly
 * one implementation and it lives next to the store it mutates.
 *
 * WHAT IT DOES, in order:
 *   1. truncate the store to `startIndex` (exclusive of later messages)
 *   2. recompute the token count from the kept messages
 *   3. clear the pending-tool ledger (calls in the removed span are now invalid)
 *   4. drop deferred note()/user() submissions (their referent is gone)
 *   5. journal a control event ('rollback') so the transcript carries the
 *      boundary marker
 *
 * WHAT IS *NOT* THE STORE, AND WHY EACH IS A NARROW CALLBACK:
 *
 *  - `clearPendingToolCalls` — the pending-tool LEDGER is transport bookkeeping
 *    (assistant tool_calls → tool results), shared with tool(), agent(),
 *    skipPendingTools() and the TP fixer; it is deliberately not part of
 *    MessageStore, and this helper must not reach into the facade's copy.
 *  - `dropDeferredInputs` — the facade buffers note()/user() submissions while
 *    tool_calls are outstanding. A truncated span destroys their referent, so
 *    they must be DROPPED, not replayed; the queue is the facade's, re-entered
 *    through its own public producers.
 *  - `emitControl` — the transcript boundary marker. The journal sink is the
 *    facade's `onMessage` option (TriologueOptions); this helper must not import
 *    the facade's option type just to journal.
 *
 * TOKEN RECOUNT IS DELIBERATELY *NOT* A CALLBACK: `recomputeTokenCount()` is a
 * store method, so the accounting stays inside the store and this helper only
 * sequences the two.
 */

import type { MessageStore } from './store.js';

/** Everything a truncation needs that is NOT a MessageStore method. */
export interface TruncateDeps {
  /** Clear the pending-tool ledger (calls in the removed span are now invalid). */
  clearPendingToolCalls: () => void;
  /** Drop buffered note()/user() submissions whose referent is being removed. */
  dropDeferredInputs: (reason: string) => void;
  /** Journal the truncation boundary to the transcript. */
  emitControl: (event: 'rollback') => void;
}

/**
 * Truncate the message store to `startIndex`, recount tokens, clear the pending
 * ledger, drop deferred submissions and journal the boundary event.
 */
export function truncateAndRecount(
  store: MessageStore,
  deps: TruncateDeps,
  startIndex: number,
  event: 'rollback' = 'rollback',
): void {
  store.truncateTo(startIndex);
  store.recomputeTokenCount();
  deps.clearPendingToolCalls();
  // A truncated span discards messages, so a deferred submission's referent may
  // be gone — drop it rather than replay into a truncated context.
  deps.dropDeferredInputs(`truncateAndRecount(${event})`);
  deps.emitControl(event);
}
