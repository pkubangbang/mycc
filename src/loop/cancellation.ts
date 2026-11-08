/**
 * cancellation.ts - One definition of "this failure is a cancellation".
 *
 * Used at the boundary where a tool result is produced (Loader.execute) and at
 * the state that consumes it (TOOL). Deliberately a LEAF: it imports nothing,
 * so both sides share it without a dependency cycle. The abort error classes
 * live in the engine, and depending on them here would drag the LLM transport
 * into the tool layer — so the shapes are recognised structurally instead.
 *
 * WHY IT MATTERS
 * --------------
 * A cancelled operation is not a failure. If it is reported as one, the model
 * sees `Error executing web_fetch: aborted` and reasonably retries the tool the
 * user just interrupted, while the confusion index is raised for the agent's
 * own correct behaviour and triologue parity is broken (the assistant message
 * still carries the call id).
 */

/** Names used by the abort error classes and by undici / Node. */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AbortError', // undici / DOMException for an aborted fetch
  'StreamAbortedError' // our own retry/collect plumbing
]);

/**
 * Did this error come from CANCELLATION rather than a genuine fault?
 *
 * Recognised structurally (no imports):
 * - an Error whose `name` is `AbortError` (undici) or `StreamAbortedError`
 *   (our engine), possibly subclassed;
 * - an explicit `causedByCancellation === true` marker, for wrappers that
 *   re-wrap the original error while preserving the intent.
 *
 * When the caller's signal is available it is the tie-breaker: if that signal
 * is aborted, any rejection that reached us during the operation is the
 * cancellation.
 *
 * Deliberately NOT based on the message containing "aborted":
 * `isTransientError` treats network-level aborts as retryable transport
 * faults, and those must keep their normal error path.
 */
export function isCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (err instanceof Error) {
    if (ABORT_ERROR_NAMES.has(err.name)) return true;
    if ((err as { causedByCancellation?: unknown }).causedByCancellation === true) return true;
  }
  return signal?.aborted === true;
}
