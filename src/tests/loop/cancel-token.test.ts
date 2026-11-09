/**
 * cancel-token.test.ts - The child process's real cancellation source.
 *
 * Regression guard for the "dead signal" defect: ChildCore.escAware used to
 * hand every operation a fresh AbortController that nothing could abort, so
 * teammates type-checked as cancellable but could never be interrupted. These
 * tests pin the observable behaviour: an aborted process token must reach
 * every derived controller, and the listener bookkeeping must not leak.
 */

import { describe, it, expect, vi } from 'vite-plus/test';

describe('process cancel token', () => {
  // The token is a module-level singleton whose lifetime is the process. Use
  // vi.resetModules() per test so each starts from an un-cancelled state.
  async function load() {
    vi.resetModules();
    return await import('../../loop/cancel-token.js');
  }

  it('starts uncancelled and exposes a non-aborted signal', async () => {
    const { getProcessSignal, isProcessCancelled } = await load();
    expect(isProcessCancelled()).toBe(false);
    expect(getProcessSignal().aborted).toBe(false);
  });

  it('propagates cancellation to every derived controller', async () => {
    const { deriveController, cancelProcess } = await load();
    const a = deriveController();
    const b = deriveController();
    cancelProcess();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it('is idempotent and fires listeners exactly once', async () => {
    const { onProcessCancel, cancelProcess } = await load();
    const listener = vi.fn();
    onProcessCancel(listener);
    cancelProcess();
    cancelProcess('again');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('short-circuits late subscribers after cancellation', async () => {
    const { onProcessCancel, cancelProcess, deriveController } = await load();
    cancelProcess();
    const listener = vi.fn();
    onProcessCancel(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    // A controller derived after cancellation is already aborted, so a caller
    // that checks before awaiting never starts doomed I/O.
    expect(deriveController().signal.aborted).toBe(true);
  });

  it('a locally aborted derived controller detaches itself from the process token', async () => {
    const { deriveController, getProcessSignal, processCancelListenerCount, cancelProcess } = await load();
    const baseline = processCancelListenerCount();
    const controller = deriveController();
    expect(processCancelListenerCount()).toBe(baseline + 1);
    const onLocalAbort = vi.fn();
    controller.signal.addEventListener('abort', onLocalAbort, { once: true });
    // Abort LOCALLY: the derived controller's own signal must fire, and the
    // process listener must be dropped rather than kept until process exit.
    controller.abort('local');
    expect(onLocalAbort).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);

    // The decisive assertion the old test never made: the count is back to
    // baseline, so a later process-wide cancel cannot re-enter this controller.
    expect(processCancelListenerCount()).toBe(baseline);
    cancelProcess();
    expect(onLocalAbort).toHaveBeenCalledTimes(1);
    // getProcessSignal is referenced so an unused import cannot creep in.
    expect(getProcessSignal().aborted).toBe(true);
  });
});
