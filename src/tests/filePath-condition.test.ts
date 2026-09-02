/**
 * Test for filePath-based condition (replacing isTestFile)
 */

import { describe, it, expect } from 'vitest';
import { testExpression, createMockSequence } from '../hook/condition-validator.js';

describe('filePath-based condition', () => {
  it('evaluates true for a test file over 300 lines', () => {
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

  it('evaluates false for a non-test file even over 300 lines', () => {
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

  it('evaluates false for a test file under 300 lines', () => {
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

  it('evaluates false for a test file exactly at the 300-line boundary', () => {
    const result = testExpression(
      "call.metadata.filePath.includes('/tests/') && call.metadata.newLoc > 300",
      createMockSequence(),
      {
        metadata: {
          filePath: '/home/student/proj/mycc/src/tests/example.test.ts',
          newLoc: 300,
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

  it('uses the default mock call context when no callContext is provided', () => {
    // Without an explicit callContext, testExpression falls back to a default
    // mock metadata (filePath '/mock/test.ts', newLoc 100). The condition
    // checks for '/tests/' which the default path does not contain.
    const result = testExpression(
      "call.metadata.filePath.includes('/tests/') && call.metadata.newLoc > 300",
      createMockSequence()
    );

    expect(result.passed).toBe(true);
    expect(result.evaluatedValue).toBe(false);
  });
});