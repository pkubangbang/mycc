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
 * Scope: advisory and cooperative — it only protects writers that go through
 * {@link withFileLock}. All identity.json writers do, so the guarantee holds
 * for this file. It is NOT a general-purpose mutex for arbitrary files.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A lock whose owner has been gone (or which has outlived this TTL) is stale. */
const STALE_MS = 10_000;
/** Total time {@link withFileLock} will wait for a contended lock before degrading. */
const ACQUIRE_TIMEOUT_MS = 5_000;
/** Delay between acquire attempts (kept short: critical sections are <1ms). */
const POLL_MS = 25;

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
      if (typeof owner.pid === 'number' && !pidAlive(owner.pid)) return true;
      if (typeof owner.time === 'number' && Date.now() - owner.time > STALE_MS) return true;
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
 * Degradation contract: the lock is best-effort. On acquire timeout (extreme
 * contention, or a wedged holder we could not reclaim) this method DOES NOT
 * throw — it logs nothing and runs `fn` anyway. A liveness failure must not
 * turn a discovery write into a crash; the write remains as safe as it was
 * before the lock existed (atomic rename), just without the merge guarantee.
 * On platforms where the lock directory cannot be created/removed for a
 * non-contention reason (e.g. a read-only volume), the same degrade-and-run
 * path applies.
 *
 * @param filePath Absolute or relative path of the file being guarded.
 * @param fn The read-merge-write critical section.
 * @returns whatever `fn` returns.
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
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
        // mkdir failed for a reason other than contention (e.g. EACCES): give
        // up on locking and run the section unlocked rather than crash.
        break;
      }
      if (isStale(dir)) removeLockDir(dir);
      else sleep(POLL_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) removeLockDir(dir);
  }
}
