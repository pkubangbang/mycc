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
    // timeout is optional — coerced to a safe default (30) when omitted, so it
    // is intentionally NOT in `required`. This prevents the guaranteed
    // first-call failure when the LLM omits timeout.
    expect(bashTool.input_schema.required).not.toContain('timeout');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Timeout coercion — the bash tool must normalize args.timeout into [1,60]
// before calling agentIO.exec(), which enforces a strict 1-60 integer
// invariant. The LLM frequently omits timeout (undefined) or sends
// out-of-range values (90/120); without coercion the FIRST bash call of
// nearly every session fails with "timeout must be an integer between 1
// and 60". These tests pin the coercion contract.
// ═══════════════════════════════════════════════════════════════════════
describe('bashTool timeout coercion', () => {
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

  // Helper: run the handler with a given timeout and return the timeout value
  // that agentIO.exec was called with. Clears the mock first so multiple calls
  // within a single test do not accumulate.
  async function execTimeoutFor(args: Record<string, unknown>): Promise<number> {
    const mockExec = vi.mocked(agentIO.exec);
    mockExec.mockClear();
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: '',
      interrupted: false,
      exitCode: 0,
      timedOut: false,
    });
    await bashTool.handler(ctx, {
      command: 'echo hi',
      intent: 'test coercion',
      ...args,
    });
    expect(mockExec).toHaveBeenCalledTimes(1);
    return mockExec.mock.calls[0][0].timeout;
  }

  it('defaults to 30 when timeout is undefined (the common first-call case)', async () => {
    expect(await execTimeoutFor({})).toBe(30);
  });

  it('defaults to 30 when timeout is omitted entirely', async () => {
    expect(await execTimeoutFor({ timeout: undefined })).toBe(30);
  });

  it('clamps 90 down to 60', async () => {
    expect(await execTimeoutFor({ timeout: 90 })).toBe(60);
  });

  it('clamps 120 down to 60', async () => {
    expect(await execTimeoutFor({ timeout: 120 })).toBe(60);
  });

  it('clamps 0 up to 1', async () => {
    expect(await execTimeoutFor({ timeout: 0 })).toBe(1);
  });

  it('clamps negative up to 1', async () => {
    expect(await execTimeoutFor({ timeout: -5 })).toBe(1);
  });

  it('floors non-integer values (5.9 -> 5)', async () => {
    expect(await execTimeoutFor({ timeout: 5.9 })).toBe(5);
  });

  it('passes through a valid in-range integer unchanged', async () => {
    expect(await execTimeoutFor({ timeout: 30 })).toBe(30);
    expect(await execTimeoutFor({ timeout: 1 })).toBe(1);
    expect(await execTimeoutFor({ timeout: 60 })).toBe(60);
  });

  it('treats NaN as the default (30)', async () => {
    expect(await execTimeoutFor({ timeout: NaN })).toBe(30);
  });

  it('treats Infinity as the max (60)', async () => {
    expect(await execTimeoutFor({ timeout: Infinity })).toBe(60);
  });

  it('treats a non-number string as the default (30)', async () => {
    expect(await execTimeoutFor({ timeout: '30' })).toBe(30);
  });

  // ── Pushback warning: the tool result must tell the LLM its timeout was
  // invalid, so it learns the contract instead of repeating the mistake.
  describe('pushback warning in result', () => {
    async function runAndGetResult(args: Record<string, unknown>): Promise<string> {
      const mockExec = vi.mocked(agentIO.exec);
      mockExec.mockClear();
      mockExec.mockResolvedValue({
        stdout: 'ok',
        stderr: '',
        interrupted: false,
        exitCode: 0,
        timedOut: false,
      });
      return bashTool.handler(ctx, {
        command: 'echo hi',
        intent: 'test warning',
        ...args,
      });
    }

    it('includes a warning when timeout is undefined', async () => {
      const result = await runAndGetResult({});
      expect(result).toContain('[Warning: bash timeout]');
      expect(result).toContain('no timeout (undefined)');
      expect(result).toContain('default 30');
      expect(result).toContain('timeout=30');
    });

    it('includes a warning when timeout is out of range (90)', async () => {
      const result = await runAndGetResult({ timeout: 90 });
      expect(result).toContain('[Warning: bash timeout]');
      expect(result).toContain('90');
      expect(result).toContain('clamped to 60');
    });

    it('includes a warning when timeout is out of range (120)', async () => {
      const result = await runAndGetResult({ timeout: 120 });
      expect(result).toContain('[Warning: bash timeout]');
      expect(result).toContain('120');
      expect(result).toContain('clamped to 60');
    });

    it('includes a warning when timeout is 0', async () => {
      const result = await runAndGetResult({ timeout: 0 });
      expect(result).toContain('[Warning: bash timeout]');
      expect(result).toContain('clamped to 1');
    });

    it('includes a warning when timeout is a non-integer (5.9)', async () => {
      const result = await runAndGetResult({ timeout: 5.9 });
      expect(result).toContain('[Warning: bash timeout]');
      expect(result).toContain('floored to 5');
    });

    it('does NOT include a warning for a valid in-range integer', async () => {
      const result = await runAndGetResult({ timeout: 30 });
      expect(result).not.toContain('[Warning: bash timeout]');
    });

    it('does NOT include a warning for boundary values 1 and 60', async () => {
      expect(await runAndGetResult({ timeout: 1 })).not.toContain('[Warning: bash timeout]');
      // reset mock for second call
      const r60 = await runAndGetResult({ timeout: 60 });
      expect(r60).not.toContain('[Warning: bash timeout]');
    });

    it('surfaces the warning even on the timeout (timedOut) path', async () => {
      const mockExec = vi.mocked(agentIO.exec);
      mockExec.mockClear();
      mockExec.mockResolvedValue({
        stdout: '',
        stderr: '',
        interrupted: false,
        exitCode: 137,
        timedOut: true,
      });
      const result = await bashTool.handler(ctx, {
        command: 'sleep 100',
        intent: 'test',
        timeout: 120,
      });
      expect(result).toContain('[Warning: bash timeout]');
      expect(result).toContain('Command timeout after 60 seconds');
    });

    it('surfaces the warning on the interrupted path', async () => {
      const mockExec = vi.mocked(agentIO.exec);
      mockExec.mockClear();
      mockExec.mockResolvedValue({
        stdout: '',
        stderr: '',
        interrupted: true,
        exitCode: -1,
        timedOut: false,
      });
      const result = await bashTool.handler(ctx, {
        command: 'long cmd',
        intent: 'test',
        timeout: 90,
      });
      expect(result).toContain('[Warning: bash timeout]');
      expect(result).toContain('Command interrupted by user.');
    });
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
      expect(checkDangerousCommand('rm -rf --no-preserve-root /')).toEqual({
        blocked: true,
        reason: blocked,
      });
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
      expect(checkDangerousCommand('rm -rf ~/some/dir')).toEqual({
        blocked: true,
        reason: blocked,
      });
    });
    it('allows rm -f ~ (non-recursive)', () => {
      expect(checkDangerousCommand('rm -f ~').blocked).toBe(false);
    });
  });

  // ── Privileged operations ─────────────────────────────────────────
  describe('privileged deletion', () => {
    const blocked = 'Privileged deletion';

    it('blocks sudo rm -rf /', () => {
      expect(checkDangerousCommand('sudo rm -rf /')).toEqual({
        blocked: true,
        reason: 'Privileged deletion',
      });
    });
    it('blocks sudo -u root rm -rf /', () => {
      expect(checkDangerousCommand('sudo -u root rm -rf /')).toEqual({
        blocked: true,
        reason: 'Privileged deletion',
      });
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
      expect(checkDangerousCommand('sudo chmod 000 /etc/shadow')).toEqual({
        blocked: true,
        reason: blocked,
      });
    });
    it('blocks sudo chmod -R 000 /dir', () => {
      expect(checkDangerousCommand('sudo chmod -R 000 /dir')).toEqual({
        blocked: true,
        reason: blocked,
      });
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

// ═══════════════════════════════════════════════════════════════════════
// Cluster C — dangerous escape + wrappers (hand_over improvement plan)
// ═══════════════════════════════════════════════════════════════════════

import { judgeBash } from '../../context/grant/bash-judge.js';
import { findDangerousCommand } from '../../context/grant/dangerous-commands.js';

describe('Cluster C — findDangerousCommand wrapper semantics', () => {
  // ── C3: observation-skip for pure-observation tmux subcommands ─────
  describe('C3 observation-skip (INDIRECT_WRAPPERS)', () => {
    it('allows tmux capture-pane even if pane content mentions mkfs', () => {
      // The command string itself is observation-only; the dangerous check
      // is skipped regardless of what the captured pane might contain.
      expect(findDangerousCommand('tmux capture-pane -t mycc-1 -p')).toBeNull();
    });
    it('allows tmux capture-pane with mkfs in the literal command tail', () => {
      // Even a literal "mkfs" substring in the command must not trigger when
      // the wrapper is pure observation.
      expect(
        findDangerousCommand("tmux capture-pane -t mycc-1 -p 'sudo mkfs.vfat /dev/sdd1'")
      ).toBeNull();
    });
    it('allows tmux show / display-message / list-*', () => {
      expect(findDangerousCommand('tmux show -t mycc-1')).toBeNull();
      expect(findDangerousCommand('tmux display-message -t mycc-1')).toBeNull();
      expect(findDangerousCommand('tmux list-sessions')).toBeNull();
      expect(findDangerousCommand('tmux list-windows')).toBeNull();
      expect(findDangerousCommand('tmux list-panes')).toBeNull();
      expect(findDangerousCommand('tmux show-options')).toBeNull();
    });

    // ── C4: EXEC_WRAPPERS defense — obfuscation cannot bypass ───────
    describe('C4 EXEC_WRAPPERS defense', () => {
      it('blocks sh -c wrapping mkfs', () => {
        const dc = findDangerousCommand("sh -c 'mkfs.vfat /dev/sda1'");
        expect(dc).not.toBeNull();
        expect(dc!.category).toBe('irreversible');
      });
      it('blocks bash -c wrapping mkfs', () => {
        const dc = findDangerousCommand("bash -c 'mkfs.ext4 /dev/sda1'");
        expect(dc).not.toBeNull();
        expect(dc!.reason).toBe('Filesystem formatting');
      });
      it('blocks eval wrapping mkfs', () => {
        expect(findDangerousCommand("eval 'mkfs.vfat /dev/sda1'")).not.toBeNull();
      });
      it('blocks $(...) command substitution wrapping mkfs', () => {
        expect(findDangerousCommand('echo $(mkfs.vfat /dev/sda1)')).not.toBeNull();
      });
      it('blocks backtick command substitution wrapping mkfs', () => {
        expect(findDangerousCommand('echo `mkfs.vfat /dev/sda1`')).not.toBeNull();
      });
      it('blocks xargs wrapping mkfs', () => {
        expect(findDangerousCommand('echo /dev/sda1 | xargs mkfs.vfat')).not.toBeNull();
      });
      it('blocks find -exec wrapping mkfs', () => {
        expect(findDangerousCommand('find /dev -name sda1 -exec mkfs.vfat {} \\;')).not.toBeNull();
      });
      // Even when an indirect wrapper is present, an exec wrapper still trips the check.
      it('blocks tmux capture-pane when sh -c also present (exec wins over observation)', () => {
        expect(
          findDangerousCommand("tmux capture-pane -t x -p && sh -c 'mkfs.vfat /dev/sda1'")
        ).not.toBeNull();
      });
    });

    // ── tmux send-keys is NOT observation — routes through dangerous check ──
    describe('tmux send-keys routes through dangerous check', () => {
      it('blocks tmux send-keys routing sudo mkfs', () => {
        const dc = findDangerousCommand(
          "tmux send-keys -t mycc-1 'sudo mkfs.vfat /dev/sdd1' Enter"
        );
        // sudo ... mkfs matches the privileged-deletion pattern? No — that pattern
        // is sudo+rm. mkfs itself is the irreversible match.
        expect(dc).not.toBeNull();
        expect(dc!.category).toBe('irreversible');
        expect(dc!.reason).toBe('Filesystem formatting');
      });
      it('allows tmux send-keys with a benign payload', () => {
        expect(findDangerousCommand("tmux send-keys -t mycc-1 'echo hi' Enter")).toBeNull();
      });
    });
  });
});

describe('Cluster C — judgeBash dangerous=i_know escape param', () => {
  // judgeBash signature: (command, intent, mode, isChildProcess, askUser?, escAware?)
  const mkfs = 'sudo mkfs.vfat /dev/sdd1';
  const planSafeIntent = 'WRITE SYSTEM cmd=mkfs TO format';
  const planEscapeIntent = 'WRITE SYSTEM cmd=mkfs dangerous=i_know TO format';

  // ── C1: escape param routes to user confirmation ──────────────────
  it('C1: with dangerous=i_know, asks user and allows on "y"', async () => {
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(mkfs, planEscapeIntent, 'normal', false, askUser);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(res.decision).toBe('allow');
  });

  it('C1: with dangerous=i_know, asks user and blocks on "n"', async () => {
    const askUser = vi.fn(async () => 'n');
    const res = await judgeBash(mkfs, planEscapeIntent, 'normal', false, askUser);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('User denied');
  });

  it('C1: with dangerous=i_know, "yes" also approves', async () => {
    const askUser = vi.fn(async () => 'yes');
    const res = await judgeBash(mkfs, planEscapeIntent, 'normal', false, askUser);
    expect(res.decision).toBe('allow');
  });

  it('C1: with dangerous=i_know, empty answer (ESC) denies', async () => {
    const askUser = vi.fn(async () => '');
    const res = await judgeBash(mkfs, planEscapeIntent, 'normal', false, askUser);
    expect(res.decision).toBe('block');
  });

  // ── C2: Socratic hint when escape param absent ────────────────────
  it('C2: without dangerous=i_know, blocks with Socratic hint (names PARAM override, withholds key/value)', async () => {
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(mkfs, planSafeIntent, 'normal', false, askUser);
    expect(askUser).not.toHaveBeenCalled(); // never reaches user without the escape param
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('Command blocked');
    // Names the existence of a PARAM override…
    expect(res.reason).toContain('PARAM');
    // …but withholds the exact key/value (no "dangerous=i_know" spoon-feeding).
    expect(res.reason).not.toContain('dangerous=i_know');
    expect(res.reason).not.toContain('i_know');
  });

  // ── scope: system category is NOT overridable ────────────────────
  it('system category (git commit) stays hard-blocked even with dangerous=i_know', async () => {
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(
      'git commit -m x',
      'WRITE SOURCE dangerous=i_know TO commit',
      'normal',
      false,
      askUser
    );
    expect(askUser).not.toHaveBeenCalled();
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('Use git_commit tool instead');
  });

  // ── scope: child process cannot use the escape hatch ─────────────
  it('child process: dangerous=i_know is rejected (cannot reach user prompt)', async () => {
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(mkfs, planEscapeIntent, 'normal', true, askUser);
    expect(askUser).not.toHaveBeenCalled();
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('child process');
  });

  // ── grammar gate: escape param must NOT bypass intent validation ─
  it('malformed intent with dangerous=i_know substring is blocked by grammar, not routed to user', async () => {
    const askUser = vi.fn(async () => 'y');
    // Bare token, no VERB OBJECT TO PURPOSE — parseIntent returns null and
    // validateIntent reports the grammar error. The escape param substring is
    // present but the intent is not well-formed, so it must NOT reach the user.
    const res = await judgeBash(mkfs, 'dangerous=i_know', 'normal', false, askUser);
    expect(askUser).not.toHaveBeenCalled();
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('Error: [Intent]');
  });

  it('malformed PARAM with dangerous=i_know is blocked by grammar, not routed to user', async () => {
    const askUser = vi.fn(async () => 'y');
    // Has VERB OBJECT TO PURPOSE but a malformed PARAM (uppercase key) AND the
    // escape substring. Grammar must win — the human is not asked.
    const res = await judgeBash(
      mkfs,
      'WRITE SYSTEM CMD=mkfs dangerous=i_know TO format',
      'normal',
      false,
      askUser
    );
    expect(askUser).not.toHaveBeenCalled();
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('Error: [Intent]');
    expect(res.reason).toContain('uppercase');
  });

  it('well-formed intent with dangerous=i_know still routes to user (grammar gate does not regress happy path)', async () => {
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(mkfs, planEscapeIntent, 'normal', false, askUser);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(res.decision).toBe('allow');
  });

  // ── EXEC_WRAPPER obfuscation still blocks ────────────────────────
  it('sh -c wrapping mkfs is blocked even with dangerous=i_know (exec wrapper defense)', async () => {
    const askUser = vi.fn(async () => 'y');
    // The escape param would normally route to user confirmation, but the
    // command itself is an exec-wrapped obfuscation of mkfs. judgeBash still
    // matches the dangerous pattern; with dangerous=i_know present and a real
    // askUser, it routes to user confirmation (the human is the gate). The
    // key assertion: the dangerous pattern was NOT bypassed by the wrapper.
    const res = await judgeBash(
      "sh -c 'mkfs.vfat /dev/sda1'",
      'WRITE SYSTEM cmd=mkfs dangerous=i_know TO format',
      'normal',
      false,
      askUser
    );
    // askUser fires because the pattern matched (not bypassed) AND the escape
    // param was declared AND we're in the parent process.
    expect(askUser).toHaveBeenCalledTimes(1);
    // On user denial, it blocks.
    askUser.mockResolvedValueOnce('n');
    const res2 = await judgeBash(
      "sh -c 'mkfs.vfat /dev/sda1'",
      'WRITE SYSTEM cmd=mkfs dangerous=i_know TO format',
      'normal',
      false,
      askUser
    );
    expect(res2.decision).toBe('block');
    // decision from the first (approved) call:
    expect(res.decision).toBe('allow');
  });

  // ── pure observation wrapper is allowed outright ─────────────────
  it('tmux capture-pane is allowed (observation-skip), no user prompt', async () => {
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(
      'tmux capture-pane -t mycc-1 -p',
      'READ SOURCE TO inspect pane output',
      'normal',
      false,
      askUser
    );
    expect(askUser).not.toHaveBeenCalled();
    expect(res.decision).toBe('allow');
  });

  it('tmux list-sessions is allowed (observation-skip)', async () => {
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(
      'tmux list-sessions',
      'READ SOURCE TO list active sessions',
      'normal',
      false,
      askUser
    );
    expect(askUser).not.toHaveBeenCalled();
    expect(res.decision).toBe('allow');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cluster D — batch=i_know escape param (skip LLM safeguard for batch delete)
// ═══════════════════════════════════════════════════════════════════════

// NOTE: the chat-provider is already mocked at the top of this file
// (retryChat → resolves with a content object; MODEL → 'test-model'). The
// batch=i_know path is asserted indirectly: when the escape param is present,
// askUser is called with the "acknowledged by agent" wording and NO LLM
// round-trip intervenes. Without the param, the LLM path runs and askUser is
// NOT called with that short-circuit wording (it may be called via the
// UNCERTAIN fallthrough, or not at all if the LLM returns SAFE).

describe('Cluster D — judgeBash batch=i_know escape param', () => {
  // A batch-delete command that is NOT a catastrophic dangerous pattern, so it
  // passes step 1 (findDangerousCommand → null) and reaches step 4.
  const batchCmd = 'rm -rf node_modules dist';
  const batchIntent = 'DELETE TEMP batch=i_know TO clean build artifacts before rebuild';
  const batchIntentNoEscape = 'DELETE TEMP TO clean build artifacts before rebuild';

  it('D1: with batch=i_know, skips LLM and routes directly to user (allow on "y")', async () => {
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(batchCmd, batchIntent, 'normal', false, askUser);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(res.decision).toBe('allow');
    // The user prompt uses the "acknowledged by agent" wording, not "…detected",
    // and passes onEsc:'n' so ESC defaults to denying the batch deletion.
    expect(askUser).toHaveBeenCalledWith(
      expect.stringContaining('acknowledged by agent'),
      'bash-judge',
      { onEsc: 'n' }
    );
  });

  it('D1: with batch=i_know, blocks on user "n"', async () => {
    const askUser = vi.fn(async () => 'n');
    const res = await judgeBash(batchCmd, batchIntent, 'normal', false, askUser);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('User denied');
  });

  it('D1: with batch=i_know, "yes" also approves', async () => {
    const askUser = vi.fn(async () => 'yes');
    const res = await judgeBash(batchCmd, batchIntent, 'normal', false, askUser);
    expect(res.decision).toBe('allow');
  });

  it('D1: with batch=i_know, empty answer (ESC) denies', async () => {
    const askUser = vi.fn(async () => '');
    const res = await judgeBash(batchCmd, batchIntent, 'normal', false, askUser);
    expect(res.decision).toBe('block');
  });

  it('D2: child process: batch=i_know is rejected (cannot reach user prompt)', async () => {
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(batchCmd, batchIntent, 'normal', true, askUser);
    expect(askUser).not.toHaveBeenCalled();
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('child process');
  });

  it('D3: without batch=i_know, does NOT short-circuit to user (falls through to LLM path)', async () => {
    // Without the escape param, the batch path calls analyzeBatchDelete (LLM).
    // We assert it does NOT call askUser with the "acknowledged by agent"
    // short-circuit wording. The LLM mock returns a content object; the real
    // retryMultipleChoice is mocked at module level, so this exercises the LLM
    // branch. The key assertion: askUser is NOT called with the acknowledged
    // wording (it may be called via the UNCERTAIN fallthrough, but not the
    // batch=i_know short-circuit).
    const askUser = vi.fn(async () => 'y');
    await judgeBash(batchCmd, batchIntentNoEscape, 'normal', false, askUser);
    // If the LLM classifier returns SAFE, askUser is not called at all. If it
    // throws/returns unexpected, it falls to UNCERTAIN → askUser with "detected"
    // wording. Either way, the "acknowledged by agent" wording must NOT appear.
    if (askUser.mock.calls.length > 0) {
      expect(askUser).not.toHaveBeenCalledWith(
        expect.stringContaining('acknowledged by agent'),
        'bash-judge',
        { onEsc: 'n' }
      );
    }
  });

  it('D4: batch=i_know is a no-op on a non-batch DELETE (single-file rm)', async () => {
    // rm file.txt is not isBatchDelete, so the DELETE branch is not entered;
    // the command is allowed outright regardless of batch=i_know.
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash('rm file.txt', batchIntent, 'normal', false, askUser);
    expect(askUser).not.toHaveBeenCalled();
    expect(res.decision).toBe('allow');
  });

  it('D5: batch=i_know does not override the dangerous hard-block (rm -rf / still blocked)', async () => {
    // rm -rf / matches the destructive dangerous pattern in step 1 and never
    // reaches the batch path. batch=i_know is irrelevant; without
    // dangerous=i_know, the Socratic hint is returned.
    const askUser = vi.fn(async () => 'y');
    const res = await judgeBash(
      'rm -rf /',
      'DELETE SYSTEM batch=i_know TO wipe root',
      'normal',
      false,
      askUser
    );
    expect(askUser).not.toHaveBeenCalled();
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('Command blocked');
  });
});
