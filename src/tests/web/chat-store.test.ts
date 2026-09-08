/**
 * chat-store.test.ts - L2 unit tests for the Pinia chat store
 *
 * Verifies the store's invariants directly:
 *  - The 6-phase enum is the single source of truth.
 *  - Derived getters (`isWaiting` / `isRunning` / `hasPendingCard` / `hasReview`)
 *    are correct projections of `phase` (and `pendingSteeringReview` for
 *    `hasReview`) and can NEVER reach an invalid combination.
 *  - `isAutoMode` is an orthogonal boolean (NOT derived from `phase === 'await'`).
 *  - `setPhase` / `setAutoMode` are the single mutation surface; `setAutoMode(true)`
 *    abandons pending steering review.
 *
 * Uses a real Pinia instance (`setActivePinia(createPinia())`) so the store's
 * reactivity (computed getters over reactive refs) is exercised exactly as in
 * the browser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useChatStore } from '../../web/src/stores/chat-store.js';
import type { WebuiPhase } from '../../web/src/types.js';

describe('chat-store — source of truth', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('initial phase is idle', () => {
    const store = useChatStore();
    expect(store.phase).toBe('idle');
  });

  it('setPhase transitions the phase', () => {
    const store = useChatStore();
    const phases: WebuiPhase[] = ['idle', 'submitted', 'working', 'prompt', 'card', 'await'];
    for (const p of phases) {
      store.setPhase(p);
      expect(store.phase).toBe(p);
    }
  });
});

describe('chat-store — derived getters (can never be invalid)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('isWaiting is true only for prompt and card', () => {
    const store = useChatStore();
    const waiting: WebuiPhase[] = ['prompt', 'card'];
    const notWaiting: WebuiPhase[] = ['idle', 'submitted', 'working', 'await'];
    for (const p of waiting) {
      store.setPhase(p);
      expect(store.isWaiting, `phase=${p}`).toBe(true);
    }
    for (const p of notWaiting) {
      store.setPhase(p);
      expect(store.isWaiting, `phase=${p}`).toBe(false);
    }
  });

  it('isRunning is true for working and submitted (send→running gap)', () => {
    const store = useChatStore();
    const running: WebuiPhase[] = ['working', 'submitted'];
    const notRunning: WebuiPhase[] = ['idle', 'prompt', 'card', 'await'];
    for (const p of running) {
      store.setPhase(p);
      expect(store.isRunning, `phase=${p}`).toBe(true);
    }
    for (const p of notRunning) {
      store.setPhase(p);
      expect(store.isRunning, `phase=${p}`).toBe(false);
    }
  });

  it('hasPendingCard is true only for card', () => {
    const store = useChatStore();
    const notCard: WebuiPhase[] = ['idle', 'submitted', 'working', 'prompt', 'await'];
    store.setPhase('card');
    expect(store.hasPendingCard).toBe(true);
    for (const p of notCard) {
      store.setPhase(p);
      expect(store.hasPendingCard, `phase=${p}`).toBe(false);
    }
  });

  it('hasReview tracks pendingSteeringReview.length > 0', () => {
    const store = useChatStore();
    expect(store.hasReview).toBe(false);
    store.pendingSteeringReview.push({ id: 1, text: 'note' });
    expect(store.hasReview).toBe(true);
    store.pendingSteeringReview.splice(0);
    expect(store.hasReview).toBe(false);
  });
});

describe('chat-store — isAutoMode is orthogonal (NOT derived from phase)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('isAutoMode defaults false regardless of phase', () => {
    const store = useChatStore();
    expect(store.isAutoMode).toBe(false);
    store.setPhase('await');
    expect(store.isAutoMode).toBe(false); // await does NOT imply auto
  });

  it('working-in-auto and working-in-manual are the same phase', () => {
    const store = useChatStore();
    store.setPhase('working');
    store.setAutoMode(false);
    expect(store.phase).toBe('working');
    expect(store.isAutoMode).toBe(false);
    store.setAutoMode(true);
    expect(store.phase).toBe('working'); // phase unchanged
    expect(store.isAutoMode).toBe(true);
  });

  it('setAutoMode(true) abandons pending steering review', () => {
    const store = useChatStore();
    store.pendingSteeringReview.push({ id: 1, text: 'note A' });
    store.pendingSteeringReview.push({ id: 2, text: 'note B' });
    expect(store.hasReview).toBe(true);
    store.setAutoMode(true);
    expect(store.isAutoMode).toBe(true);
    expect(store.pendingSteeringReview).toEqual([]);
    expect(store.hasReview).toBe(false);
  });

  it('setAutoMode(false) does NOT clear pending steering review', () => {
    const store = useChatStore();
    store.pendingSteeringReview.push({ id: 1, text: 'note A' });
    store.setAutoMode(false);
    expect(store.pendingSteeringReview).toHaveLength(1);
    expect(store.hasReview).toBe(true);
  });
});

describe('chat-store — no invalid flag combinations are reachable', () => {
  // The 4 loose flags had 16 combinations, only 6 valid. With phase as source
  // of truth, the derived flags are projections — the 10 invalid combinations
  // are structurally impossible. This test enumerates all 6 phases and asserts
  // the derived flags match the canonical valid table from the design doc.
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('every phase yields exactly its canonical (isWaiting, isRunning, hasPendingCard) tuple', () => {
    const store = useChatStore();
    // phase:      (isWaiting, isRunning, hasPendingCard)
    const expected: Record<WebuiPhase, [boolean, boolean, boolean]> = {
      idle: [false, false, false],
      submitted: [false, true, false],
      working: [false, true, false],
      prompt: [true, false, false],
      card: [true, false, true],
      await: [false, false, false],
    };
    for (const p of Object.keys(expected) as WebuiPhase[]) {
      store.setPhase(p);
      const [w, r, c] = expected[p];
      expect(store.isWaiting, `phase=${p} isWaiting`).toBe(w);
      expect(store.isRunning, `phase=${p} isRunning`).toBe(r);
      expect(store.hasPendingCard, `phase=${p} hasPendingCard`).toBe(c);
    }
  });
});