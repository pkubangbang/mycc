/**
 * file-lock.ts - Cooperative cross-process advisory lock for a read-merge-write
 * critical section over a shared JSON file.
 *
 * Why this exists (the lost-update class it closes): identity.json is written
 * by EVERY mycc instance (IdentityManager.register / unregister) AND by the
 * `mycc-compose` repair pass (repairIdentity). The write is a read-merge-write
 * — read the map, merge this writer's entries on top, atomically rename — and
 * two writers whose windows overlap each loss: the one that renames last wins,
 * and the other's entry silently vanishes. Re-reading just before the write
 * narrows the window but cannot close it; the only sound fix is to serialize
 * the whole read→write section across processes.
 *
 * The lock is a directory created with `mkdir`, which is atomic on every
 * supported platform (including Windows: only one caller can create a given
 * directory). The owner writes a small {pid, time} owner file inside it so a
 * crashed holder can be reclaimed: a contended acquirer treats the lock as
 * abandoned when the recorded pid is dead OR the lock is older than
 * {@link STALE_MS}, then removes it (best-effort) and retries.
 *
 * STRICT VS BEST-EFFORT ({@link FileLockOptions.strict}):
 *   - best-effort (DEFAULT, `strict` unset/false): on acquire timeout `fn`
 *     runs anyway, unheld. The write is then no safer than before the lock
 *     existed (atomic-rename only, no merge guarantee) — but the guarded write
 *     still lands, so a lock that merely cannot be CREATED never crashes the
 *     caller. This is the safe default for a background utility: a transient
 *     lock failure degrades correctness, it does not abort startup.
 *   - strict (`strict: true`): on acquire timeout `withFileLock` THROWS
 *     {@link FileLockTimeoutError} rather than running `fn` unheld. A caller
 *     that cannot tolerate a silent lost-update (the identity.json writers)
 *     opts into this and decides itself how to surface the failure.
 *
 * The identity.json critical sections (register/unregister/repairIdentity) run
 * with `{ strict: true }` AND catch {@link FileLockTimeoutError} to fall back to
 * a single unheld read-merge-write with a loud warning — see identity.ts. So in
 * practice a lock timeout there is a NOISY degradation, never a crash.
 *
 * Scope: advisory and cooperative — it only protects writers that go through
 * {@link withFileLock}. All identity.json writers do, so the guarantee holds
 * for this file. It is NOT a general-purpose mutex for arbitrary files.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A lock whose owner has been gone (or which has outlived this TTL) is stale. */
const STALE_MS = 10_000;
/** Total time {@link withFileLock} will wait for a contended lock before giving up. */
const ACQUIRE_TIMEOUT_MS = 5_000;
/** Delay between acquire attempts (kept short: critical sections are <1ms). */
const POLL_MS = 25;

/** Options for {@link withFileLock}. */
export interface FileLockOptions {
  /**
   * true → throw {@link FileLockTimeoutError} on acquire timeout instead of
   * running `fn` unheld. Default (unset/false) degrades and runs (best-effort).
   * See the file header for which callers use which.
   */
  strict?: boolean;
}

/** Raised when a strict lock cannot be acquired within the timeout. */
export class FileLockTimeoutError extends Error {
  constructor(filePath: string) {
    super(
      `could not acquire the file lock for ${filePath} within ${ACQUIRE_TIMEOUT_MS}ms ` +
      `(a live holder never released it, or the lock could not be created)`,
    );
    this.name = 'FileLockTimeoutError';
  }
}

/** The lock directory for `filePath` (a sibling, so it shares the file's volume). */
function lockDirFor(filePath: string): string {
  return `${filePath}.lock`;
}

/** Best-effort "is this pid still alive?" (EPERM counts as alive). */
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** True when the lock dir exists but its owner is provably gone or too old. */
function isStale(dir: string): boolean {
  try {
    const ownerPath = path.join(dir, 'owner.json');
    if (fs.existsSync(ownerPath)) {
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf-8')) as { pid?: number; time?: number };
      // A LIVE owner is NEVER stale, no matter how old the lease — stealing a
      // lock from a running holder would re-open the very race it closes.
      if (typeof owner.pid === 'number') return !pidAlive(owner.pid);
      // No pid recorded (a partial write): fall back to the age check.
      if (typeof owner.time === 'number') return Date.now() - owner.time > STALE_MS;
      return false;
    }
    // No owner file yet — a racing creator may not have written it. Fall back
    // to the lock dir's own mtime; only reclaim once it is clearly old.
    const st = fs.statSync(dir);
    return Date.now() - st.mtimeMs > STALE_MS;
  } catch {
    // The dir vanished between our existsSync and statSync → treat as free.
    return true;
  }
}

/** Remove a lock dir (its owner file first, then the dir). Best-effort. */
function removeLockDir(dir: string): void {
  try {
    const ownerPath = path.join(dir, 'owner.json');
    if (fs.existsSync(ownerPath)) fs.unlinkSync(ownerPath);
    fs.rmdirSync(dir);
  } catch {
    // Another acquirer may have already removed it — ignore.
  }
}

/** Synchronous sleep (the acquire loop runs in synchronous callers). */
function sleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait: synchronous context */ }
}

/**
 * Run `fn` while holding an exclusive advisory lock on `filePath`. The lock is
 * always released, even when `fn` throws.
 *
 * STRICT (`opts.strict === true`): on acquire failure this THROWS
 * {@link FileLockTimeoutError} instead of running `fn` unheld — for callers
 * that cannot tolerate a silent lost-update (the identity.json writers).
 *
 * BEST-EFFORT (default): on acquire failure `fn` runs anyway, unheld. The write
 * is then no safer than before the lock existed (atomic rename only, no merge
 * guarantee). Use where a missed merge is tolerable and an abort is not.
 *
 * @param filePath Absolute or relative path of the file being guarded.
 * @param fn The read-merge-write critical section.
 * @param opts See {@link FileLockOptions}.
 * @returns whatever `fn` returns.
 * @throws FileLockTimeoutError when strict and the lock could not be acquired.
 */
export function withFileLock<T>(filePath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const strict = opts.strict === true; // default best-effort (opt-in strict)
  const dir = lockDirFor(filePath);
  const parent = path.dirname(dir);
  try {
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  } catch {
    // Cannot create the parent — the guarded write will surface its own error.
  }

  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(dir);
      // We own it now — publish our identity so a peer can reclaim us if we die.
      try {
        fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, time: Date.now() }));
      } catch {
        // Non-fatal: the mtime fallback in isStale() still covers reclaim.
      }
      acquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        // mkdir failed for a reason other than contention (e.g. EACCES).
        break;
      }
      if (isStale(dir)) removeLockDir(dir);
      else sleep(POLL_MS);
    }
  }

  if (!acquired && strict) {
    // Never run the critical section unheld under a strict lock.
    throw new FileLockTimeoutError(filePath);
  }

  try {
    return fn();
  } finally {
    if (acquired) removeLockDir(dir);
  }
}
