/**
 * serve-host-guard.test.ts — locks the loopback-by-default bind contract.
 *
 * REGRESSION: v0.9.7 → v0.11.12 shipped `server.listen(port)` whenever
 * `--host` was absent. A bare `listen(port)` binds 0.0.0.0/:: — every
 * interface — so the unauthenticated /ws, /dump and /history surface was
 * reachable from the LAN, VPN/WireGuard peers and virtual adapters, while the
 * docs (serve-banner, getServeHost, WebStackHost.host) promised
 * "localhost-only". `listeningAddress()` is now the single resolution point
 * that mountWebStack feeds to `listen()`, so these assertions are the guard.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  classifyBind,
  listeningAddress,
  bindExposureWarning
} from '../../serve/serve-host-guard.js';

describe('listeningAddress() — the address handed to server.listen()', () => {
  it('maps a missing --host (null) to loopback, never undefined/wildcard', () => {
    expect(listeningAddress(null)).toBe('127.0.0.1');
  });

  it('passes an explicit --host through unchanged', () => {
    expect(listeningAddress('0.0.0.0')).toBe('0.0.0.0');
    expect(listeningAddress('192.168.1.5')).toBe('192.168.1.5');
    expect(listeningAddress('::')).toBe('::');
  });

  it("normalises the 'localhost' literal to the IPv4 loopback", () => {
    // 'localhost' may resolve to ::1; pinning 127.0.0.1 keeps the banner
    // (http://localhost:PORT) and the socket on the same address family.
    expect(listeningAddress('localhost')).toBe('127.0.0.1');
  });

  it('never returns null/empty for any input — listen() cannot fall back to the wildcard', () => {
    for (const input of [null, '', 'localhost', '127.0.0.1', '0.0.0.0', '::', '10.0.1.4']) {
      const resolved = listeningAddress(input);
      expect(resolved, `input=${String(input)}`).toBeTruthy();
      expect(typeof resolved).toBe('string');
    }
  });
});

describe('classifyBind() — exposure of the resolved bind', () => {
  it('treats no --host as loopback, not off-box', () => {
    const bind = classifyBind(null);
    expect(bind.exposure).toBe('loopback');
    expect(bind.listenHost).toBe('127.0.0.1');
    expect(bind.offBoxReachable).toBe(false);
  });

  it('treats every loopback literal as loopback', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(classifyBind(host).offBoxReachable, host).toBe(false);
    }
  });

  it('treats 0.0.0.0 and :: as all-interfaces and off-box reachable', () => {
    for (const host of ['0.0.0.0', '::']) {
      const bind = classifyBind(host);
      expect(bind.exposure, host).toBe('all-interfaces');
      expect(bind.offBoxReachable, host).toBe(true);
    }
  });

  it('treats a concrete address as specific-host and off-box reachable', () => {
    // The exact tunnel case this repo hit: 10.0.1.4 is the WireGuard peer addr.
    const bind = classifyBind('10.0.1.4');
    expect(bind.exposure).toBe('specific-host');
    expect(bind.offBoxReachable).toBe(true);
  });
});

describe('bindExposureWarning() — loud when the surface is off-box reachable', () => {
  it('returns null for the default (no --host) bind', () => {
    expect(bindExposureWarning(null, 3173)).toBeNull();
  });

  it('returns null for a loopback bind', () => {
    expect(bindExposureWarning('127.0.0.1', 3173)).toBeNull();
  });

  it('warns for 0.0.0.0 and names the missing authentication', () => {
    const warning = bindExposureWarning('0.0.0.0', 3173);
    expect(warning).toContain('SECURITY');
    expect(warning).toContain('NO authentication');
    expect(warning).toContain('every local interface');
  });

  it('warns for a specific host and echoes that host', () => {
    const warning = bindExposureWarning('10.0.1.4', 3173);
    expect(warning).toContain('10.0.1.4');
    expect(warning).toContain('NO authentication');
  });
});
