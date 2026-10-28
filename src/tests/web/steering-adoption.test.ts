/**
 * steering-adoption.test.ts - the ONE rule that replaces the boomerang guard
 *
 * The user-reported symptom was "a consumed steering note shows in the buffer
 * again". Every resurrection path in the old delta protocol came from the
 * client having to GUESS what a payload-less `steer-flush` meant. The queue is
 * now a revisioned snapshot and the client has exactly one rule:
 *
 *   adopt a snapshot iff `revision > adopted`,
 *   keep review entries whose id is still in the snapshot,
 *   derive the bar as (queue − review).
 *
 * These tests pin those three clauses, plus the two behavioural contracts they
 * must not break: the ESC "继续…" card survives while the note is queued, and a
 * new serve process (revision restarting at 1) does not freeze the bar.
 *
 * Uses a real Pinia instance so the store's reactive projections are exercised
 * exactly as in the browser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useChatStore } from '../../web/src/stores/chat-store.js';

const note = (id: number, text = `n${id}`) => ({ id, text });

describe('chat-store — steering snapshot adoption', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('a newer revision is adopted into the queue and derived into the bar', () => {
    const store = useChatStore();
    expect(store.adoptSteering(1, [note(1), note(2)])).toBe(true);
    expect(store.steeringRevision).toBe(1);
    expect(store.steeringQueue.map((n) => n.id)).toEqual([1, 2]);
    expect(store.steeringBuffer.map((n) => n.id)).toEqual([1, 2]);
    expect(store.pendingSteeringReview).toEqual([]);
  });

  it('a STALE revision is rejected — the /history-in-flight bug', () => {
    const store = useChatStore();
    store.adoptSteering(7, [note(1)]);
    // A /history response snapshotted before the resolve lands afterwards.
    expect(store.adoptSteering(6, [note(1), note(2)])).toBe(false);
    expect(store.steeringRevision).toBe(7);
    expect(store.steeringQueue.map((n) => n.id)).toEqual([1]);
  });

  it('an EQUAL revision is a no-op (idempotent replay of the same snapshot)', () => {
    const store = useChatStore();
    store.adoptSteering(4, [note(1)]);
    expect(store.adoptSteering(4, [note(1), note(2)])).toBe(false);
    expect(store.steeringQueue.map((n) => n.id)).toEqual([1]);
  });

  it('review is pruned to live ids — a drained note leaves the card (guard-free confirmation)', () => {
    const store = useChatStore();
    store.adoptSteering(1, [note(1), note(2)]);
    store.populateSteeringReview();
    expect(store.pendingSteeringReview.map((n) => n.id)).toEqual([1, 2]);
    expect(store.steeringBuffer).toEqual([]);

    // The server drained both (resolve or COLLECT consumption) — rev 2, empty.
    store.adoptSteering(2, []);
    expect(store.pendingSteeringReview).toEqual([]);
    expect(store.steeringBuffer).toEqual([]);

    // ...and a late, older snapshot carrying id 1 again cannot resurrect it.
    expect(store.adoptSteering(1, [note(1)])).toBe(false);
    expect(store.pendingSteeringReview).toEqual([]);
    expect(store.steeringBuffer).toEqual([]);
  });

  it('the ESC contract holds: a note still queued keeps its card', () => {
    const store = useChatStore();
    store.adoptSteering(1, [note(1), note(2)]);
    store.populateSteeringReview();
    // ESC kept both notes queued (stop.ts:72-81); the next snapshot still holds
    // them, so the review card must survive the adoption untouched.
    store.adoptSteering(2, [note(1), note(2)]);
    expect(store.pendingSteeringReview.map((n) => n.id)).toEqual([1, 2]);
    // The agent then consumes id 1 only.
    store.adoptSteering(3, [note(2)]);
    expect(store.pendingSteeringReview.map((n) => n.id)).toEqual([2]);
    expect(store.steeringBuffer).toEqual([]);
  });

  it('a partial discard leaves the remainder in review and the bar stays consistent', () => {
    const store = useChatStore();
    store.adoptSteering(1, [note(1), note(2)]);
    store.populateSteeringReview();
    // The user discarded id 1 and sent id 2: the server drains the whole queue.
    store.adoptSteering(2, []);
    expect(store.pendingSteeringReview).toEqual([]);
    expect(store.steeringBuffer).toEqual([]);
    // A brand-new note later appears as a chip, not a card.
    store.adoptSteering(3, [note(3)]);
    expect(store.steeringBuffer.map((n) => n.id)).toEqual([3]);
    expect(store.pendingSteeringReview).toEqual([]);
  });

  it('populateSteeringReview is idempotent (reconnect re-sends `prompt`)', () => {
    const store = useChatStore();
    store.adoptSteering(1, [note(1)]);
    store.populateSteeringReview();
    store.populateSteeringReview();
    expect(store.pendingSteeringReview.map((n) => n.id)).toEqual([1]);
  });

  it('auto mode abandons review — notes stay chips in the bar', () => {
    const store = useChatStore();
    store.adoptSteering(1, [note(1)]);
    store.setAutoMode(true);
    store.populateSteeringReview();
    expect(store.pendingSteeringReview).toEqual([]);
    expect(store.steeringBuffer.map((n) => n.id)).toEqual([1]);
  });

  it('resetSteering lets a NEW serve process (revision restarts at 1) be adopted', () => {
    const store = useChatStore();
    store.adoptSteering(9, [note(1)]);
    store.populateSteeringReview();
    // A new process numbers its queue from 1; without the reset every snapshot
    // would look stale and the bar would freeze empty forever.
    store.resetSteering();
    expect(store.steeringRevision).toBe(-1);
    expect(store.adoptSteering(1, [note(5)])).toBe(true);
    expect(store.steeringBuffer.map((n) => n.id)).toEqual([5]);
    expect(store.pendingSteeringReview).toEqual([]);
  });

  it('buffer and review partition the queue — no duplicate id renders twice', () => {
    const store = useChatStore();
    store.adoptSteering(1, [note(1), note(2)]);
    store.populateSteeringReview();
    store.adoptSteering(2, [note(1), note(2), note(3)]);
    const ids = [...store.steeringBuffer, ...store.pendingSteeringReview].map((n) => n.id).sort();
    expect(ids).toEqual([1, 2, 3]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
