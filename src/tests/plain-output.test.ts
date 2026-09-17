/**
 * plain-output.test.ts — the "plain output" (no-TTY) suppression contract.
 *
 * The problem this file guards: when a program pipes mycc's stdout (e.g.
 * `mycc | grep …` or `mycc > out.txt`), the in-place terminal decorations
 * (spinner, progress bars, title escapes, colour) must NOT be emitted, or
 * they corrupt the captured stream with ANSI escapes and carriage-return
 * rewrites.
 *
 * Why the verdict lives in the Coordinator: the Lead never owns a TTY. The
 * Coordinator spawns it with piped stdio (`src/index.ts` startLead,
 * `stdio: ['pipe','pipe','pipe','ipc']`), so inside the Lead
 * `process.stdout.isTTY` is ALWAYS falsy. Any in-Lead isTTY gate is therefore
 * permanently false and silently disables the feature it guards (the bug
 * behind commit 999a463, "render /wiki rebuild progress bar unconditionally").
 * The Coordinator — the only process owning the real terminal — derives the
 * verdict from `process.stdout.isTTY` alone and publishes it as MYCC_PLAIN.
 *
 * Covered here:
 *   1. isPlainOutput() predicate resolution (MYCC_PLAIN vs MYCC_DEBUG_ANSI).
 *   2. ctx.core.isPlainOutput() relays the SAME verdict (the tool-facing path;
 *      tools must read it via ctx, never from config directly).
 *   3. startSpinner() writes NOTHING to stderr and its frames land on stdout
 *      (pins the stream move — a spinner on stderr could interleave with a
 *      progress bar on stdout inside one escape sequence).
 *   4. startSpinner() is a no-op in plain mode; the RebuildProgressBar too.
 *   5. Drift guards: the verdict is derived from stdout.isTTY ONLY; no tool
 *      imports config.isPlainOutput directly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// agentIO is imported by chat-helpers at module load; stub it so the spinner
// tests do not touch the real I/O singleton.
vi.mock('../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), brief: vi.fn() },
}));

import { isPlainOutput } from '../config.js';
import { startSpinner, stopSpinner } from '../engine/chat-helpers.js';
import { beginProgressDisplay, endProgressDisplay, ProgressTracker } from '../mindmap/compile-utils.js';
import { BaseCore } from '../context/shared/base-core.js';

/** Concrete BaseCore subclass so we can instantiate the abstract class. */
class TestCore extends BaseCore {}

describe('isPlainOutput() predicate resolution', () => {
  const saved = { MYCC_PLAIN: process.env.MYCC_PLAIN, MYCC_DEBUG_ANSI: process.env.MYCC_DEBUG_ANSI };

  afterEach(() => {
    if (saved.MYCC_PLAIN === undefined) delete process.env.MYCC_PLAIN;
    else process.env.MYCC_PLAIN = saved.MYCC_PLAIN;
    if (saved.MYCC_DEBUG_ANSI === undefined) delete process.env.MYCC_DEBUG_ANSI;
    else process.env.MYCC_DEBUG_ANSI = saved.MYCC_DEBUG_ANSI;
  });

  it('is false when neither flag is set (decorated output)', () => {
    delete process.env.MYCC_PLAIN;
    delete process.env.MYCC_DEBUG_ANSI;
    expect(isPlainOutput()).toBe(false);
  });

  it('is true when MYCC_PLAIN is "1" (Coordinator detected a non-TTY stdout)', () => {
    delete process.env.MYCC_DEBUG_ANSI;
    process.env.MYCC_PLAIN = '1';
    expect(isPlainOutput()).toBe(true);
  });

  it('is true when MYCC_DEBUG_ANSI is "true" (user forced the plain path)', () => {
    delete process.env.MYCC_PLAIN;
    process.env.MYCC_DEBUG_ANSI = 'true';
    expect(isPlainOutput()).toBe(true);
  });

  it('does not treat a bare/other MYCC_PLAIN value as plain', () => {
    delete process.env.MYCC_DEBUG_ANSI;
    process.env.MYCC_PLAIN = '0';
    expect(isPlainOutput()).toBe(false);
  });
});

describe('ctx.core.isPlainOutput() relays the verdict (tool-facing path)', () => {
  const saved = { MYCC_PLAIN: process.env.MYCC_PLAIN, MYCC_DEBUG_ANSI: process.env.MYCC_DEBUG_ANSI };

  afterEach(() => {
    if (saved.MYCC_PLAIN === undefined) delete process.env.MYCC_PLAIN;
    else process.env.MYCC_PLAIN = saved.MYCC_PLAIN;
    if (saved.MYCC_DEBUG_ANSI === undefined) delete process.env.MYCC_DEBUG_ANSI;
    else process.env.MYCC_DEBUG_ANSI = saved.MYCC_DEBUG_ANSI;
  });

  it('agrees with the config predicate when decorated', () => {
    delete process.env.MYCC_PLAIN;
    delete process.env.MYCC_DEBUG_ANSI;
    expect(new TestCore('/tmp').isPlainOutput()).toBe(false);
  });

  it('agrees with the config predicate when MYCC_PLAIN is set', () => {
    process.env.MYCC_PLAIN = '1';
    delete process.env.MYCC_DEBUG_ANSI;
    expect(new TestCore('/tmp').isPlainOutput()).toBe(true);
  });

  it('agrees with the config predicate when MYCC_DEBUG_ANSI is set', () => {
    process.env.MYCC_DEBUG_ANSI = 'true';
    delete process.env.MYCC_PLAIN;
    expect(new TestCore('/tmp').isPlainOutput()).toBe(true);
  });
});

describe('startSpinner() stream + suppression', () => {
  const saved = { MYCC_PLAIN: process.env.MYCC_PLAIN, MYCC_DEBUG_ANSI: process.env.MYCC_DEBUG_ANSI };

  afterEach(() => {
    stopSpinner();
    if (saved.MYCC_PLAIN === undefined) delete process.env.MYCC_PLAIN;
    else process.env.MYCC_PLAIN = saved.MYCC_PLAIN;
    if (saved.MYCC_DEBUG_ANSI === undefined) delete process.env.MYCC_DEBUG_ANSI;
    else process.env.MYCC_DEBUG_ANSI = saved.MYCC_DEBUG_ANSI;
    vi.restoreAllMocks();
  });

  it('writes nothing to stderr and its setup bytes land on stdout', () => {
    delete process.env.MYCC_PLAIN;
    delete process.env.MYCC_DEBUG_ANSI;
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true; });

    startSpinner();
    stopSpinner();

    // The cursor-hide escape must be on stdout — the stream the Coordinator
    // mirrors alongside the progress bars.
    expect(out.join('')).toContain('\x1b[?25l');
    // The stream move: NOTHING on stderr.
    expect(err.join('')).toBe('');
  });

  it('is a no-op in plain mode (no bytes on either stream)', () => {
    process.env.MYCC_PLAIN = '1';
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true; });

    startSpinner();

    expect(out.join('')).toBe('');
    expect(err.join('')).toBe('');
  });
});

describe('decoration writers are clean in plain mode (integration)', () => {
  const saved = { MYCC_PLAIN: process.env.MYCC_PLAIN, MYCC_DEBUG_ANSI: process.env.MYCC_DEBUG_ANSI };

  /** Run `fn` with both stdout and stderr captured; return the captured text. */
  function capture(fn: () => void): { out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true; });
    try {
      fn();
    } finally {
      so.mockRestore();
      se.mockRestore();
    }
    return { out: out.join(''), err: err.join('') };
  }

  afterEach(() => {
    if (saved.MYCC_PLAIN === undefined) delete process.env.MYCC_PLAIN;
    else process.env.MYCC_PLAIN = saved.MYCC_PLAIN;
    if (saved.MYCC_DEBUG_ANSI === undefined) delete process.env.MYCC_DEBUG_ANSI;
    else process.env.MYCC_DEBUG_ANSI = saved.MYCC_DEBUG_ANSI;
  });

  it('beginProgressDisplay/endProgressDisplay emit nothing in plain mode (no reserve, no stray blanks)', () => {
    process.env.MYCC_PLAIN = '1';
    const { out, err } = capture(() => { beginProgressDisplay(); endProgressDisplay(); });
    expect(out).toBe('');
    expect(err).toBe('');
  });

  it('beginProgressDisplay/endProgressDisplay emit the reserve + erase when decorated', () => {
    delete process.env.MYCC_PLAIN;
    delete process.env.MYCC_DEBUG_ANSI;
    const { out } = capture(() => { beginProgressDisplay(); endProgressDisplay(); });
    expect(out).toContain('\n\n\n\n');
    expect(out).toContain('\x1b[4A\x1b[J');
  });

  it('ProgressTracker.update() writes nothing in plain mode', () => {
    process.env.MYCC_PLAIN = '1';
    const tracker = new ProgressTracker(4, 3);
    const { out, err } = capture(() => {
      tracker.onNodeStart('node-a');
      tracker.onProgress('node-a', 1, 1, 'read_file', { path: 'a.ts' });
      tracker.onNodeComplete('node-a');
    });
    expect(out).toBe('');
    expect(err).toBe('');
  });

  it('ProgressTracker.update() paints the bar when decorated', () => {
    delete process.env.MYCC_PLAIN;
    delete process.env.MYCC_DEBUG_ANSI;
    const tracker = new ProgressTracker(4, 3);
    const { out } = capture(() => {
      tracker.onNodeStart('node-a');
      tracker.onProgress('node-a', 1, 1, 'read_file', { path: 'a.ts' });
    });
    // The tracker's in-place render is the cursor-up + clear-line escape.
    expect(out).toContain('\x1b[4A');
    expect(out).toContain('\x1b[2K');
  });

  it('the mindmap decorate-then-plain boundary never leaves four reserved blanks', () => {
    // Simulates the real compile flow: reserve, then (if plain) erase is also
    // skipped — so net output must be empty. This is the invariant the old
    // direct writes violated when only one of the pair was gated.
    process.env.MYCC_PLAIN = '1';
    const { out } = capture(() => {
      beginProgressDisplay();
      const tracker = new ProgressTracker(2, 3);
      tracker.onNodeStart('a');
      tracker.onNodeComplete('a');
      tracker.finish();
      endProgressDisplay();
    });
    expect(out).toBe('');
  });
});

describe('--help honours the plain-output contract (real subprocess)', () => {
  it('mycc --help with piped stdout contains no ANSI escape sequences', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const myccBin = path.join(repoRoot, 'bin', 'mycc.js');
    if (!fs.existsSync(myccBin)) {
      // The launcher is expected in-repo; if it is missing, fail loudly rather
      // than silently pass — the contract is untested otherwise.
      throw new Error(`bin/mycc.js not found at ${myccBin}`);
    }

    // Run with stdout captured (a pipe, never a TTY) — exactly the
    // `mycc --help > help.txt` case. Force color vars OFF-compatible by NOT
    // setting FORCE_COLOR; the Coordinator's stdout.isTTY is false in a pipe.
    const out = execFileSync(process.execPath, [myccBin, '--help'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '1' },
      timeout: 20000,
    });

    // Sanity: help actually printed.
    expect(out).toContain('Usage:');
    // The contract: no ESC (0x1b) anywhere in the redirected dump. FORCE_COLOR
    // is deliberately set to prove the verdict, not chalk's own detection,
    // suppresses the styling.
    expect(out).not.toMatch(/\x1b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Drift guards
// ═══════════════════════════════════════════════════════════════════════════
describe('drift guards (plain-output contract)', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

  it('the Coordinator derives the verdict from stdout.isTTY, never stdin.isTTY', () => {
    const src = read('../index.ts');
    // Pin the stdout-only derivation. A stdin-based verdict would wrongly
    // strip decoration for a human who pipes stdout (the Coordinator's stdin
    // is still the real terminal).
    expect(src).toMatch(/process\.stdout\.isTTY/);
    expect(src).toMatch(/process\.env\.MYCC_PLAIN\s*=\s*'1'/);
    // The verdict derivation must not consult stdin.isTTY.
    const plainIdx = src.indexOf('MYCC_PLAIN');
    const prelude = src.slice(Math.max(0, plainIdx - 400), plainIdx);
    expect(prelude).not.toMatch(/process\.stdin\.isTTY/);
  });

  it('the verdict is derived BEFORE the --help intercept (redirected help stays plain)', () => {
    const src = read('../index.ts');
    const verdictIdx = src.indexOf("process.env.MYCC_PLAIN = '1'");
    const helpIdx = src.indexOf('printHelp()');
    expect(verdictIdx).toBeGreaterThan(-1);
    expect(helpIdx).toBeGreaterThan(-1);
    // The `--help > help.txt` hole: if printHelp() ran first, the chalk-styled
    // help would be emitted before MYCC_PLAIN was ever set.
    expect(verdictIdx).toBeLessThan(helpIdx);
  });

  it('printHelp consults isPlainOutput() (no unconditional chalk styling)', () => {
    const src = read('../help.ts');
    const fn = src.slice(src.indexOf('export function printHelp'), src.indexOf('Coloring —'));
    expect(fn).toContain('isPlainOutput()');
  });

  it('no Lead-side writer gates the spinner on a bare isTTY check', () => {
    // The Lead never owns a TTY — an isTTY gate there is dead code. The
    // spinner's suppression must be isPlainOutput().
    const src = read('../engine/chat-helpers.ts');
    const spinnerBlock = src.slice(src.indexOf('export function startSpinner'), src.indexOf('export function stopSpinner'));
    expect(spinnerBlock).toContain('isPlainOutput()');
    expect(spinnerBlock).not.toMatch(/process\.stdout\.isTTY/);
  });

  it('tool handlers do not import config.isPlainOutput directly (relay via ctx.core)', () => {
    // Convention: a tool reads the plain-output verdict through
    // ctx.core.isPlainOutput(), not from config, so it depends only on its
    // declared ctx contract. mycc_title is the reference implementation.
    const toolsDir = path.resolve(__dirname, '../tools');
    const offenders: string[] = [];
    for (const name of fs.readdirSync(toolsDir)) {
      if (!name.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(toolsDir, name), 'utf-8');
      // Look for an actual import binding of isPlainOutput from config
      // (not a mention in a comment).
      if (/import\s*\{[^}]*\bisPlainOutput\b[^}]*\}\s*from\s*['"][^'"]*config\.js['"]/.test(src)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
