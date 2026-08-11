/**
 * paths-x1.test.ts — Data-driven tests for all 5 x=1 paths.
 *
 * x=1 paths (single LLM call or zero-LLM exit):
 *   CE — COLLECT→PROMPT (zero-LLM exit)
 *   E  — LLM→PROMPT (ESC/error in LLM)
 *   X  — HOOK→PROMPT (HOOK catch error)
 *   P  — HOOK→TOOL→PROMPT (ESC during tool)
 *   S  — HOOK→STOP→PROMPT (all-done)
 *
 * Each test creates a MockHarness from the path's symbols, installs mocks,
 * drives the path via drivePath(), and asserts the state_transition trace
 * matches the mechanically-derived expectedStates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pathGenerator, type PathSpec } from '../path-generator.js';
import { MockHarness } from '../mock-harness.js';
import { captureLoopEvents, getStateSequence } from '../loop-events-helper.js';
import { ConsoleCapture } from '../console-capture.js';

describe('x=1 parametric paths (5 paths)', () => {
  const specs = pathGenerator.x1();

  // Verify the generator produced exactly 5 paths
  it('pathGenerator.x1() returns exactly 5 paths', () => {
    expect(specs).toHaveLength(5);
  });

  // Verify each expectedStates is mechanically derived
  it('every x1 path has non-empty expectedStates starting with PROMPT+COLLECT', () => {
    for (const spec of specs) {
      expect(spec.expectedStates.length).toBeGreaterThan(1);
      expect(spec.expectedStates[0]).toBe('prompt');
      expect(spec.expectedStates[1]).toBe('collect');
    }
  });

  // Data-driven: one test per path
  describe.each(specs)('path: $id', (spec: PathSpec) => {
    let consoleCap: ConsoleCapture;
    let eventCap: ReturnType<typeof captureLoopEvents>;
    let harness: MockHarness;

    beforeEach(() => {
      vi.clearAllMocks();
      consoleCap = new ConsoleCapture();
      consoleCap.start();
      eventCap = captureLoopEvents();
      harness = new MockHarness({
        symbols: spec.symbols,
        userQuery: 'test query',
      });
      harness.install();
    });

    afterEach(() => {
      consoleCap.stop();
      eventCap.cleanup();
      vi.restoreAllMocks();
    });

    it(`should match expected state sequence (${spec.description})`, async () => {
      // drivePath is imported dynamically AFTER MockHarness.install()
      const { drivePath } = await import('../path-generator.js');
      await drivePath(spec, harness);

      const actualStates = getStateSequence(eventCap.trace);
      expect(actualStates).toEqual(spec.expectedStates);
    });
  });
});