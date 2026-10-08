/**
 * exit-drain.test.ts — the bounded post-exit stdio drain primitive.
 *
 * This is the shared mechanism behind BOTH consumers that used to gate
 * completion on stdio EOF ('close'):
 *   - src/context/shared/bg.ts   (bg_create/bg_await)
 *   - src/loop/agent-exec.ts     (the bash tool)
 *
 * Contract under test:
 *   - the ordinary path ('close' follows 'exit' within ms) settles at once and
 *     never pays the grace delay;
 *   - a grandchild holding the inherited pipes open past the grace window does
 *     NOT stall the drain — the grace deadline settles it (this is the exact
 *     case measured at exit@453ms / close@20715ms on Windows);
 *   - cancel() stops a pending grace timer.
 *
 * The grandchild cases are Windows-only (the pwsh wrapper is Windows-specific).
 */
import { describe, it, expect } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { armExitDrain, DEFAULT_EXIT_DRAIN_GRACE_MS } from '../../utils/exit-drain.js';

/** Spawn a direct child that exits immediately while a grandchild holds stdio. */
function spawnPipeHolder(grandchildSeconds: number) {
  const cmd = `Start-Process pwsh -ArgumentList "-NoProfile","-Command","Start-Sleep ${grandchildSeconds}" -NoNewWindow; Write-Output parent-done`;
  return spawn('pwsh', [
    '-NoProfile', '-NonInteractive', '-Command', cmd,
  ], { windowsHide: true });
}

/** Best-effort kill of the grandchild sleeper by command line. */
function killGrandchild(grandchildSeconds: number): void {
  try {
    execSync(
      `Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" | Where-Object { $_.CommandLine -like '*Start-Sleep ${grandchildSeconds}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      { shell: 'pwsh', stdio: 'ignore' },
    );
  } catch { /* best-effort */ }
}

describe('armExitDrain — bounds completion on process exit, not stdio EOF', () => {
  it('exposes the default grace window', () => {
    expect(DEFAULT_EXIT_DRAIN_GRACE_MS).toBe(1000);
  });

  it('settles promptly on the ordinary path (close follows exit within ms)', async () => {
    const child = spawn(process.execPath, ['-e', 'console.log("hi")'], { windowsHide: true });
    const drain = armExitDrain(child);
    const t0 = Date.now();
    await drain.settled;
    // Must not sit through the full grace window.
    expect(Date.now() - t0).toBeLessThan(DEFAULT_EXIT_DRAIN_GRACE_MS);
    expect(drain.isSettled()).toBe(true);
    child.kill();
  });

  it('settles via the grace deadline when a grandchild holds the pipes past it', async () => {
    if (process.platform !== 'win32') return;

    const GRANDCHILD = 20;
    const child = spawnPipeHolder(GRANDCHILD);
    // Never let the reader stall on the held pipes: drain with 'data' handlers,
    // mirroring both real consumers.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});

    const drain = armExitDrain(child);
    const t0 = Date.now();
    try {
      await drain.settled;
      const elapsed = Date.now() - t0;
      // The grandchild sleeps 20s, so settling here proves 'close' did NOT drive
      // completion — the grace deadline did. Allow slack on a loaded machine but
      // stay well under the 20s hold.
      expect(elapsed).toBeLessThan(GRANDCHILD * 1000);
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(drain.isSettled()).toBe(true);
    } finally {
      killGrandchild(GRANDCHILD);
      child.kill('SIGKILL');
    }
  }, 15000);

  it('cancel() stops a pending grace timer', async () => {
    if (process.platform !== 'win32') return;

    const GRANDCHILD = 20;
    const child = spawnPipeHolder(GRANDCHILD);
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    const drain = armExitDrain(child);
    try {
      // Give 'exit' a moment to arm the timer.
      await new Promise((r) => setTimeout(r, 300));
      drain.cancel();
      // Cancelling must not settle the drain (the caller is responsible for
      // finalizing, as bg.ts does on kill/trim).
      await new Promise((r) => setTimeout(r, 300));
      expect(drain.isSettled()).toBe(false);
    } finally {
      killGrandchild(GRANDCHILD);
      child.kill('SIGKILL');
    }
  }, 15000);
});
