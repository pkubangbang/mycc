/**
 * peer-wire-harness.ts — shared in-process fixture for the peer-wire suites.
 *
 * The peer-wire matrix was split at behaviour seams:
 *   peer-wire-registry.test.ts     — registry invariants (pure index rules)
 *   peer-wire-convergence.test.ts  — convergence / survivor regressions
 *   peer-wire-dialer.test.ts       — probe → dial → announce → mail → disconnect
 *   peer-wire-acceptor.test.ts     — real acceptor + liveness + todo lifecycle
 *
 * What lives here is ONLY the fixture: the config mock payload, the hook log,
 * makeHooks, and the FakeRemote stand-in for the far side of a wire. Each
 * test file keeps its own `vi.mock('../../config.js', …)` call (vitest hoists
 * mocks per test file, so a helper's vi.mock would not reliably apply) and
 * pulls the factory from `configMock()`.
 */

import { expect } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  setWireHooks,
  resetWireRegistry,
  resetSeenMailIds,
} from '../../peer/wire-registry.js';
import { resetWireClient, stopWireClient } from '../../peer/wire-client.js';
import { resetPeerWireAcceptor, PEER_WIRE_MAX_PAYLOAD_BYTES } from '../../serve/peer-wire.js';
import type { WireHooks } from '../../peer/wire-registry.js';

export const SID_SELF = 'aaaa0000-0000-0000-0000-00000000000a'; // lexicographically SMALL
export const SID_REMOTE = 'zzzz0000-0000-0000-0000-00000000000z';
export const TOKEN = 'test-wire-token';

/**
 * Create the per-test temp dir. The CALLER owns the variable: each test file
 * declares `let tempDir = ''` and its `vi.mock('../../config.js', …)` factory
 * closes over that local (vitest hoists mocks, so the binding must live in the
 * test file itself — a helper's variable is not yet initialised when the
 * hoisted factory runs).
 */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wire-'));
}

/** `<tempDir>/discovery/identity.json` — the same-store sid registry. */
export const identityFile = (tempDir: string) => path.join(tempDir, 'discovery', 'identity.json');

/** Collected hook calls for assertions (the "both sides" of test g). */
export interface HookLog {
  todos: Array<{ sid: string; endpoint: string; done: boolean }>;
  mails: Array<{ from: string; title: string; content: string }>;
}
export const selfLog: HookLog = { todos: [], mails: [] };

export function makeHooks(sid: string, log: HookLog): WireHooks {
  return {
    getSessionId: () => sid,
    getWorkDir: () => '/work/self',
    getDaemon: () => false,
    getRole: () => undefined,
    getServingEndpoint: () => null,
    recordRemotePeerTodo: (entry) => { log.todos.push({ ...entry }); },
    appendLocalMail: (from, title, content) => { log.mails.push({ from, title, content }); },
    verbose: () => { /* captured via log above when needed */ },
  };
}

/** A minimal stand-in for the REMOTE side: a /peer/ws server + /health. */
export class FakeRemote {
  server: http.Server;
  wss: WebSocketServer;
  healthHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  /** Frames received from the dialer. */
  received: Array<Record<string, unknown>>;
  /** Sockets accepted. */
  sockets: WebSocket[];
  token: string | null;
  announceSid: string;

  constructor() {
    this.received = [];
    this.sockets = [];
    this.token = TOKEN;
    this.announceSid = SID_REMOTE;
    this.healthHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        peer: { sessionId: this.announceSid, daemon: false },
      }));
    };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: PEER_WIRE_MAX_PAYLOAD_BYTES });
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        this.received.push(frame);
        if (frame.type === 'announce') {
          // The real acceptor replies with its own announce.
          ws.send(JSON.stringify({
            type: 'announce',
            sessionId: this.announceSid,
            workDir: '/work/remote',
            daemon: false,
          }));
        }
      });
    });
    this.server = http.createServer((req, res) => this.healthHandler(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/peer/ws') {
        // Open mode (token === null) mirrors a real acceptor with no
        // MYCC_WIRE_TOKEN configured: accept the upgrade with NO token
        // check. When a token IS configured, a missing/mismatched
        // X-MYCC-Wire-Token header is refused with 401 (the optional in-app
        // auth gate). The token travels as a REQUEST HEADER (review finding
        // 3), NOT a ?token= query param.
        const raw = req.headers['x-mycc-wire-token'];
        const presented = Array.isArray(raw) ? raw[0] : raw;
        const tokenOk = this.token === null || presented === this.token;
        if (!tokenOk) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  get endpoint(): string {
    const addr = this.server.address() as { port: number };
    return `127.0.0.1:${addr.port}`;
  }

  /** Send a mail frame to the FIRST connected socket (the remote→self direction). */
  sendMailToDialer(id: string, title: string, content: string): void {
    const ws = this.sockets.find((s) => s.readyState === s.OPEN);
    expect(ws, 'fake remote must hold an open socket').toBeTruthy();
    ws!.send(JSON.stringify({
      type: 'mail', id, from: `${SID_REMOTE}/lead`, title, content, timestamp: Date.now(),
    }));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const ws of this.sockets) { try { ws.terminate(); } catch { /* ignore */ } }
      this.wss.close(() => undefined);
      this.server.close(() => resolve());
    });
  }
}
/**
 * Per-file beforeEach: fresh temp dir, clean registry/client/acceptor state,
 * wire env, self hooks, and a listening FakeRemote.
 */
export async function harnessBeforeEach(tempDir: string): Promise<FakeRemote> {
  fs.mkdirSync(path.join(tempDir, 'discovery'), { recursive: true });
  selfLog.todos.length = 0;
  selfLog.mails.length = 0;
  resetWireRegistry();
  resetSeenMailIds();
  resetWireClient();
  resetPeerWireAcceptor();
  process.env.MYCC_WIRE_TOKEN = TOKEN;
  process.env.MYCC_WIRE_ALLOW_LOCAL = '1'; // in-process suite shares the mocked store
  setWireHooks(makeHooks(SID_SELF, selfLog));
  const remote = new FakeRemote();
  await remote.listen();
  return remote;
}

/** Per-file afterEach: stop the dialer, close the fake remote, drop env. */
export async function harnessAfterEach(remote: FakeRemote): Promise<void> {
  stopWireClient();
  await remote.close();
  delete process.env.MYCC_WIRE_TOKEN;
  delete process.env.MYCC_WIRE_ALLOW_LOCAL;
}
