/**
 * Test for filePath-based condition (replacing isTestFile)
 */

import { describe, it, expect } from 'vitest';
import { testExpression, createMockSequence } from '../hook/condition-validator.js';

describe('filePath-based condition', () => {
  it('should block test files over 300 lines', () => {
    const result = testExpression(
      "call.metadata.filePath.includes('/tests/') && call.metadata.newLoc > 300",
      createMockSequence(),
      {
        metadata: {
          filePath: '/home/student/proj/mycc/src/tests/example.test.ts',
          newLoc: 350,
          existingLoc: 0,
        },
        args: {},
      }
    );

    expect(result.passed).toBe(true);
    expect(result.evaluatedValue).toBe(true);
  });

  it('should not block non-test files', () => {
    const result = testExpression(
      "call.metadata.filePath.includes('/tests/') && call.metadata.newLoc > 300",
      createMockSequence(),
      {
        metadata: {
          filePath: '/home/student/proj/mycc/src/index.ts',
          newLoc: 350,
          existingLoc: 0,
        },
        args: {},
      }
    );

    expect(result.passed).toBe(true);
    expect(result.evaluatedValue).toBe(false);
  });

  it('should not block test files under 300 lines', () => {
    const result = testExpression(
      "call.metadata.filePath.includes('/tests/') && call.metadata.newLoc > 300",
      createMockSequence(),
      {
        metadata: {
          filePath: '/home/student/proj/mycc/src/tests/example.test.ts',
          newLoc: 250,
          existingLoc: 0,
        },
        args: {},
      }
    );

    expect(result.passed).toBe(true);
    expect(result.evaluatedValue).toBe(false);
  });

  it('should handle filePath with different test patterns', () => {
    // Test with .spec. pattern
    const result1 = testExpression(
      "call.metadata.filePath.includes('/tests/') || call.metadata.filePath.includes('.test.')",
      createMockSequence(),
      {
        metadata: { filePath: '/src/utils/helpers.test.ts', newLoc: 100 },
        args: {},
      }
    );

    expect(result1.passed).toBe(true);
    expect(result1.evaluatedValue).toBe(true);

    // Test with .spec. pattern
    const result2 = testExpression(
      "call.metadata.filePath.includes('/tests/') || call.metadata.filePath.includes('.spec.')",
      createMockSequence(),
      {
        metadata: { filePath: '/src/utils/helpers.spec.ts', newLoc: 100 },
        args: {},
      }
    );

    expect(result2.passed).toBe(true);
    expect(result2.evaluatedValue).toBe(true);
  });
});