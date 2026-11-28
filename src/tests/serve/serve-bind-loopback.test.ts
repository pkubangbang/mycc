/**
 * serve-bind-loopback.test.ts — the END-TO-END regression for the wildcard
 * bind: mount the REAL stack with `bindHost = null` (no `--host`) and assert
 * the socket is loopback-only.
 *
 * v0.9.7 → v0.11.12: `mountWebStack` fell through to `server.listen(port)`,
 * which binds 0.0.0.0/::. On this dev box that made the unauthenticated /ws +
 * /dump + /history reachable over a WireGuard tunnel peer (10.0.1.1 could
 * connect to 3173). The fix routes `null` through `listeningAddress()` →
 * 127.0.0.1. This test would have failed at every one of those versions.
 *
 * Witness: `server.address()` — the OS-level truth about the bound address,
 * not the banner text and not our own resolution helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';

// Record every http.createServer() so we can inspect the socket it bound.
const httpServers: Server[] = [];
vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  const createServer = (...args: unknown[]): Server => {
    const server = (actual.createServer as unknown as (...a: unknown[]) => Server)(...args);
    httpServers.push(server);
    return server;
  };
  // `default` matters: serve-web-stack.ts does `import http from 'http'`, so a
  // namespace-only mock would leave the DEFAULT import pointing at the real,
  // unwrapped createServer and the recording would stay empty.
  return { ...actual, createServer, default: { ...actual, createServer } };
});

// Vite is not needed to prove a bind address — stub it out (same shape the
// route test uses) so this test stays fast and dependency-free.
vi.mock('vite', () => ({
  createServer: vi.fn(async () => ({
    middlewares: (_req: unknown, _res: unknown, next: () => void) => next(),
    close: vi.fn(async () => undefined)
  }))
}));

vi.mock('@vitejs/plugin-vue', () => ({ default: () => ({}) }));

vi.mock('ws', async () => {
  const actual = await vi.importActual<typeof import('ws')>('ws');
  class RecordingWebSocketServer extends actual.WebSocketServer {
    constructor(options?: Record<string, unknown>) {
      super(options as never);
    }
  }
  return { ...actual, WebSocketServer: RecordingWebSocketServer };
});

import { mountWebStack, type WebStackHost } from '../../serve/serve-web-stack.js';
import { ClientRegistry } from '../../serve/serve-clients.js';
import { DisconnectTimer } from '../../serve/serve-disconnect-timer.js';
import { resetPeerWireAcceptor } from '../../serve/peer-wire.js';
import type { HubHandler } from '../../serve/serve-ws-handler.js';
import type { WsEventHost } from '../../serve/serve-ws-events.js';
import type { ServerDiagnostics } from '../../serve/serve-diag.js';

function makeHost(): WebStackHost {
  const clients = new ClientRegistry();
  const wsEventHost: WsEventHost = {
    clients,
    disconnectTimer: new DisconnectTimer(
      { onGenuineDisconnect: () => undefined, onSuspend: () => undefined },
      () => false
    ),
    isRunning: () => true,
    replayConnectionState: () => undefined,
    recordInboundFrame: () => undefined,
    clearPendingDiagFrame: () => undefined,
    dispatch: () => undefined
  };
  return {
    clients,
    getMode: () => 'normal',
    getAutoState: () => false,
    isRunning: () => true,
    agentRunning: () => false,
    port: () => 0,
    host: () => null,
    messageLog: () => [],
    transcriptPath: () => null,
    dumpSnapshot: (capturedAt) => ({
      capturedAt,
      diagnostics: { frames: [], clients: 0, capacity: 0 } as unknown as ServerDiagnostics,
      frames: []
    }),
    wsEventHost: () => wsEventHost,
    hub: {} as HubHandler
  };
}

describe('mountWebStack() bind address — loopback by default', () => {
  let tmpDir: string;
  let stack: Awaited<ReturnType<typeof mountWebStack>> | null = null;

  beforeEach(() => {
    httpServers.length = 0;
    resetPeerWireAcceptor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-bind-'));
  });

  afterEach(async () => {
    await stack?.dispose();
    stack = null;
    resetPeerWireAcceptor();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('binds 127.0.0.1 — NOT 0.0.0.0/:: — when --host is absent (bindHost null)', async () => {
    stack = await mountWebStack(makeHost(), 0, null);
    const server = httpServers[0];
    expect(server, 'the stack created an http server').toBeTruthy();
    const address = server!.address();
    expect(address && typeof address !== 'string', 'a TCP port is bound').toBe(true);
    const { address: boundIp, family } = address as { address: string; family: string };
    // The OS truth: loopback only. A wildcard bind reports '0.0.0.0' or '::'.
    expect(boundIp, `bound address must be loopback, got ${boundIp} (${family})`).toBe('127.0.0.1');
    expect(boundIp).not.toBe('0.0.0.0');
    expect(boundIp).not.toBe('::');
  });

  it('honours an explicit --host instead of forcing loopback', async () => {
    stack = await mountWebStack(makeHost(), 0, '127.0.0.1');
    const address = httpServers[0]?.address();
    expect((address as { address: string }).address).toBe('127.0.0.1');
  });
});
