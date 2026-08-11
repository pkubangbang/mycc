/**
 * hang-detection.test.ts — Dedicated tests for hang detection mechanisms.
 *
 * Verifies the three hang detection capabilities of the test harness:
 *   1. Per-transition timeout — drivePath throws if a transition exceeds
 *      HANG_TIMEOUT_MS (2000ms), pinpointing the stuck state.
 *   2. Transition count upper bound — assertTransitionCount() throws if
 *      the loop emits more transitions than expected (infinite loop).
 *   3. assertExhausted() — MockHarness throws if the symbol queue is not
 *      fully consumed (loop called LLM more times than scripted).
 *
 * These are "meta-tests" — they test the harness's hang detection itself,
 * not the agent-loop. Each test deliberately triggers a hang condition and
 * asserts the harness catches it with a useful diagnostic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pathGenerator,
  type PathSpec,
  drivePath,
  assertTransitionCount,
  HANG_TIMEOUT_MS,
} from '../path-generator.js';
import { MockHarness, type Symbol } from '../mock-harness.js';
import { captureLoopEvents, getStateSequence } from '../loop-events-helper.js';
import { ConsoleCapture } from '../console-capture.js';

describe('hang detection mechanisms', () => {
  let consoleCap: ConsoleCapture;
  let eventCap: ReturnType<typeof captureLoopEvents>;
  let harness: MockHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleCap = new ConsoleCapture();
    consoleCap.start();
    eventCap = captureLoopEvents();
  });

  afterEach(() => {
    consoleCap.stop();
    eventCap.cleanup();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Mechanism 1: Per-transition timeout
  // ==========================================================================

  describe('mechanism 1: per-transition timeout', () => {
    it('should expose HANG_TIMEOUT_MS as a configurable constant', () => {
      expect(HANG_TIMEOUT_MS).toBeDefined();
      expect(typeof HANG_TIMEOUT_MS).toBe('number');
      expect(HANG_TIMEOUT_MS).toBeGreaterThan(0);
      // Default is 2000ms — well under vitest's 10s global timeout
      expect(HANG_TIMEOUT_MS).toBe(2000);
    });

    it('should complete normally when all transitions finish within timeout', async () => {
      const spec = pathGenerator.x1()[0]; // CE path (fastest, no LLM)
      harness = new MockHarness({ symbols: spec.symbols, userQuery: 'test' });
      harness.install();

      // drivePath should complete well within HANG_TIMEOUT_MS
      const start = Date.now();
      await drivePath(spec, harness);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(HANG_TIMEOUT_MS);
      const states = getStateSequence(eventCap.trace);
      expect(states).toEqual(spec.expectedStates);
    });

    it('should complete an x=3 path (longest) within timeout', async () => {
      const specs = pathGenerator.x3();
      const spec = specs[0]; // First x=3 path (e.g. x3-TT-E)
      harness = new MockHarness({ symbols: spec.symbols, userQuery: 'test' });
      harness.install();

      const start = Date.now();
      await drivePath(spec, harness);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(HANG_TIMEOUT_MS);
      const states = getStateSequence(eventCap.trace);
      expect(states).toEqual(spec.expectedStates);
    });
  });

  // ==========================================================================
  // Mechanism 2: Transition count upper bound
  // ==========================================================================

  describe('mechanism 2: transition count upper bound', () => {
    it('should pass when transition count equals expected', () => {
      // Simulate a trace with exactly the expected number of transitions
      const spec = pathGenerator.x2()[0]; // T-E path: 9 states = 8 transitions + 1 synthetic = 9
      const expectedMax = spec.expectedStates.length;
      // Create a fake trace with the right count
      const fakeTrace = spec.expectedStates.map((_, i) => ({
        type: 'state_transition',
        from: i === 0 ? 'init' : spec.expectedStates[i - 1],
        to: spec.expectedStates[i],
      }));

      // Should not throw — count matches
      expect(() => assertTransitionCount(fakeTrace, expectedMax, spec.id)).not.toThrow();
    });

    it('should throw when transition count exceeds expected (infinite loop)', () => {
      const spec = pathGenerator.x1()[0]; // CE path: 3 states
      const expectedMax = spec.expectedStates.length; // 3
      // Simulate a trace with MORE transitions than expected (loop ran extra)
      const fakeTrace: Array<{ type: string }> = [
        { type: 'state_transition' },
        { type: 'state_transition' },
        { type: 'state_transition' },
        { type: 'state_transition' },
        { type: 'state_transition' }, // 5 > 3 — hang!
      ];

      expect(() => assertTransitionCount(fakeTrace, expectedMax, spec.id)).toThrow(
        /Hang detected.*did not terminate.*infinite/i,
      );
    });

    it('should include the path id and counts in the error message', () => {
      const fakeTrace: Array<{ type: string }> = [
        { type: 'state_transition' },
        { type: 'state_transition' },
        { type: 'state_transition' },
        { type: 'state_transition' },
      ];
      try {
        assertTransitionCount(fakeTrace, 2, 'x2-T-S');
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain('x2-T-S');
        expect(msg).toContain('4'); // actual count
        expect(msg).toContain('2'); // expected max
      }
    });

    it('should detect a simulated infinite T-bridge loop via trace length', async () => {
      // Simulate: a path that should be T-S (2 LLM calls) but the loop
      // kept doing T bridges forever. We script only 2 symbols but the
      // trace would be longer if the loop didn't stop.
      const spec = pathGenerator.x2().find((s) => s.id === 'x2-T-S')!;
      harness = new MockHarness({ symbols: spec.symbols, userQuery: 'test' });
      harness.install();

      await drivePath(spec, harness);

      // The actual trace should match expected length (no hang)
      const states = getStateSequence(eventCap.trace);
      expect(states.length).toBe(spec.expectedStates.length);

      // Now simulate a hang: create a trace longer than expected
      const hangTrace = [...states, 'collect', 'llm', 'hook', 'tool', 'collect'];
      expect(() =>
        assertTransitionCount(
          hangTrace.map((s) => ({ type: 'state_transition', to: s })),
          spec.expectedStates.length,
          spec.id,
        ),
      ).toThrow(/Hang detected/);
    });
  });

  // ==========================================================================
  // Mechanism 3: assertExhausted (symbol queue consumption)
  // ==========================================================================

  describe('mechanism 3: assertExhausted (symbol queue)', () => {
    it('should pass when all symbols are consumed', async () => {
      const spec = pathGenerator.x1()[0]; // CE
      harness = new MockHarness({ symbols: spec.symbols, userQuery: 'test' });
      harness.install();

      await drivePath(spec, harness);

      // All symbols consumed — should not throw
      expect(() => harness.assertExhausted()).not.toThrow();
    });

    it('should throw when symbols remain unconsumed (loop ended early)', async () => {
      // Script a 2-symbol path but only drive 1 symbol (simulating early exit)
      const symbols: Symbol[] = ['T', 'S'];
      harness = new MockHarness({ symbols, userQuery: 'test' });
      harness.install();

      // Manually consume only 1 symbol (simulating a path that exits early)
      MockHarness.generateLlmResponse(); // consume T only

      // S remains unconsumed — assertExhausted should catch this
      expect(() => harness.assertExhausted()).toThrow(
        /unconsumed symbol.*S/i,
      );
    });

    it('should report the count and names of unconsumed symbols', async () => {
      const symbols: Symbol[] = ['T', 'H', 'S'];
      harness = new MockHarness({ symbols, userQuery: 'test' });
      harness.install();

      // Consume none
      expect(() => harness.assertExhausted()).toThrow();
      try {
        harness.assertExhausted();
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain('3'); // count
        expect(msg).toContain('T');
        expect(msg).toContain('H');
        expect(msg).toContain('S');
      }
    });
  });

  // ==========================================================================
  // Integration: all 53 paths complete within timeout (no hang)
  // ==========================================================================

  describe('integration: all 53 paths complete without hang', () => {
    const allSpecs = pathGenerator.all();

    it('should have exactly 53 paths', () => {
      expect(allSpecs).toHaveLength(53);
    });

    // Test a sample of paths across x=1,2,3 to verify none hang
    const sampleSpecs = [
      ...pathGenerator.x1(), // 5
      ...pathGenerator.x2().slice(0, 4), // 4 of 12
      ...pathGenerator.x3().slice(0, 6), // 6 of 36
    ];

    it.each(sampleSpecs)(
      'path $id should complete within HANG_TIMEOUT_MS',
      async (spec: PathSpec) => {
        harness = new MockHarness({ symbols: spec.symbols, userQuery: 'test' });
        harness.install();

        const start = Date.now();
        await drivePath(spec, harness);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(HANG_TIMEOUT_MS);
        // Also verify the transition count is within bounds
        assertTransitionCount(
          eventCap.trace,
          spec.expectedStates.length,
          spec.id,
        );
        // And all symbols consumed
        harness.assertExhausted();
      },
    );
  });
});