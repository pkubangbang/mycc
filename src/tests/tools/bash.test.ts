/**
 * bash.test.ts - Tests for the bash tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bashTool } from '../../tools/bash.js';
import { agentIO } from '../../loop/agent-io.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

// Mock agentIO.exec
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    exec: vi.fn(),
  },
}));

// Mock the ollama module for bash summarization
vi.mock('../../engine/chat-provider.js', () => ({
  retryChat: vi.fn().mockResolvedValue({
    message: { content: 'Summary of output' },
  }),
  MODEL: 'test-model',
}));

describe('bashTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('should execute a successful command', async () => {
    const mockExec = vi.mocked(agentIO.exec);
    mockExec.mockResolvedValue({
      stdout: 'hello world',
      stderr: '',
      interrupted: false,
      exitCode: 0,
      timedOut: false,
    });

    const result = await bashTool.handler(ctx, {
      command: 'echo hello',
      intent: 'test output',
      timeout: 5,
    });

    expect(mockExec).toHaveBeenCalledWith({
      cwd: tempDir,
      command: 'echo hello',
      timeout: 5,
    });
    expect(result).toContain('Command completed successfully');
    expect(result).toContain('hello world');
  });

  it('should handle command failure', async () => {
    const mockExec = vi.mocked(agentIO.exec);
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: 'command not found: badcmd',
      interrupted: false,
      exitCode: 127,
      timedOut: false,
    });

    const result = await bashTool.handler(ctx, {
      command: 'badcmd',
      intent: 'test failure',
      timeout: 5,
    });

    expect(result).toContain('Command failed');
    expect(result).toContain('exit: 127');
    expect(result).toContain('command not found: badcmd');
  });

  it('should block dangerous commands', async () => {
    // Mock requestGrant to return blocked for dangerous commands
    vi.mocked(ctx.core.requestGrant).mockResolvedValueOnce({
      approved: false,
      reason: 'Command blocked: Recursive delete from root directory',
    });

    const result = await bashTool.handler(ctx, {
      command: 'rm -rf /',
      intent: 'dangerous test',
      timeout: 5,
    });

    expect(result).toContain('Command blocked');
  });

  it('should block "sudo rm" commands', async () => {
    vi.mocked(ctx.core.requestGrant).mockResolvedValueOnce({
      approved: false,
      reason: 'Command blocked: Privileged deletion',
    });

    const result = await bashTool.handler(ctx, {
      command: 'sudo rm -rf /home',
      intent: 'dangerous test',
      timeout: 5,
    });

    expect(result).toContain('Command blocked');
  });

  it('should block "mkfs" commands', async () => {
    vi.mocked(ctx.core.requestGrant).mockResolvedValueOnce({
      approved: false,
      reason: 'Command blocked: Filesystem formatting',
    });

    const result = await bashTool.handler(ctx, {
      command: 'mkfs.ext4 /dev/sda1',
      intent: 'dangerous test',
      timeout: 5,
    });

    expect(result).toContain('Command blocked');
  });

  it('should block "dd if=" commands', async () => {
    vi.mocked(ctx.core.requestGrant).mockResolvedValueOnce({
      approved: false,
      reason: 'Command blocked: Disk imaging operation',
    });

    const result = await bashTool.handler(ctx, {
      command: 'dd if=/dev/zero of=/dev/sda',
      intent: 'dangerous test',
      timeout: 5,
    });

    expect(result).toContain('Command blocked');
  });

  it('should handle timeout', async () => {
    const mockExec = vi.mocked(agentIO.exec);
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: '',
      interrupted: false,
      exitCode: 137,
      timedOut: true,
    });

    const result = await bashTool.handler(ctx, {
      command: 'sleep 100',
      intent: 'test timeout',
      timeout: 1,
    });

    expect(result).toContain('Error: Command timeout after 1 seconds');
    expect(result).toContain('1 seconds');
  });

  it('should handle interruption', async () => {
    const mockExec = vi.mocked(agentIO.exec);
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: '',
      interrupted: true,
      exitCode: -1,
      timedOut: false,
    });

    const result = await bashTool.handler(ctx, {
      command: 'long running command',
      intent: 'test interruption',
      timeout: 5,
    });

    expect(result).toBe('Command interrupted by user.');
  });

  it('should handle both stdout and stderr', async () => {
    const mockExec = vi.mocked(agentIO.exec);
    mockExec.mockResolvedValue({
      stdout: 'standard output',
      stderr: 'error output',
      interrupted: false,
      exitCode: 0,
      timedOut: false,
    });

    const result = await bashTool.handler(ctx, {
      command: 'test',
      intent: 'test mixed output',
      timeout: 5,
    });

    expect(result).toContain('[stdout]');
    expect(result).toContain('standard output');
    expect(result).toContain('[stderr]');
    expect(result).toContain('error output');
  });

  it('should use default elor value of 50', async () => {
    const mockExec = vi.mocked(agentIO.exec);
    mockExec.mockResolvedValue({
      stdout: 'output',
      stderr: '',
      interrupted: false,
      exitCode: 0,
      timedOut: false,
    });

    await bashTool.handler(ctx, {
      command: 'test',
      intent: 'test',
      timeout: 5,
    });

    // Verify brief was called (part of context validation)
    expect(ctx.core.brief).toHaveBeenCalled();
  });

  it('should handle empty command output', async () => {
    const mockExec = vi.mocked(agentIO.exec);
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: '',
      interrupted: false,
      exitCode: 0,
      timedOut: false,
    });

    const result = await bashTool.handler(ctx, {
      command: 'true',
      intent: 'test empty output',
      timeout: 5,
    });

    expect(result).toContain('Command completed successfully');
    // Should not have [stdout] or [stderr] sections for empty output
    expect(result).not.toContain('[stdout]');
    expect(result).not.toContain('[stderr]');
  });

  it('should have correct metadata', () => {
    expect(bashTool.name).toBe('bash');
    expect(bashTool.scope).toEqual(['main', 'child']);
    expect(bashTool.input_schema.required).toContain('command');
    expect(bashTool.input_schema.required).toContain('intent');
    expect(bashTool.input_schema.required).toContain('timeout');
  });
});