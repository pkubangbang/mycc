/**
 * paths-x2.test.ts — Data-driven tests for all 12 x=2 paths.
 *
 * x=2 paths (1 bridge + 1 exit): 3 bridges (T,H,W) × 4 exits (E,X,P,S) = 12.
 * Each path: PROMPT→COLLECT→LLM→HOOK→[bridge]→COLLECT→LLM→HOOK→[exit]→PROMPT.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pathGenerator, type PathSpec } from '../path-generator.js';
import { MockHarness } from '../mock-harness.js';
import { captureLoopEvents, getStateSequence } from '../loop-events-helper.js';
import { ConsoleCapture } from '../console-capture.js';

describe('x=2 parametric paths (12 paths)', () => {
  const specs = pathGenerator.x2();

  it('pathGenerator.x2() returns exactly 12 paths', () => {
    expect(specs).toHaveLength(12);
  });

  it('every x2 path has 2 symbols and starts with PROMPT+COLLECT', () => {
    for (const spec of specs) {
      expect(spec.symbols).toHaveLength(2);
      expect(spec.expectedStates[0]).toBe('prompt');
      expect(spec.expectedStates[1]).toBe('collect');
    }
  });

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
      const { drivePath } = await import('../path-generator.js');
      await drivePath(spec, harness);

      const actualStates = getStateSequence(eventCap.trace);
      expect(actualStates).toEqual(spec.expectedStates);
    });
  });
});