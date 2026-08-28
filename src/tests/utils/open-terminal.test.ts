/**
 * open-terminal.test.ts - Tests for the command-wrapping helpers in
 * src/utils/open-terminal.ts.
 *
 * wrapCommand() interpolates the parent process's PATH / DISPLAY /
 * WAYLAND_DISPLAY into single-quoted shell `export` statements. The core
 * invariant under test: a single quote inside any of those env values MUST
 * be escaped (POSIX `'\''`), otherwise the embedded quote closes the
 * single-quoted context early and turns the spawned terminal's `export`
 * into a bash syntax error — the command never runs.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { wrapCommand } from '../../utils/open-terminal.js';

const ORIG_PATH = process.env.PATH;
const ORIG_DISPLAY = process.env.DISPLAY;
const ORIG_WAYLAND = process.env.WAYLAND_DISPLAY;

function restoreEnv(): void {
  if (ORIG_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIG_PATH;
  if (ORIG_DISPLAY === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = ORIG_DISPLAY;
  if (ORIG_WAYLAND === undefined) delete process.env.WAYLAND_DISPLAY;
  else process.env.WAYLAND_DISPLAY = ORIG_WAYLAND;
}

describe('wrapCommand', () => {
  afterEach(() => {
    restoreEnv();
  });

  beforeEach(() => {
    // Start each test from a clean, deterministic env state.
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
  });

  it('exports PATH and appends exec bash', () => {
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
    const out = wrapCommand('vim ~/.bashrc');
    expect(out).toContain("export PATH='/usr/local/bin:/usr/bin:/bin'");
    expect(out).toContain('vim ~/.bashrc');
    expect(out.endsWith('exec bash')).toBe(true);
  });

  it('escapes a single quote in PATH so the export stays valid shell', () => {
    // Regression: a PATH entry containing a single quote (legal, if rare —
    // e.g. /opt/a'b/bin) used to be interpolated verbatim into the single-
    // quoted export, closing the quote early:
    //   export PATH='/opt/a'b/bin'   ← syntax error in the spawned shell
    // Now each `'` is escaped to `'\''`, keeping the single-quoted context
    // intact.
    process.env.PATH = "/usr/bin:/opt/a'b/bin";
    const out = wrapCommand('echo hi');
    // The escaped form: '/usr/bin:/opt/a'\''b/bin'
    expect(out).toContain("export PATH='/usr/bin:/opt/a'\\''b/bin'");
    // The raw, unescaped interpolation must NOT appear.
    expect(out).not.toContain("export PATH='/usr/bin:/opt/a'b/bin'");
  });

  it('escapes a single quote in DISPLAY when present', () => {
    process.env.PATH = '/usr/bin';
    process.env.DISPLAY = "host:1'.0";
    const out = wrapCommand('xterm');
    expect(out).toContain("export DISPLAY='host:1'\\''.0'");
  });

  it('escapes single quotes in WAYLAND_DISPLAY when present', () => {
    process.env.PATH = '/usr/bin';
    process.env.WAYLAND_DISPLAY = "wayland-0'sock";
    const out = wrapCommand('foot');
    expect(out).toContain("export WAYLAND_DISPLAY='wayland-0'\\''sock'");
  });

  it('does not crash and produces a valid export when PATH is unset', () => {
    // process.env.PATH can legitimately be undefined (e.g. a stripped env in
    // tests/sandboxes). shellSingleQuote must handle undefined without
    // throwing and emit an empty quoted value.
    delete process.env.PATH;
    const out = wrapCommand('echo hi');
    expect(out).toContain("export PATH=''");
  });
});