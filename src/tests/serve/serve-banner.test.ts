/**
 * serve-banner.test.ts - displayUrl() / displayUrls() address arithmetic.
 *
 * WHY THIS FILE EXISTS (issue #10, "unpinned web-stack routes" half): before
 * this file NOTHING imported `src/serve/serve-banner.ts`. The module was
 * extracted from serve-hub.ts with the hub's `/serve` banner and `/reload`
 * hand-off as its only consumers, and the extraction was covered by no test at
 * all — a regression in the LAN-address branch (the one branch a developer
 * cannot exercise on a single-NIC box without care) would ship silently and
 * only show up as "the banner prints a URL nobody can reach".
 *
 * WHAT IS PINNED: the three (host, port) branches of `displayUrl` and the two
 * shapes of `displayUrls` — specifically that the LAN probe is consulted for
 * `0.0.0.0` and NOT for an explicit `--host`, that a failed probe degrades to
 * localhost rather than to an empty host, and that `displayUrls` enumerates
 * EVERY non-internal IPv4 (not just the first) when bound to all interfaces.
 *
 * MOCKING NOTE: `detectLanIpv4` / `detectAllLanIpv4` are bound through ESM
 * named imports, which cannot be reassigned or spied on the module namespace
 * (ESM live bindings are read-only). So the LAN probe is replaced with
 * `vi.mock` + `importOriginal`, keeping the rest of serve-utils real. The
 * assertions therefore describe the CALL CONTRACT of the probe (was it asked?
 * what happens when it answers null / several addresses), which is the part
 * the banner owns; the probe's own enumeration is covered by serve-utils tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';

vi.mock('../../serve/serve-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../serve/serve-utils.js')>();
  return {
    ...actual,
    detectLanIpv4: vi.fn(),
    detectAllLanIpv4: vi.fn()
  };
});

import { detectAllLanIpv4, detectLanIpv4 } from '../../serve/serve-utils.js';
import { displayUrl, displayUrls } from '../../serve/serve-banner.js';

const lanIpv4 = vi.mocked(detectLanIpv4);
const allLanIpv4 = vi.mocked(detectAllLanIpv4);

describe('displayUrl() — one URL for log lines (/reload, "Web UI restarted")', () => {
  beforeEach(() => {
    lanIpv4.mockReturnValue('192.168.1.50');
    allLanIpv4.mockReturnValue(['192.168.1.50']);
  });

  it('localhost-only bind (host null) yields localhost and never probes the LAN', () => {
    expect(displayUrl(null, 3210)).toBe('http://localhost:3210');
    // The probe is LAN-ONLY: a localhost bind must not report a reachable-on-LAN
    // address it is not actually listening on (that URL would be a lie the user
    // copies into another machine's browser).
    expect(lanIpv4).not.toHaveBeenCalled();
  });

  it('an explicit --host is used verbatim, and the LAN is not probed', () => {
    expect(displayUrl('10.0.0.7', 3210)).toBe('http://10.0.0.7:3210');
    expect(lanIpv4).not.toHaveBeenCalled();
  });

  it('0.0.0.0 substitutes the detected LAN IPv4', () => {
    expect(displayUrl('0.0.0.0', 3210)).toBe('http://192.168.1.50:3210');
    expect(lanIpv4).toHaveBeenCalledTimes(1);
  });

  it('0.0.0.0 with NO detected LAN IPv4 degrades to localhost (never an empty host)', () => {
    lanIpv4.mockReturnValue(null);
    // Degradation contract: `http://:3210` would be unparseable, so a failed
    // probe must fall back to the one address that always exists.
    expect(displayUrl('0.0.0.0', 3210)).toBe('http://localhost:3210');
  });

  it('port 0 (never started) is rendered as-is — the arithmetic does not invent a port', () => {
    expect(displayUrl(null, 0)).toBe('http://localhost:0');
  });
});

describe('displayUrls() — the startup banner address list', () => {
  beforeEach(() => {
    lanIpv4.mockReturnValue('192.168.1.50');
    allLanIpv4.mockReturnValue(['192.168.1.50', '10.8.0.2']);
  });

  it('localhost-only bind yields one local URL and an empty network list', () => {
    expect(displayUrls(null, 3210)).toEqual({ local: 'http://localhost:3210', network: [] });
    expect(allLanIpv4).not.toHaveBeenCalled();
  });

  it('an explicit --host yields that single URL and an empty network list', () => {
    expect(displayUrls('192.168.1.99', 3210)).toEqual({ local: 'http://192.168.1.99:3210', network: [] });
    expect(allLanIpv4).not.toHaveBeenCalled();
  });

  it('0.0.0.0 keeps localhost AND lists EVERY detected IPv4 (not just the first)', () => {
    expect(displayUrls('0.0.0.0', 3210)).toEqual({
      local: 'http://localhost:3210',
      network: ['http://192.168.1.50:3210', 'http://10.8.0.2:3210']
    });
    expect(allLanIpv4).toHaveBeenCalledTimes(1);
  });

  it('0.0.0.0 with no detected IPv4 still yields the local URL and no network entries', () => {
    allLanIpv4.mockReturnValue([]);
    expect(displayUrls('0.0.0.0', 3210)).toEqual({ local: 'http://localhost:3210', network: [] });
  });
});
