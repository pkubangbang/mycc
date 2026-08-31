/**
 * time.ts - Local-time formatting helpers
 *
 * Why not `toISOString()`: it renders UTC, which is misleading for terminal
 * display — a "started: 2026-08-31 05:48:57" line next to "(11m ago)" reads
 * wrong by hours whenever the machine is not on UTC. These helpers format
 * timestamps in the machine's local timezone, zero-padded, so they can be
 * dropped into human-facing listings.
 */

/**
 * Format a timestamp as a local-time `YYYY-MM-DD HH:mm:ss` string.
 *
 * Mirrors the shape of `toISOString().replace('T', ' ').slice(0, 19)` but in
 * the local timezone instead of UTC.
 *
 * @param time - Epoch milliseconds (e.g. `Date.now()`, heartbeat timestamps).
 *               Defaults to now.
 */
export function formatLocalDateTime(time: number = Date.now()): string {
  const d = new Date(time);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    ` ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}