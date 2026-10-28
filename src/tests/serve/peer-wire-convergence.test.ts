/**
 * peer-wire-convergence.test.ts — convergence + survivor regressions (Tests A, B, D)
 *
 * The review round-2 scenarios: a lost convergence race must not corrupt the
 * survivor's sid index, a TLS dialBase must survive a redial, and a
 * peer_disconnect after a convergence window must clear both endpoints.
 *
 * Split out of the former 1,007-line peer-wire.test.ts at behaviour seams;
 * the shared in-process fixture lives in peer-wire-harness.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { WebSocket } from 'ws';
import {
  SID_SELF,
  SID_REMOTE,
  harnessBeforeEach,
  harnessAfterEach,
  FakeRemote,
  makeTempDir,
  identityFile,
} from './peer-wire-harness.js';
import {
  findBySid,
  findByEndpoint,
  endpointOfSid,
  endpointsForSid,
  hasLiveWireForEndpoint,
  listRemotePeers,
  sendWireMail,
  recordAnnounce,
  convergePairBySid,
  pruneSocket,
  teardownPair,
  WIRE_CLOSE_SUPERSEDED,
  WIRE_CLOSE_BYE,
} from '../../peer/wire-registry.js';
import { connectPeer, disconnectPeer, parseWireTarget } from '../../peer/wire-client.js';

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

let remote: FakeRemote;

beforeEach(async () => {
  vi.useRealTimers();
  tempDir = makeTempDir();
  remote = await harnessBeforeEach(tempDir);
});

afterEach(async () => {
  await harnessAfterEach(remote);
  vi.useRealTimers();
});

// ── Review round-2 regression tests (Tests A, B, D) ─────────────────────────
//
// The PR review (round 2) requested explicit regression coverage for three
// scenarios the round-1 suite did not pin down:
//   Test A — different-endpoint convergence then LOSER teardown must NOT
//            corrupt the survivor's sidIndex (the Fix #1 invariant: SID =
//            logical peer identity, endpoint = connection locator; one sid
//            can transiently span multiple endpoints, so teardown must only
//            drop the sid→endpoint mapping when it still points at the
//            endpoint being torn down).
//   Test B — a wss:// (TLS) target's scheme is RETAINED in the dialBase the
//            reconnect loop reuses; it must not silently fall back to ws://
//            on a redial (the Fix #2 invariant: the closed-over dialBase is
//            the single source of truth, not a reconstruction from the bare
//            endpoint key).
//   Test D — peer_disconnect after a convergence window tears down BOTH
//            endpoint entries for the peer sid and leaves no redial.
//   Test E (todo lineage: stale hash hint + actual update still fails) is
//            already covered in src/tests/context/shared/todo.test.ts
//            ("should still REJECT a stale write even when the lineage ring
//            matches (integrity gate unchanged)").

describe('peer wire — review round-2 regressions (Tests A, B, D)', () => {
  it('Test A: convergence loser teardown keeps the survivor findBySid-resolvable and mail-routable', () => {
    // The exact scenario Fix #1 addresses: a simultaneous mutual dial keys
    // its two sockets under DIFFERENT endpoint strings. Convergence elects a
    // winner and closes the loser (4000). When the loser's endpoint is then
    // torn down (its close handler calls teardownPair), the survivor — keyed
    // under the OTHER endpoint — must remain resolvable by sid AND able to
    // carry mail. A naive `sidIndex.delete(entry.sid)` in teardownPair would
    // delete the survivor's index and break sendWireMail for a live wire.
    const survivorEndpoint = '127.0.0.1:3195'; // the URL we typed (dialed)
    const loserEndpoint = '192.168.1.20:3195'; // the endpoint the peer announced (accepted)
    const peerSid = 'peer-survivor';

    // A fake socket that CAN send (sendWireMail calls ws.send) — the
    // survivor must actually accept the mail frame.
    const sentFrames: string[] = [];
    const makeSock = (): WebSocket => ({
      readyState: 1, OPEN: 1,
      close: vi.fn(),
      send: (data: string) => { sentFrames.push(data); },
    } as unknown as WebSocket);

    const sockSurvivor = makeSock(); // dialed by US → initiatorSid = our sid (small)
    const sockLoser = makeSock();    // accepted from peer → initiatorSid = peer sid (large)

    recordAnnounce({ endpoint: survivorEndpoint, dialed: true, socket: sockSurvivor, sid: peerSid, initiatorSid: SID_SELF, meta: {} });
    recordAnnounce({ endpoint: loserEndpoint, dialed: false, socket: sockLoser, sid: peerSid, initiatorSid: peerSid, meta: {} });

    // Both endpoints now index the same peer sid (most-recent announce wins
    // → the accepted socket's announce re-pointed sidIndex at loserEndpoint).
    expect(endpointOfSid(peerSid)).toBe(loserEndpoint);

    // Convergence: our dialed socket (initiatorSid SID_SELF, smaller) wins;
    // the accepted socket (initiatorSid peerSid, larger) is the loser.
    const losers = convergePairBySid(peerSid);
    expect(losers).not.toBeNull();
    expect(losers!.map((l) => l.socket)).toContain(sockLoser);
    expect(sockLoser.close).toHaveBeenCalledWith(WIRE_CLOSE_SUPERSEDED, 'superseded');

    // The loser's close handler runs: pruneSocket then teardownPair (the
    // 4000-with-no-live-sibling path — but the survivor IS live, so a real
    // close handler would skip teardown; here we simulate the WORST case the
    // guard must survive: teardownPair IS called on the loser's endpoint
    // while the survivor remains. This is exactly the corrupting call the
    // guard protects against.)
    pruneSocket(sockLoser);
    teardownPair(loserEndpoint);

    // THE REGRESSION ASSERTION: the survivor's endpoint entry is intact...
    expect(findByEndpoint(survivorEndpoint)).not.toBeNull();
    expect(hasLiveWireForEndpoint(survivorEndpoint)).toBe(true);
    // ...and findBySid STILL resolves to the survivor (the sidIndex was NOT
    // corrupted by the loser's teardown — Fix #1's ownership guard).
    expect(findBySid(peerSid)).not.toBeNull();
    expect(endpointOfSid(peerSid)).toBe(survivorEndpoint);
    // ...and sendWireMail succeeds over the survivor (mail is routable).
    expect(sentFrames.length).toBe(0);
    const sent = sendWireMail(peerSid, 'survivor-mail', 'still alive').ok;
    expect(sent).toBe(true);
    expect(sentFrames.length).toBe(1);
    const delivered = JSON.parse(sentFrames[0]) as Record<string, unknown>;
    expect(delivered.type).toBe('mail');
    expect(delivered.title).toBe('survivor-mail');
  });

  it('Test A2: an accepted socket that merely claims an established sid cannot evict the live wire', () => {
    // Threat: /peer/ws is open by default, so an unauthenticated host can
    // announce a victim's sid. For accepted sockets initiatorSid is whatever
    // the remote sent, so both sockets TIE — and a tie must not be decided by
    // registry order (whichever announced first would otherwise keep the pair,
    // letting an impostor displace a healthy wire, and 4000-with-no-survivor is
    // TERMINAL on the dialer). Established first, impostor second: the
    // impostor must be the loser.
    const establishedEndpoint = '10.0.0.5:3195';
    const impostorEndpoint = 'sid:evil-claims-victim';
    const peerSid = 'victim-sid';

    const makeSock = (): WebSocket => ({
      readyState: 1,
      OPEN: 1,
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket);

    const sockEstablished = makeSock(); // accepted from the real peer
    const sockImpostor = makeSock();    // accepted from anyone at all

    recordAnnounce({ endpoint: establishedEndpoint, dialed: false, socket: sockEstablished, sid: peerSid, initiatorSid: peerSid, meta: {} });
    recordAnnounce({ endpoint: impostorEndpoint, dialed: false, socket: sockImpostor, sid: peerSid, initiatorSid: peerSid, meta: {} });

    const losers = convergePairBySid(peerSid);
    expect(losers).not.toBeNull();
    expect(losers!.map((l) => l.socket)).toContain(sockImpostor);
    expect(losers!.map((l) => l.socket)).not.toContain(sockEstablished);
    expect(sockEstablished.close).not.toHaveBeenCalled();
    expect(sockImpostor.close).toHaveBeenCalledWith(WIRE_CLOSE_SUPERSEDED, 'superseded');
  });

  it('Test B: parseWireTarget retains wss:// (and https://) in dialBase for the reconnect loop', () => {
    // The reconnect loop reuses the dialBase parseWireTarget derived — it
    // must carry the ORIGINAL scheme so a TLS-only deployment does not
    // silently fall back to ws:// on a redial (Fix #2). A bare host:port key
    // cannot recover the scheme, so the closed-over dialBase is the only
    // source of truth. Assert all four accepted scheme spellings.
    const wss = parseWireTarget('wss://remote.example.com:3191')!;
    expect(wss.endpoint).toBe('remote.example.com:3191');
    expect(wss.dialBase).toBe('wss://remote.example.com:3191/peer/ws');
    expect(wss.probeUrl).toBe('https://remote.example.com:3191/health');

    const https = parseWireTarget('https://remote.example.com:3191')!;
    expect(https.dialBase).toBe('wss://remote.example.com:3191/peer/ws');

    const ws = parseWireTarget('ws://remote.example.com:3191')!;
    expect(ws.dialBase).toBe('ws://remote.example.com:3191/peer/ws');

    const bare = parseWireTarget('remote.example.com:3191')!;
    expect(bare.dialBase).toBe('ws://remote.example.com:3191/peer/ws'); // bare → plain ws (documented default)

    // The dialBase is what scheduleRedial threads through attemptRedial →
    // dialSocket; the scheme survives the close→redial boundary because it
    // is closed over, not reconstructed from the endpoint key.
    expect(wss.dialBase.startsWith('wss://')).toBe(true);
  });

  it('Test D: peer_disconnect after convergence tears down BOTH endpoints and leaves no redial', async () => {
    // THE REAL RACE (review round-2 finding 2): the prior Test D manually
    // pruned the loser before the disconnect logic, so it never tested the
    // two-live-endpoints state in which the round-2 bug occurs. This version
    // leaves BOTH sockets registered when the whole-pair teardown runs — a
    // genuine convergence window where one peer sid spans two endpoint keys.
    //
    // A simultaneous mutual dial: the socket WE dialed is keyed by the URL
    // we typed (survivorEndpoint); the socket we ACCEPTED is keyed by the
    // endpoint the peer announced (loserEndpoint). Both announce the same
    // peer sid. sidIndex points at the most-recent announce (loserEndpoint),
    // so a single-endpoint disconnect would visit ONLY loserEndpoint and
    // leave survivorEndpoint's socket live.
    const survivorEndpoint = '127.0.0.1:3195';
    const loserEndpoint = '192.168.1.20:3195';
    const peerSid = 'peer-disconnect-both';

    const sockA = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    const sockB = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    recordAnnounce({ endpoint: survivorEndpoint, dialed: true, socket: sockA, sid: peerSid, initiatorSid: SID_SELF, meta: {} });
    recordAnnounce({ endpoint: loserEndpoint, dialed: false, socket: sockB, sid: peerSid, initiatorSid: peerSid, meta: {} });
    // Convergence elects sockA (smaller initiatorSid) and closes sockB with
    // 4000 — but its close event has NOT run yet (the race window), so BOTH
    // endpoint entries are still live in the registry.
    convergePairBySid(peerSid);

    // PRE-CONDITION: the genuine two-endpoint state. Both endpoints hold the
    // peer sid; sidIndex points at the loser (most-recent announce); BOTH
    // sockets are still registered.
    expect(findByEndpoint(survivorEndpoint)).not.toBeNull();
    expect(findByEndpoint(loserEndpoint)).not.toBeNull();
    expect(hasLiveWireForEndpoint(survivorEndpoint)).toBe(true);
    expect(hasLiveWireForEndpoint(loserEndpoint)).toBe(true);
    expect(endpointOfSid(peerSid)).toBe(loserEndpoint); // sidIndex → loser
    // endpointsForSid MUST see BOTH endpoints (the whole logical peer),
    // not just the one sidIndex points at — this is the primitive
    // disconnectPeer now relies on.
    const allEndpoints = endpointsForSid(peerSid).sort();
    expect(allEndpoints).toEqual([loserEndpoint, survivorEndpoint].sort());
    expect(allEndpoints.length).toBe(2);

    // WHOLE-PAIR teardown (the path disconnectPeer now drives): for every
    // endpoint holding the sid, bye each live socket then teardownPair.
    // pruneSocket is NOT called first — the sockets are still registered,
    // exactly as in the race. teardownPair removes the entry + its sockets
    // from the census regardless of socket identity (pair gone by
    // declaration).
    let sentBye = 0;
    for (const ep of allEndpoints) {
      const pair = findByEndpoint(ep);
      if (!pair) continue;
      for (const s of [...pair.sockets]) {
        if (s.socket.readyState === s.socket.OPEN) {
          try { s.socket.close(WIRE_CLOSE_BYE, 'bye'); sentBye++; } catch { /* closing */ }
        }
      }
      teardownPair(ep);
    }
    expect(sentBye).toBe(2); // bye reached BOTH live sockets

    // POST-CONDITION: BOTH endpoint entries gone, sid lookup gone, no live
    // wire anywhere — the whole logical peer is terminated from a state
    // where two endpoints were simultaneously live.
    expect(findByEndpoint(survivorEndpoint)).toBeNull();
    expect(findByEndpoint(loserEndpoint)).toBeNull();
    expect(findBySid(peerSid)).toBeNull();
    expect(endpointOfSid(peerSid)).toBeUndefined();
    expect(endpointsForSid(peerSid)).toEqual([]);
    expect(hasLiveWireForEndpoint(survivorEndpoint)).toBe(false);
    expect(hasLiveWireForEndpoint(loserEndpoint)).toBe(false);
    expect(listRemotePeers().length).toBe(0);
  });

  it('Test D (API path): disconnectPeer by sid tears down a convergence-window pair end-to-end', async () => {
    // End-to-end coverage of the actual disconnectPeer API (bye-send +
    // loop-disposal + whole-pair teardown) in a two-socket convergence
    // setup. The first dial establishes the survivor; a second accepted
    // socket announces the SAME remote sid under a different endpoint,
    // creating the two-endpoint state. disconnectPeer(SID) must close bye
    // on both live sockets, dispose both loops, and tear down both pairs.
    await connectPeer(remote.endpoint); // establishes the survivor (dialed)
    expect(hasLiveWireForEndpoint(remote.endpoint)).toBe(true);

    // Inject a second socket for the SAME remote sid under a different
    // endpoint (the accepted half of a mutual dial). Both sockets are live.
    const secondEndpoint = '10.0.0.99:3195';
    const sock2 = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    recordAnnounce({ endpoint: secondEndpoint, dialed: false, socket: sock2, sid: SID_REMOTE, initiatorSid: SID_REMOTE, meta: {} });
    expect(hasLiveWireForEndpoint(secondEndpoint)).toBe(true);
    expect(endpointsForSid(SID_REMOTE).sort()).toEqual([remote.endpoint, secondEndpoint].sort());

    const result = await disconnectPeer(SID_REMOTE);
    expect(result).toContain('hung up');
    expect(result).toContain(SID_REMOTE);
    // The message reports the multi-endpoint teardown (both pairs torn down).
    expect(result).toContain('2 pairs torn down');

    // Both endpoints gone; sid lookup gone; no live wire.
    expect(findByEndpoint(remote.endpoint)).toBeNull();
    expect(findByEndpoint(secondEndpoint)).toBeNull();
    expect(findBySid(SID_REMOTE)).toBeNull();
    expect(hasLiveWireForEndpoint(remote.endpoint)).toBe(false);
    expect(hasLiveWireForEndpoint(secondEndpoint)).toBe(false);
    // The injected second socket received a bye (4001).
    expect(sock2.close).toHaveBeenCalledWith(WIRE_CLOSE_BYE, 'bye');
    // The real dialed socket was also closed by the disconnect.
    await vi.waitFor(() => {
      expect(remote.sockets[0].readyState).toBe(remote.sockets[0].CLOSED);
    });
  }, 20_000);
});
