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
import type { AgentContext, CoreModule } from '../../types.js';

// Re-export comprehensive mock utilities
export { createMockContext as createFullMockContext, createMinimalMockContext } from '../test-utils/mock-context.js';

/**
 * Create a minimal mock AgentContext with a temporary work directory
 * For full mock context with all modules, use createFullMockContext from mock-context.ts
 */
export function createMockContext(workdir: string): AgentContext {
  const core: CoreModule = {
    getWorkDir: () => workdir,
    setWorkDir: vi.fn(),
    getName: () => 'test-agent',
    brief: vi.fn(),
    verbose: vi.fn(),
    question: vi.fn(),
    webSearch: vi.fn(),
    webFetch: vi.fn(),
    imgDescribe: vi.fn(),
    requestGrant: vi.fn(async () => ({ approved: true })),
    getMode: vi.fn(() => 'normal' as const),
    getMindmap: vi.fn(() => null),
    setMindmap: vi.fn(),
    getConfusionIndex: vi.fn(() => 0),
    increaseConfusionIndex: vi.fn(),
    resetConfusionIndex: vi.fn(),
  };

  return {
    core,
    todo: {} as never,
    mail: {} as never,
    skill: {} as never,
    issue: {} as never,
    bg: {} as never,
    wt: {} as never,
    team: {} as never,
    wiki: {} as never,
  };
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