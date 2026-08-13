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
import type { AgentContext, CoreModule, AskResult } from '../../types.js';

// Re-export comprehensive mock utilities
export { createMockContext as createFullMockContext, createMinimalMockContext } from '../test-utils/mock-context.js';

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
    readPictureCached: vi.fn(),
    requestGrant: vi.fn(async () => ({ approved: true })),
    requestExternalPathAccess: vi.fn(async () => ({ approved: false, resolvedPath: '', reason: 'Path escapes workspace' })),
    addExternalAutoGrant: vi.fn(),
    getMode: vi.fn(() => 'normal' as const),
    // Auto mode is lead-only; default false so existing tests that hit the
    // denied branch keep returning "Commit cancelled by user". Individual
    // tests override getAuto via vi.mocked(ctx.core.getAuto).mockReturnValue(true).
    getAuto: vi.fn(() => false),
    setAuto: vi.fn(),
    getMindmap: vi.fn(() => null),
    setMindmap: vi.fn(),
    getConfusionIndex: vi.fn(() => 0),
    increaseConfusionIndex: vi.fn(),
    resetConfusionIndex: vi.fn(),
    escAware: (vi.fn() as unknown) as CoreModule['escAware'],
  };

  return {
    core,
    todo: {
      createTodo: vi.fn(),
    } as never,
    mail: {} as never,
    skill: {} as never,
    issue: {} as never,
    bg: {
      runCommand: vi.fn(),
      getOutput: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      awaitExit: vi.fn(),
    } as never,
    wt: {} as never,
    team: {} as never,
    wiki: {} as never,
    peer: {
      listIdentities: vi.fn(() => []),
      isFresh: vi.fn(() => false),
      listChannels: vi.fn(() => []),
      joinChannel: vi.fn(() => ({ joined: false })),
      sendMail: vi.fn(() => false),
      sendPeerMail: vi.fn(() => false),
      hasActiveChannel: vi.fn(() => false),
      start: vi.fn(),
      stop: vi.fn(),
      getSelfSessionId: vi.fn(() => ''),
      recordBrief: vi.fn(),
      getBriefs: vi.fn(() => []),
      getLatestHeartbeat: vi.fn(() => null),
      setOnChannelJoin: vi.fn(),
    } as never,
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