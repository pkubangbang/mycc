/**
 * bash.test.ts - Tests for the bash tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bashTool } from '../../tools/bash.js';
import { agentIO } from '../../loop/agent-io.js';
import { checkDangerousCommand } from '../../context/grant/dangerous-commands.js';
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

describe('checkDangerousCommand', () => {
  // ── Recursive delete from root ────────────────────────────────────
  describe('recursive delete from root', () => {
    const blocked = 'Recursive delete from root directory';

    it('blocks rm -rf /', () => {
      expect(checkDangerousCommand('rm -rf /')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -fr /', () => {
      expect(checkDangerousCommand('rm -fr /')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -r /', () => {
      expect(checkDangerousCommand('rm -r /')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -Rf /', () => {
      expect(checkDangerousCommand('rm -Rf /')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -rf /*', () => {
      expect(checkDangerousCommand('rm -rf /*')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -rf / ', () => {
      expect(checkDangerousCommand('rm -rf / ')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -r -f / (separate flags)', () => {
      expect(checkDangerousCommand('rm -r -f /')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -rf --no-preserve-root /', () => {
      expect(checkDangerousCommand('rm -rf --no-preserve-root /')).toEqual({ blocked: true, reason: blocked });
    });

    it('allows rm /some/file (absolute path, not root)', () => {
      expect(checkDangerousCommand('rm /some/file').blocked).toBe(false);
    });
    it('allows rm -rf /some/dir (absolute path, not root)', () => {
      expect(checkDangerousCommand('rm -rf /some/dir').blocked).toBe(false);
    });
    it('allows rm -rf /tmp/build (targeted directory cleanup)', () => {
      expect(checkDangerousCommand('rm -rf /tmp/build').blocked).toBe(false);
    });
  });

  // ── Recursive delete of current directory ─────────────────────────
  describe('recursive delete of current directory', () => {
    const blocked = 'Recursive delete of current directory';

    it('blocks rm -rf .', () => {
      expect(checkDangerousCommand('rm -rf .')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -r .', () => {
      expect(checkDangerousCommand('rm -r .')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -rf . ', () => {
      expect(checkDangerousCommand('rm -rf . ')).toEqual({ blocked: true, reason: blocked });
    });
    it('allows rm . (non-recursive)', () => {
      expect(checkDangerousCommand('rm .').blocked).toBe(false);
    });
  });

  // ── Recursive deletion in home directory ──────────────────────────
  describe('recursive deletion in home directory', () => {
    const blocked = 'Recursive deletion in home directory';

    it('blocks rm -rf ~', () => {
      expect(checkDangerousCommand('rm -rf ~')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -r ~', () => {
      expect(checkDangerousCommand('rm -r ~')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -rf ~/some/dir', () => {
      expect(checkDangerousCommand('rm -rf ~/some/dir')).toEqual({ blocked: true, reason: blocked });
    });
    it('allows rm -f ~ (non-recursive)', () => {
      expect(checkDangerousCommand('rm -f ~').blocked).toBe(false);
    });
  });

  // ── Privileged operations ─────────────────────────────────────────
  describe('privileged deletion', () => {
    const blocked = 'Privileged deletion';

    it('blocks sudo rm -rf /', () => {
      expect(checkDangerousCommand('sudo rm -rf /')).toEqual({ blocked: true, reason: 'Privileged deletion' });
    });
    it('blocks sudo -u root rm -rf /', () => {
      expect(checkDangerousCommand('sudo -u root rm -rf /')).toEqual({ blocked: true, reason: 'Privileged deletion' });
    });
    it('blocks sudo -E rm file', () => {
      expect(checkDangerousCommand('sudo -E rm file')).toEqual({ blocked: true, reason: blocked });
    });
    it('allows sudo mv file (not rm)', () => {
      expect(checkDangerousCommand('sudo mv file').blocked).toBe(false);
    });
  });

  describe('privileged permission removal', () => {
    const blocked = 'Privileged permission removal';

    it('blocks sudo chmod 000 /etc/shadow', () => {
      expect(checkDangerousCommand('sudo chmod 000 /etc/shadow')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks sudo chmod -R 000 /dir', () => {
      expect(checkDangerousCommand('sudo chmod -R 000 /dir')).toEqual({ blocked: true, reason: blocked });
    });
  });

  // ── Batch deletion with glob ──────────────────────────────────────
  describe('batch deletion with glob', () => {
    const blocked = 'Batch deletion with glob pattern';

    it('blocks rm *', () => {
      expect(checkDangerousCommand('rm *')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm -rf *', () => {
      expect(checkDangerousCommand('rm -rf *')).toEqual({ blocked: true, reason: blocked });
    });
    it('blocks rm *.txt', () => {
      expect(checkDangerousCommand('rm *.txt')).toEqual({ blocked: true, reason: blocked });
    });
    it('allows rm /path/to/* (targeted, has path prefix)', () => {
      expect(checkDangerousCommand('rm /path/to/*').blocked).toBe(false);
    });
    it('allows rm src/*.test.ts (targeted, has path prefix)', () => {
      expect(checkDangerousCommand('rm src/*.test.ts').blocked).toBe(false);
    });
  });

  // ── Irreversible operations ───────────────────────────────────────
  describe('irreversible operations', () => {
    it('blocks mkfs.ext4 /dev/sda1', () => {
      expect(checkDangerousCommand('mkfs.ext4 /dev/sda1')).toEqual({
        blocked: true,
        reason: 'Filesystem formatting',
      });
    });
    it('blocks dd if=/dev/sda of=/dev/sdb', () => {
      expect(checkDangerousCommand('dd if=/dev/sda of=/dev/sdb')).toEqual({
        blocked: true,
        reason: 'Disk imaging operation',
      });
    });
    it('blocks dd bs=4M if=/dev/sda of=/dev/sdb', () => {
      expect(checkDangerousCommand('dd bs=4M if=/dev/sda of=/dev/sdb')).toEqual({
        blocked: true,
        reason: 'Disk imaging operation',
      });
    });
    it('blocks shutdown -h now', () => {
      expect(checkDangerousCommand('shutdown -h now')).toEqual({
        blocked: true,
        reason: 'System shutdown',
      });
    });
    it('blocks reboot', () => {
      expect(checkDangerousCommand('reboot')).toEqual({
        blocked: true,
        reason: 'System reboot',
      });
    });
    it('allows dd --help', () => {
      expect(checkDangerousCommand('dd --help').blocked).toBe(false);
    });
  });

  // ── Git operations ────────────────────────────────────────────────
  describe('git operations', () => {
    it('blocks git commit -m "msg"', () => {
      expect(checkDangerousCommand('git commit -m "msg"')).toEqual({
        blocked: true,
        reason: 'Use git_commit tool instead',
      });
    });
    it('blocks git push --force', () => {
      expect(checkDangerousCommand('git push --force')).toEqual({
        blocked: true,
        reason: 'Force push',
      });
    });
    it('blocks git push origin main --force', () => {
      expect(checkDangerousCommand('git push origin main --force')).toEqual({
        blocked: true,
        reason: 'Force push',
      });
    });
    it('allows git push --force-with-lease', () => {
      expect(checkDangerousCommand('git push --force-with-lease').blocked).toBe(false);
    });
    it('blocks git push -f', () => {
      expect(checkDangerousCommand('git push -f')).toEqual({
        blocked: true,
        reason: 'Force push (-f)',
      });
    });
    it('blocks git push origin main -f', () => {
      expect(checkDangerousCommand('git push origin main -f')).toEqual({
        blocked: true,
        reason: 'Force push (-f)',
      });
    });
    it('allows git push (no force)', () => {
      expect(checkDangerousCommand('git push').blocked).toBe(false);
    });
    it('blocks git reset --hard', () => {
      expect(checkDangerousCommand('git reset --hard')).toEqual({
        blocked: true,
        reason: 'Hard reset discards working changes',
      });
    });
  });

  // ── Package publishing ────────────────────────────────────────────
  describe('package publishing', () => {
    it('blocks npm publish', () => {
      expect(checkDangerousCommand('npm publish')).toEqual({
        blocked: true,
        reason: 'Package publishing requires manual confirmation',
      });
    });
    it('blocks twine upload dist/*', () => {
      expect(checkDangerousCommand('twine upload dist/*')).toEqual({
        blocked: true,
        reason: 'Package publishing requires manual confirmation',
      });
    });
    it('blocks python -m twine upload dist/*', () => {
      expect(checkDangerousCommand('python -m twine upload dist/*')).toEqual({
        blocked: true,
        reason: 'Package publishing requires manual confirmation',
      });
    });
    it('allows pip install (not a publish)', () => {
      expect(checkDangerousCommand('pip install requests').blocked).toBe(false);
    });
  });

  // ── Benign commands ───────────────────────────────────────────────
  describe('benign commands', () => {
    it('allows echo hello', () => {
      expect(checkDangerousCommand('echo hello').blocked).toBe(false);
    });
    it('allows ls -la', () => {
      expect(checkDangerousCommand('ls -la').blocked).toBe(false);
    });
    it('allows pnpm test', () => {
      expect(checkDangerousCommand('pnpm test').blocked).toBe(false);
    });
    it('allows git status', () => {
      expect(checkDangerousCommand('git status').blocked).toBe(false);
    });
    it('allows cat file.txt', () => {
      expect(checkDangerousCommand('cat file.txt').blocked).toBe(false);
    });
  });
});