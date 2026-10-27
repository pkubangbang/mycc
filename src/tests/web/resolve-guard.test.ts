import { describe, it, expect } from 'vitest';
import {
  createResolveGuard,
  armResolve,
  confirmResolve,
  disarmResolve,
  rollbackResolve,
  isResolvePending,
} from '../../web/src/resolve-guard.js';

/**
 * The steering "boomerang" guard: a resolve is UNCONFIRMED until the server's
 * `steer-flush` ack. These tests pin the decision table the WebUI relies on to
 * avoid restoring an already-delivered instruction (or losing one on a drop).
 */

interface Note { id: number; text: string }

const note = (id: number): Note => ({ id, text: `note ${id}` });

describe('resolve-guard', () => {
  it('starts settled', () => {
    const g = createResolveGuard<Note>();
    expect(isResolvePending(g)).toBe(false);
    expect(disarmResolve(g)).toBe(false);
    expect(confirmResolve(g)).toBe(false);
    expect(rollbackResolve(g)).toBeNull();
  });

  it('arming snapshots the notes and sendIds by copy', () => {
    const g = createResolveGuard<Note>();
    const notes = [note(1), note(2)];
    const sendIds = [1];
    armResolve(g, notes, sendIds);

    // Copies, not aliases: later mutation of the caller's arrays must not
    // change what a rollback restores.
    notes.push(note(3));
    sendIds.push(2);

    expect(isResolvePending(g)).toBe(true);
    expect(g.pending).toEqual({ notes: [note(1), note(2)], sendIds: [1] });
  });

  it('steer-flush CONFIRMS and disarms', () => {
    const g = createResolveGuard<Note>();
    armResolve(g, [note(1)], [1]);

    expect(confirmResolve(g)).toBe(true);
    expect(isResolvePending(g)).toBe(false);
    // Nothing to roll back once delivered — restoring here is exactly the
    // double-submit bug.
    expect(rollbackResolve(g)).toBeNull();
  });

  it('prompt DISARMS without confirming (a turn end proves nothing about delivery)', () => {
    const g = createResolveGuard<Note>();
    armResolve(g, [note(1)], [1]);

    expect(disarmResolve(g)).toBe(true);
    expect(isResolvePending(g)).toBe(false);
    expect(rollbackResolve(g)).toBeNull();
  });

  it('a failed send ROLLS BACK the snapshot exactly once', () => {
    const g = createResolveGuard<Note>();
    armResolve(g, [note(1), note(2)], [2]);

    const restored = rollbackResolve(g);
    expect(restored).toEqual({ notes: [note(1), note(2)], sendIds: [2] });
    // Second rollback is a no-op — the card must not be restored twice.
    expect(rollbackResolve(g)).toBeNull();
  });

  it('re-arming replaces the previous snapshot (latest intent wins)', () => {
    const g = createResolveGuard<Note>();
    armResolve(g, [note(1), note(2)], [1]);
    armResolve(g, [note(2)], [2]);

    expect(g.pending).toEqual({ notes: [note(2)], sendIds: [2] });
  });

  it('full sequence: arm → send throws → rollback → arm → flush → settled', () => {
    const g = createResolveGuard<Note>();

    armResolve(g, [note(7)], [7]);
    // ws.send threw (socket closing) → the backend still holds note 7.
    expect(rollbackResolve(g)?.notes).toEqual([note(7)]);

    // Reconnect, user resolves again, this time the server drains.
    armResolve(g, [note(7)], [7]);
    expect(confirmResolve(g)).toBe(true);
    expect(isResolvePending(g)).toBe(false);
  });
});
