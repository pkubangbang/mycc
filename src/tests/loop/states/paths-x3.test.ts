/**
 * paths-x3.test.ts — Data-driven tests for all 36 x=3 paths.
 *
 * x=3 paths (2 bridges + 1 exit): 3² bridges × 4 exits = 36.
 * Each path: PROMPT→COLLECT→LLM→HOOK→[bridge1]→COLLECT→LLM→HOOK→[bridge2]→COLLECT→LLM→HOOK→[exit]→PROMPT.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pathGenerator, type PathSpec } from '../path-generator.js';
import { MockHarness } from '../mock-harness.js';
import { captureLoopEvents, getStateSequence } from '../loop-events-helper.js';
import { ConsoleCapture } from '../console-capture.js';

describe('x=3 parametric paths (36 paths)', () => {
  const specs = pathGenerator.x3();

  it('pathGenerator.x3() returns exactly 36 paths', () => {
    expect(specs).toHaveLength(36);
  });

  it('every x3 path has 3 symbols and starts with PROMPT+COLLECT', () => {
    for (const spec of specs) {
      expect(spec.symbols).toHaveLength(3);
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