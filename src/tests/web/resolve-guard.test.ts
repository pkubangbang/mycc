/**
 * resolve-guard.test.ts — the "was the steer-resolve delivered?" decision.
 *
 * These cover the branch that `71eb910` added to main.ts and that had NO test
 * (nothing under src/tests imported main.ts). The logic now lives in
 * resolve-guard.ts so it can be exercised deterministically with an injected
 * clock — main.ts is the HMR-persistent entry point and keeps only the wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createResolveGuard,
  isResolveAck,
  RESOLVE_ACK_TIMEOUT_MS,
} from '../../web/src/resolve-guard.js';

interface Note {
  id: number;
  text: string;
}

describe('createResolveGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores the snapshot when the ack never arrives (half-open socket)', () => {
    // THE bug: ws.send() "succeeds" into a half-open socket, wsSend returns
    // true, the card was cleared optimistically — and nothing ever comes back.
    // The timeout is the only signal that the resolve was not delivered.
    const onUnconfirmed = vi.fn();
    const reconnect = vi.fn();
    const guard = createResolveGuard<Note>({ onUnconfirmed, reconnect });

    const notes: Note[] = [{ id: 1, text: 'A' }];
    guard.arm(notes);
    expect(guard.isPending()).toBe(true);
    expect(onUnconfirmed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RESOLVE_ACK_TIMEOUT_MS - 1);
    expect(onUnconfirmed).not.toHaveBeenCalled(); // still inside the window

    vi.advanceTimersByTime(1);
    expect(onUnconfirmed).toHaveBeenCalledWith(notes);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(guard.isPending()).toBe(false);
  });

  it('clear() disarms: an acknowledged resolve is never restored', () => {
    const onUnconfirmed = vi.fn();
    const reconnect = vi.fn();
    const guard = createResolveGuard<Note>({ onUnconfirmed, reconnect });

    guard.arm([{ id: 1, text: 'A' }]);
    guard.clear(); // steer-flush arrived

    expect(guard.isPending()).toBe(false);
    vi.advanceTimersByTime(RESOLVE_ACK_TIMEOUT_MS * 4);
    expect(onUnconfirmed).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('clear() on an idle guard is a no-op (double ack, or none pending)', () => {
    const onUnconfirmed = vi.fn();
    const guard = createResolveGuard<Note>({ onUnconfirmed, reconnect: vi.fn() });
    expect(() => guard.clear()).not.toThrow();
    expect(() => guard.clear()).not.toThrow();
    expect(guard.isPending()).toBe(false);
  });

  it('a second arm supersedes the first — only one restore, with the newest notes', () => {
    // The user resolves twice before the first ack lands. Restoring the older
    // snapshot would re-offer notes already in the newer one.
    const onUnconfirmed = vi.fn();
    const guard = createResolveGuard<Note>({ onUnconfirmed, reconnect: vi.fn() });

    const first: Note[] = [{ id: 1, text: 'A' }];
    const second: Note[] = [{ id: 1, text: 'A' }, { id: 2, text: 'B' }];
    guard.arm(first);
    vi.advanceTimersByTime(RESOLVE_ACK_TIMEOUT_MS / 2);
    guard.arm(second);

    // The first timer was cleared, so the full window restarts.
    vi.advanceTimersByTime(RESOLVE_ACK_TIMEOUT_MS / 2);
    expect(onUnconfirmed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RESOLVE_ACK_TIMEOUT_MS / 2);
    expect(onUnconfirmed).toHaveBeenCalledTimes(1);
    expect(onUnconfirmed).toHaveBeenCalledWith(second);
  });

  it('exposes the pending snapshot for diagnostics', () => {
    const guard = createResolveGuard<Note>({ onUnconfirmed: vi.fn(), reconnect: vi.fn() });
    const notes: Note[] = [{ id: 9, text: 'X' }];
    guard.arm(notes);
    expect(guard.pending()?.notes).toBe(notes);
    guard.clear();
    expect(guard.pending()).toBeNull();
  });
});

describe('isResolveAck', () => {
  it('treats steer-flush as the positive ack', () => {
    expect(isResolveAck('steer-flush')).toBe(true);
  });

  it('treats prompt as terminal for the queue too (the card is rebuilt from it)', () => {
    expect(isResolveAck('prompt')).toBe(true);
  });

  it('ignores unrelated traffic', () => {
    for (const t of ['result', 'running', 'steer-echo', 'card', 'auto', 'file-flush']) {
      expect(isResolveAck(t)).toBe(false);
    }
  });
});
