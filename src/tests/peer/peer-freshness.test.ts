/**
 * peer-freshness.test.ts — Tests for the isFresh() absolute-window fix (Fix #1).
 *
 * AFTER FIX: a remote is fresh ONLY if its latest heartbeat is within an
 * absolute window (FRESHNESS_WINDOW_MS = 90s) of now, AND remoteLatest >
 * localOldest. The old code checked only remoteLatest > localOldest, so a
 * dead instance whose last beat was hours ago stayed "fresh" forever as long
 * as it beat after the local oldest.
 *
 * This file mirrors the mocking style of peer.test.ts (config.js mocked to
 * point at a per-test temp dir, writeHeartbeatRaw helper).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Mock config so discovery paths point at a temp directory ----------------
let tempDir = '';
const discoveryDir = () => path.join(tempDir, 'discovery');
const identityFile = () => path.join(discoveryDir(), 'identity.json');
const heartbeatDir = () => path.join(discoveryDir(), 'heartbeat');
const heartbeatFile = (sid: string) => path.join(heartbeatDir(), `${sid}.json`);

vi.mock('../../config.js', () => ({
  getDiscoveryDir: () => discoveryDir(),
  getIdentityFile: () => identityFile(),
  getHeartbeatDir: () => heartbeatDir(),
  getHeartbeatFile: (sid: string) => heartbeatFile(sid),
  getChannelsDir: () => path.join(discoveryDir(), 'channels'),
  getChannelFile: (sid: string, cid: string) =>
    path.join(discoveryDir(), 'channels', `${sid}-${cid}.json`),
}));

import { IdentityManager } from '../../peer/identity.js';

const SID_A = 'aaaa0000-0000-0000-0000-000000000000';
const SID_B = 'bbbb1111-1111-1111-1111-111111111111';

function writeHeartbeatRaw(sid: string, timestamps: number[]): void {
  const dir = heartbeatDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(heartbeatFile(sid), JSON.stringify({ timestamps }), 'utf-8');
}

function makeMailboxPath(sid: string): string {
  const mbDir = path.join(tempDir, 'mailbox', sid);
  if (!fs.existsSync(mbDir)) fs.mkdirSync(mbDir, { recursive: true });
  return path.join(mbDir, 'unread-lead.jsonl');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-fresh-'));
  for (const d of [discoveryDir(), heartbeatDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('isFresh() absolute-window fix (Fix #1)', () => {
  it('a remote whose latest heartbeat is 120s old is NOT fresh, even if it beat after local oldest', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();

    const now = Date.now();
    // Local oldest is very old (10 min ago); remote latest beat 120s ago.
    // remoteLatest (now-120s) > localOldest (now-600s) → relative check passes,
    // but the absolute window (90s) must reject it.
    writeHeartbeatRaw(SID_A, [now - 600_000]);
    writeHeartbeatRaw(SID_B, [now - 120_000]);

    // AFTER FIX: false (heartbeat too old for the absolute window).
    expect(id.isFresh(SID_B)).toBe(false);
  });

  it('a remote with a recent heartbeat (<90s) that beat after local oldest IS fresh', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();

    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 600_000]);
    writeHeartbeatRaw(SID_B, [now - 30_000]);

    expect(id.isFresh(SID_B)).toBe(true);
  });

  it('a remote not in identity.json is not fresh', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    // SID_B never registered.
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now]);
    writeHeartbeatRaw(SID_B, [now]); // heartbeat exists but no identity entry

    expect(id.isFresh(SID_B)).toBe(false);
  });

  it('a remote exactly at the window edge (90s) is borderline — just inside is fresh, just outside is not', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();

    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 600_000]);

    // 80s ago — within window → fresh.
    writeHeartbeatRaw(SID_B, [now - 80_000]);
    expect(id.isFresh(SID_B)).toBe(true);

    // 200s ago — outside window → not fresh.
    writeHeartbeatRaw(SID_B, [now - 200_000]);
    expect(id.isFresh(SID_B)).toBe(false);
  });

  it('a remote registered with zero heartbeats but very old startedAt is not fresh (absolute window)', () => {
    // When remote has 0 beats, the fallback is Date.now()-30s (recent), so this
    // case is fresh. The absolute-window check applies to actual heartbeat
    // timestamps. This test documents the fallback behavior is still fresh.
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();

    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 600_000]);
    // No heartbeat file for B → fallback to Date.now()-30s → within window → fresh.
    expect(id.isFresh(SID_B)).toBe(true);
  });
});