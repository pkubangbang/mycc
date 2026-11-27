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
 * directory). The owner writes a small {pid, time, id} owner file inside it so
 * a crashed holder can be reclaimed: a contended acquirer treats the lock as
 * abandoned when the recorded pid is dead, when there is no owner file yet and
 * the directory is old, or when the lock outlives {@link HARD_STALE_MS}
 * regardless of the recorded pid (see that constant for why the ceiling needs
 * no pid evidence). It then removes the lock (best-effort) and retries.
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
 * WAITING COSTS NO CPU: the acquire loop blocks the calling thread (callers are
 * synchronous) but parks it via {@link sleepSync} instead of spinning, so a
 * contended lock never pins a core while it waits — see utils/sleep.ts.
 *
 * Scope: advisory and cooperative — it only protects writers that go through
 * {@link withFileLock}. All identity.json writers do, so the guarantee holds
 * for this file. It is NOT a general-purpose mutex for arbitrary files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
// CPU-free synchronous sleep — the acquire loop must BLOCK (callers are sync)
// without burning a core (see utils/sleep.ts).
import { sleepSync } from './sleep.js';

/** A lock whose owner has been gone (or which has outlived this TTL) is stale. */
const STALE_MS = 10_000;
/**
 * Hard ceiling: a lock older than this is reclaimable EVEN IF its owner.json
 * names a live pid. Without it, a lock left by a SIGKILLed holder whose pid was
 * later recycled by an unrelated live process is never reclaimable, so every
 * waiter pays the whole acquire timeout on every launch. The ceiling only fires
 * when a critical section (a few file reads plus one atomic write) somehow takes
 * minutes, so it is a safety net for a wedged lock, not a normal path.
 *
 * Kept well above both STALE_MS and the tests' backdated-but-live fixture (1 min)
 * so "a merely old lock held by a live pid is not stolen" still holds.
 */
const HARD_STALE_MS = 120_000;
/** Total time {@link withFileLock} will wait for a contended lock before giving up. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** Delay between acquire attempts (kept short: critical sections are <1ms). */
const DEFAULT_POLL_MS = 25;
/** Random extra delay added to each poll — de-synchronizes a simultaneous burst. */
const POLL_JITTER_MS = 10;

/** Options for {@link withFileLock}. */
export interface FileLockOptions {
  /**
   * true → throw {@link FileLockTimeoutError} on acquire timeout instead of
   * running `fn` unheld. Default (unset/false) degrades and runs (best-effort).
   * See the file header for which callers use which.
   */
  strict?: boolean;
  /**
   * How long to wait for a contended lock, in ms. Defaults to 5000. Tests pass a
   * short value so the contended path is provable in milliseconds instead of
   * costing the full production timeout on every run.
   */
  timeoutMs?: number;
  /** Delay between acquire attempts, in ms. Defaults to 25. */
  pollMs?: number;
}

/** Raised when a strict lock cannot be acquired within the timeout. */
export class FileLockTimeoutError extends Error {
  constructor(filePath: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    super(
      `could not acquire the file lock for ${filePath} within ${timeoutMs}ms ` +
        `(a live holder never released it, or the lock could not be created)`
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
      // HARD CEILING FIRST: an ancient lock is reclaimable even when its pid
      // looks alive, because that pid may have been RECYCLED by an unrelated
      // process. Without this, one SIGKILLed holder wedges the lock forever and
      // every launch pays the full acquire timeout. See HARD_STALE_MS.
      const ownerAge = typeof owner.time === 'number' ? Date.now() - owner.time : 0;
      if (ownerAge > HARD_STALE_MS) return true;
      // A live owner below the ceiling is NEVER stale — stealing a lock from a
      // running holder would re-open the very race it closes.
      if (typeof owner.pid === 'number') return !pidAlive(owner.pid);
      // No pid recorded (a partial write): fall back to the age check.
      if (typeof owner.time === 'number') return ownerAge > STALE_MS;
      return false;
    }
    // No owner file yet — a racing creator may not have written it. Fall back
    // to the lock dir's own mtime; reclaim once it is clearly old (or ancient).
    const st = fs.statSync(dir);
    const age = Date.now() - st.mtimeMs;
    return age > HARD_STALE_MS || age > STALE_MS;
  } catch {
    // The dir vanished between our existsSync and statSync → treat as free.
    return true;
  }
}

/** Publish this acquisition's identity so a peer can reclaim us if we die. */
function writeOwnerFile(ownerPath: string, ownerId: string): void {
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, time: Date.now(), id: ownerId }));
}

/** True when `owner.json` still records `ownerId` (this acquisition still holds it). */
function stillOwned(dir: string, ownerId: string): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf-8')) as { id?: string };
    return owner.id === ownerId;
  } catch {
    // Unreadable/absent owner file: be conservative and leave the dir for the
    // stale/ceiling paths rather than risk deleting a different holder's lock.
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

/**
 * Release only when this acquisition is still the recorded owner.
 *
 * OWNERSHIP CHECK: a lock older than {@link HARD_STALE_MS} can be taken over
 * while its original holder is still running. If that holder then released
 * unconditionally, it would delete the NEW holder's lock and let two processes
 * into the critical section at once. So a release only proceeds when
 * `owner.json` still carries the caller's own owner id.
 */
function releaseIfStillOwned(dir: string, ownerId: string): void {
  if (stillOwned(dir, ownerId)) removeLockDir(dir);
}

/** CPU-free poll delay with jitter: parks the thread instead of spinning. */
function pollDelay(pollMs: number): void {
  sleepSync(pollMs + Math.random() * POLL_JITTER_MS);
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const dir = lockDirFor(filePath);
  const parent = path.dirname(dir);
  try {
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  } catch {
    // Cannot create the parent — the guarded write will surface its own error.
  }

  // Unique per acquisition, so a holder that was taken over cannot delete the
  // usurper's lock on release (see releaseIfStillOwned).
  const ownerId = randomBytes(8).toString('hex');
  const ownerPath = path.join(dir, 'owner.json');
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(dir);
      // We own it now — publish our identity so a peer can reclaim us if we die.
      try {
        writeOwnerFile(ownerPath, ownerId);
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
      else pollDelay(pollMs);
    }
  }

  if (!acquired && strict) {
    // Never run the critical section unheld under a strict lock.
    throw new FileLockTimeoutError(filePath, timeoutMs);
  }

  try {
    return fn();
  } finally {
    if (acquired) releaseIfStillOwned(dir, ownerId);
  }
}
