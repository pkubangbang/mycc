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
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  getSteeringManager,
  SteeringManager,
} from '../../loop/steering-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'serve', 'serve-hub.ts');
const PROVIDER_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'serve', 'web-input-provider.ts');

const read = (p: string): string => fs.readFileSync(p, 'utf-8');

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
    const hubSrc = read(HUB_PATH);
    // The wipe exists...
    expect(hubSrc).toContain('getSteeringManager().clear()');
    // ...and it is guarded: the unconditional-wipe root cause (停止 race) is
    // `this.steeringQueue = []` / bare clear() in stop(); the guard must be
    // present between stop() start and the wipe call.
    const stopIdx = hubSrc.indexOf('async stop(skipAbortInput');
    const clearIdx = hubSrc.indexOf('getSteeringManager().clear()');
    expect(stopIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(stopIdx);
    const stopBody = hubSrc.slice(stopIdx, clearIdx + 40);
    expect(stopBody).toContain('!this.restarting');
    // The old field-wipe is gone.
    expect(hubSrc).not.toContain('this.steeringQueue = []');
  });

  it('restartServe() does NOT wipe the manager (restart-preservation)', () => {
    const hubSrc = read(HUB_PATH);
    const restartIdx = hubSrc.indexOf('async restartServe()');
    const endIdx = hubSrc.indexOf('}', hubSrc.indexOf('this.restarting = false;', restartIdx));
    const restartBody = hubSrc.slice(restartIdx, endIdx);
    expect(restartBody).not.toContain('clear()');
  });

  it('WebInputProvider wipes in BOTH terminal-fallback branches, restart branches return before the wipe', () => {
    const src = read(PROVIDER_PATH);
    const provider = src.slice(src.indexOf('export class WebInputProvider'));
    // Exactly two live wipes + none elsewhere (pushSteer/write sites own other paths).
    const wipeCount = provider.split('getSteeringManager().clear()').length - 1;
    expect(wipeCount).toBe(2);

    // The hub is resolved LAZILY (liveHub → tryGetServeHub, never a ctor
    // field) so the lazy-serve refactor keeps the boot path hub-free. The
    // guards therefore read through a local `hub` binding, not `this.hub`.
    // Branch 1: entry fallback — wipe AFTER the shouldDaemon throw, and the
    // isRestarting branch above it must `return` before reaching the wipe.
    const entryIdx = provider.indexOf('async getInput(');
    const branch1 = provider.slice(entryIdx, provider.indexOf('getSteeringManager().clear()', entryIdx));
    expect(branch1).toContain('if (hub && hub.isRestarting()) return hub.waitForInput();');
    expect(branch1).toContain('if (shouldDaemon()) throw new ServeDetachedExitError();');
    // The hub comes from the lazy accessor, not a stored field.
    expect(branch1).toContain('this.liveHub()');
    // Branch ordering: the restart return precedes the wipe (so 重启 never wipes).
    expect(branch1.indexOf('isRestarting()')).toBeLessThan(branch1.length);

    // Branch 2: post-abort fallback — same guard shape.
    const abortIdx = provider.indexOf("abortInput() resolved waitForInput() with null");
    const branch2 = provider.slice(abortIdx, provider.indexOf('getSteeringManager().clear()', abortIdx));
    expect(branch2).toContain('if (hub.isRestarting()) return hub.waitForInput();');
    expect(branch2).toContain('if (shouldDaemon()) throw new ServeDetachedExitError();');
  });
});