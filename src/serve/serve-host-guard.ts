/**
 * serve-host-guard.ts — classify a `--host` binding and warn when `/serve`
 * becomes reachable from off-box.
 *
 * WHY: `/serve` has NO authentication. `/ws` accepts agent input, `/dump`
 * exposes diagnostics, `/history` exposes the transcript. Before this guard,
 * `mountWebStack` called a bare `server.listen(port)` whenever `--host` was
 * absent, which binds EVERY interface (0.0.0.0 / ::) — so the unauthenticated
 * surface was silently reachable from the whole LAN, any VPN/WireGuard peer,
 * and every virtual adapter, from v0.9.7 through v0.11.12. The binding is now
 * loopback-by-default, and binding is the ONLY access control this surface
 * has, so an explicit non-loopback bind must be loud.
 *
 * This module is pure: it decides, it does not log. The caller prints.
 */

/** Loopback host literals that keep the server on this machine only. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** How a bind relates to the network around this machine. */
export type BindExposure = 'loopback' | 'all-interfaces' | 'specific-host';

/** The binding facts the banner / warning needs, derived from `--host`. */
export interface BindClassification {
  /**
   * - `loopback`       — no `--host`, or a loopback literal: this machine only.
   * - `all-interfaces` — `0.0.0.0` / `::` / empty: every local interface.
   * - `specific-host`  — a concrete address the user named.
   */
  exposure: BindExposure;
  /** The address to pass to `server.listen()` (never null — the fix). */
  listenHost: string;
  /** True when another machine on the network could reach the port. */
  offBoxReachable: boolean;
}

/**
 * Classify the effective bind.
 *
 * `bindHost === null` means `--host` was not given, which the documented
 * contract (`WebStackHost.host`, `displayUrls`, `getServeHost`) defines as
 * LOCALHOST-ONLY. This function is the single source of that decision:
 * `mountWebStack` reads `listeningAddress(null)` to resolve its `listen()`
 * argument, so the listener and the banner can never drift apart again.
 */
export function classifyBind(bindHost: string | null): BindClassification {
  const listenHost = listeningAddress(bindHost);
  if (LOOPBACK_HOSTS.has(listenHost)) {
    return { exposure: 'loopback', listenHost, offBoxReachable: false };
  }
  if (listenHost === '0.0.0.0' || listenHost === '::') {
    return { exposure: 'all-interfaces', listenHost, offBoxReachable: true };
  }
  return { exposure: 'specific-host', listenHost, offBoxReachable: true };
}

/**
 * The concrete address to hand `server.listen(port, address)`.
 *
 * This exists because a bare `listen(port)` binds 0.0.0.0/:: — the exact
 * regression that shipped in v0.9.7. `null` (no `--host`) MUST become
 * `127.0.0.1`, never undefined.
 */
export function listeningAddress(bindHost: string | null): string {
  if (bindHost === null || bindHost === '') return '127.0.0.1';
  if (bindHost === 'localhost') return '127.0.0.1';
  return bindHost;
}

/**
 * The security warning to print when the bind is off-box reachable, else null.
 * Plain text (no colour) so the caller routes it through its own logger while
 * the wording stays unit-testable.
 */
export function bindExposureWarning(bindHost: string | null, port: number): string | null {
  const { exposure, listenHost, offBoxReachable } = classifyBind(bindHost);
  if (!offBoxReachable) return null;
  const scope = exposure === 'all-interfaces' ? `every local interface (${listenHost})` : `${listenHost}`;
  return [
    `SECURITY: /serve is listening on ${scope} with NO authentication.`,
    '  /ws lets anyone send agent input; /dump and /history expose diagnostics and transcript.',
    '  Reachable by anyone who can route here (LAN, VPN/WireGuard peer, virtual adapter).',
    `  Drop --host to keep the Web UI on 127.0.0.1:${port} only.`
  ].join('\n');
}
