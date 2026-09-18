/**
 * serve-hub.ts - Express + Vite + WebSocket orchestrator for the /serve web UI.
 *
 * Thin orchestrator: HTTP/Vite/WS setup + the input/card/steering/upload queues
 * live here; fan-out (ClientRegistry), history reconstruction (serve-history),
 * the disconnect timer (serve-disconnect-timer), and WS message dispatch
 * (serve-ws-handler) are extracted into sibling modules. Inbound WS messages
 * are routed via handleWsMessage(); the hub implements HubHandler.
 *
 * Lifecycle: start(port) → running=true; stop(skipAbortInput?) → running=false
 * (FIRST) → abortInput() (unless skipped) → cleanup. gracefulShutdown() passes
 * skipAbortInput=true and calls abortInput() LAST so the restore message prints
 * before the fallback `agent >>` prompt (the "ESC quit serve" race).
 */

import express from 'express';
import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import chalk from 'chalk';
import { agentIO } from '../loop/agent-io.js';
import { PromptAbortError } from '../loop/agent-io.js';
import { setResultCallback } from '../utils/letter-box.js';
import { getMaxUploadMb, shouldDaemon, getApiProvider } from '../config.js';
import { sendToParent } from '../utils/parent-ipc.js';
import { type SteeringNote, resolveSteeringQueue, joinSteeringNotes } from './steering-queue.js';
import type { LogEntry, FileUploadEntry, CardMessage } from './serve-types.js';
export type { CardMessage } from './serve-types.js';
import { stripAnsi, detectLanIpv4, detectAllLanIpv4 } from './serve-utils.js';
import { ClientRegistry } from './serve-clients.js';
import { readHistory, computeHistoryVersion, etagMatchesIfNoneMatch } from './serve-history.js';
import { DisconnectTimer } from './serve-disconnect-timer.js';
import { handleWsMessage, type HubHandler } from './serve-ws-handler.js';
import { getPeerWireAcceptor } from './peer-wire.js';
import { getWireHooks } from '../peer/wire-registry.js';
import { wireOutputMirroring } from './activate.js';
import pkg from '../../package.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

export class ServeHub implements HubHandler {
  private static instance: ServeHub | null = null;

  static getInstance(): ServeHub {
    if (!ServeHub.instance) ServeHub.instance = new ServeHub();
    return ServeHub.instance;
  }

  // ── Server handles ──
  private httpServer: http.Server | null = null;
  private expressApp: express.Application | null = null;
  private viteServer: ViteDevServer | null = null;
  private wsServer: WebSocketServer | null = null;
  private clients = new ClientRegistry();
  private port = 0;
  private upgradeHandler: ((req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => void) | null = null;
  private host: string | null = null;

  // ── Input bridge — single resolver, no AbortController ──
  private inputResolver: ((input: string | null) => void) | null = null;
  // Rejecter paired with inputResolver: an external wake (peer channel join)
  // REJECTs waitForInput() with PromptAbortError (→ prompt.ts catch → AWAIT),
  // distinct from abortInput() which RESOLVES with null (→ terminal fallback).
  private inputRejecter: ((reason: unknown) => void) | null = null;

  // ── Card bridge — keyed resolvers for interactive cards ──
  private cardResolvers: Map<string, (value: string | null) => void> = new Map();

  // ── Steering queue — ephemeral in-memory buffer for webui steering notes ──
  private steeringQueue: SteeringNote[] = [];
  private steeringIdCounter = 0;

  // ── File upload queue — ephemeral in-memory buffer ──
  private fileUploadQueue: FileUploadEntry[] = [];

  // ── Message log for reconnect replay ──
  private messageLog: LogEntry[] = [];
  private static readonly MAX_LOG_SIZE = 1000;

  // ── Durable history sources ──
  private transcriptPath: string | null = null;
  private userLogPath: string | null = null;

  // ── Disconnect-reconnect (encapsulated in DisconnectTimer) ──
  //
  // Lifecycle contract: the timer's `persist` predicate (shouldDaemon())
  // guarantees `start()` is a no-op in a daemon, so the timer can NEVER arm
  // and `onGenuineDisconnect` can NEVER fire in persistent mode. The callback
  // therefore has exactly ONE reachable branch — gracefulShutdown() — and
  // does NOT re-check shouldDaemon() to pick restart-vs-shutdown. (An
  // earlier version had a dead `if (shouldDaemon()) restartServe()` branch
  // here; it was unreachable by the timer's own contract and leaked the
  // hub's lifecycle policy into a callback whose firing condition already
  // excluded it.) The "restart instead of kill when persistent" intent now
  // lives entirely in restartServe(), the 重启 button path.
  private disconnectTimer = new DisconnectTimer({
    onGenuineDisconnect: () => {
      this.gracefulShutdown().catch((err) => {
        agentIO.verbose('serve', `disconnect shutdown error: ${String(err)}`);
      });
    },
    onSuspend: () => { this.clients.closeAll(); },
  }, () => shouldDaemon());

  // ── Auto-mode providers (callbacks to avoid a module-load cycle with agent-io) ──
  private autoStateProvider: (() => boolean) | null = null;
  private enterAutoProvider: (() => boolean) | null = null;

  private running = false;
  // State-machine-driven processing flag (idle PROMPT/AWAIT → false; else true).
  private agentRunning = false;
  // Re-entrancy guard for stop().
  private stopping = false;
  // Re-entrancy flag for restartServe(): true while the HTTP/Vite/WS stack is
  // being recycled in-process on the same port. During this window `running`
  // is transiently false, so WebInputProvider's three-way guard treats this as
  // "still mine, keep waiting" rather than "serve is gone → exit" (which would
  // kill a headless daemon on a Restart click). Section 3 ships it returning
  // false; Section 2 wires the real implementation.
  private restarting = false;

  /**
   * Whether the serve stack is mid-restart (stop(true) → start(same port)).
   * WebInputProvider reads this in its three-way fallback so a blocked
   * waitForInput() survives a restartServe() cycle instead of falling through
   * to the headless-exit branch.
   */
  isRestarting(): boolean { return this.restarting; }

  /** Set the durable triologue transcript path (read by /history). */
  setTranscriptPath(p: string | null): void { this.transcriptPath = p; }

  /** Set the durable user-log path (real user submissions, read by /history). */
  setUserLogPath(p: string | null): void { this.userLogPath = p; }

  /**
   * Append a real user submission (prompt query or steering note) to the
   * user-log JSONL. Kept separate from the triologue because the triologue's
   * role:'user' entries are polluted with injected system notes. Each entry
   * carries a timestamp for chronological merge in readHistory.
   */
  appendUserLog(text: string, kind: 'prompt' | 'steer'): void {
    if (!this.userLogPath) return;
    const entry = JSON.stringify({ type: 'user', content: text, kind, timestamp: Date.now() });
    try { fs.appendFileSync(this.userLogPath, `${entry}\n`, 'utf-8'); } catch { /* ignore */ }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  isRunning(): boolean { return this.running; }

  /**
   * The port the server is currently bound to (0 when not running). Used by
   * /reload so the coordinator can respawn the lead with `--serve <port>` and
   * the web UI resumes on the same port after the brief disconnect.
   */
  getPort(): number { return this.port; }

  /**
   * The host the server is bound to (null = localhost-only). Used by /reload
   * to forward the --host binding to the respawned lead so the web UI stays
   * reachable on the same interface.
   */
  getHost(): string | null { return this.host; }

  getUrl(): string | null {
    if (!this.running) return null;
    let displayHost: string;
    if (this.host && this.host !== '0.0.0.0') {
      displayHost = this.host; // explicit --host value
    } else if (this.host === '0.0.0.0') {
      displayHost = detectLanIpv4() ?? 'localhost'; // all interfaces → LAN IP
    } else {
      displayHost = 'localhost';
    }
    return `http://${displayHost}:${this.port}`;
  }

  /**
   * Return all display URLs for the startup banner. When bound to 0.0.0.0,
   * yields a local URL (localhost) plus one network URL per non-internal
   * IPv4 so the user can see every reachable address, not just the first.
   * When bound to a specific host, yields that single URL. Returns null
   * when not running.
   */
  getUrls(): { local: string; network: string[] } | { local: string; network: [] } | null {
    if (!this.running) return null;
    if (this.host && this.host !== '0.0.0.0') {
      // Specific host — single URL, no separate local/network split.
      const url = `http://${this.host}:${this.port}`;
      return { local: url, network: [] };
    }
    const local = `http://localhost:${this.port}`;
    if (this.host === '0.0.0.0') {
      const network = detectAllLanIpv4().map(ip => `http://${ip}:${this.port}`);
      return { local, network };
    }
    // localhost-only bind (no --host).
    return { local, network: [] };
  }

  /** Start the Express + Vite + WS stack on a single port. */
  async start(port: number, host?: string | null): Promise<void> {
    if (this.running) return;
    this.port = port;
    this.host = host ?? null;

    this.expressApp = express();
    this.httpServer = http.createServer(this.expressApp);

    // Public dir for static assets served at `/` during dev (vite publicDir).
    // Lives under the project's .mycc/ tree (process.cwd()) so per-project
    // static files are co-located with sessions/mindmap/skills. Created here
    // so Vite never sees a missing directory at startup; recursive mkdir is a
    // no-op if it already exists. See the built-in skill
    // `serve-public-dir` for how the agent should reference these files in
    // replies (markdown image / download-link syntax).
    const publicDir = path.join(process.cwd(), '.mycc', 'public');
    fs.mkdirSync(publicDir, { recursive: true });

    // Vite in middleware mode — HMR shares the same http server (single port).
    this.viteServer = await createViteServer({
      root: WEB_ROOT,
      publicDir, // serve <cwd>/.mycc/public at root path `/` during dev
      plugins: [vue()],
      server: { middlewareMode: true, hmr: { server: this.httpServer } },
      appType: 'custom',
      configFile: false, // inline config only — avoid parent vite.config
    });

    // GET /health — registered BEFORE viteServer.middlewares so it answers
    // while Vite is still compiling (a watchdog polling every 30 s must never
    // mistake "still warming up" for "dead"). Deliberately cheap: no
    // provider/embedding probe (those hit Ollama on every poll). A deep check
    // (?deep=1) can be added later if wanted.
    this.expressApp.get('/health', (_req, res) => {
      res.status(200).set({ 'Content-Type': 'application/json' }).end(JSON.stringify({
        status: this.running ? 'ok' : 'stopping',
        pid: process.pid,
        uptimeMs: Math.round(process.uptime() * 1000),
        version: pkg.version,
        serve: {
          port: this.port,
          host: this.host,
          clients: this.clients.size,
          persistent: shouldDaemon(),
          agentRunning: this.agentRunning,
          auto: this.getAutoState(),
        },
        peer: (() => {
          // Remote peer wire identity (docs/remote-peer-protocol.md §2 step 1):
          // the dialer probes /health BEFORE dialing — the peer block tells it
          // who answers (sid) and whether the webui is daemon-backed (so the
          // dialer can refuse/flag an interactive instance whose webui will
          // auto-shutdown in 30s). Values come from the wire hooks (G3); a
          // null hooks means the agent context never started (unreachable in
          // practice — serve starts from the lead loop).
          const wireHooks = getWireHooks();
          return {
            sessionId: wireHooks?.getSessionId() ?? null,
            daemon: wireHooks?.getDaemon() ?? false,
          };
        })(),
        provider: getApiProvider(),
      }));
    });

    this.expressApp.use(this.viteServer.middlewares);

    // GET / → serve index.html via Vite HTML transforms (injects HMR client).
    this.expressApp.get('/', async (_req, res) => {
      try {
        const template = fs.readFileSync(path.resolve(WEB_ROOT, 'index.html'), 'utf-8');
        const html = await this.viteServer!.transformIndexHtml('/', template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).end(`Vite transform error: ${msg}`);
      }
    });

    // GET /history → chat history as JSON (fetched at load BEFORE the WS, so
    // live updates layer on top with no race). Merges transcript + user-log +
    // messageLog by timestamp (see serve-history.ts).
    //
    // Caching: a content-derived weak ETag (computeHistoryVersion) is sent on
    // every response, alongside `Cache-Control: no-cache`. `no-cache` does NOT
    // mean "never cache" — it means the client MUST revalidate with the server
    // (via If-None-Match) before using a stored copy. When the revalidation
    // ETag matches, the server returns a 0-byte 304 and the client keeps its
    // hydrated copy — the lock-screen wake path. The ETag folds in transient
    // fields (steering-length, isRunning) so a state flip is never masked by a
    // 304.
    this.expressApp.get('/history', (req, res) => {
      const etag = computeHistoryVersion(
        this.transcriptPath, this.userLogPath, this.messageLog,
        this.steeringQueue.length, this.agentRunning,
      );
      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache');
      // If-None-Match match → 304 Not Modified, empty body. The client's
      // hydrated copy stays on screen (lock-screen instant wake). The match
      // uses RFC 7232 §3.2 conditional semantics (weak comparison) via
      // etagMatchesIfNoneMatch: it handles a comma-separated list of
      // entity-tags and the `*` wildcard, and compares the opaque tags
      // ignoring the weak/strong distinction (correct for If-None-Match).
      // The prior `inm === etag` equality only handled the single-tag
      // exact-string case and silently failed on multi-tag or
      // strong/weak-equivalent headers.
      const inm = req.headers['if-none-match'];
      if (etagMatchesIfNoneMatch(typeof inm === 'string' ? inm : undefined, etag)) {
        res.status(304).end();
        return;
      }
      const history = readHistory(this.transcriptPath, this.userLogPath, this.messageLog);
      const payload = JSON.stringify({
        messages: history,
        steeringBuffer: this.getSteeringNotes(),
        isRunning: this.agentRunning,
      });
      res.status(200).set({ 'Content-Type': 'application/json' }).end(payload);
    });

    // GET /config → client-facing runtime config (per-file upload cap +
    // persistent flag so the Web UI renders 重启 vs 退出 correctly).
    //
    // `sessionId` is the wire session id (null when no wire session, e.g.
    // serve started before the agent context). The client uses it as the
    // per-session key for its IndexedDB chatlog cache: a new sessionId must
    // never show a foreign session's cached log, so the cache is keyed by
    // this value and pruned of other sessions on every write.
    this.expressApp.get('/config', (_req, res) => {
      const wireHooks = getWireHooks();
      res.status(200).set({ 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          maxUploadMb: getMaxUploadMb(),
          persistent: shouldDaemon(),
          sessionId: wireHooks?.getSessionId() ?? null,
        }),
      );
    });

    // Chat WebSocket on /ws (noServer; route upgrades by URL so Vite HMR at /
    // is left untouched). maxPayload caps a single inbound ws frame to the same
    // byte limit the application enforces for file uploads (getMaxUploadMb).
    // Without it, the `ws` library default is 100 MB — decoupled from
    // MYCC_MAX_UPLOAD_MB — so a client could send a near-100 MB single frame
    // that bypasses the app-level size guard in pushFileUpload.
    const maxPayloadBytes = getMaxUploadMb() * 1024 * 1024;
    this.wsServer = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
    this.wsServer.on('connection', (ws) => this.onWsConnection(ws));
    // Remote peer wire on /peer/ws (docs/remote-peer-protocol.md). Dedicated
    // WebSocketServer with its OWN maxPayload (4 MB, decoupled from the webui
    // upload cap); the acceptor NEVER touches this.clients or the
    // disconnectTimer (G1: peer wires must not sustain the webui lifetime).
    try { getPeerWireAcceptor().createServer(); } catch { /* start() is re-entrant via restartServe */ }
    this.upgradeHandler = (req, socket, head) => {
      if (req.url && req.url.split('?')[0] === '/peer/ws') {
        getPeerWireAcceptor().handleUpgrade(req, socket, head);
        return;
      }
      if (req.url === '/ws') {
        this.wsServer!.handleUpgrade(req, socket, head, (ws) => {
          this.wsServer!.emit('connection', ws, req);
        });
      }
    };
    this.httpServer.on('upgrade', this.upgradeHandler);

    await new Promise<void>((resolve, reject) => {
      if (this.host) {
        this.httpServer!.listen(port, this.host, () => resolve());
      } else {
        this.httpServer!.listen(port, () => resolve());
      }
      this.httpServer!.once('error', reject);
    });

    this.messageLog = [];
    this.running = true;
  }

  /**
   * Tear down the serve stack. skipAbortInput=true (gracefulShutdown) defers
   * abortInput() to the caller so the restore message prints first — calling
   * it here would let WebInputProvider draw `agent >>` before the message,
   * clobbering the prompt (the "ESC quit serve" bug).
   */
  async stop(skipAbortInput = false): Promise<void> {
    if (this.stopping) return; // re-entrancy guard
    this.stopping = true;
    try {
      this.running = false; // isRunning() immediately returns false
      this.agentRunning = false;
      sendToParent({ type: 'serve_mode', active: false }); // restore stdin filtering
      if (!skipAbortInput) { this.abortInput(); }
      this.disconnectTimer.cancel();
      this.clients.closeAll();
      if (this.httpServer && this.upgradeHandler) {
        this.httpServer.removeListener('upgrade', this.upgradeHandler);
        this.upgradeHandler = null;
      }
      if (this.wsServer) { try { this.wsServer.close(); } catch { /* ignore */ } this.wsServer = null; }
      // Peer wire acceptor teardown (docs/remote-peer-protocol.md §2
      // disconnect): abnormal close so the DIALER side fails fast / redials
      // per its loop policy. Sockets are unref'd so the httpServer close
      // promise below cannot hang on a live peer wire. MUST NOT touch the
      // disconnectTimer (G1). Also safe when no wire server was created.
      try { await getPeerWireAcceptor().stop(); } catch { /* ignore */ }
      if (this.viteServer) { try { await this.viteServer.close(); } catch { /* ignore */ } this.viteServer = null; }
      if (this.httpServer) {
        await new Promise<void>((resolve) => { this.httpServer!.close(() => resolve()); });
        this.httpServer = null;
      }
      this.expressApp = null;
      this.messageLog = [];
      this.steeringQueue = [];
      this.fileUploadQueue = [];
    } finally {
      this.stopping = false;
    }
  }

  // ===========================================================================
  // Input bridge (called by WebInputProvider)
  // ===========================================================================

  /**
   * Blocks until submitInput (WS), abortInput (stop), or rejectInput (peer
   * channel join). Returns the input string, null if aborted (serve stopped),
   * or throws PromptAbortError if rejected (→ prompt.ts catch → AWAIT).
   */
  waitForInput(): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.inputResolver = (input: string | null) => {
        this.inputResolver = null;
        this.inputRejecter = null;
        resolve(input);
      };
      this.inputRejecter = reject;
    });
  }

  /** Resolve a blocked waitForInput() with the submitted text. */
  submitInput(text: string): void {
    if (this.inputResolver) {
      this.inputResolver(text);
    } else if (this.cardResolvers.size > 0) {
      // A card is pending and the user typed in the chat box instead — dialog
      // input can't reach the TOOL-blocked card resolver. Surface a warning.
      this.broadcast('warn', '当前有卡片等待回复，请在卡片上操作（对话框输入未送达）', 'serve');
    }
    // else: neither prompt nor card pending — silently drop (stale client race).
  }

  /** Resolve blocked waitForInput() with null + clear all card resolvers. */
  abortInput(): void {
    if (this.inputResolver) { this.inputResolver(null); }
    for (const resolver of this.cardResolvers.values()) { resolver(null); }
    this.cardResolvers.clear();
  }

  /**
   * Reject a blocked waitForInput() with PromptAbortError (external wake →
   * AWAIT). Distinct from abortInput() (resolve null → terminal fallback). Card
   * resolvers are NOT rejected — a channel join mid-card is not a PROMPT wait.
   */
  rejectInput(): void {
    const rejecter = this.inputRejecter;
    if (rejecter) {
      this.inputResolver = null;
      this.inputRejecter = null;
      rejecter(new PromptAbortError());
    }
  }

  /** Whether a PROMPT wait (waitForInput) is currently blocked. */
  isInputBlocked(): boolean { return this.inputRejecter !== null; }

  // ===========================================================================
  // Card bridge (called by agent-io ask() serve-mode path)
  // ===========================================================================

  /** Broadcast an interactive card to all clients and log it for replay. */
  broadcastCard(card: CardMessage): void {
    const cleanCard: CardMessage = {
      type: 'card',
      cardId: card.cardId,
      query: stripAnsi(card.query),
      kind: card.kind,
      options: card.options?.map((opt) => ({ label: stripAnsi(opt.label), value: opt.value, isDefault: opt.isDefault })),
      initialContent: card.initialContent ? stripAnsi(card.initialContent) : card.initialContent,
      placeholder: card.placeholder,
    };
    const entry: LogEntry = { type: 'card', content: cleanCard.query, timestamp: Date.now() };
    (entry as LogEntry & { card?: CardMessage }).card = cleanCard;
    this.messageLog.push(entry);
    if (this.messageLog.length > ServeHub.MAX_LOG_SIZE) { this.messageLog.shift(); }
    const payload = JSON.stringify(cleanCard);
    this.clients.forEachOpen((ws) => ws.send(payload));
  }

  /** Block until a matching card-response arrives or stop() aborts with null. */
  waitForCardResponse(cardId: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.cardResolvers.set(cardId, (value: string | null) => {
        this.cardResolvers.delete(cardId);
        resolve(value);
      });
    });
  }

  /** Resolve a pending card response (stale/duplicate ids silently drop). */
  submitCardResponse(cardId: string, value: string): void {
    const resolver = this.cardResolvers.get(cardId);
    if (resolver) { resolver(value); }
  }

  // ===========================================================================
  // Steering queue (webui-only — user mid-task direction while LLM runs)
  // ===========================================================================

  /** Buffer a steering note, persist it, and echo it to all clients' buffer bars. */
  pushSteer(text: string): void {
    const note: SteeringNote = { id: ++this.steeringIdCounter, text };
    this.steeringQueue.push(note);
    this.appendUserLog(text, 'steer'); // persist so the bubble survives refresh
    // steer-echo carries the stable steerId for per-note discard/send; sent
    // directly (not via broadcast()) because broadcast() takes a flat string.
    const echoPayload = JSON.stringify({ type: 'steer-echo', content: text, steerId: note.id });
    this.clients.forEachOpen((ws) => ws.send(echoPayload));
  }

  /** Drain all steering notes' text (COLLECT REMINDER injection) + flush clients. */
  drainSteering(): string[] {
    if (this.steeringQueue.length === 0) return [];
    const notes = this.steeringQueue.map((n) => n.text);
    this.steeringQueue = [];
    this.broadcast('steer-flush', '');
    return notes;
  }

  /**
   * Atomically resolve the queue: sendIds declares which notes to SEND; the
   * rest are discarded. The whole queue drains in one step so PROMPT never
   * re-synthesizes. Always broadcasts 'steer-flush'.
   */
  resolveSteering(sendIds: number[] = []): string[] {
    if (this.steeringQueue.length === 0) return [];
    const selected = resolveSteeringQueue(this.steeringQueue, sendIds);
    // Source-side observability for the implicitly-discarded notes (dir-9
    // 发现3). The pure resolveSteeringQueue silently drops everything not in
    // sendIds; logging the discarded ids/count here (before the atomic drain)
    // makes "which steering notes vanished" diagnosable under -v. steering-
    // queue.ts itself stays framework-free/pure, so the log lives in the hub.
    const discarded = this.steeringQueue.filter((n) => !sendIds.includes(n.id));
    if (discarded.length > 0) {
      agentIO.verbose('serve',
        `Steering notes discarded (not sent): ids=[${discarded.map((n) => n.id).join(',')}] count=${discarded.length}`);
    }
    this.steeringQueue = []; // atomic drain BEFORE submit
    this.broadcast('steer-flush', '');
    if (selected.length > 0) { this.submitInput(joinSteeringNotes(selected)); }
    return selected.map((n) => n.text);
  }

  /** Peek queued steering note texts without consuming (PROMPT synthesis gate). */
  getSteeringNotes(): string[] { return this.steeringQueue.map((n) => n.text); }

  // ===========================================================================
  // File upload queue (webui-only)
  // ===========================================================================

  /** Buffer a file upload (defense-in-depth size guard; reject oversized). */
  pushFileUpload(entry: FileUploadEntry): void {
    const maxBytes = getMaxUploadMb() * 1024 * 1024;
    const b64 = entry.data ?? '';
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const approxBytes = Math.floor((b64.length * 3) / 4) - padding;
    if (approxBytes > maxBytes) {
      this.broadcast('error', `上传被拒绝：「${entry.filename}」超过 ${getMaxUploadMb()}MB 限制`, 'serve');
      return;
    }
    this.fileUploadQueue.push(entry);
    this.broadcast('file-upload', entry.filename);
  }

  drainFileUploads(): FileUploadEntry[] {
    if (this.fileUploadQueue.length === 0) return [];
    const files = this.fileUploadQueue;
    this.fileUploadQueue = [];
    this.broadcast('file-flush', '');
    return files;
  }

  getFileUploads(): FileUploadEntry[] { return [...this.fileUploadQueue]; }

  // ===========================================================================
  // Auto-mode + running-state signals (session-level, not logged)
  // ===========================================================================

  /** Broadcast auto-mode state to all clients (keeps chat box enabled in AWAIT). */
  broadcastAuto(value: boolean): void {
    const payload = JSON.stringify({ type: 'auto', content: value ? 'on' : 'off' });
    this.clients.forEachOpen((ws) => ws.send(payload));
  }

  /** Broadcast agent running state (idle PROMPT/AWAIT → off; processing → on). */
  setAgentRunning(value: boolean): void {
    if (value === this.agentRunning) return;
    this.agentRunning = value;
    const payload = JSON.stringify({ type: 'running', content: value ? 'on' : 'off' });
    this.clients.forEachOpen((ws) => ws.send(payload));
  }

  setAutoStateProvider(provider: (() => boolean) | null): void { this.autoStateProvider = provider; }
  setEnterAutoProvider(provider: (() => boolean) | null): void { this.enterAutoProvider = provider; }

  // ===========================================================================
  // Output bridge (called by agentIO output callback)
  // ===========================================================================

  broadcast(type: string, content: string, label?: string, detail?: string, synthetic?: boolean): void {
    this.clients.broadcast(type, content, label, detail, synthetic, this.messageLog);
  }

  /** Broadcast to all clients EXCEPT the sender (multi-browser user-bubble sync). */
  broadcastExcept(sender: WebSocket, type: string, content: string, label?: string, detail?: string): void {
    this.clients.broadcastExcept(sender, type, content, label, detail);
  }

  getAutoState(): boolean { return this.autoStateProvider ? this.autoStateProvider() : false; }

  /** Run the combined auto entry; return true if a provider ran, false if none registered. */
  enterAuto(): boolean {
    if (this.enterAutoProvider) { this.enterAutoProvider(); return true; }
    return false;
  }

  // ===========================================================================
  // WebSocket events
  // ===========================================================================

  private onWsConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.disconnectTimer.cancel(); // reconnect cancels 30s timer
    // History is NOT replayed over the socket — the client fetches /history at
    // load before connecting; WS carries only live updates from here on.
    if (this.inputResolver) {
      try { ws.send(JSON.stringify({ type: 'prompt', content: '' })); } catch { /* ignore */ }
    }
    // Send current auto + running state so late-joining/reconnecting clients
    // pick up the flags without waiting for the next flip.
    if (this.autoStateProvider) {
      try { if (this.autoStateProvider()) { ws.send(JSON.stringify({ type: 'auto', content: 'on' })); } } catch { /* ignore */ }
    }
    try { ws.send(JSON.stringify({ type: 'running', content: this.agentRunning ? 'on' : 'off' })); } catch { /* ignore */ }
    ws.on('message', (data) => handleWsMessage(this, ws, data.toString()));
    ws.on('close', () => this.onWsClose(ws));
    ws.on('error', (err) => this.onWsError(ws, err));
  }

  private onWsClose(ws: WebSocket): void {
    // During stop(), running=false is set FIRST, then clients.closeAll() closes
    // every client, each firing onWsClose. Without this guard each close would
    // re-arm disconnectTimer.start() AFTER stop() already cancelled it, leaving
    // a stray reconnect timer running against a stopped server. A closed
    // connection during shutdown is expected — skip the reconnect path.
    if (!this.running) return;
    this.clients.delete(ws);
    if (this.clients.size === 0) { this.disconnectTimer.start(); }
  }

  private onWsError(_ws: WebSocket, err: Error): void {
    agentIO.verbose('serve', `WebSocket error: ${err.message}`);
  }

  // ===========================================================================
  // Graceful shutdown (warm — no neglection, no LLM abort)
  // ===========================================================================

  /** Called by: exit button, disconnect timeout, ESC neglection handler. */
  async gracefulShutdown(): Promise<void> {
    this.disconnectTimer.cancel();
    // stop(skipAbortInput=true): tear down servers + set running=false, but
    // defer abortInput() to the tail so the restore message prints BEFORE the
    // fallback `agent >>` prompt (the "ESC quit serve" race).
    await this.stop(true);
    agentIO.setOutputCallback(null);
    setResultCallback(null);
    sendToParent({ type: 'serve_mode', active: false });
    console.log(chalk.yellow('\nWeb UI stopped. Terminal input restored.'));
    this.abortInput(); // now unblock the fallback terminal prompt
  }

  /**
   * Recycle the HTTP/Vite/WS stack in-process on the same port (the 重启
   * button in persistent mode). Distinct from gracefulShutdown(): this does
   * NOT unblock the input resolver (stop(true) skips abortInput), does NOT
   * clear the output/result callbacks until re-wired, and does NOT print the
   * "Terminal input restored" message — the terminal is never touched.
   *
   * Build-order contract: `isRestarting()` is read at arm time by
   * WebInputProvider's three-way guard, so a blocked waitForInput() across
   * the stop→start window treats the gap as "still mine, keep waiting" rather
   * than "serve is gone → headless exit" (which would kill a daemon on a
   * Restart click). `restarting` is set BEFORE stop() (which flips running
   * to false) and cleared in a finally AFTER start() flips it back to true.
   */
  async restartServe(): Promise<void> {
    if (this.restarting) return; // re-entrancy guard
    const port = this.getPort();
    const host = this.getHost();
    this.restarting = true;
    try {
      // stop(skipAbortInput=true): tear down the stack and set running=false
      // WITHOUT resolving a blocked waitForInput() with null — a null would
      // send WebInputProvider down its terminal-fallback / headless-exit path
      // mid-restart. The pending input resolver survives the cycle (start()
      // does not clear inputResolver) and is resubmitted against the fresh hub.
      await this.stop(true);
      await this.start(port, host);
      // Re-wire output + result mirroring (stop() does not clear the callbacks,
      // but a fresh start means the hub is a clean slate — re-wire explicitly
      // so the Web UI keeps receiving live updates after the recycle).
      wireOutputMirroring(this);
      agentIO.verbose('serve', `Web UI restarted on port ${port}`);
    } finally {
      this.restarting = false;
    }
  }
}