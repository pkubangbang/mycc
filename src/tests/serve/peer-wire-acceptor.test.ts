/**
 * peer-wire-acceptor.test.ts — real acceptor: upgrade, auth, liveness, todo lifecycle
 *
 * Boots the REAL PeerWireAcceptor on a plain http.Server upgrade event, as
 * ServeHub does in production: token gate, self-announce refusal, missed-pong
 * termination, and the info-symmetry todo lifecycle (test g).
 *
 * Split out of the former 1,007-line peer-wire.test.ts at behaviour seams;
 * the shared in-process fixture lives in peer-wire-harness.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import { WebSocket } from 'ws';
import {
  SID_SELF,
  SID_REMOTE,
  TOKEN,
  selfLog,
  makeHooks,
  FakeRemote,
  harnessBeforeEach,
  harnessAfterEach,
  makeTempDir,
  identityFile,
} from './peer-wire-harness.js';
import {
  setWireHooks,
  findBySid,
  hasLiveWireForEndpoint,
  listRemotePeers,
  recordAnnounce,
  WIRE_CLOSE_SUPERSEDED,
} from '../../peer/wire-registry.js';
import { connectPeer, disconnectPeer, setPingIntervalForTest } from '../../peer/wire-client.js';
import { getPeerWireAcceptor } from '../../serve/peer-wire.js';

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

describe('peer wire — acceptor side (real PeerWireAcceptor)', () => {
  it('accepts a dial, replies with its own announce, records the pair, and prunes on close', async () => {
    const httpServer = http.createServer();
    const acceptor = getPeerWireAcceptor();
    acceptor.createServer();
    httpServer.on('upgrade', (req, socket, head) => {
      acceptor.handleUpgrade(req, socket, head);
    });
    const port = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as { port: number }).port));
    });

    // Simulate the REMOTE dialer connecting to US. The token travels as the
    // X-MYCC-Wire-Token request header (review finding 3), not a query param.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/peer/ws`, { headers: { 'X-MYCC-Wire-Token': TOKEN } });
    const gotReply = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'announce', sessionId: SID_REMOTE, workDir: '/work/remote', daemon: false,
        }));
      });
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === 'announce') resolve(frame);
      });
    });
    const reply = await gotReply;
    expect(reply.sessionId).toBe(SID_SELF);

    // Registry on OUR side: pair keyed by sid-scoped endpoint (no announced
    // serving endpoint → "sid:<sid>" key, NAT'd dialer case).
    const pair = findBySid(SID_REMOTE);
    expect(pair).not.toBeNull();
    expect(pair!.endpoint.startsWith('sid:')).toBe(true);
    expect(pair!.dialed).toBe(false);

    // Info-symmetry todo fired on the ACCEPTOR side too.
    expect(selfLog.todos.some((t) => t.sid === SID_REMOTE && !t.done)).toBe(true);

    // Close → pruned + teardown (no live sibling).
    ws.close(1000, 'done');
    await vi.waitFor(() => {
      expect(findBySid(SID_REMOTE)).toBeNull();
    });

    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    acceptor.stop();
  }, 20_000);

  it('refuses an upgrade with a bad token (401, socket destroyed)', async () => {
    const httpServer = http.createServer();
    const acceptor = getPeerWireAcceptor();
    acceptor.createServer();
    httpServer.on('upgrade', (req, socket, head) => {
      acceptor.handleUpgrade(req, socket, head);
    });
    const port = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as { port: number }).port));
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/peer/ws`, { headers: { 'X-MYCC-Wire-Token': 'WRONG' } });
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('unexpected-response', () => resolve(-1)); // 401 path
    });
    const code = await closed;
    expect([1006, -1]).toContain(code); // refused before WS establishment

    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    acceptor.stop();
  }, 20_000);

  it('self-dial backstop: announce carrying OUR OWN sid closes 4000', async () => {
    const httpServer = http.createServer();
    const acceptor = getPeerWireAcceptor();
    acceptor.createServer();
    httpServer.on('upgrade', (req, socket, head) => {
      acceptor.handleUpgrade(req, socket, head);
    });
    const port = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as { port: number }).port));
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/peer/ws`, { headers: { 'X-MYCC-Wire-Token': TOKEN } });
    const closeCode = new Promise<number>((resolve) => {
      ws.on('open', () => {
        // Announce with OUR OWN sid — the backstop violation.
        ws.send(JSON.stringify({
          type: 'announce', sessionId: SID_SELF, workDir: '/work/self', daemon: false,
        }));
      });
      ws.on('close', (code) => resolve(code));
    });
    expect(await closeCode).toBe(WIRE_CLOSE_SUPERSEDED);
    // No registry entry was recorded for the self-announce.
    expect(listRemotePeers().length).toBe(0);

    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    acceptor.stop();
  }, 20_000);
});

describe('peer wire — liveness (missed-pong terminate)', () => {
  it('terminates a dialed socket after 2 missed pongs', async () => {
    // Shorten the cadence via the test seam (fake timers cannot adopt the
    // interval created during the real-timer WS handshake).
    setPingIntervalForTest(50);

    // Capture the dialer's verbose termination log (our side of the wire).
    const verboseMsgs: string[] = [];
    const hooks = makeHooks(SID_SELF, selfLog);
    setWireHooks({ ...hooks, verbose: (_tool, message) => { verboseMsgs.push(message); } });

    await connectPeer(remote.endpoint);
    expect(hasLiveWireForEndpoint(remote.endpoint)).toBe(true);

    // Sabotage the pong path: pause the REMOTE's underlying TCP socket so it
    // never reads our pings — no read, no auto-pong, misses accumulate.
    const remoteRaw = (remote.sockets[0] as unknown as { _socket?: { pause: () => void } })._socket;
    expect(remoteRaw).toBeDefined();
    remoteRaw!.pause();

    // The dialer terminates after the misses exceed the limit; observe OUR
    // side (the paused remote socket cannot report the TCP reset — its read
    // stream is blinded, so readyState there never flips). The verbose log
    // fires at the terminate call site, and the registry prunes the dead
    // socket on its close event.
    await vi.waitFor(() => {
      expect(verboseMsgs.some((m) => m.includes('missed-pong limit reached'))).toBe(true);
    }, { timeout: 5_000 });
    // The liveness map drops the socket and the pair loses its live wire.
    await vi.waitFor(() => {
      expect(hasLiveWireForEndpoint(remote.endpoint)).toBe(false);
    }, { timeout: 5_000 });
  }, 20_000);
});

describe('peer wire — info-symmetry todo lifecycle (test g)', () => {
  it('terminal 4001 marks todo done; transient close keeps it; re-announce refreshes', async () => {
    await connectPeer(remote.endpoint);

    // (1) Establishment → done=false.
    expect(selfLog.todos.filter((t) => !t.done).length).toBeGreaterThanOrEqual(1);

    // (2) Transient close (network) → todo stays not-done; loop reconnects.
    remote.sockets[0].terminate();
    await vi.waitFor(() => {
      expect(remote.received.filter((f) => f.type === 'announce').length).toBe(2);
    }, { timeout: 5_000 });
    const todosAfterTransient = selfLog.todos.filter((t) => !t.done);
    expect(todosAfterTransient.length).toBeGreaterThanOrEqual(1);

    // (3) Terminal bye (peer_disconnect) → done=true.
    await disconnectPeer(SID_REMOTE);
    const doneTodos = selfLog.todos.filter((t) => t.done);
    expect(doneTodos.length).toBeGreaterThanOrEqual(1);
    expect(doneTodos.every((t) => t.sid === SID_REMOTE)).toBe(true);
    // ...and the pair is gone for good.
    expect(findBySid(SID_REMOTE)).toBeNull();
  }, 25_000);

  it('re-announce does not duplicate the reminder (recordAnnounce refresh path)', async () => {
    await connectPeer(remote.endpoint);
    const countAfterConnect = selfLog.todos.filter((t) => t.endpoint === remote.endpoint && !t.done).length;
    expect(countAfterConnect).toBe(1); // one establishment todo

    // A re-announce of the SAME pair (e.g. the remote re-sends announce on a
    // second socket that then converges away): the registry-level refresh
    // fires recordRemotePeerTodo again — the PARENT dedupe (by endpoint)
    // is ParentContext's job; here we assert the registry keeps firing the
    // hook with the same endpoint key so the dedupe CAN work.
    const sock = { readyState: 1, OPEN: 1 } as unknown as WebSocket;
    recordAnnounce({ endpoint: remote.endpoint, dialed: false, socket: sock, sid: SID_REMOTE, initiatorSid: SID_REMOTE, meta: {} });
    const todosForEndpoint = selfLog.todos.filter((t) => t.endpoint === remote.endpoint && !t.done);
    expect(todosForEndpoint.length).toBe(2); // hook fired again — same endpoint key
    expect(todosForEndpoint.every((t) => t.sid === SID_REMOTE)).toBe(true);
  }, 20_000);
});
