/**
 * serve-web-stack.ts — the Express + Vite + WebSocket plumbing for `/serve`,
 * extracted verbatim from serve-hub.ts.
 *
 * SCOPE: this module owns *building and tearing down* the HTTP stack and the
 * `/health`, `/dump`, `/history`, `/config` routes. It is deliberately
 * STATELESS about lifecycle: it never sets `running`, never publishes the
 * WebUI up/down seam, never touches the disconnect timer or the input bridge.
 * The caller (ServeLifecycleState via ServeHub) drives it.
 *
 * Why extracted: these ~380 lines are pure wiring. Interleaved with the
 * input/card/steering bridges they buried the hub's actual state machine under
 * Express middleware and comment walls — the bug class that motivated the
 * split (a dead `/clear` branch) was invisible for exactly that reason.
 */

import express from 'express';
import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, type WebSocket } from 'ws';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import type { ViteDevServer as ViteServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { agentIO } from '../loop/agent-io.js';
import { getMaxUploadMb, shouldDaemon, getApiProvider, isVerbose } from '../config.js';
import { getSteeringManager } from '../loop/steering-manager.js';
import type { LogEntry } from './serve-types.js';
import {
  computeClearBoundarySeq,
  computeHistoryVersion,
  etagMatchesIfNoneMatch,
  maxSeqOfRecords,
  projectDisplayRecords,
  readTranscriptRecords
} from './serve-history.js';
import { ClientRegistry } from './serve-clients.js';
import { onWsConnection, type WsEventHost } from './serve-ws-events.js';
import type { HubHandler } from './serve-ws-handler.js';
import { getPeerWireAcceptor } from './peer-wire.js';
import { getWireHooks } from '../peer/wire-registry.js';
import type { ServerDiagnostics } from './serve-diag.js';
import pkg from '../../package.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

/** Everything the stack needs from the hub, by reference or by closure. */
export interface WebStackHost {
  readonly clients: ClientRegistry;
  readonly getMode: () => 'plan' | 'normal';
  readonly getAutoState: () => boolean;
  readonly isRunning: () => boolean;
  readonly agentRunning: () => boolean;
  /** The current port binding (0 before the first start). */
  readonly port: () => number;
  /** The explicit `--host` binding (null = localhost-only). */
  readonly host: () => string | null;
  /** The serve-lifetime fallback log served by /history before the first record. */
  readonly messageLog: () => readonly LogEntry[];
  /** The durable transcript path, or null when the loop has not bound one. */
  readonly transcriptPath: () => string | null;
  readonly dumpSnapshot: (capturedAt: number) => {
    capturedAt: number;
    diagnostics: ServerDiagnostics;
    frames: unknown[];
  };
  /** The narrow surface the WS connection/close/error handlers may touch. */
  readonly wsEventHost: () => WsEventHost;
  /** The hub itself, for `handleWsMessage` (it implements HubHandler). */
  readonly hub: HubHandler;
}

/**
 * The live handles of a mounted stack. `dispose()` is idempotent and null-safe
 * at every step; it releases resources WITHOUT touching lifecycle state.
 */
export interface WebStack {
  dispose(): Promise<void>;
}

/**
 * Build the Express app, the Vite dev server (middleware mode, same port) and
 * the `ws` chat server, register every HTTP route, and resolve once the HTTP
 * server is listening. Throws after releasing whatever was already allocated.
 */
export async function mountWebStack(host: WebStackHost, port: number, bindHost: string | null): Promise<WebStack> {
  let httpServer: http.Server | null = null;
  let viteServer: ViteDevServer | null = null;
  let wsServer: WebSocketServer | null = null;
  let upgradeHandler: ((req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => void) | null = null;

  const dispose = async (): Promise<void> => {
    if (httpServer && upgradeHandler) {
      httpServer.removeListener('upgrade', upgradeHandler);
      upgradeHandler = null;
    }
    if (wsServer) {
      try {
        wsServer.close();
      } catch {
        /* ignore */
      }
      wsServer = null;
    }
    // Peer wire acceptor teardown (docs/peers/remote-peer-protocol.md §2
    // disconnect): abnormal close so the DIALER side fails fast / redials
    // per its loop policy. Idempotent (safe when no server exists).
    try {
      getPeerWireAcceptor().stop();
    } catch {
      /* ignore */
    }
    if (viteServer) {
      try {
        await viteServer.close();
      } catch {
        /* ignore */
      }
      viteServer = null;
    }
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
    }
  };

  try {
    const app = express();
    httpServer = http.createServer(app);

    // Public dir for static assets served at `/` during dev (vite publicDir).
    // Lives under the project's .mycc/ tree (process.cwd()) so per-project
    // static files are co-located with sessions/mindmap/skills.
    const publicDir = path.join(process.cwd(), '.mycc', 'public');
    fs.mkdirSync(publicDir, { recursive: true });

    // Vite in middleware mode — HMR shares the same http server (single port).
    viteServer = await createViteServer({
      root: WEB_ROOT,
      plugins: [vue()],
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
        watch: { ignored: ['**/.mycc/**'] }
      },
      appType: 'custom',
      configFile: false // inline config only — avoid parent vite.config
    });

    // Serve the agent runtime dir <cwd>/.mycc/public at `/`, BEFORE Vite's
    // middlewares so it wins for agent-produced assets (the `serve-public-dir`
    // skill contract). `fallthrough: true` lets a miss reach Vite.
    //
    // SECURITY — this dir is served to any WebUI client, which may be on the
    // LAN when bound to 0.0.0.0 (`--host`): `send` rejects `..` segments with
    // 403 and cannot escape `root`; `dotfiles: 'deny'` hard-403s hidden entries
    // (`.env`, dot-dirs); `index: false` disables directory index files. A
    // symlink INSIDE this dir is accepted by design — the agent already has
    // full write access to the workdir, so it escapes nothing it could not
    // write directly. Do NOT treat this mount as a sandbox.
    app.use(
      express.static(publicDir, {
        fallthrough: true,
        index: false,
        dotfiles: 'deny'
      })
    );

    // GET /health — registered BEFORE viteServer.middlewares so it answers
    // while Vite is still compiling (a watchdog must never mistake "still
    // warming up" for "dead"). Deliberately cheap.
    app.get('/health', (_req, res) => {
      res
        .status(200)
        .set({ 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({
            status: host.isRunning() ? 'ok' : 'stopping',
            pid: process.pid,
            uptimeMs: Math.round(process.uptime() * 1000),
            version: pkg.version,
            serve: {
              port: host.port(),
              host: host.host(),
              clients: host.clients.size,
              persistent: shouldDaemon(),
              agentRunning: host.agentRunning(),
              auto: host.getAutoState()
            },
            peer: (() => {
              // Remote peer wire identity (docs/peers/remote-peer-protocol.md
              // §2 step 1): the dialer probes /health BEFORE dialing.
              const wireHooks = getWireHooks();
              return {
                sessionId: wireHooks?.getSessionId() ?? null,
                daemon: wireHooks?.getDaemon() ?? false
              };
            })(),
            provider: getApiProvider()
          })
        );
    });

    // GET /dump → the SERVER half of `window.$webui.dump()` (serve-diag.ts).
    // Read-only; the only consumer is a human-triggered capture from the
    // browser console. Registered BEFORE Vite's middlewares for the same
    // reason as /health.
    app.get('/dump', (_req, res) => {
      res
        .status(200)
        .set({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(host.dumpSnapshot(Date.now())));
    });

    app.use(viteServer.middlewares);

    // GET / → serve index.html via Vite HTML transforms (injects HMR client).
    app.get('/', async (_req, res) => {
      try {
        const template = fs.readFileSync(path.resolve(WEB_ROOT, 'index.html'), 'utf-8');
        const html = await viteServer!.transformIndexHtml('/', template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).end(`Vite transform error: ${msg}`);
      }
    });

    // GET /history → chat history as JSON (fetched at load BEFORE the WS, so
    // live updates layer on top with no race). ONE read of the transcript per
    // GET, shared by the ETag and the body, so they cannot disagree about which
    // source is live (it used to parse the file four times).
    app.get('/history', (req, res) => {
      const steering = getSteeringManager().snapshot();
      const transcriptPath = host.transcriptPath();
      const messageLog = host.messageLog();
      const records = transcriptPath ? readTranscriptRecords(transcriptPath) : [];
      const etag = computeHistoryVersion(
        transcriptPath,
        steering.revision,
        host.agentRunning(),
        messageLog,
        records.length > 0,
        maxSeqOfRecords(records)
      );
      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache');
      // If-None-Match match → 304 with an empty body; the client keeps its
      // hydrated copy (lock-screen instant wake). RFC 7232 §3.2 weak
      // comparison, comma-separated lists and `*` included.
      const inm = req.headers['if-none-match'];
      if (etagMatchesIfNoneMatch(typeof inm === 'string' ? inm : undefined, etag)) {
        res.status(304).end();
        return;
      }
      const history = records.length > 0 ? projectDisplayRecords(records) : messageLog;
      const payload = JSON.stringify({
        messages: history,
        // THE /clear BOUNDARY, stated by the SERVER so it survives hydration.
        //
        // Every record with `seq <= clearBoundarySeq` was cut by the LAST
        // `/clear` — the same `lastClearIndex` cut `history` above already
        // reflects, so body and boundary cannot disagree. A client MUST NOT
        // re-admit a row at or below it: the merge that keeps a live tail has no
        // other way to tell "a row the snapshot lacks" from "a row the clear
        // removed", and a page that HYDRATED from cache (second tab, sleeping
        // tab, reload) never saw the live `clear-history` frame, so a page-local
        // epoch cannot save it — that was the resurrection BLOCKER.
        //
        // 0 means "no clear in this transcript" (or none stated), which is the
        // no-op for the client gate.
        clearBoundarySeq: computeClearBoundarySeq(records),
        // Revisioned snapshot (steering-manager.ts header): the client adopts it
        // only when `steeringRevision` is newer than what it holds, so an
        // in-flight snapshot can never re-insert a note the user just resolved.
        steeringRevision: steering.revision,
        steeringBuffer: steering.notes,
        isRunning: host.agentRunning()
      });
      res.status(200).set({ 'Content-Type': 'application/json' }).end(payload);
    });

    // GET /config → client-facing runtime config (per-file upload cap +
    // persistent flag so the Web UI renders 重启 vs 退出 correctly).
    app.get('/config', (_req, res) => {
      const wireHooks = getWireHooks();
      res
        .status(200)
        .set({ 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({
            maxUploadMb: getMaxUploadMb(),
            persistent: shouldDaemon(),
            // CAPABILITY flag only (`-v` / MYCC_VERBOSE): the browser offers the
            // 详细日志 toggle; it never turns it on.
            verbose: isVerbose(),
            sessionId: wireHooks?.getSessionId() ?? null,
            // Plan/normal mode (row obs-002): the browser must be able to see
            // that edits are refused because the lead is in plan mode.
            mode: host.getMode()
          })
        );
    });

    // Chat WebSocket on /ws (noServer; route upgrades by URL so Vite HMR at /
    // is left untouched). maxPayload caps a single inbound ws frame to the same
    // byte limit the application enforces for file uploads (getMaxUploadMb).
    // Without it, `ws` defaults to 100 MB — decoupled from MYCC_MAX_UPLOAD_MB.
    const maxPayloadBytes = getMaxUploadMb() * 1024 * 1024;
    wsServer = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
    const chatServer = wsServer;
    chatServer.on('connection', (ws: WebSocket) => onWsConnection(host.wsEventHost(), ws));
    // Remote peer wire on /peer/ws (docs/peers/remote-peer-protocol.md).
    // Dedicated WebSocketServer with its OWN maxPayload; the acceptor NEVER
    // touches clients or the disconnect timer (G1: peer wires must not sustain
    // the webui lifetime).
    try {
      getPeerWireAcceptor().createServer();
    } catch {
      /* start() is re-entrant via restartServe */
    }
    upgradeHandler = (req, socket, head) => {
      if (req.url && req.url.split('?')[0] === '/peer/ws') {
        getPeerWireAcceptor().handleUpgrade(req, socket, head);
        return;
      }
      if (req.url === '/ws') {
        chatServer.handleUpgrade(req, socket, head, (ws) => {
          chatServer.emit('connection', ws, req);
        });
      }
    };
    httpServer.on('upgrade', upgradeHandler);

    const server = httpServer;
    await new Promise<void>((resolve, reject) => {
      if (bindHost) {
        server.listen(port, bindHost, () => resolve());
      } else {
        server.listen(port, () => resolve());
      }
      server.once('error', reject);
    });

    return { dispose };
  } catch (err) {
    // A partially-initialized stack must release what it allocated so a later
    // retry does not overwrite live handles and leak them (Vite watchers /
    // esbuild, the HTTP server, the peer-wire acceptor). Then rethrow.
    agentIO.verbose('serve', `web stack mount failed: ${String(err)}`);
    await dispose();
    throw err;
  }
}

/** Suppress the unused-import check for the type-only ViteDevServer alias. */
export type { ViteServer };
