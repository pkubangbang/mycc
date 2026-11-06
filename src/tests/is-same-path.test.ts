/**
 * is-same-path.test.ts - Regression tests for `isSamePath()` in utils/path.ts.
 *
 * BUG (reported 2026-11-06): `/fork` (and `--from`, `/load <id>`) aborted with
 * "Working directory mismatch" when the shell's cwd spelled the drive letter
 * in a different case than the one recorded in the source session:
 *
 *     Current:               D:\proj\pb-wiki\myblog
 *     Source session expects: d:\proj\pb-wiki\myblog
 *
 * Node's `process.cwd()` echoes the case the shell used, so `cwd !== project_dir`
 * was false-negative on Windows, where `D:` and `d:` are the same volume. Both
 * call sites now delegate to isSamePath():
 *   - restoreSession()  src/session/index.ts
 *   - /load handler     src/slashes/load.ts
 *
 * The tests assert the PLATFORM-SPECIFIC contract, so they run meaningfully on
 * both Windows (case-insensitive) and POSIX (case-sensitive) CI.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { isSamePath, isInsideWorkspace } from '../utils/path.js';

const isWindows = process.platform === 'win32';

describe('isSamePath: identical and trivially-equivalent spellings', () => {
  it('treats a path as equal to itself', () => {
    const dir = os.tmpdir();
    expect(isSamePath(dir, dir)).toBe(true);
  });

  it('ignores a trailing separator', () => {
    const dir = path.join(os.tmpdir(), 'mycc-same-path');
    expect(isSamePath(dir, dir + path.sep)).toBe(true);
  });

  it('collapses "." and ".." segments', () => {
    const base = path.join(os.tmpdir(), 'mycc-same-path');
    expect(isSamePath(path.join(base, 'a', '.'), path.join(base, 'a'))).toBe(true);
    expect(isSamePath(path.join(base, 'a', 'b', '..'), path.join(base, 'a'))).toBe(true);
  });

  it('resolves relative paths against the cwd', () => {
    expect(isSamePath('.', process.cwd())).toBe(true);
    expect(isSamePath('./', process.cwd())).toBe(true);
  });

  it('distinguishes genuinely different directories', () => {
    expect(isSamePath(path.join(os.tmpdir(), 'mycc-a'), path.join(os.tmpdir(), 'mycc-b'))).toBe(false);
  });
});

describe('isSamePath: case sensitivity follows the filesystem', () => {
  it.runIf(isWindows)('ignores drive-letter and path case on Windows (/fork bug)', () => {
    // The exact shape from the bug report.
    expect(isSamePath('D:\\proj\\pb-wiki\\myblog', 'd:\\proj\\pb-wiki\\myblog')).toBe(true);
    expect(isSamePath('C:\\Users\\Admin\\PROJ', 'c:\\users\\admin\\proj')).toBe(true);
    // Forward slashes are accepted by Windows too.
    expect(isSamePath('D:/proj/pb-wiki/myblog', 'd:\\proj\\pb-wiki\\myblog')).toBe(true);
  });

  it.runIf(!isWindows)('keeps case-significant on POSIX', () => {
    // On a case-sensitive filesystem `/Proj` and `/proj` are DIFFERENT dirs;
    // folding case here would let a session be branched from the wrong dir.
    expect(isSamePath('/tmp/Proj', '/tmp/proj')).toBe(false);
  });
});

describe('isSamePath: does not loosen the other containment guard', () => {
  it('leaves isInsideWorkspace unchanged for a sibling with a shared prefix', () => {
    const root = path.join(os.tmpdir(), 'mycc-root');
    // Must match isInsideWorkspace's documented contract (prefix-sibling escape
    // is rejected) — isSamePath must not be used to bypass containment.
    expect(isInsideWorkspace(path.join(root + '-evil', 'x.txt'), root)).toBe(false);
    expect(isInsideWorkspace(path.join(root, 'x.txt'), root)).toBe(true);
  });
});
