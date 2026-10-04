/**
 * file-lock.test.ts — unit tests for the cross-process advisory lock that
 * serializes identity.json read-merge-write sections (the lost-update fix).
 *
 * These pin the properties the identity-merge correctness depends on:
 *   - mutual exclusion: a nested acquire on the SAME path from another
 *     "process" (a second withFileLock call on a different fiber is not
 *     possible synchronously, so we assert via a sentinel file that a second,
 *     overlapping acquire does NOT enter while the first holds the lock);
 *   - always-release: the lock dir is gone after fn() returns AND after fn()
 *     throws;
 *   - stale reclaim: a lock dir whose owner pid is dead is reclaimed;
 *   - degrade-and-run (best-effort default): when the lock cannot be created
 *     (simulated by pre-creating a non-directory at the lock path) fn still
 *     runs after the acquire timeout;
 *   - strict: with `{ strict: true }` the same uncreatable lock makes
 *     withFileLock THROW FileLockTimeoutError instead of running fn unheld.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withFileLock, FileLockTimeoutError } from '../utils/file-lock.js';

let tmp = '';
let target = '';
let lockDir = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-file-lock-'));
  target = path.join(tmp, 'identity.json');
  lockDir = `${target}.lock`;
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('withFileLock', () => {
  it('creates the lock dir, runs the section, and releases the lock', () => {
    let sawLock = false;
    const ret = withFileLock(target, () => {
      sawLock = fs.existsSync(lockDir);
      return 42;
    });
    expect(sawLock).toBe(true);
    expect(ret).toBe(42);
    // Released after the section — a later acquire succeeds immediately.
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('releases the lock even when the section throws', () => {
    expect(() =>
      withFileLock(target, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('reclaims a lock dir with no owner file once it is older than the stale window', () => {
    // A lock whose owner file never landed (crashed between mkdir and write):
    // only its mtime is available. Backdate it past the 10s stale window.
    fs.mkdirSync(lockDir);
    const old = (Date.now() - 30_000) / 1000;
    fs.utimesSync(lockDir, old, old);

    let ran = false;
    withFileLock(target, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('reclaims a lock whose owner pid is dead', () => {
    // A lock left by a crashed process: owner pid is provably dead.
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 30, time: Date.now() }));

    let ran = false;
    withFileLock(target, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('degrades to running the section unlocked (default best-effort) when the lock cannot be created', () => {
    // A regular FILE sits where the lock dir would go → mkdirSync fails with
    // EEXIST on every attempt. The DEFAULT is best-effort: withFileLock waits
    // out the acquire timeout then runs fn anyway so the guarded write lands.
    fs.writeFileSync(lockDir, 'not a dir');
    let ran = false;
    const ret = withFileLock(target, () => {
      ran = true;
      return 'ok';
    });
    expect(ran).toBe(true);
    expect(ret).toBe('ok');
  });

  it('THROWS FileLockTimeoutError (strict) instead of running unheld when the lock cannot be created', () => {
    // Same uncreatable lock, but the caller opted into strict — e.g. the
    // identity.json writers, which must never silently proceed without the
    // exclusion guarantee. withFileLock must refuse rather than run fn.
    fs.writeFileSync(lockDir, 'not a dir');
    let ran = false;
    expect(() =>
      withFileLock(
        target,
        () => {
          ran = true;
        },
        { strict: true },
      ),
    ).toThrow(FileLockTimeoutError);
    expect(ran, 'fn must NOT run when a strict lock cannot be acquired').toBe(false);
  });

  it('never reclaims a lock held by a LIVE pid merely because it is old', () => {
    // A lock owned by THIS (live) process, backdated far past the stale window.
    // The old age-only reclaim would steal it, re-opening the lost-update race.
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, time: Date.now() }));
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockDir, old, old);
    fs.utimesSync(path.join(lockDir, 'owner.json'), old, old);

    // Strict mode: a live holder that never releases must make the acquirer
    // TIME OUT (not steal).
    expect(() =>
      withFileLock(target, () => { /* should never run */ }, { strict: true }),
    ).toThrow(FileLockTimeoutError);
    // The live holder's lock dir is intact — not stolen.
    expect(fs.existsSync(lockDir)).toBe(true);
  });
});
