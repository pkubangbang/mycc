/**
 * serve-banner.ts — the DISPLAY-ADDRESS computation for the `/serve` banner and
 * the `/reload` hand-off, extracted from serve-hub.ts.
 *
 * WHY: these are three pure functions of (host, port, running). They were
 * inline methods on the hub only because they read its fields; the logic is
 * address arithmetic, and the LAN-IP probing deserves its own testable home
 * next to `detectLanIpv4` / `detectAllLanIpv4` in serve-utils.
 */

import { detectLanIpv4, detectAllLanIpv4 } from './serve-utils.js';

/** The URLs the startup banner prints. `network` is empty for a specific host. */
export interface DisplayUrls {
  local: string;
  network: string[];
}

/**
 * The single URL for log lines (`/reload`, "Web UI restarted"): the explicit
 * `--host` when given, the detected LAN address for `0.0.0.0`, else localhost.
 */
export function displayUrl(host: string | null, port: number): string {
  let displayHost: string;
  if (host && host !== '0.0.0.0') {
    displayHost = host; // explicit --host value
  } else if (host === '0.0.0.0') {
    displayHost = detectLanIpv4() ?? 'localhost'; // all interfaces → LAN IP
  } else {
    displayHost = 'localhost';
  }
  return `http://${displayHost}:${port}`;
}

/**
 * Every reachable URL for the banner. When bound to 0.0.0.0, yields a local
 * URL (localhost) plus one network URL per non-internal IPv4 so the user can
 * see every reachable address, not just the first. When bound to a specific
 * host, yields that single URL with an empty network list.
 */
export function displayUrls(host: string | null, port: number): DisplayUrls {
  if (host && host !== '0.0.0.0') {
    // Specific host — single URL, no separate local/network split.
    return { local: `http://${host}:${port}`, network: [] };
  }
  const local = `http://localhost:${port}`;
  if (host === '0.0.0.0') {
    return { local, network: detectAllLanIpv4().map((ip) => `http://${ip}:${port}`) };
  }
  // localhost-only bind (no --host).
  return { local, network: [] };
}
