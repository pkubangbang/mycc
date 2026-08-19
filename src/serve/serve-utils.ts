/**
 * serve-utils.ts - stateless helpers for the /serve Web UI stack
 *
 * Extracted from serve-hub.ts so they can be shared by the extracted modules
 * (serve-clients, serve-history, serve-ws-handler) without importing the
 * heavy serve-hub.ts module graph.
 */
import * as os from 'os';

/**
 * Strip ANSI escape sequences (CSI/SGR, cursor moves, OSC, etc.) from a
 * string. Verbose logs and direct log() calls carry chalk-formatted text
 * that would render as garbled escape codes in the Web UI; this normalizes
 * everything to plain text at the broadcast boundary so the frontend never
 * sees a TTY escape code.
 */
export function stripAnsi(text: string): string {
  // CSI ... (0x40-0x7E terminator) | OSC ... BEL or ST | other escape runs.
  // The regexes intentionally match the ESC control character (0x1b) — that is
  // what an ANSI escape sequence IS — so disable no-control-regex for the
  // whole chain rather than per-line (the original single-line disable was
  // misplaced above the comment, leaving the regex lines un-suppressed).
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
  /* eslint-enable no-control-regex */
}

/**
 * Detect ALL non-internal IPv4 addresses on the machine for display when the
 * server is bound to 0.0.0.0 (all interfaces). Walks os.networkInterfaces()
 * and returns every non-internal IPv4 address (skips loopback 127.x and
 * link-local 169.254.x — APIPA), de-duplicated and order-stable.
 *
 * Used only for the startup message / getUrl() reporting; the actual bind
 * is still 0.0.0.0 so the server accepts connections on every interface.
 * Returns an empty array if no suitable address is found — the caller then
 * falls back to 'localhost'.
 */
export function detectAllLanIpv4(): string[] {
  const interfaces = os.networkInterfaces();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const a of addrs) {
      // IPv4, not internal (loopback), not link-local (169.254.x — APIPA)
      if (a.family === 'IPv4' && !a.internal) {
        if (a.address.startsWith('169.254.')) continue;
        if (seen.has(a.address)) continue; // de-dup across interfaces
        seen.add(a.address);
        out.push(a.address);
      }
    }
  }
  return out;
}

/**
 * Detect the machine's primary LAN IPv4 address for display when the server
 * is bound to 0.0.0.0 (all interfaces). Returns the first non-internal IPv4
 * address, or null if none is found — the caller then falls back to
 * 'localhost'. Thin wrapper over detectAllLanIpv4() kept for the single-URL
 * "already running" reporting path (getUrl()).
 */
export function detectLanIpv4(): string | null {
  const all = detectAllLanIpv4();
  return all.length > 0 ? all[0] : null;
}