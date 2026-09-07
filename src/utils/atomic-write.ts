/**
 * atomic-write.ts - Shared atomic file write (temp-file + rename)
 *
 * Single implementation of the temp-file-then-rename pattern used across the
 * codebase (peer discovery, sessions, hooks, mindmap, channel files, image
 * cache). Centralizing it fixes two problems that the duplicated copies had:
 *
 * 1. Windows EPERM on rename: `fs.renameSync(tmp, dest)` fails with EPERM
 *    (errno -4048) on Windows when the destination is briefly locked by a
 *    concurrent reader (another mycc instance, Windows Defender/antivirus
 *    scanning the just-written temp, or a search indexer). The lock is
 *    transient (released within milliseconds) but the throw was fatal in the
 *    old copies — it crashed startup and left the temp file orphaned. This
 *    implementation retries on transient codes and always cleans up the temp
 *    file on failure.
 * 2. Divergent temp-suffix strategies: the old copies variously used
 *    `process.pid`, `Date.now()`, or a fixed `.tmp` suffix. The fixed suffix
 *    is a collision risk under concurrency; `Date.now()` can collide under
 *    fast successive writes within the same millisecond. `process.pid` is
 *    unique per running instance, so it is the safest suffix and is used here.
 *
 * POSIX note: renaming over an existing destination is atomic and never
 * EPERM-locked on POSIX, so the retry path is never hit there — behavior is
 * unchanged for Linux/macOS.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Transient fs errors on Windows that warrant a retry. See file header for
 * the full rationale.
 */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAY_MS = 50;

/**
 * Atomically write `data` to `filePath`: write to a PID-suffixed temp file in
 * the same directory, then rename it over the destination.
 *
 * - Ensures the parent directory exists (created recursively if missing).
 * - Retries the rename up to {@link RENAME_RETRIES} times on transient
 *   Windows lock errors (EPERM/EBUSY/ENOTEMPTY/EACCES) with a short backoff.
 * - On ultimate failure, removes the orphaned temp file so it does not
 *   accumulate in the target directory across crashes.
 * - Rethrows non-transient errors (ENOENT, ENOSPC, real permission loss)
 *   immediately — more retries won't help those.
 *
 * @param filePath - Destination file path.
 * @param data - String content to write (UTF-8, no BOM).
 */
export function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, 'utf-8');
  try {
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return; // success
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Only retry on transient Windows lock errors; rethrow anything else
        // (e.g. ENOENT if the temp file vanished, ENOSPC, real permission loss).
        if (code && TRANSIENT_RENAME_ERRORS.has(code) && attempt < RENAME_RETRIES - 1) {
          // Brief backoff before retrying — the lock is typically gone by the
          // next event-loop tick, but a small sleep smooths antivirus scans.
          const delay = RENAME_RETRY_DELAY_MS * (attempt + 1);
          const end = Date.now() + delay;
          while (Date.now() < end) { /* busy-wait: synchronous context */ }
          continue;
        }
        throw err;
      }
    }
  } finally {
    // If the rename never succeeded (thrown above), remove the orphaned temp
    // file so it does not accumulate in the target directory across crashes.
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup; ignore
    }
  }
}