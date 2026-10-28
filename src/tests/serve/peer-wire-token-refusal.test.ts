/**
 * peer-wire-token-refusal.test.ts — a wire-token mismatch must be visible on
 * BOTH ends (REPORT row 25).
 *
 * BEFORE: the acceptor destroyed the socket after a bare `HTTP/1.1 401`, so the
 * dialer could only report an abnormal close and its redial loop retried a
 * permanently-broken configuration forever; the accepting side logged nothing
 * a human would see.
 *
 * AFTER:
 *   - the acceptor answers the handshake with WIRE_CLOSE_UNAUTHORIZED and
 *     briefs the operator (it cannot send a WS close frame — the upgrade never
 *     completed, so the status line IS the only evidence the dialer can get);
 *   - the dialer reads that status from `unexpected-response`, turns 401 into
 *     an actionable message, and STOPS the redial loop for the endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import { WebSocket } from 'ws';
import {
  selfLog,
  makeHooks,
  harnessBeforeEach,
  harnessAfterEach,
  FakeRemote,
  makeTempDir,
  identityFile,
} from './peer-wire-harness.js';
import {
  setWireHooks,
  WIRE_CLOSE_UNAUTHORIZED,
  type WireHooks,
} from '../../peer/wire-registry.js';
import { getPeerWireAcceptor } from '../../serve/peer-wire.js';
import { connectPeer } from '../../peer/wire-client.js';

let tempDir = '';
vi.mock('../../config.js', () => ({
  getDiscoveryDir: () => path.join(tempDir, 'discovery'),
  getIdentityFile: () => identityFile(tempDir),
  isWireDebugLocal: () => true, // same-store/self dial is allowed in-process
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

/** Hooks with the optional refusal brief captured. */
function hooksWithBriefing(refusals: string[]): WireHooks {
  const base = makeHooks('aaaa0000-0000-0000-0000-00000000000a', selfLog);
  return {
    ...base,
    briefPeerWireRefusal: (reason) => { refusals.push(reason); },
  };
}

describe('wire token mismatch — visible on both ends', () => {
  it('the acceptor refuses with 401 and briefs the operator', async () => {
    const refusals: string[] = [];
    setWireHooks(hooksWithBriefing(refusals));

    process.env.MYCC_WIRE_TOKEN = 'acceptor-token';
    const httpServer = http.createServer();
    const acceptor = getPeerWireAcceptor();
    acceptor.createServer();
    httpServer.on('upgrade', (req, socket, head) => acceptor.handleUpgrade(req, socket, head));
    const port = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as { port: number }).port));
    });

    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/peer/ws`, {
        headers: { 'X-MYCC-Wire-Token': 'some-other-token' },
      });
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on('open', () => reject(new Error('mismatched token must not be accepted')));
      ws.on('error', () => { /* the unexpected-response path settles first */ });
    });

    expect(status).toBe(WIRE_CLOSE_UNAUTHORIZED);
    expect(refusals.join(' ')).toMatch(/token mismatch/);

    acceptor.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 20_000);

  it('the acceptor refuses a missing token with the same code and reason', async () => {
    const refusals: string[] = [];
    setWireHooks(hooksWithBriefing(refusals));

    process.env.MYCC_WIRE_TOKEN = 'acceptor-token';
    const acceptor = getPeerWireAcceptor();
    acceptor.createServer();
    const httpServer = http.createServer();
    httpServer.on('upgrade', (req, socket, head) => acceptor.handleUpgrade(req, socket, head));
    const port = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as { port: number }).port));
    });

    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/peer/ws`); // no token header
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on('error', () => { /* handled by unexpected-response */ });
    });

    expect(status).toBe(WIRE_CLOSE_UNAUTHORIZED);
    expect(refusals.join(' ')).toMatch(/token required but not sent/);

    acceptor.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 20_000);
});

describe('wire token mismatch — DIALER side (connectPeer must settle)', () => {
  function refusingServer(status: number, phrase: string): { url: Promise<string>; close: () => Promise<void> } {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', peer: { sessionId: 'zzzz0000-0000-0000-0000-00000000000z', daemon: false } }));
    });
    server.on('upgrade', (_req, socket) => {
      socket.write(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    });
    const url = new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        resolve(`127.0.0.1:${port}`);
      });
    });
    return {
      url,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('settles with the actionable unauthorized message (regression: used to hang)', async () => {
    // A listener on `unexpected-response` suppresses ws's internal
    // abortHandshake, so unless the dialer terminates the socket itself the
    // refused upgrade never emits `close` and connectPeer hangs forever.
    const srv = refusingServer(WIRE_CLOSE_UNAUTHORIZED, 'Unauthorized');
    const endpoint = await srv.url;

    const result = await connectPeer(endpoint);

    expect(result).toMatch(/not established/);
    expect(result).toMatch(/unauthorized/);
    expect(result).toMatch(/SAME value on both instances/);
    await srv.close();
  }, 20_000);

  it('settles for a non-401 refusal too (503 wire server not running)', async () => {
    const srv = refusingServer(503, 'Service Unavailable');
    const endpoint = await srv.url;

    const result = await connectPeer(endpoint);

    expect(result).toMatch(/not established/);
    await srv.close();
  }, 20_000);
});
