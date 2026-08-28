import { describe, it, expect } from 'vitest';
import { runExec } from '../../loop/agent-exec.js';

/**
 * Regression tests for runExec() timeout behavior.
 *
 * Background (code-review 2026-08-28-1336-agent-loop-state-machine 弱点3):
 * runExec's timeout branch previously resolved with `stdout: '', stderr: ''`,
 * discarding any output the subprocess had already written before the
 * timeout. Commit 6b61410 fixed the timeout branch to flush the ReplayBuffer
 * (`stdoutBuffer.getString()` / `stderrBuffer.getString()`), consistent with
 * the ESC (onNeglected) and close paths. These tests guard that fix: a
 * subprocess that writes output and then exceeds the timeout must surface
 * the partial output, not empty strings.
 *
 * runExec uses the startup-detected shell (shell-detect.ts). The command
 * below works under both pwsh7 (Windows default here) and bash/zsh:
 *   - `node -e "<script>"` is a native exe the shell launches directly.
 *   - The script writes "partial-stdout" to stdout and "partial-stderr" to
 *     stderr, then blocks for 30s (well past the 1s timeout).
 */
describe('runExec timeout — partial output preservation', () => {
  it('preserves stdout/stderr written before the timeout (not empty strings)', async () => {
    // Write a marker to each stream, then block far past the timeout.
    const script =
      "process.stdout.write('partial-stdout');" +
      "process.stderr.write('partial-stderr');" +
      "setTimeout(()=>{}, 30000);";
    // Quote for the shell: double quotes around the -e arg. The script uses
    // single quotes internally, so double-quote wrapping is safe under both
    // pwsh and bash.
    const command = `node -e "${script}"`;

    const result = await runExec(
      { cwd: process.cwd(), command, timeout: 1 },
      () => {},
    );

    // The fix: timeout must surface partial output, not discard it.
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('partial-stdout');
    expect(result.stderr).toContain('partial-stderr');
    // Pre-fix, stdout/stderr were '' — explicitly guard against regression.
    expect(result.stdout).not.toBe('');
  });

  it('reports timedOut=true and exitCode=137 on timeout', async () => {
    // A command that produces no output and just blocks.
    const command = `node -e "setTimeout(()=>{}, 30000)"`;
    const result = await runExec(
      { cwd: process.cwd(), command, timeout: 1 },
      () => {},
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(137);
    expect(result.interrupted).toBe(false);
  });
});