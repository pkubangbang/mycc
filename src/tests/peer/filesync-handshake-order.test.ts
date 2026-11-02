/**
 * Live-order reproduction of the daemon handshake (PR #38 P1 follow-up).
 *
 * The isolated crypto test passed but the DAEMONS never became partners. The
 * difference is the ORDER a daemon runs in: the socket is opened, the peer's
 * announce arrives, recordAnnounce registers it — then handlePeerShares runs
 * and must challenge over THAT socket. This test drives exactly that sequence
 * through the real ws server and the real registry, so a broken link
 * (registration order, sid mismatch, challenge send) fails here instead of in
 * a live sim.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import * as reg from '../../peer/wire-registry.js';
import { handlePeerShares } from '../../peer/filesync/wire-codec.js';

const SHARE = 'simtest1';

afterEach(() => { /* sockets are closed per test */ });

describe('daemon-order share handshake', () => {
  it('challenges over the announcing socket and grants membership on proof', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    const me = new WebSocket(`ws://127.0.0.1:${port}`);
    const peer = await new Promise<WebSocket>((r) => wss.once('connection', (s) => r(s)));
    await new Promise<void>((r) => me.once('open', () => r()));

    const received: string[] = [];
    peer.on('message', (d: Buffer) => received.push(d.toString()));

    reg.setWireHooks({
      getSessionId: () => 'SELF', getWorkDir: () => '/tmp', getDaemon: () => false,
      getRole: () => undefined, getShares: () => [SHARE], getServingEndpoint: () => null,
      recordRemotePeerTodo: () => {}, appendLocalMail: () => {}, verbose: () => {},
    });

    // 1. The peer announces (exactly what peer-wire.ts handles).
    const sid = 'PEERLIVE1234';
    reg.recordAnnounce({
      endpoint: 'peer:1', dialed: false, socket: me, sid, initiatorSid: sid, meta: {},
    });
    // 2. Then the announce-shares hook runs (peer-wire.ts:309).
    const target = {
      onControlFrame: () => {}, onDataFrame: () => {},
      localShares: () => [SHARE], onPartnerShares: () => {},
    };
    const challenged = handlePeerShares(target, sid, [reg.shareTag(SHARE)]);
    await new Promise((r) => setTimeout(r, 100));

    expect(challenged).toBe(true);
    expect(received.length).toBe(1);
    const ch = JSON.parse(received[0]!) as { type: string; challenge: string };
    expect(ch.type).toBe('share-challenge');

    // 3. The peer replies with the correct proof → membership.
    const proof = [{ tag: reg.shareTag(SHARE), proof: reg.shareProof(SHARE, ch.challenge) }];
    expect(reg.confirmShareChallenges(sid, ch.challenge, proof)).toEqual([SHARE]);
    expect(reg.partnersForShare(SHARE)).toContain(sid);

    me.close(); peer.close(); wss.close();
  });
});
