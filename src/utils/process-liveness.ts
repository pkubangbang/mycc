/**
 * process-liveness.ts — the SINGLE liveness decision shared by the peer
 * subsystem (src/peer/identity.ts, src/loop/daemon-init.ts) and the
 * mycc-compose launcher (scripts/mycc-compose/lib/discovery.ts).
 *
 * WHY CENTRALIZED: a PID that exists does NOT prove the ORIGINAL holder is
 * still alive. The original process may have exited leaving a still-fresh
 * heartbeat, and the OS may have reused its PID for an unrelated process. A
 * bare `process.kill(pid, 0)` probe then succeeds, and a restart/duplicate
 * decision gated on it alone wrongly concludes "the live peer is still here":
 *   - daemon deduplication (daemon-init.ts) rejects a legitimate new daemon;
 *   - name registration (identity.ts assertNameNotLive) refuses a new peer.
 * `stopPeer` (mycc-compose) already narrowed recycled pids with {@link
 * didPidStartAfter}; folding that evidence into the shared predicate makes the
 * RESTART decisions agree with the STOP decision instead of drifting.
 *
 * CONSERVATIVE FALLBACK: when process-start evidence is unavailable we treat
 * the pid as a LIVE holder (never assume a recycled pid to bypass a guard).
 */

import fs from 'fs';
import { execFileSync } from 'child_process';

/**
 * Run `ps` with a PINNED C locale. Every `ps` call in mycc goes through here.
 *
 * WHY: `ps` output is locale-sensitive. With `LANG=zh_CN.UTF-8` (and `LC_ALL`
 * unset) `ps -o lstart=` prints `日 10月 18 22:50:52 2026`, which
 * `Date.parse()` cannot read → NaN → "start time unknown". Downstream that is
 * NOT a harmless unknown: `didPidStartAfter()` returns false and the caller
 * concludes the ORIGINAL pid holder is still alive — a silently recycled pid
 * reads as live. The failure is invisible whenever the developer's own locale
 * happens to be C/UTF-8-English, which is why it survives testing.
 *
 * Fixing it here rather than at the call site is deliberate: inheriting the
 * caller's env would relocate the dependency instead of removing it, and every
 * future `ps` call would have to remember to repeat the incantation.
 */
export function runPs(args: string[]): string {
  return execFileSync('ps', args, {
    encoding: 'utf-8',
    timeout: 5_000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
}

/**
 * True when `pid` looks like a live process. `process.kill(pid, 0)` sends no
 * signal but throws ESRCH when the pid does not exist; EPERM means it exists
 * but is owned by another user (treat as alive).
 */
export function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Best-effort read of when process `pid` started (ms since epoch), or null when
 * we cannot tell. Used to detect PID RECYCLING: a recycled pid started AFTER
 * the heartbeat file that names it, whereas the process that wrote a given
 * heartbeat necessarily started BEFORE that file was written.
 *
 * Windows: `wmic process where processid=<pid> get creationdate` (falling back
 * to PowerShell `Get-Process`). Unix: `ps -o lstart=`, run through
 * {@link runPs} so the locale is pinned to C (see that function for why a
 * locale-dependent `ps` silently reads a recycled pid as alive). Every path
 * returns null on failure — callers must treat null as "unknown".
 */
export function getProcessStartTime(pid: number): number | null {
  if (!pid || typeof pid !== 'number') return null;
  try {
    if (process.platform === 'win32') {
      try {
        const out = execFileSync('wmic', ['process', 'where', `processid=${pid}`, 'get', 'creationdate', '/value'], {
          encoding: 'utf-8',
          timeout: 5_000,
          windowsHide: true,
        });
        const m = /CreationDate=(\d{14})/.exec(out);
        if (m) return compactStampToMs(m[1]);
      } catch {
        // wmic absent/deprecated → fall through to PowerShell.
      }
      const psOut = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
        { encoding: 'utf-8', timeout: 5_000, windowsHide: true },
      );
      const fileTime = Number(psOut.trim());
      // FILETIME is 100-ns ticks since 1601-01-01; convert to Unix ms.
      if (Number.isFinite(fileTime) && fileTime > 0) return fileTime / 10_000 - 11_644_473_600_000;
      return null;
    }
    const out = runPs(['-p', String(pid), '-o', 'lstart=']);
    const ms = Date.parse(out.trim());
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** `YYYYMMDDhhmmss` (local) → ms since epoch, or null. */
function compactStampToMs(stamp: string): number | null {
  const y = Number(stamp.slice(0, 4));
  const mo = Number(stamp.slice(4, 6)) - 1;
  const d = Number(stamp.slice(6, 8));
  const h = Number(stamp.slice(8, 10));
  const mi = Number(stamp.slice(10, 12));
  const s = Number(stamp.slice(12, 14));
  const ms = new Date(y, mo, d, h, mi, s).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when we can PROVE the process at `pid` started after `notBeforeMs` — a
 * strong indication the pid was recycled (the original owner is gone). Returns
 * false when the start time is unknown, so the caller never refuses a
 * legitimate instance just because introspection failed.
 */
export function didPidStartAfter(pid: number, notBeforeMs: number): boolean {
  if (!Number.isFinite(notBeforeMs)) return false;
  const startedAt = getProcessStartTime(pid);
  if (startedAt === null) return false;
  // 2s of slack absorbs coarse clock resolution (wmic stamps are whole
  // seconds; `ps lstart` likewise) so a genuine owner is never misjudged.
  return startedAt > notBeforeMs + 2_000;
}

/**
 * The pid-reuse-aware liveness predicate used for RESTART / duplicate-NAME
 * decisions: is the recorded pid a LIVE holder of the identity, or has the OS
 * merely recycled the pid onto an unrelated process?
 *
 * Evidence order:
 *   1. pid not alive → false (no holder).
 *   2. heartbeat mtime unavailable (0/non-finite) → true conservatively; missing
 *      timestamp is not evidence of a recycled PID.
 *   3. start time available AND the pid started AFTER the heartbeat file's
 *      mtime (beyond the clock-resolution slack) → false (PID was recycled).
 *   4. otherwise → true. Unknown start time or inconclusive ordering is the
 *      CONSERVATIVE branch: do not bypass a guard without evidence.
 *
 * @param pid The pid recorded in the heartbeat (or identity entry).
 * @param heartbeatMtimeMs The heartbeat file's mtime — the moment the recorded
 *   process last proved it was the writer. A pid that started after this cannot
 *   have written it.
 */
export function isOriginalHolderAlive(pid: number | undefined | null, heartbeatMtimeMs: number): boolean {
  if (typeof pid !== 'number' || !isPidAlive(pid)) return false;
  // mtime 0 is the sentinel returned when the heartbeat file cannot be statted.
  // It is not evidence that the process started after the heartbeat; fail
  // conservatively so a transient read/stat race cannot admit a duplicate name.
  if (!Number.isFinite(heartbeatMtimeMs) || heartbeatMtimeMs <= 0) return true;
  if (didPidStartAfter(pid, heartbeatMtimeMs)) return false;
  return true;
}

/** The heartbeat file's mtime (ms since epoch), or 0 when it cannot be read. */
export function heartbeatMtimeMs(heartbeatFile: string): number {
  try {
    return fs.statSync(heartbeatFile).mtimeMs;
  } catch {
    return 0;
  }
}
