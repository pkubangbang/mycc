/**
 * Tests for auto-state.ts - the AutoState singleton (auto flag, streak,
 * autofly threshold, onAutoChange callback).
 *
 * Each test instantiates a fresh `AutoState` (the exported `autoState` is a
 * shared module-level singleton used in production; tests use the class
 * directly for isolation).
 */
import { describe, it, expect, vi } from 'vitest';
import { AutoState, DEFAULT_AUTOfLY_THRESHOLD } from '../../loop/auto-state.js';

describe('AutoState', () => {
  describe('auto flag', () => {
    it('defaults to auto off', () => {
      const s = new AutoState();
      expect(s.getAuto()).toBe(false);
    });

    it('setAuto(true) turns auto on', () => {
      const s = new AutoState();
      s.setAuto(true);
      expect(s.getAuto()).toBe(true);
    });

    it('setAuto(false) turns auto off', () => {
      const s = new AutoState();
      s.setAuto(true);
      s.setAuto(false);
      expect(s.getAuto()).toBe(false);
    });

    it('setAuto is idempotent — no-op on unchanged value', () => {
      const s = new AutoState();
      const cb = vi.fn();
      s.onAutoChange = cb;
      s.setAuto(true);
      s.setAuto(true); // unchanged — should NOT fire callback again
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('streak', () => {
    it('defaults to 0', () => {
      const s = new AutoState();
      expect(s.getStreak()).toBe(0);
    });

    it('recordLlmSuccess() increments the streak', () => {
      const s = new AutoState();
      s.recordLlmSuccess();
      expect(s.getStreak()).toBe(1);
      s.recordLlmSuccess();
      expect(s.getStreak()).toBe(2);
    });

    it('resetStreak() sets the streak back to 0', () => {
      const s = new AutoState();
      s.recordLlmSuccess();
      s.recordLlmSuccess();
      expect(s.getStreak()).toBe(2);
      s.resetStreak();
      expect(s.getStreak()).toBe(0);
    });

    it('setAuto(false) resets the streak to 0', () => {
      const s = new AutoState();
      s.recordLlmSuccess();
      s.recordLlmSuccess();
      s.setAuto(true);
      // streak may have been reset by autofly; force a non-zero streak while in auto
      s.recordLlmSuccess();
      s.setAuto(false);
      expect(s.getStreak()).toBe(0);
    });
  });

  describe('autofly', () => {
    it('engages auto mode when streak reaches the default threshold (3)', () => {
      const s = new AutoState();
      expect(s.getAutoflyThreshold()).toBe(DEFAULT_AUTOfLY_THRESHOLD);
      expect(s.getAutoflyThreshold()).toBe(3);

      s.recordLlmSuccess(); // streak 1
      expect(s.getAuto()).toBe(false);
      s.recordLlmSuccess(); // streak 2
      expect(s.getAuto()).toBe(false);
      s.recordLlmSuccess(); // streak 3 → autofly
      expect(s.getAuto()).toBe(true);
    });

    it('resets the streak after autofly engages (next cycle starts fresh)', () => {
      const s = new AutoState();
      s.recordLlmSuccess();
      s.recordLlmSuccess();
      s.recordLlmSuccess(); // autofly engages
      expect(s.getAuto()).toBe(true);
      expect(s.getStreak()).toBe(0);
    });

    it('does NOT autofly when already in auto mode', () => {
      const s = new AutoState();
      s.setAuto(true); // manual entry
      expect(s.getStreak()).toBe(0);
      // recordLlmSuccess while already in auto just increments; no re-trigger
      s.recordLlmSuccess();
      s.recordLlmSuccess();
      s.recordLlmSuccess();
      expect(s.getAuto()).toBe(true);
      // streak keeps growing (autofly only fires when !auto)
      expect(s.getStreak()).toBe(3);
    });

    it('respects a custom threshold via setAutoflyThreshold()', () => {
      const s = new AutoState();
      s.setAutoflyThreshold(5);
      expect(s.getAutoflyThreshold()).toBe(5);

      for (let i = 0; i < 4; i++) s.recordLlmSuccess();
      expect(s.getAuto()).toBe(false);
      s.recordLlmSuccess(); // 5th → autofly
      expect(s.getAuto()).toBe(true);
    });

    it('setAutoflyThreshold clamps to a minimum of 1', () => {
      const s = new AutoState();
      s.setAutoflyThreshold(0);
      expect(s.getAutoflyThreshold()).toBe(1);
      s.setAutoflyThreshold(-3);
      expect(s.getAutoflyThreshold()).toBe(1);
    });

    it('setAutoflyThreshold floors fractional values', () => {
      const s = new AutoState();
      s.setAutoflyThreshold(2.9);
      expect(s.getAutoflyThreshold()).toBe(2);
    });

    it('a resetStreak() mid-count prevents an early autofly', () => {
      const s = new AutoState();
      s.recordLlmSuccess();
      s.recordLlmSuccess(); // streak 2
      s.resetStreak();       // user input arrived
      expect(s.getStreak()).toBe(0);
      s.recordLlmSuccess();  // streak 1 — not enough
      s.recordLlmSuccess();  // streak 2 — not enough
      expect(s.getAuto()).toBe(false);
      s.recordLlmSuccess();  // streak 3 → autofly
      expect(s.getAuto()).toBe(true);
    });
  });

  describe('onAutoChange callback', () => {
    it('fires once when auto flips true→false→true', () => {
      const s = new AutoState();
      const cb = vi.fn();
      s.onAutoChange = cb;

      s.setAuto(true);
      s.setAuto(false);
      s.setAuto(true);

      expect(cb).toHaveBeenCalledTimes(3);
      expect(cb).toHaveBeenNthCalledWith(1, true);
      expect(cb).toHaveBeenNthCalledWith(2, false);
      expect(cb).toHaveBeenNthCalledWith(3, true);
    });

    it('does NOT fire on an unchanged setAuto (idempotent)', () => {
      const s = new AutoState();
      const cb = vi.fn();
      s.onAutoChange = cb;

      s.setAuto(false); // already false
      expect(cb).not.toHaveBeenCalled();
    });

    it('fires when autofly engages via recordLlmSuccess()', () => {
      const s = new AutoState();
      const cb = vi.fn();
      s.onAutoChange = cb;

      s.recordLlmSuccess();
      s.recordLlmSuccess();
      expect(cb).not.toHaveBeenCalled();
      s.recordLlmSuccess(); // autofly → setAuto(true) → callback
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(true);
    });

    it('swallows errors thrown by the callback (flag still flips)', () => {
      const s = new AutoState();
      s.onAutoChange = () => { throw new Error('boom'); };
      expect(() => s.setAuto(true)).not.toThrow();
      expect(s.getAuto()).toBe(true);
    });
  });
});