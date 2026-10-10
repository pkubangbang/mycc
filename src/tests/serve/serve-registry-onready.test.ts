/**
 * serve-registry-onready.test.ts - onServeHubReady() queue semantics (P1 #1).
 *
 * THE BUG (P1 #1): src/loop/agent-repl.ts wired the durable transcript path and
 * the user-journal provider with `tryGetServeHub()?.setTranscriptPath(...)` /
 * `tryGetServeHub()?.setUserJournalProvider(...)`. Those calls run BEFORE
 * `activateServe()`, so on every boot path (both `--serve` at startup and
 * terminal-mode-then-`/serve`) the hub is null and BOTH registrations are
 * SILENTLY DROPPED. Result: `/history` can't read the durable transcript, and
 * WebUI user submissions aren't journaled — history/user bubbles vanish on
 * refresh.
 *
 * THE FIX: register BOTH through `onServeHubReady()`, which runs the callback
 * immediately when the hub already exists and otherwise QUEUES it until
 * `registerServeHubFactory()` drains the queue. These tests pin that contract —
 * the property the fix relies on.
 *
 * ORDER-INDEPENDENCE: `serve-registry` holds module-level singleton state
 * (factory / instance / readyCallbacks) with no reset export. Every test below
 * therefore calls `vi.resetModules()` and dynamically imports a FRESH module
 * instance, so no test can observe another's registrations — the header's
 * order-independent claim is real, not aspirational. (The alternative — a
 * `__resetForTest()` export on production code — would add test-only surface
 * to the module purely to work around shared state.)
 */
import { describe, it, expect, vi } from 'vitest';
import type { ServeHubLike } from '../../serve/serve-registry.js';

/** A minimal structural ServeHubLike stub — only the members these tests touch. */
function makeStubHub(): ServeHubLike {
  return {
    isRunning: () => true,
    isRestarting: () => false,
    setTranscriptPath: () => {},
    setUserJournalProvider: () => {},
  } as unknown as ServeHubLike;
}

/** Import a FRESH serve-registry instance (isolated singleton per call). */
async function freshRegistry() {
  vi.resetModules();
  return import('../../serve/serve-registry.js');
}

describe('onServeHubReady: queued callbacks drain when the hub materializes (P1 #1)', () => {
  it('the queued callback receives the live hub once registerServeHubFactory runs', async () => {
    const reg = await freshRegistry();
    const hub = makeStubHub();
    let received: ServeHubLike | null = null;

    // Register BEFORE any factory exists — exactly the agent-repl boot order
    // (onServeHubReady runs before activateServe()). Nothing must throw and the
    // callback must NOT run yet.
    reg.onServeHubReady((h) => { received = h; });
    expect(received).toBeNull();

    // The serve layer materializes: register the factory. This drains the queue.
    reg.registerServeHubFactory(() => hub);

    // The callback now has the live hub — the registration is NOT dropped.
    expect(received).toBe(hub);
  });

  it('a callback registered AFTER the factory exists runs immediately', async () => {
    const reg = await freshRegistry();
    const hub = makeStubHub();
    reg.registerServeHubFactory(() => hub);

    let received: ServeHubLike | null = null;
    reg.onServeHubReady((h) => { received = h; });
    // Immediate — no queue involved.
    expect(received).toBe(hub);
  });

  it('tryGetServeHub returns the registered hub (the boot-path accessor is live)', async () => {
    const reg = await freshRegistry();
    const hub = makeStubHub();
    reg.registerServeHubFactory(() => hub);
    expect(reg.tryGetServeHub()).toBe(hub);
  });

  it('a THROWING callback in the QUEUE does not prevent sibling callbacks from draining', async () => {
    // Fresh module instance ⇒ no factory yet ⇒ both callbacks take the QUEUED
    // path, whose drain loop (registerServeHubFactory) IS per-callback
    // try/catch-wrapped. (The IMMEDIATE path in onServeHubReady is intentionally
    // NOT wrapped — a boot-time provider that throws should surface, not be
    // silently swallowed — so this test must exercise the queue, not it.)
    const reg = await freshRegistry();
    const hub = makeStubHub();
    let secondRan = false;

    reg.onServeHubReady(() => { throw new Error('bad provider'); });
    reg.onServeHubReady(() => { secondRan = true; });

    // Draining must isolate the throw and still deliver to the second.
    expect(() => reg.registerServeHubFactory(() => hub)).not.toThrow();
    expect(secondRan).toBe(true);
  });
});
