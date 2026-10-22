/**
 * test-utils.ts - Shared test utilities for tool tests
 *
 * This file provides tool-specific test utilities.
 * For comprehensive mocking utilities, use ../test-utils/mock-context.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vi } from 'vitest';
import type { AskResult } from '../../types.js';

// Re-export comprehensive mock utilities
import { createMockContext as createSharedMockContext, type MockContextOptions } from '../test-utils/index.js';

export { createMinimalMockContext } from '../test-utils/index.js';
export { createMockContext as createFullMockContext } from '../test-utils/mock-context.js';

/**
 * Wrap a plain answer string into an AskResult (the shape Core.question()
 * now returns). Use this in tool tests to mock ctx.core.question:
 *   vi.mocked(ctx.core.question).mockResolvedValue(askResult('y'));
 *
 * @param answer - the user's answer string
 * @param source - 'user' (default) or 'auto'
 */
export function askResult(answer: string, source: 'user' | 'auto' = 'user'): AskResult {
  return {
    question: '',
    answer,
    reason: source === 'auto' ? 'auto mode: question auto-replied with onEsc default' : '',
    source,
  };
}

/**
 * AgentContext factory for tool tests.
 *
 * Delegates every module to the shared factories (single source of truth) but
 * keeps one tool-specific default: requestExternalPathAccess DENIES with
 * 'Path escapes workspace'. Tool tests rely on that denial to assert the
 * path-traversal / out-of-workspace guards; the shared default approves so
 * that non-tool suites can exercise the granted path.
 */
export function createMockContext(options: MockContextOptions = {}): ReturnType<typeof createSharedMockContext> {
  return createSharedMockContext({
    ...options,
    core: {
      requestExternalPathAccess: vi.fn(async () => ({
        approved: false,
        resolvedPath: '',
        reason: 'Path escapes workspace',
      })),
      ...options.core,
    },
  });
}

/**
 * Create a temporary directory for testing
 */
export function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-tools-test-'));
}

/**
 * Remove a temporary directory
 */
export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Path traversal patterns for security testing
 */
export const pathTraversalPatterns = [
  '../../../etc/passwd',
  '..%2F..%2F..%2Fetc/passwd',
  '....//....//etc/passwd',
  '..\\..\\..\\windows\\system32',
  '/etc/passwd',
  '/root/.ssh/id_rsa',
];