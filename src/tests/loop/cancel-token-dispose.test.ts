/**
 * cancel-token-dispose.test.ts - The peer's finding #3: listener accumulation.
 *
 * `deriveDisposableController()` attaches a listener to the process token.
 * ChildCore.escAware used to drop the controller without detaching it, so a
 * long-lived teammate accumulated one listener per COMPLETED tool call. These
 * tests pin both sides: the count returns to baseline after success, and it
 * still fires cancellation after disposal-free creation.
 */

import { describe, it, expect, vi } from 'vite-plus/test';

describe('process cancel token disposal', () => {
  async function load() {
    vi.resetModules();
    return await import('../../loop/cancel-token.js');
  }

  it('keeps the listener count stable across many successful operations', async () => {
    const { deriveDisposableController, processCancelListenerCount, getProcessSignal } = await load();
    const baseline = processCancelListenerCount();

    for (let i = 0; i < 50; i++) {
      const { controller, dispose } = deriveDisposableController();
      expect(controller.signal.aborted).toBe(false);
      dispose();
    }

    expect(processCancelListenerCount()).toBe(baseline);
    expect(getProcessSignal().aborted).toBe(false);
  });

  it('dispose is idempotent', async () => {
    const { deriveDisposableController, processCancelListenerCount } = await load();
    const baseline = processCancelListenerCount();
    const { dispose } = deriveDisposableController();
    dispose();
    dispose();
    dispose();
    expect(processCancelListenerCount()).toBe(baseline);
  });

  it('a non-disposed controller still aborts with the process (no false negative)', async () => {
    const { deriveDisposableController, cancelProcess } = await load();
    const { controller } = deriveDisposableController();
    cancelProcess('test teardown');
    expect(controller.signal.aborted).toBe(true);
  });

  it('a controller derived after cancellation needs no subscription', async () => {
    const { deriveDisposableController, cancelProcess, processCancelListenerCount } = await load();
    cancelProcess();
    const before = processCancelListenerCount();
    const { controller, dispose } = deriveDisposableController();
    expect(controller.signal.aborted).toBe(true);
    expect(processCancelListenerCount()).toBe(before);
    dispose();
  });
});
