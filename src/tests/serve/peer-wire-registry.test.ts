/**
 * peer-wire-registry.test.ts — registry index invariants (no sockets needed)
 *
 * Pure registry arithmetic: payload cap, mail-id shape, convergence election,
 * sid re-keying and teardown epochs. Sockets here are stubs — nothing dials.
 *
 * Split out of the former 1,007-line peer-wire.test.ts at behaviour seams;
 * the shared in-process fixture lives in peer-wire-harness.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { WebSocket } from 'ws';
import {
  SID_SELF,
  makeTempDir,
  identityFile,
} from './peer-wire-harness.js';
import {
  resetWireRegistry,
  resetSeenMailIds,
  findBySid,
  findByEndpoint,
  endpointOfSid,
  endpointsForSid,
  sendWireMail,
  generateWireMailId,
  recordAnnounce,
  convergePairBySid,
  pruneSocket,
  teardownPair,
  WIRE_CLOSE_SUPERSEDED,
  WIRE_MAX_PAYLOAD_BYTES,
} from '../../peer/wire-registry.js';
import { PEER_WIRE_MAX_PAYLOAD_BYTES, resetPeerWireAcceptor } from '../../serve/peer-wire.js';

// config.js is mocked BEFORE the modules under test are imported: the
// dialer's same-store filter reads identity.json via getIdentityFile().
let tempDir = '';
vi.mock('../../config.js', () => ({
  getDiscoveryDir: () => path.join(tempDir, 'discovery'),
  getIdentityFile: () => identityFile(tempDir),
  // Mirror the real isWireDebugLocal(): accepts --debug-wire ('true') and
  // the legacy MYCC_WIRE_ALLOW_LOCAL=1 spelling.
  isWireDebugLocal: () => {
    const v = process.env.MYCC_WIRE_ALLOW_LOCAL;
    return v === '1' || v === 'true';
  },
}));

beforeEach(() => {
  tempDir = makeTempDir();
  vi.useRealTimers();
  // Registry state is module-global: every test starts from an empty index.
  resetWireRegistry();
  resetSeenMailIds();
  resetPeerWireAcceptor();
});

describe('peer wire — registry invariants', () => {
  it('WIRE_MAX_PAYLOAD_BYTES matches the acceptor cap (single source of truth)', () => {
    expect(WIRE_MAX_PAYLOAD_BYTES).toBe(PEER_WIRE_MAX_PAYLOAD_BYTES);
    expect(WIRE_MAX_PAYLOAD_BYTES).toBe(4 * 1024 * 1024);
  });

  it('generateWireMailId is high-entropy and monotonic per sender', () => {
    const a = generateWireMailId('sid-a');
    const b = generateWireMailId('sid-a');
    const c = generateWireMailId('sid-b');
    expect(a).not.toBe(b);
    expect(a.startsWith('sid-a-')).toBe(true);
    expect(c.startsWith('sid-b-')).toBe(true);
  });

  it('recordAnnounce → convergePairBySid closes the loser with 4000 and keeps the winner', () => {
    // Two fake sockets for the same pair (simultaneous mutual dial window).
    const sockA = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    const sockB = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    recordAnnounce({ endpoint: 'h:1', dialed: true, socket: sockA, sid: 'peer-1', initiatorSid: 'aaa', meta: {} });
    recordAnnounce({ endpoint: 'h:1', dialed: false, socket: sockB, sid: 'peer-1', initiatorSid: 'bbb', meta: {} });
    const losers = convergePairBySid('peer-1');
    // Winner = socket initiated by the SMALLER sid → sockA (initiator aaa).
    expect(losers).not.toBeNull();
    expect(losers!.map((l) => l.initiatorSid)).toEqual(['bbb']);
    expect(sockB.close).toHaveBeenCalledWith(WIRE_CLOSE_SUPERSEDED, 'superseded');
    expect(sockA.close).not.toHaveBeenCalled();
  });

  it('REGRESSION (review finding 1): convergence fires across MISMATCHED endpoint keys', () => {
    // A simultaneous mutual dial keys its two sockets DIFFERENTLY: the socket
    // WE dialed is keyed by the URL string we typed ("127.0.0.1:3195"); the
    // socket we ACCEPTED is keyed by the endpoint the PEER announced
    // ("192.168.1.20:3195" — a legitimate tunnel/alias split, plan §2 step
    // 1.5). Endpoint-scoped bothAnnounced would silently no-op here; the
    // sid-scoped census must still converge to ONE live socket.
    const sockDialed = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    const sockAccepted = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    recordAnnounce({ endpoint: '127.0.0.1:3195', dialed: true, socket: sockDialed, sid: 'peer-1', initiatorSid: 'me', meta: {} });
    recordAnnounce({ endpoint: '192.168.1.20:3195', dialed: false, socket: sockAccepted, sid: 'peer-1', initiatorSid: 'peer-1', meta: {} });
    // The peer's initiator sid ("peer-1") is lexicographically LARGER than
    // ours ("me"), so the ACCEPTED socket (initiated by the peer) is the
    // loser and must be closed 4000 on OUR side.
    const losers = convergePairBySid('peer-1');
    expect(losers).not.toBeNull();
    expect(sockAccepted.close).toHaveBeenCalledWith(WIRE_CLOSE_SUPERSEDED, 'superseded');
    expect(sockDialed.close).not.toHaveBeenCalled();
    // Census is honest after the close is observed: prune the closed socket,
    // and a re-run finds only the winner (no second election, no-op).
    pruneSocket(sockAccepted);
    const rerun = convergePairBySid('peer-1');
    expect(rerun).toBeNull();
    expect(sockDialed.close).not.toHaveBeenCalled();
  });

  it('REGRESSION (review finding 2): the oversize guard measures UTF-8 BYTES, not chars', () => {
    // Multi-byte content: CJK chars are 3 bytes each in UTF-8. A payload
    // just under the cap in CHARACTERS can exceed it in BYTES — the guard
    // must refuse it BEFORE sending (no 1009 on the remote side).
    const cjk = '中'.repeat(WIRE_MAX_PAYLOAD_BYTES / 3 + 100); // chars < cap, bytes > cap
    expect(cjk.length).toBeLessThan(WIRE_MAX_PAYLOAD_BYTES); // char count passes
    expect(Buffer.byteLength(cjk, 'utf-8')).toBeGreaterThan(WIRE_MAX_PAYLOAD_BYTES); // byte count does not
    const sent = sendWireMail('peer-x', 't', cjk).ok;
    expect(sent).toBe(false);
  });

  it('sid re-key on remote restart: findBySid resolves the NEW sid, old sid fails', () => {
    const sock = { readyState: 1, OPEN: 1 } as unknown as WebSocket;
    recordAnnounce({ endpoint: 'h:1', dialed: true, socket: sock, sid: 'old-sid', initiatorSid: 'me', meta: {} });
    expect(findBySid('old-sid')).not.toBeNull();
    recordAnnounce({ endpoint: 'h:1', dialed: true, socket: sock, sid: 'new-sid', initiatorSid: 'me', meta: {} });
    expect(findBySid('new-sid')).not.toBeNull();
    expect(findBySid('old-sid')).toBeNull(); // re-keyed away
    expect(endpointOfSid('new-sid')).toBe('h:1');
    // REGRESSION (review round-3 finding 1): the socketsBySid census MUST
    // migrate with the socket — the same socket re-announcing under a new
    // sid must NOT linger under the old sid's group, or
    // endpointsForSid(oldSid)/convergePairBySid(oldSid) would operate on a
    // socket that no longer belongs to that sid.
    expect(endpointsForSid('old-sid')).toEqual([]); // old sid holds no socket
    expect(endpointsForSid('new-sid')).toEqual(['h:1']); // new sid holds it
  });

  it('REGRESSION (review round-3 finding 1): re-announce under a new sid drops the socket from the OLD sid census (no stale convergence)', () => {
    // The precise scenario finding 1 calls out: a socket re-announces under
    // a NEW sid (peer restart). The old sid's socketsBySid group MUST lose
    // the socket — otherwise convergePairBySid(oldSid) would discover a
    // socket now announcing newSid and try to converge against it (operating
    // on the wrong logical peer). The new sid's group must hold exactly the
    // one migrated socket.
    const sock = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    recordAnnounce({ endpoint: 'h:1', dialed: true, socket: sock, sid: 'old-sid', initiatorSid: 'me', meta: {} });
    expect(endpointsForSid('old-sid')).toEqual(['h:1']);

    // Re-announce the SAME socket under a new sid (the restart).
    recordAnnounce({ endpoint: 'h:1', dialed: true, socket: sock, sid: 'new-sid', initiatorSid: 'me', meta: {} });

    // OLD sid census is now EMPTY — no socket still announces it.
    expect(endpointsForSid('old-sid')).toEqual([]);
    // Convergence against the old sid finds nothing (group length < 2 → null)
    // and crucially does NOT close the migrated socket.
    expect(convergePairBySid('old-sid')).toBeNull();
    expect(sock.close).not.toHaveBeenCalled();
    // The new sid census holds exactly the migrated socket, keyed at h:1.
    expect(endpointsForSid('new-sid')).toEqual(['h:1']);
    // The pair entry's sid field reflects the new sid, and the socket info
    // carries the new sid (the per-socket field is the source of truth for
    // the NEXT migration detection).
    const pair = findByEndpoint('h:1');
    expect(pair!.sid).toBe('new-sid');
    expect(pair!.sockets[0].sid).toBe('new-sid');
  });

  it('REGRESSION (review round-3 finding 2): re-key away does NOT erase a sibling endpoint\'s sidIndex (ownership guard)', () => {
    // The precise scenario finding 2 calls out: during a simultaneous
    // mutual dial one sid transiently spans TWO endpoint keys. When ONE
    // endpoint's socket re-announces under a new sid, the old sid's
    // sidIndex mapping must NOT be deleted when it currently points at the
    // OTHER (still-live, still-old-sid) endpoint. The re-key deletion must
    // be OWNERSHIP-GUARDED, exactly like teardownPair's survivor re-point.
    const endpointA = '127.0.0.1:3195'; // holds socketA under oldSid
    const endpointB = '192.168.1.20:3195'; // holds socketB under oldSid
    const oldSid = 'peer-old';
    const newSid = 'peer-new';

    const sockA = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    const sockB = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    recordAnnounce({ endpoint: endpointA, dialed: true, socket: sockA, sid: oldSid, initiatorSid: SID_SELF, meta: {} });
    recordAnnounce({ endpoint: endpointB, dialed: false, socket: sockB, sid: oldSid, initiatorSid: oldSid, meta: {} });
    // sidIndex points at the most-recent announce (endpointB). Both
    // endpoints legitimately still hold oldSid.
    expect(endpointOfSid(oldSid)).toBe(endpointB);
    expect(endpointsForSid(oldSid).sort()).toEqual([endpointA, endpointB].sort());

    // Now endpointA's socket re-announces under newSid (A restarted).
    recordAnnounce({ endpoint: endpointA, dialed: true, socket: sockA, sid: newSid, initiatorSid: SID_SELF, meta: {} });

    // THE REGRESSION ASSERTION: oldSid's index still resolves (to endpointB,
    // the surviving holder) — A's re-key did NOT delete it because it did not
    // own it. B remains fully reachable by oldSid and mail-routable.
    expect(findBySid(oldSid)).not.toBeNull();
    expect(endpointOfSid(oldSid)).toBe(endpointB); // untouched — A didn't own it
    expect(endpointsForSid(oldSid)).toEqual([endpointB]); // A dropped, B remains
    // A is now reachable by the NEW sid.
    expect(findBySid(newSid)).not.toBeNull();
    expect(endpointOfSid(newSid)).toBe(endpointA);
    expect(endpointsForSid(newSid)).toEqual([endpointA]);
    // No socket was closed — this is a pure index migration, not teardown.
    expect(sockA.close).not.toHaveBeenCalled();
    expect(sockB.close).not.toHaveBeenCalled();
  });

  it('teardownPair bumps the epoch so a mid-flight dial aborts', () => {
    const before = teardownPair('h:9'); // no entry — still bumps
    expect(before).toBeNull();
    const sock = { readyState: 1, OPEN: 1 } as unknown as WebSocket;
    recordAnnounce({ endpoint: 'h:9', dialed: true, socket: sock, sid: 's', initiatorSid: 'me', meta: {} });
    teardownPair('h:9');
    expect(findByEndpoint('h:9')).toBeNull();
    expect(findBySid('s')).toBeNull();
  });
});
