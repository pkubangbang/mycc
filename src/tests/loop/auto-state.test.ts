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
      // force a non-zero streak while in auto
      s.recordLlmSuccess();
      s.setAuto(false);
      expect(s.getStreak()).toBe(0);
    });
  });

  describe('autofly', () => {
    // NOTE: The autofly engagement decision no longer lives in the singleton.
    // recordLlmSuccess() only increments the streak; the PROMPT state handler
    // checks (--debug-autofly && streak >= threshold) and calls setAuto(true).
    // These tests verify the singleton's counter/threshold behavior only;
    // the PROMPT-level engagement is tested in the prompt state tests.

    it('exposes the default threshold (3)', () => {
      const s = new AutoState();
      expect(s.getAutoflyThreshold()).toBe(DEFAULT_AUTOfLY_THRESHOLD);
      expect(s.getAutoflyThreshold()).toBe(3);
    });

    it('recordLlmSuccess() only increments — it does NOT engage auto mode', () => {
      const s = new AutoState();
      s.recordLlmSuccess(); // streak 1
      expect(s.getAuto()).toBe(false);
      s.recordLlmSuccess(); // streak 2
      expect(s.getAuto()).toBe(false);
      s.recordLlmSuccess(); // streak 3 — still off (engagement is PROMPT's job)
      expect(s.getAuto()).toBe(false);
      s.recordLlmSuccess(); // streak 4 — still off
      expect(s.getAuto()).toBe(false);
      expect(s.getStreak()).toBe(4);
    });

    it('does NOT reset the streak after reaching the threshold (counter is pure)', () => {
      const s = new AutoState();
      s.recordLlmSuccess();
      s.recordLlmSuccess();
      s.recordLlmSuccess(); // streak 3 — no engagement, no reset
      expect(s.getAuto()).toBe(false);
      expect(s.getStreak()).toBe(3);
    });

    it('streak keeps growing in auto mode (no re-trigger from the singleton)', () => {
      const s = new AutoState();
      s.setAuto(true); // manual entry
      expect(s.getStreak()).toBe(0);
      s.recordLlmSuccess();
      s.recordLlmSuccess();
      s.recordLlmSuccess();
      expect(s.getAuto()).toBe(true);
      expect(s.getStreak()).toBe(3);
    });

    it('respects a custom threshold via setAutoflyThreshold()', () => {
      const s = new AutoState();
      s.setAutoflyThreshold(5);
      expect(s.getAutoflyThreshold()).toBe(5);

      for (let i = 0; i < 5; i++) s.recordLlmSuccess();
      // streak is 5, but auto is still off — engagement is PROMPT's job
      expect(s.getStreak()).toBe(5);
      expect(s.getAuto()).toBe(false);
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

    it('a resetStreak() mid-count prevents a PROMPT-level autofly trigger', () => {
      const s = new AutoState();
      s.recordLlmSuccess();
      s.recordLlmSuccess(); // streak 2
      s.resetStreak();       // user input arrived
      expect(s.getStreak()).toBe(0);
      s.recordLlmSuccess();  // streak 1
      s.recordLlmSuccess();  // streak 2
      s.recordLlmSuccess();  // streak 3 — PROMPT would compare streak(3) >= threshold(3) → engage
      expect(s.getStreak()).toBe(3);
      expect(s.getAuto()).toBe(false); // engagement is PROMPT's job, not the singleton's
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

    it('does NOT fire when recordLlmSuccess() increments (engagement is PROMPT\'s job)', () => {
      const s = new AutoState();
      const cb = vi.fn();
      s.onAutoChange = cb;

      s.recordLlmSuccess();
      s.recordLlmSuccess();
      s.recordLlmSuccess(); // streak 3 — no engagement from the singleton
      expect(cb).not.toHaveBeenCalled();
      expect(s.getAuto()).toBe(false);
    });

    it('swallows errors thrown by the callback (flag still flips)', () => {
      const s = new AutoState();
      s.onAutoChange = () => { throw new Error('boom'); };
      expect(() => s.setAuto(true)).not.toThrow();
      expect(s.getAuto()).toBe(true);
    });
  });
});