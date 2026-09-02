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
import { getMaxUploadMb } from '../config.js';
import { type SteeringNote, resolveSteeringQueue, joinSteeringNotes } from './steering-queue.js';
import type { LogEntry, FileUploadEntry, CardMessage } from './serve-types.js';
export type { CardMessage } from './serve-types.js';
import { stripAnsi, detectLanIpv4, detectAllLanIpv4 } from './serve-utils.js';
import { ClientRegistry } from './serve-clients.js';
import { readHistory } from './serve-history.js';
import { DisconnectTimer } from './serve-disconnect-timer.js';
import { handleWsMessage, type HubHandler } from './serve-ws-handler.js';

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
  private disconnectTimer = new DisconnectTimer({
    onGenuineDisconnect: () => {
      this.gracefulShutdown().catch((err) => {
        agentIO.verbose('serve', `disconnect shutdown error: ${String(err)}`);
      });
    },
    onSuspend: () => { this.clients.closeAll(); },
  });

  // ── Auto-mode providers (callbacks to avoid a module-load cycle with agent-io) ──
  private autoStateProvider: (() => boolean) | null = null;
  private enterAutoProvider: (() => boolean) | null = null;

  private running = false;
  // State-machine-driven processing flag (idle PROMPT/AWAIT → false; else true).
  private agentRunning = false;
  // Re-entrancy guard for stop().
  private stopping = false;

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

    // Vite in middleware mode — HMR shares the same http server (single port).
    this.viteServer = await createViteServer({
      root: WEB_ROOT,
      plugins: [vue()],
      server: { middlewareMode: true, hmr: { server: this.httpServer } },
      appType: 'custom',
      configFile: false, // inline config only — avoid parent vite.config
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
    this.expressApp.get('/history', (_req, res) => {
      const history = readHistory(this.transcriptPath, this.userLogPath, this.messageLog);
      const payload = JSON.stringify({
        messages: history,
        steeringBuffer: this.getSteeringNotes(),
        isRunning: this.agentRunning,
      });
      res.status(200).set({ 'Content-Type': 'application/json' }).end(payload);
    });

    // GET /config → client-facing runtime config (per-file upload cap).
    this.expressApp.get('/config', (_req, res) => {
      res.status(200).set({ 'Content-Type': 'application/json' }).end(
        JSON.stringify({ maxUploadMb: getMaxUploadMb() }),
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
    this.upgradeHandler = (req, socket, head) => {
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
      if (process.send) process.send({ type: 'serve_mode', active: false }); // restore stdin filtering
      if (!skipAbortInput) { this.abortInput(); }
      this.disconnectTimer.cancel();
      this.clients.closeAll();
      if (this.httpServer && this.upgradeHandler) {
        this.httpServer.removeListener('upgrade', this.upgradeHandler);
        this.upgradeHandler = null;
      }
      if (this.wsServer) { try { this.wsServer.close(); } catch { /* ignore */ } this.wsServer = null; }
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

  broadcast(type: string, content: string, label?: string, detail?: string): void {
    this.clients.broadcast(type, content, label, detail, this.messageLog);
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
    if (process.send) { process.send({ type: 'serve_mode', active: false }); }
    console.log(chalk.yellow('\nWeb UI stopped. Terminal input restored.'));
    this.abortInput(); // now unblock the fallback terminal prompt
  }
}