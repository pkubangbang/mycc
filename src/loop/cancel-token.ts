/**
 * cancel-token.ts - Process-wide cooperative cancellation for tool execution.
 *
 * WHY THIS EXISTS
 * ---------------
 * Tool handlers receive an AbortSignal so a slow tool (web_fetch, bash, an
 * LLM judge) can be interrupted. In the LEAD that signal comes from
 * `ctx.core.escAware`, which wires it to the ESC key. A CHILD process
 * (teammate / explorer) cannot receive ESC directly: `ChildCore.escAware`
 * used to hand every operation a fresh AbortController that nothing ever
 * aborted — a signal that looked real but was dead. That is the worst shape a
 * cancellation bug can take, because call sites and type signatures all say
 * "cancellable".
 *
 * This module is the child's real cancellation source. There is exactly ONE
 * owner of the abort state (a process-level token), and every nested
 * controller derives from it:
 *
 *   cancelProcess()  ──►  childCancelToken.signal aborts
 *                            │
 *                            ├─►  ChildCore.escAware's per-operation controller
 *                            └─►  the signal handed to silentLoader.execute
 *
 * The lead is the only party allowed to call `cancelProcess()` (today: process
 * shutdown; tomorrow: a `cancel` IPC frame from `tm_remove`). The token never
 * resets — once the process is cancelled it stays cancelled, which is the
 * correct lifetime for "this teammate is being shut down".
 *
 * Why not reuse `agentIO.isNeglectedMode()`? Neglect is turn-scoped UI state
 * owned by the lead's line editor; a child has no line editor. Keep the two
 * concepts apart: neglect means "stop and wrap up", cancellation means
 * "release the resources you are holding right now".
 */

/**
 * The process-level cancellation source. One per process (there is no reason
 * to have more: a child process either lives or is being torn down).
 */
import { listenerCount } from 'node:events';

const token = new AbortController();

/** True once this process has been asked to cancel in-flight work. */
export function isProcessCancelled(): boolean {
  return token.signal.aborted;
}

/** The signal to hand to any long-running operation. Never resets. */
export function getProcessSignal(): AbortSignal {
  return token.signal;
}

/**
 * Cancel every in-flight operation in this process. Idempotent: the second and
 * subsequent calls are no-ops, so shutdown paths may call it freely.
 */
export function cancelProcess(reason?: unknown): void {
  if (token.signal.aborted) return;
  token.abort(reason);
}

/**
 * Register a listener that fires when the process is cancelled. Returns an
 * unsubscribe function so the caller can detach on normal completion and
 * avoid leaking listeners across many short tool calls.
 *
 * Unsubscribing twice is safe, and unsubscribing after the token fired is a
 * no-op (the listener is `once`). Callers MUST call the returned function on
 * success as well as failure — otherwise every completed operation leaves a
 * listener behind until the process ends.
 */
export function onProcessCancel(fn: () => void): () => void {
  if (token.signal.aborted) {
    fn();
    let called = false;
    return () => {
      if (called) return;
      called = true;
    };
  }
  token.signal.addEventListener('abort', fn, { once: true });
  return () => token.signal.removeEventListener('abort', fn);
}

/** Number of live listeners on the process token (diagnostics/tests only). */
export function processCancelListenerCount(): number {
  // An AbortSignal is an EventTarget; the events module's listenerCount works
  // on it even though the signal does not expose the count itself.
  return listenerCount(token.signal, 'abort');
}

/**
 * Derive an AbortController from the process token: it aborts when either the
 * caller aborts it or the process is cancelled. Use this when an operation
 * needs its OWN controller (e.g. to react to a timeout) but must still honour
 * process-wide cancellation.
 */
export function deriveController(): AbortController {
  const { controller, dispose } = deriveDisposableController();
  // Self-cleaning: aborting this controller (locally OR by the process token)
  // detaches its process listener, so the count stays bounded even if the
  // caller never calls dispose().
  controller.signal.addEventListener('abort', dispose, { once: true });
  return controller;
}

/**
 * Like deriveController, but also returns a `dispose` that detaches the
 * process listener. Callers that create short-lived controllers must call it
 * when the operation finishes — on SUCCESS too, not only on abort — or every
 * completed operation leaves a listener behind until the process exits.
 *
 * `dispose` is idempotent and safe after the controller already aborted.
 */
export function deriveDisposableController(): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  if (token.signal.aborted) {
    controller.abort(token.signal.reason);
    return { controller, dispose: () => { /* never subscribed */ } };
  }
  const unsubscribe = onProcessCancel(() => controller.abort(token.signal.reason));
  return { controller, dispose: unsubscribe };
}
