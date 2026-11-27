/**
 * serve-web-stack-routes.test.ts - the routes and the upgrade split in
 * serve-web-stack.ts, pinned WITHOUT a live tmux session.
 *
 * WHY THIS FILE EXISTS (issue #10, "unpinned web-stack routes"): the only
 * coverage for these routes lived in live-tmux integration tests
 * (serve-health.test.ts, serve-public-static.test.ts), which SKIP when tmux or
 * the global `mycc` command is unavailable. So on CI — and on any box without
 * tmux — the whole module was unguarded, and a silent route-ORDER regression
 * would not fail anything. That is the same class of hole that let the dead
 * /clear branch sit in serve-hub.ts unnoticed: a test that never runs is a
 * comment.
 *
 * The extraction into serve-web-stack.ts is what makes this testable at all:
 * `mountWebStack(host, port, bindHost)` takes its whole surface from a host
 * object, so a test can supply one without a ServeHub, a steering manager or a
 * real transcript.
 *
 * WHAT IS PINNED, in the order the header of the module states them:
 *   (a) ROUTE ORDER. /health and /dump are registered BEFORE
 *       viteServer.middlewares (a watchdog must answer while Vite compiles);
 *       /, /history and /config AFTER it (they need Vite's HTML transform /
 *       the static middleware chain). This is a correctness property, not a
 *       style one: moving /health behind the Vite middlewares makes it hang
 *       while Vite is still warming up, which is exactly the "is the server
 *       dead?" false alarm /health exists to prevent.
 *   (b) REAL HTTP BEHAVIOUR on an ephemeral port: /health, /config, /dump and
 *       /history's ETag/304 path — including an EMPTY 304 body and the fact
 *       that the tag CHANGES when the transcript grows (the property
 *       `maxSeqOfRecords` exists for). Nothing outside a tmux session pinned
 *       the 304 before this file.
 *   (c) THE UPGRADE SPLIT: '/peer/ws' goes to the peer-wire acceptor and NEVER
 *       to the chat server; '/ws' goes to the chat server; every other URL is
 *       left alone (Vite HMR owns '/'). The order of those two guards inside
 *       one handler is the whole bug surface.
 *   (d) DISPOSE IDEMPOTENCY: `dispose()` twice does not throw and does not skip
 *       releasing the acceptor / the http server.
 *
 * DELIBERATE MOCK BOUNDARY: `vite`, `@vitejs/plugin-vue`, the `ws` server
 * constructor and `http.createServer` are replaced so no watcher/esbuild
 * process is spawned, no socket is upgraded, and the test can learn the
 * EPHEMERAL port the stack bound. Everything the assertions READ — Express's
 * own route table, the HTTP responses, the upgrade handler Node actually
 * registered — is real. No fixed port, no network egress, no tmux.
 *
 * WHY `vi.mock('http')` AND NOT `vi.spyOn(http, 'createServer')`: ESM module
 * namespaces are frozen, so `spyOn` throws "Cannot redefine property". The mock
 * below wraps the REAL createServer and records the instance, which is the same
 * observation without touching the namespace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

/** Every http.Server constructed while a stack is mounted (real instances). */
const httpServers: Server[] = [];
/** Every WebSocketServer constructed while a stack is mounted (real instances). */
const wsInstances: unknown[] = [];

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  const createServer = (...args: unknown[]): Server => {
    const server = (actual.createServer as unknown as (...a: unknown[]) => Server)(...args);
    httpServers.push(server);
    return server;
  };
  return { ...actual, createServer, default: { ...actual, createServer } };
});

vi.mock('vite', () => ({
  // The middleware-mode dev server, stubbed to a NAMED function so its layer in
  // Express's route table is identifiable by name (`fakeViteMiddlewares`).
  createServer: async () => ({
    middlewares: function fakeViteMiddlewares(_req: unknown, _res: unknown, next: () => void): void {
      next();
    },
    transformIndexHtml: async (_url: string, html: string) => `<!--vite-->${html}`,
    close: async () => undefined
  })
}));

vi.mock('@vitejs/plugin-vue', () => ({ default: () => ({ name: 'stub-vue' }) }));

vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  const RealServer = actual.WebSocketServer;
  class RecordingWebSocketServer extends RealServer {
    constructor(options?: Record<string, unknown>) {
      super(options as never);
      wsInstances.push(this);
    }
  }
  return { ...actual, WebSocketServer: RecordingWebSocketServer };
});

import { mountWebStack, type WebStackHost } from '../../serve/serve-web-stack.js';
import { ClientRegistry } from '../../serve/serve-clients.js';
import { DisconnectTimer } from '../../serve/serve-disconnect-timer.js';
import { getPeerWireAcceptor, resetPeerWireAcceptor } from '../../serve/peer-wire.js';
import { JsonlTranscriptWriter } from '../../loop/triologue/transcript.js';
import type { HubHandler } from '../../serve/serve-ws-handler.js';
import type { WsEventHost } from '../../serve/serve-ws-events.js';
import type { ServerDiagnostics } from '../../serve/serve-diag.js';

/** A host stub with every field the stack reads, and no ServeHub behind it. */
function makeHost(transcriptPath: string | null): WebStackHost {
  const clients = new ClientRegistry();
  const wsEventHost: WsEventHost = {
    clients,
    disconnectTimer: new DisconnectTimer({ onGenuineDisconnect: () => undefined, onSuspend: () => undefined }, () => false),
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
    port: () => 3210,
    host: () => null,
    messageLog: () => [],
    transcriptPath: () => transcriptPath,
    dumpSnapshot: (capturedAt) => ({
      capturedAt,
      diagnostics: { frames: [], clients: 0, capacity: 0 } as unknown as ServerDiagnostics,
      frames: []
    }),
    wsEventHost: () => wsEventHost,
    hub: {} as HubHandler
  };
}

type LayerLike = { name: string; route?: { path: string } };

/** Express's own mounted stack — the PRIMARY witness for route order. */
function expressLayers(app: unknown): LayerLike[] {
  return (app as { router: { stack: LayerLike[] } }).router.stack;
}

/** Index of the layer Express actually mounted for a route path, or -1. */
function routeIndex(app: unknown, routePath: string): number {
  return expressLayers(app).findIndex((layer) => layer.route?.path === routePath);
}

/** Index of the named middleware layer (the stubbed Vite middlewares). */
function middlewareIndex(app: unknown, name: string): number {
  return expressLayers(app).findIndex((layer) => layer.name === name);
}

describe('mountWebStack() — route registration order and real HTTP behaviour', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let stack: Awaited<ReturnType<typeof mountWebStack>> | null = null;
  let baseUrl = '';
  let server: Server | null = null;

  beforeEach(async () => {
    httpServers.length = 0;
    wsInstances.length = 0;
    resetPeerWireAcceptor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-webstack-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    // Seed ONE durable record so /history takes the transcript branch
    // (records > 0), which is the branch that owns the seq-based ETag.
    const writer = new JsonlTranscriptWriter(transcriptPath);
    writer.append({ kind: 'user', user_origin: true, role: 'user', content: 'first' } as never);

    stack = await mountWebStack(makeHost(transcriptPath), 0, '127.0.0.1');
    server = httpServers[0] ?? null;
    const address = server?.address();
    if (!address || typeof address === 'string') throw new Error('stack did not bind a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await stack?.dispose();
    stack = null;
    server = null;
    resetPeerWireAcceptor();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers /health and /dump BEFORE the Vite middlewares, and / /history /config AFTER (primary witness: Express route table)', () => {
    // The Express app IS the http request listener — read the real mounted table.
    const app = server?.listeners('request')[0];
    expect(app, 'the Express app is the http request listener').toBeTruthy();

    const vite = middlewareIndex(app, 'fakeViteMiddlewares');
    expect(vite, 'the Vite middleware layer is mounted').toBeGreaterThanOrEqual(0);

    // A watchdog must get an answer while Vite is still compiling.
    expect(routeIndex(app, '/health'), '/health is registered').toBeGreaterThanOrEqual(0);
    expect(routeIndex(app, '/dump'), '/dump is registered').toBeGreaterThanOrEqual(0);
    expect(routeIndex(app, '/health'), '/health answers before Vite runs').toBeLessThan(vite);
    expect(routeIndex(app, '/dump'), '/dump answers before Vite runs').toBeLessThan(vite);

    // These three depend on Vite (HTML transform) or follow the static chain.
    for (const route of ['/', '/history', '/config']) {
      expect(routeIndex(app, route), `${route} is registered`).toBeGreaterThanOrEqual(0);
      expect(routeIndex(app, route), `${route} is registered AFTER the Vite middlewares`).toBeGreaterThan(vite);
    }
  });

  it('GET /health answers 200 with the serve block (real HTTP, ephemeral port)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.pid).toBe(process.pid);
    expect(typeof body.uptimeMs).toBe('number');
    expect(typeof body.version).toBe('string');
    const serve = body.serve as Record<string, unknown>;
    expect(serve.port).toBe(3210);
    expect(serve.host).toBeNull();
    expect(serve.clients).toBe(0);
    expect(serve.agentRunning).toBe(false);
    expect(serve.auto).toBe(false);
  });

  it('GET /config answers 200 with the upload cap, persistent flag, verbose capability and mode', async () => {
    const res = await fetch(`${baseUrl}/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.maxUploadMb).toBe('number');
    expect(body.maxUploadMb).toBeGreaterThan(0);
    expect(typeof body.persistent).toBe('boolean');
    expect(typeof body.verbose).toBe('boolean');
    expect(body.mode).toBe('normal');
  });

  it('GET /dump answers 200 with no-store (a dump must never be cached)', async () => {
    const res = await fetch(`${baseUrl}/dump`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.capturedAt).toBe('number');
  });

  it('GET /history sets an ETag; replaying it in If-None-Match yields 304 with an EMPTY body', async () => {
    const first = await fetch(`${baseUrl}/history`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag, '/history must send an ETag').toBeTruthy();
    const firstBody = (await first.json()) as { messages: unknown[] };
    expect(Array.isArray(firstBody.messages)).toBe(true);

    const second = await fetch(`${baseUrl}/history`, { headers: { 'If-None-Match': etag! } });
    expect(second.status).toBe(304);
    // THE CONTRACT IS AN EMPTY BODY, not merely a 304 status: a 304 that still
    // carries a body is malformed and some clients concatenate it onto the
    // cached copy. This is the part a refactor of the route breaks silently.
    expect(await second.text()).toBe('');
  });

  it('the ETag CHANGES when the transcript grows (maxSeqOfRecords is the seq input)', async () => {
    const before = (await fetch(`${baseUrl}/history`)).headers.get('etag');
    expect(before).toBeTruthy();

    // Append through the REAL writer — the same path the loop uses.
    const writer = new JsonlTranscriptWriter(transcriptPath);
    writer.append({ kind: 'user', user_origin: true, role: 'user', content: 'second' } as never);

    const after = await fetch(`${baseUrl}/history`, { headers: { 'If-None-Match': before! } });
    // A client holding the old tag must be given the new body, not a stale 304.
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(before);
  });

  it("routes '/peer/ws' to the peer-wire acceptor and NEVER to the chat server; '/ws' to the chat server; leaves other URLs alone", () => {
    const upgrade = server?.listeners('upgrade')[0] as
      | ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)
      | undefined;
    expect(upgrade, 'the stack registered an upgrade handler').toBeTypeOf('function');
    expect(wsInstances.length, 'chat + peer WebSocketServers were constructed').toBeGreaterThanOrEqual(2);

    // wsInstances[0] is the chat server (constructed first in mountWebStack);
    // the peer-wire acceptor's dedicated server is constructed after it.
    const chatServer = wsInstances[0] as { handleUpgrade: (...a: unknown[]) => void };
    expect(wsInstances[1], "the peer acceptor's own server was constructed").toBeTruthy();

    const chatSpy = vi.spyOn(chatServer, 'handleUpgrade').mockImplementation(() => undefined);
    const acceptorSpy = vi.spyOn(getPeerWireAcceptor(), 'handleUpgrade').mockImplementation(() => undefined);

    const fakeSocket = { write: () => undefined, destroy: () => undefined } as unknown as Duplex;

    // /peer/ws → acceptor only. This is the ordering that matters: if the chat
    // branch were tested first (or the peer branch dropped), peer traffic would
    // be handed to the browser chat server.
    upgrade!({ url: '/peer/ws', headers: {} } as IncomingMessage, fakeSocket, Buffer.alloc(0));
    expect(acceptorSpy).toHaveBeenCalledTimes(1);
    expect(chatSpy).not.toHaveBeenCalled();

    // A query string must not defeat the match (the handler strips it).
    upgrade!({ url: '/peer/ws?room=1', headers: {} } as IncomingMessage, fakeSocket, Buffer.alloc(0));
    expect(acceptorSpy).toHaveBeenCalledTimes(2);
    expect(chatSpy).not.toHaveBeenCalled();

    // /ws → chat server only.
    upgrade!({ url: '/ws', headers: {} } as IncomingMessage, fakeSocket, Buffer.alloc(0));
    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(acceptorSpy).toHaveBeenCalledTimes(2);

    // Any other URL (Vite's HMR socket lives at '/') is NOT ours to handle.
    upgrade!({ url: '/', headers: {} } as IncomingMessage, fakeSocket, Buffer.alloc(0));
    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(acceptorSpy).toHaveBeenCalledTimes(2);

    chatSpy.mockRestore();
    acceptorSpy.mockRestore();
  });

  it('dispose() is idempotent: a second call does not throw and both calls release the acceptor', async () => {
    const acceptorStop = vi.spyOn(getPeerWireAcceptor(), 'stop');
    await stack!.dispose();
    await expect(stack!.dispose()).resolves.toBeUndefined();
    // The acceptor teardown runs on EVERY dispose (it is null-safe) — this is
    // what lets the mount-catch path release a half-built stack.
    expect(acceptorStop).toHaveBeenCalledTimes(2);
    acceptorStop.mockRestore();

    // And the port is genuinely released: a fresh server can bind it.
    const address = server?.address();
    if (address && typeof address !== 'string') {
      const probe = net.createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(address.port, '127.0.0.1', () => resolve());
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });
});
