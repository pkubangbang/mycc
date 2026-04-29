/**
 * core.test.ts - Tests for the mode and grant system
 *
 * Tests the mode system (plan/normal) and requestGrant functionality
 * for both parent and child contexts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Core } from '../../context/parent/core.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Mock agentIO for parent Core
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    ask: vi.fn(),
  },
}));

// Mock ollama for web search/fetch
vi.mock('../../ollama.js', () => ({
  ollama: {
    webSearch: vi.fn(),
    webFetch: vi.fn(),
    chat: vi.fn(),
  },
  retryWithBackoff: vi.fn(async (fn) => fn()),
}));

// Mock config
vi.mock('../../config.js', () => ({
  isVerbose: vi.fn(() => false),
  getVisionModel: vi.fn(() => 'test-vision-model'),
  isVisionEnabled: vi.fn(() => false),
}));

// Mock ipc-helpers for ChildCore tests - use factory that returns mock functions
vi.mock('../../context/child/ipc-helpers.js', () => ({
  ipc: {
    sendRequest: vi.fn().mockResolvedValue({ approved: true }),
    sendNotification: vi.fn(),
  },
  sendStatus: vi.fn(),
}));

// Import ChildCore AFTER mocking ipc-helpers
import { ChildCore } from '../../context/child/core.js';
import { ipc } from '../../context/child/ipc-helpers.js';

// ============================================================================
// Parent Core Tests - Mode System
// ============================================================================

describe('Core (Parent) - Mode System', () => {
  let core: Core;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-core-test-'));
    core = new Core(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('Mode State', () => {
    it('should start in normal mode by default', () => {
      expect(core.getMode()).toBe('normal');
    });

    it('should change mode to plan', () => {
      core.setMode('plan');
      expect(core.getMode()).toBe('plan');
    });

    it('should change mode back to normal', () => {
      core.setMode('plan');
      core.setMode('normal');
      expect(core.getMode()).toBe('normal');
    });
  });

  describe('requestGrant in normal mode', () => {
    it('should approve grants in normal mode', async () => {
      // Ensure we're in normal mode
      core.setMode('normal');

      const result = await core.requestGrant('write_file', { path: '/test/file.ts' });

      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should approve edit_file grants in normal mode', async () => {
      core.setMode('normal');

      const result = await core.requestGrant('edit_file', { path: '/test/file.ts' });

      expect(result.approved).toBe(true);
    });

    it('should approve bash grants in normal mode', async () => {
      core.setMode('normal');

      const result = await core.requestGrant('bash', { command: 'echo test' });

      expect(result.approved).toBe(true);
    });
  });

  describe('requestGrant in plan mode', () => {
    it('should reject all grants in plan mode', async () => {
      core.setMode('plan');

      const result = await core.requestGrant('write_file', { path: '/test/file.ts' });

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('plan mode');
    });

    it('should reject edit_file grants in plan mode', async () => {
      core.setMode('plan');

      const result = await core.requestGrant('edit_file', { path: '/test/file.ts' });

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('plan mode');
    });

    it('should reject bash grants in plan mode', async () => {
      core.setMode('plan');

      const result = await core.requestGrant('bash', { command: 'echo test' });

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('plan mode');
    });
  });
});

// ============================================================================
// Parent Core Tests - requestGrant Method Signature
// ============================================================================

describe('Core (Parent) - requestGrant Method', () => {
  let core: Core;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-core-test-'));
    core = new Core(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should have requestGrant method on Core', () => {
    expect(core.requestGrant).toBeDefined();
    expect(typeof core.requestGrant).toBe('function');
  });

  it('should accept write_file tool with path', async () => {
    core.setMode('normal');

    const result = await core.requestGrant('write_file', { path: '/test/file.ts' });

    expect(result).toHaveProperty('approved');
    expect(typeof result.approved).toBe('boolean');
  });

  it('should accept edit_file tool with path', async () => {
    core.setMode('normal');

    const result = await core.requestGrant('edit_file', { path: '/test/file.ts' });

    expect(result).toHaveProperty('approved');
    expect(typeof result.approved).toBe('boolean');
  });

  it('should accept bash tool with command', async () => {
    core.setMode('normal');

    const result = await core.requestGrant('bash', { command: 'ls -la' });

    expect(result).toHaveProperty('approved');
    expect(typeof result.approved).toBe('boolean');
  });

  it('should return reason when rejected', async () => {
    core.setMode('plan');

    const result = await core.requestGrant('write_file', { path: '/test/file.ts' });

    expect(result.approved).toBe(false);
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe('string');
  });
});

// ============================================================================
// Child Core Tests - requestGrant IPC
// ============================================================================

describe('ChildCore - requestGrant Method', () => {
  let childCore: ChildCore;
  const mockSendRequest = vi.mocked(ipc.sendRequest);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendRequest.mockResolvedValue({ approved: true });
    childCore = new ChildCore('test-child', '/test/workdir');
  });

  it('should have requestGrant method on ChildCore', () => {
    expect(childCore.requestGrant).toBeDefined();
    expect(typeof childCore.requestGrant).toBe('function');
  });

  it('should send IPC request for write_file grant', async () => {
    // This test documents the expected behavior
    await childCore.requestGrant('write_file', { path: '/test/file.ts' });
    
    expect(mockSendRequest).toHaveBeenCalledWith(
      'grant_request',
      expect.objectContaining({ tool: 'write_file', path: '/test/file.ts' }),
      expect.any(Number)
    );
  });

  it('should send IPC request for bash grant', async () => {
    mockSendRequest.mockResolvedValue({ approved: true, reason: undefined });
    
    await childCore.requestGrant('bash', { command: 'echo test' });
    
    expect(mockSendRequest).toHaveBeenCalledWith(
      'grant_request',
      expect.objectContaining({ tool: 'bash', command: 'echo test' }),
      expect.any(Number)
    );
  });

  it('should return the IPC response', async () => {
    mockSendRequest.mockResolvedValue({ approved: false, reason: 'Plan mode' });
    
    const result = await childCore.requestGrant('write_file', { path: '/test/file.ts' });
    
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Plan mode');
  });
});

// ============================================================================
// Grant Evaluator Tests (for parent process)
// ============================================================================

describe('Grant Evaluator', () => {
  // These tests will use the evaluateGrant function once implemented
  // For now, they document the expected behavior

  describe('Plan Mode', () => {
    it('should reject all grants in plan mode', async () => {
      // When evaluateGrant is implemented:
      // const result = await evaluateGrant('test-child', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'write_file',
      //   path: '/test/file.ts',
      // }, core);
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('plan mode');
    });
  });

  describe('Worktree Ownership', () => {
    it('should auto-grant for files in owned worktree', async () => {
      // When evaluateGrant is implemented with worktree support:
      // - Create a worktree owned by 'test-child'
      // - Request grant for file inside that worktree
      // - Expect approved: true
    });

    it('should reject files outside worktree', async () => {
      // When evaluateGrant is implemented:
      // - Create a worktree owned by 'test-child'
      // - Request grant for file outside that worktree
      // - Expect approved: false with reason
    });
  });

  describe('Bash Command Restrictions', () => {
    it('should block dangerous commands (rm -rf /)', async () => {
      // When evaluateGrant is implemented:
      // const result = await evaluateGrant('test-child', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'rm -rf /',
      // }, core);
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('Dangerous');
    });

    it('should block sudo rm commands', async () => {
      // Similar test for 'sudo rm -rf /something'
    });

    it('should block mkfs commands', async () => {
      // Similar test for 'mkfs.ext4 /dev/sda'
    });

    it('should block dd if= commands', async () => {
      // Similar test for 'dd if=/dev/zero of=/dev/sda'
    });

    it('should block git commit (must use git_commit tool)', async () => {
      // When evaluateGrant is implemented:
      // const result = await evaluateGrant('test-child', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'git commit -m "test"',
      // }, core);
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('git_commit tool');
    });
  });
});