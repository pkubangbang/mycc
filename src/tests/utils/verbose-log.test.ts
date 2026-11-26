/**
 * verbose-log.test.ts - Regression tests for the tee's failure latch
 *
 * Background: the 2026-11-26 orphan spin (PID 290457, one core for 2h24m,
 * SIGKILL-only) was a SYNCHRONOUS write loop feeding a dead stdio socketpair,
 * with the resulting error swallowed by a handler that wrote again. The tee in
 * this module is the one synchronous writer on the boot path (`fs.writeSync`
 * per chunk), so it must never re-attempt a write to an fd it has seen fail: a
 * dead log fd stays dead for the life of the process, and retrying it in a sync
 * loop is exactly the shape that starves the event loop.
 *
 * The failure is induced for REAL, not mocked: `Date.now` is pinned so the log
 * filename is predictable, that file is pre-created as a symlink to `/dev/full`
 * (which accepts open() but fails every write with ENOSPC), and the tee then
 * genuinely cannot write. This exercises the real `fs.writeSync` failure path —
 * the same class as a closed fd or a full disk — and lets us assert the latch by
 * counting the bytes that actually reach the log.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Pinned wall clock so the log filename `verbose-lead-<ts>.log` is known. */
const FIXED_MS = 1_800_000_000_000;
const FIXED_TS = Math.floor(FIXED_MS / 1000);

/**
 * The module keeps `installed` at module scope and install is once-per-process,
 * so each test re-imports a fresh copy via vi.resetModules().
 */
async function freshInstall(cwd: string) {
  vi.resetModules();
  const mod = await import('../../utils/verbose-log.js');
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    return { mod, logPath: mod.installVerboseLog('lead') };
  } finally {
    process.chdir(prevCwd);
  }
}

/** Size of the real log file, or null when it is not a regular file. */
function logSize(logPath: string): number | null {
  try {
    return fs.statSync(logPath).size;
  } catch {
    return null;
  }
}

describe('installVerboseLog — failure latch (no sync write spin)', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-verbose-'));
    fs.mkdirSync(path.join(tmpDir, '.mycc'), { recursive: true });
    logPath = path.join(tmpDir, '.mycc', `verbose-lead-${FIXED_TS}.log`);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('latches on the first failed write and never retries (no sync spin)', async () => {
    // A real, permanent write failure: open() succeeds, every write ENOSPCs.
    fs.symlinkSync('/dev/full', logPath);

    const { logPath: installed } = await freshInstall(tmpDir);
    expect(installed).toBe(logPath);
    // Nothing can land: /dev/full discards nothing and accepts no bytes.
    expect(logSize(logPath)).not.toBeNull();

    // Drive the tee hard. Before the fix each of these lines attempted one
    // fs.writeSync on the dead fd, forever — the spin. With the latch, the
    // work after the first failure is zero.
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) process.stdout.write(`chunk ${i}\n`);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

    // 2000 failing sync writes take far longer than a latched pass; the bound
    // is generous (this asserts "no per-line syscall", not a microbenchmark).
    expect(elapsedMs).toBeLessThan(500);
  });

  it('emits the failure warning exactly once', async () => {
    fs.symlinkSync('/dev/full', logPath);
    const messages: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      messages.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const { logPath: installed } = await freshInstall(tmpDir);
    expect(installed).toBe(logPath);

    for (let i = 0; i < 50; i++) process.stderr.write(`line ${i}\n`);

    const warnings = messages.filter((m) => m.includes('[verbose-log] Write to'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('logging disabled');
  });

  it('still forwards the chunk to the real stream when logging fails', async () => {
    fs.symlinkSync('/dev/full', logPath);
    const { logPath: installed } = await freshInstall(tmpDir);
    expect(installed).toBe(logPath);

    const realWrite = vi.spyOn(process.stdout, 'write');
    process.stdout.write('must still reach the terminal\n');

    const forwarded = realWrite.mock.calls.some((call) => String(call[0]).includes('must still reach the terminal'));
    expect(forwarded).toBe(true);
  });

  it('does write to a healthy log (guards against a false-positive latch)', async () => {
    const { logPath: installed } = await freshInstall(tmpDir);
    expect(installed).toBe(logPath);

    process.stdout.write('a line that should be logged\n');

    expect(fs.readFileSync(logPath, 'utf-8')).toContain('a line that should be logged');
  });

  it('is a no-op on a second install (one tee per process)', async () => {
    const { mod, logPath: installed } = await freshInstall(tmpDir);
    expect(installed).toBe(logPath);
    expect(mod.installVerboseLog('lead')).toBeNull();
    expect(mod.installVerboseLog('coordinator')).toBeNull();
  });
});
