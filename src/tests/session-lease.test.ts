/**
 * session-lease.test.ts — the P1 round-2 regression suite: the pinned-sid
 * OWNERSHIP CLAIM must be atomic, so two concurrent launches can never both
 * adopt the same session id.
 *
 * THE DEFECT: initializeSession() used to ask `isSessionHeld(sid)` and THEN
 * create the session files — two separate steps. Two `mycc --session-id <sid>`
 * (or two `mycc-compose up` runs) racing could both pass the check before
 * either registered, then both boot under one sid: same session dir, heartbeat,
 * mailbox, channel identity — and the last register() won the identity record.
 *
 * THE FIX: claimSessionOwnership() makes CHECK-AND-ACQUIRE one atomic
 * `open(lease, 'wx')`; exactly one caller wins, the loser sees 'held'.
 *
 * These tests pin:
 *   - mutual exclusion: two claims on one sid yield exactly one 'claimed';
 *   - release frees it for the next claimant;
 *   - a lease naming a DEAD pid is reclaimed (crashed owner);
 *   - a lease naming a LIVE pid is respected ('held');
 *   - the REAL initializeSession() refuses a second concurrent claim and
 *     creates no session dir for the loser.
 *
 * MYCC_DISCOVERY_DIR points at a per-test temp store so the real
 * ~/.mycc-store is untouched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SID = 'dddddddd-4444-4444-8444-444444444444';

let tmp = '';

async function loadIdentity() {
  vi.resetModules();
  return import('../peer/identity.js');
}

/** True when `pid` is still alive (EPERM also counts as alive). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-sess-lease-'));
  process.env.MYCC_DISCOVERY_DIR = path.join(tmp, 'discovery');
  fs.mkdirSync(process.env.MYCC_DISCOVERY_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('claimSessionOwnership: atomic pinned-sid lease', () => {
  it('grants exactly ONE claim per sid (the loser is told "held")', async () => {
    const id = await loadIdentity();
    const first = id.claimSessionOwnership(SID);
    const second = id.claimSessionOwnership(SID);
    expect(first).toBe('claimed');
    expect(second).toBe('held');
  });

  it('release frees the sid for the next claimant', async () => {
    const id = await loadIdentity();
    expect(id.claimSessionOwnership(SID)).toBe('claimed');
    expect(id.claimSessionOwnership(SID)).toBe('held');
    id.releaseSessionOwnership(SID);
    expect(id.claimSessionOwnership(SID)).toBe('claimed');
  });

  it('reclaims a lease whose recorded owner pid is DEAD (crashed holder)', async () => {
    const id = await loadIdentity();
    // Pre-seed a lease naming a provably-dead pid.
    const lease = id.getSessionOwnerLeaseFile(SID);
    fs.mkdirSync(path.dirname(lease), { recursive: true });
    fs.writeFileSync(lease, JSON.stringify({ pid: 2 ** 30, sid: SID, time: Date.now() }));
    expect(id.claimSessionOwnership(SID)).toBe('claimed');
  });

  it('respects a lease whose recorded owner pid is ALIVE', async () => {
    const id = await loadIdentity();
    const lease = id.getSessionOwnerLeaseFile(SID);
    fs.mkdirSync(path.dirname(lease), { recursive: true });
    // Our own pid is alive → the lease is honoured.
    fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, sid: SID, time: Date.now() }));
    expect(id.claimSessionOwnership(SID)).toBe('held');
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe('initializeSession: pinned-sid exclusivity at the bootstrap layer', () => {
  it('refuses a second launch under a held sid and creates NO session for the loser', async () => {
    const id = await loadIdentity();
    // First launch wins the lease (simulating the winner already bootstrapping).
    expect(id.claimSessionOwnership(SID)).toBe('claimed');

    // The pinned id comes from the module-private minimist `args` (parsed from
    // the PROCESS argv), which a test runner can never set — so mock config to
    // make getPinnedSessionId() return SID. Everything else stays real.
    vi.resetModules();
    vi.doMock('../config.js', async () => {
      const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
      return { ...actual, getPinnedSessionId: () => SID };
    });
    const session = await import('../session/index.js');

    // Second launch: the atomic claim must fail → initializeSession throws and
    // never reaches createSessionFile, so no session dir is created for it.
    await expect(session.initializeSession()).rejects.toThrow(/held by a live process/);
    // The loser created no session directory under the pinned id.
    expect(fs.existsSync(path.join('.mycc', 'sessions', SID))).toBe(false);

    vi.doUnmock('../config.js');
    vi.resetModules();
  });
});
