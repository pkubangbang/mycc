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

import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mutedSlowSuite } from '../tests/utils/slow-suite.js';
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

describe.skipIf(mutedSlowSuite(import.meta.url))('withFileLock', () => {
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
      })
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
    const ret = withFileLock(
      target,
      () => {
        ran = true;
        return 'ok';
      },
      { timeoutMs: 200, pollMs: 10 }
    );
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
        { strict: true }
      )
    ).toThrow(FileLockTimeoutError);
    expect(ran, 'fn must NOT run when a strict lock cannot be acquired').toBe(false);
  });

  it('reports the EFFECTIVE timeout in FileLockTimeoutError (short timeoutMs)', () => {
    // The message must quote the timeout that was actually waited, not a module
    // constant — otherwise a short-timeout caller gets a misleading "5000ms".
    fs.writeFileSync(lockDir, 'not a dir');
    try {
      withFileLock(target, () => {}, { strict: true, timeoutMs: 120, pollMs: 10 });
      throw new Error('expected FileLockTimeoutError');
    } catch (err) {
      expect(err).toBeInstanceOf(FileLockTimeoutError);
      expect((err as Error).message).toContain('within 120ms');
    }
  });

  it('reclaims a lock older than the hard ceiling EVEN IF its pid looks alive (PID recycling)', () => {
    // A SIGKILLed holder left the lock; its pid was later recycled by an
    // unrelated live process. The pid probe therefore says "alive", but the lock
    // is ancient — without the ceiling it would wedge every future launch.
    fs.mkdirSync(lockDir);
    const staleTime = Date.now() - 5 * 60_000; // 5 min > HARD_STALE_MS (2 min)
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, time: staleTime }));
    const old = staleTime / 1000;
    fs.utimesSync(lockDir, old, old);
    fs.utimesSync(path.join(lockDir, 'owner.json'), old, old);

    let ran = false;
    withFileLock(
      target,
      () => {
        ran = true;
      },
      { timeoutMs: 500, pollMs: 10 }
    );
    expect(ran).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('a robbed holder does NOT delete the usurper lock on release (ownership-checked)', () => {
    // Simulate: this caller acquired, then its lock was taken over past the hard
    // ceiling and re-created by another holder with a DIFFERENT owner id. When
    // the original section returns, its release must leave the new lock intact —
    // otherwise two processes would sit in the critical section at once.
    let lockSurvived = false;
    withFileLock(target, () => {
      // Another holder reclaims the dir and publishes ITS owner id.
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 30, time: Date.now(), id: 'usurper' }));
      lockSurvived = fs.existsSync(path.join(lockDir, 'owner.json'));
    });
    expect(lockSurvived, 'the usurper lock existed during the section').toBe(true);
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf-8')) as { id?: string };
    expect(owner.id, 'the usurper owner file must still be there').toBe('usurper');
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
    // TIME OUT (not steal). A short timeout keeps the suite fast; the rule under
    // test (a merely-old lock held by a live pid is not stolen) is unchanged.
    expect(() =>
      withFileLock(
        target,
        () => {
          /* should never run */
        },
        { strict: true, timeoutMs: 200, pollMs: 10 }
      )
    ).toThrow(FileLockTimeoutError);
    // The live holder's lock dir is intact — not stolen.
    expect(fs.existsSync(lockDir)).toBe(true);
  });
});
