/**
 * test-utils.ts - Shared test utilities for tool tests
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vi } from 'vitest';
import type { AgentContext, CoreModule } from '../../types.js';

/**
 * Create a mock AgentContext with a temporary work directory
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