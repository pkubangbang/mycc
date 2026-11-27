/**
 * steering-lifecycle.test.ts - A2 manager wipe-contract unit tests
 *
 * Gate A2 (plan §8): notes survive restartServe(); `manager.clear()` runs
 * only on terminal teardown — stop() outside restart and the WebInputProvider
 * terminal fallback. These unit tests pin the wipe contract on the REAL
 * manager singleton and the REAL hub source (source-text assertions for the
 * hub/provider wipe sites — the hub cannot be started in-unit without the
 * HTTP stack, so the boundary test reads the code path markers).
 *
 * - Manager contract: clear() wipes the queue; ids stay monotonic across
 *   clear (frontend per-note targeting must never collide after a restart).
 * - Hub stop(): the `!this.restarting` guard precedes getSteeringManager().clear()
 *   (restartServe sets `restarting` BEFORE stop(true) — notes survive 重启).
 * - WebInputProvider: BOTH terminal-fallback branches wipe (the hub will
 *   never deliver to the webui again), and both return BEFORE the wipe line
 *   on the restart branches.
 */
import { describe, it, expect, afterEach } from 'vite-plus/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getSteeringManager, SteeringManager } from '../../loop/steering-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// POST-EXTRACTION: the lifecycle transitions (stop / restartServe / the
// restarting gate) moved out of serve-hub.ts into serve-lifecycle.ts; the hub
// now only delegates. The A2 wipe contract is a property of those transitions,
// so the source pins below read the module that owns them.
const HUB_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'serve', 'serve-lifecycle.ts');
const PROVIDER_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'serve', 'web-input-provider.ts');

// Source-text pins below match CODE SHAPE, not layout: the formatter is free to
// reflow a one-line guard into a block (or join it back), so every assertion
// reads a whitespace-normalized copy. Freezing the formatter's output here would
// make `pnpm lint` (vp check runs oxfmt) break the gate — the pin must describe
// the guard, not the line breaks around it.
const read = (p: string): string => fs.readFileSync(p, 'utf-8').replace(/\s+/g, ' ');

describe('A2 manager contract (real singleton + fresh instances)', () => {
  afterEach(() => {
    getSteeringManager().clear();
  });

  it('clear() wipes the singleton queue and keeps ids monotonic', () => {
    const m = getSteeringManager();
    const a = m.addNote('before restart');
    m.clear();
    expect(m.isNonEmpty()).toBe(false);
    const b = m.addNote('after restart');
    // Ids NEVER reset — steering targeting by id (steerId echo / boomerang)
    // must not collide after a restart wipe.
    expect(b.id).toBe(a.id + 1);
  });

  it('a fresh SteeringManager has an empty queue (no cross-test leakage via new instances)', () => {
    const fresh = new SteeringManager();
    expect(fresh.peekNotes()).toEqual([]);
    expect(fresh.isNonEmpty()).toBe(false);
  });

  it('takeForDelivery(hold → deliver) mirrors the restart-window hold', () => {
    // The restart window behaves like "not parked" for delivery: notes arriving
    // while the loop holds them must survive until a delivery instant. The
    // hold path (isParked=false) consumes nothing; the delivery path drains.
    const m = new SteeringManager();
    m.addNote('survives restart');
    expect(m.takeForDelivery(false, false)).toBeNull();
    expect(m.peekTexts()).toEqual(['survives restart']);
    expect(m.takeForDelivery(true, false)).toEqual([{ id: 1, text: 'survives restart' }]);
  });
});

describe('A2 hub/provider wipe-site pins (source-text guards)', () => {
  it('stop() wipes the manager ONLY under the !restarting terminal guard', () => {
    const lifecycleSrc = read(HUB_PATH);
    // The wipe hook exists in the machine's host contract...
    expect(lifecycleSrc).toContain('clearSteering');

    // ...and the CALL SITE inside stop() is guarded.
    //
    // ISSUE #10: this used to slice from `async stop(skipAbortInput` to a bare
    // `indexOf('{ this.host.clearSteering(); }')` — an EXACT-LAYOUT match that
    // only holds while the formatter leaves the guard on one line. A reflow
    // (one statement per line, no braces) made `clearIdx` -1, and the
    // subsequent `expect(clearIdx).toBeGreaterThan(stopIdx)` would then fail
    // for a FORMATTING change rather than a behaviour change — the opposite of
    // a guard. The slice is now bounded by the NEXT method, and the guard is
    // matched against whitespace-normalised code (`read()` above), so the
    // assertion pins the CALL SITE and its predicate, not the line breaks.
    const stopIdx = lifecycleSrc.indexOf('async stop(skipAbortInput');
    const stopEnd = lifecycleSrc.indexOf('async gracefulShutdown()', stopIdx);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(stopEnd, 'gracefulShutdown() bounds the stop() body').toBeGreaterThan(stopIdx);
    const stopBody = lifecycleSrc.slice(stopIdx, stopEnd);

    // The wipe is reached through the recycle predicate, with the NEGATIVE
    // polarity (`!isRecycling()`), and the predicate and the call are adjacent
    // — an unguarded `clearSteering` anywhere else in stop() breaks this.
    expect(stopBody).toMatch(/if \(!this\.isRecycling\(\)\) \{?\s*this\.host\.clearSteering\(\);/);
    // Polarity is asserted separately so an inverted predicate names itself
    // instead of merely failing the regex above.
    expect(stopBody).not.toContain('if (this.isRecycling()) { this.host.clearSteering();');
    // The manager is never wiped directly (the hook is the only seam).
    expect(stopBody).not.toContain('getSteeringManager().clear()');
    expect(stopBody).not.toContain('this.steeringQueue = []');
  });

  it('restartServe() does NOT wipe the manager (restart-preservation)', () => {
    const lifecycleSrc = read(HUB_PATH);
    const restartIdx = lifecycleSrc.indexOf('restartServe(): Promise<void>');
    const endIdx = lifecycleSrc.indexOf('this.state.restarting = false;', restartIdx);
    const restartBody = lifecycleSrc.slice(restartIdx, endIdx);
    // The recycle path never calls the wipe hook (notes survive a 重启).
    expect(restartBody).not.toContain('clearSteering');
    // Nor the manager directly.
    expect(restartBody).not.toContain('getSteeringManager().clear()');
  });

  it('WebInputProvider wipes in BOTH terminal-fallback branches, restart branches return before the wipe', () => {
    const src = read(PROVIDER_PATH);
    const provider = src.slice(src.indexOf('export class WebInputProvider'));
    // Exactly two live wipes (both through logSteeringWipe, which records the
    // discarded note ids — row loop-b/005) and no bare clear() elsewhere.
    const wipeCount = provider.split("logSteeringWipe('terminal-fallback").length - 1;
    expect(wipeCount).toBe(2);
    expect(provider).not.toContain('getSteeringManager().clear();');

    // The hub is resolved LAZILY (liveHub → tryGetServeHub, never a ctor
    // field) so the lazy-serve refactor keeps the boot path hub-free. The
    // guards therefore read through a local `hub` binding, not `this.hub`.
    // Branch 1: entry fallback — wipe AFTER the shouldDaemon throw, and the
    // isRestarting branch above it must `return` before reaching the wipe.
    const entryIdx = provider.indexOf('async getInput(');
    const branch1 = provider.slice(entryIdx, provider.indexOf("logSteeringWipe('terminal-fallback", entryIdx));
    expect(branch1).toContain('if (hub && hub.isRestarting()) return (await hub.waitForInput()).text;');
    expect(branch1).toContain('if (shouldDaemon()) throw new ServeDetachedExitError();');
    // The hub comes from the lazy accessor, not a stored field.
    expect(branch1).toContain('this.liveHub()');
    // Branch ordering: the restart return precedes the wipe (so 重启 never wipes).
    expect(branch1.indexOf('isRestarting()')).toBeLessThan(branch1.length);

    // Branch 2: post-abort fallback — same guard shape.
    const abortIdx = provider.indexOf('abortInput() resolved waitForInput() with null');
    const branch2 = provider.slice(abortIdx, provider.indexOf("logSteeringWipe('terminal-fallback", abortIdx));
    expect(branch2).toContain('if (hub.isRestarting()) return (await hub.waitForInput()).text;');
    expect(branch2).toContain('if (shouldDaemon()) throw new ServeDetachedExitError();');
  });
});
