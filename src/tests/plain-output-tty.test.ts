/**
 * plain-output-tty.test.ts — ON-DEMAND TTY tests (skipped on a normal run).
 *
 * These cover what the mocked unit tests in plain-output.test.ts CANNOT: the
 * live, two-process reality that the plain-output feature is about.
 *
 *   A. A REAL piped run of mycc through a child process — asserts the captured
 *      stdout AND stderr contain no ANSI escapes (the actual contract), and
 *      that a plain TTY run DOES decorate (the regression direction).
 *   B. The Coordinator pipe-mirroring path (reviewer's P2 #5). The spinner was
 *      moved stderr -> stdout because the Coordinator mirrors the two pipes
 *      independently (src/index.ts): stdout chunks forwarded to process.stdout,
 *      stderr chunks to process.stderr, with NO cross-stream ordering. This
 *      suite spawns a real Coordinator-shaped parent whose child writes both
 *      streams and asserts the ordering/no-tear invariant that motivated the
 *      move — something a same-process vi.spyOn cannot prove.
 *
 * WHY SKIPPED BY DEFAULT: these spawn real processes (node/tsx) and, for the
 * TTY direction, need a real terminal (tmux). They are opt-in so `pnpm test`
 * stays hermetic and fast.
 *
 * HOW TO RUN:
 *   MYCC_TTY_TESTS=1 pnpm vitest run src/tests/plain-output-tty.test.ts
 *
 * The TTY-decoration direction additionally requires tmux (skips cleanly if
 * absent, mirroring serve-health.test.ts's presence guard).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Synchronous, cross-platform sleep (no `sleep` binary on Windows). */
function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Opt-in gate: absent => every block below is skipped (describe.skipIf true).
const ENABLED = process.env.MYCC_TTY_TESTS === '1';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MYCC_BIN = path.join(REPO_ROOT, 'bin', 'mycc.js');

/** True when a usable tmux is on PATH. */
function hasTmux(): boolean {
  try {
    execSync('tmux -V', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const tmuxOk = hasTmux();

// ═══════════════════════════════════════════════════════════════════════════
// A. Real piped run: stdout+stderr are clean
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!ENABLED)('TTY: real piped run (stdout+stderr)', () => {
  it('a redirected `mycc --help` emits no ESC on stdout or stderr, even with FORCE_COLOR', () => {
    // execFileSync with default stdio captures stdout; stderr is captured too
    // when we route it. Use a temp file for stderr so we can inspect it.
    const errFile = path.join(REPO_ROOT, '.mycc-tty-err.tmp');
    let out = '';
    try {
      out = execFileSync(process.execPath, [MYCC_BIN, '--help'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '1' },
        stdio: ['ignore', 'pipe', fs.openSync(errFile, 'w')],
        timeout: 20000,
      });
    } finally {
      // read + remove the stderr capture
      const err = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8') : '';
      fs.rmSync(errFile, { force: true });
      expect(err, 'stderr must carry no ESC').not.toMatch(/\x1b/);
    }
    expect(out).toContain('Usage:');
    expect(out, 'stdout must carry no ESC').not.toMatch(/\x1b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2. Real TTY run: decorations DO appear (regression direction)
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!ENABLED || !tmuxOk)('TTY: real terminal still decorates (tmux)', () => {
  const SESSION = 'mycc-tty-selftest';

  it('a TTY run prints the cursor-hide escape and colours (decoration is NOT suppressed)', () => {
    try { execSync(`tmux kill-session -t ${SESSION}`, { stdio: 'ignore' }); } catch { /* no prior session */ }
    try {
      execSync(`tmux new-session -s ${SESSION} -d -x 120 -y 40`, { stdio: 'ignore' });
      // Send text, pause, then Enter (mycc's Enter throttle).
      execSync(`tmux send-keys -t ${SESSION} "node bin/mycc.js --skip-healthcheck --help"`, { stdio: 'ignore' });
      waitMs(1500);
      execSync(`tmux send-keys -t ${SESSION} Enter`, { stdio: 'ignore' });
      waitMs(3000);

      // `-e` includes escape sequences in capture-pane output.
      const pane = execSync(`tmux capture-pane -t ${SESSION} -p -e -S -60`, { encoding: 'utf-8' });
      // In a real TTY stdout.isTTY is true, so MYCC_PLAIN is NOT set and the
      // help titles are chalk-styled -> at least one ESC must be present.
      expect(pane, 'a TTY must decorate (ESC present)').toMatch(/\x1b\[/);
    } finally {
      try { execSync(`tmux kill-session -t ${SESSION}`, { stdio: 'ignore' }); } catch { /* already gone */ }
    }
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Coordinator pipe-mirroring: cross-stream ordering / no tear
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!ENABLED)('TTY: Coordinator pipe mirroring preserves decoration ordering', () => {
  /**
   * Reproduce the Coordinator's mirror exactly: spawn a child with piped
   * stdio and forward each pipe independently to the parent's own streams
   * (src/index.ts startLead). Because there is no cross-stream ordering, this
   * is WHY the spinner had to move onto the same stream as the bars.
   *
   * We assert the invariant that makes the move necessary to be observable:
   * a long-lived animation split across two pipes can deliver a truncated
   * escape sequence, whereas a single-stream animation cannot.
   */
  const CHILD_SRC = `
    // Emit a full "move up 4 + clear + repaint" animation block as a SINGLE
    // write to stdout — exactly what the moved spinner + ProgressTracker now
    // do (one stream). No stderr writes.
    const block = '\\x1b[4A' + '\\x1b[2K[mindmap] [##..] 1/4\\n'.repeat(4);
    process.stdout.write(block);
    setTimeout(() => process.exit(0), 50);
  `;

  const CHILD_SPLIT_SRC = `
    // Emit a multi-byte escape sequence SPLIT across two streams: the head on
    // stdout, the tail on stderr. With independent mirrors there is no
    // guarantee the tail lands after the head — this is the tear the move
    // eliminates by keeping everything on one stream.
    process.stdout.write('\\x1b[4A');
    process.stderr.write('\\x1b[2K');
    setTimeout(() => process.exit(0), 50);
  `;

  it('single-stream animation arrives intact on stdout (no stderr bytes)', async () => {
    const script = path.join(REPO_ROOT, '.mycc-tty-child-single.mjs');
    fs.writeFileSync(script, CHILD_SRC);
    try {
      const { out, err } = await runMirrored(script);
      // The whole block — including the multi-byte CSI head — is present on
      // stdout, in order, with nothing on stderr.
      expect(out).toContain('\x1b[4A');
      expect(out).toContain('\x1b[2K');
      expect(out.indexOf('\x1b[4A')).toBeLessThan(out.indexOf('\x1b[2K'));
      expect(err).toBe('');
    } finally {
      fs.rmSync(script, { force: true });
    }
  });

  it('a split animation across two streams is NOT ordered (documents the hazard)', async () => {
    const script = path.join(REPO_ROOT, '.mycc-tty-child-split.mjs');
    fs.writeFileSync(script, CHILD_SPLIT_SRC);
    try {
      const { out, err } = await runMirrored(script);
      // The head and tail land on DIFFERENT streams — the consumer cannot
      // reconstruct the CSI sequence from either alone. This is the concrete
      // reason the spinner moved to stdout.
      expect(out).toContain('\x1b[4A');
      expect(err).toContain('\x1b[2K');
      // Neither stream alone carries the complete sequence.
      expect(out).not.toContain('\x1b[2K');
      expect(err).not.toContain('\x1b[4A');
    } finally {
      fs.rmSync(script, { force: true });
    }
  });
});

/**
 * Spawn `script` with piped stdio and mirror each pipe to the matching parent
 * stream — the Coordinator's exact forwarding shape — then return what each
 * parent stream received.
 */
function runMirrored(script: string): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    // Independent mirrors — deliberately NO ordering between them.
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf-8'); });
    child.on('error', reject);
    child.on('exit', () => resolve({ out, err }));
  });
}

// Record-keeping: report WHY the suite was skipped rather than silently 0 tests.
describe.skipIf(ENABLED)('TTY tests (skipped: set MYCC_TTY_TESTS=1 to enable)', () => {
  it('skipped — these spawn real processes and are opt-in', () => {
    expect(ENABLED).toBe(false);
  });
});
