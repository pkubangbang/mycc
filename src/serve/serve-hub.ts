/**
 * serve-hub.ts - Express + Vite + WebSocket orchestrator for the /serve web UI
 *
 * Manages:
 * - Express HTTP server (single port, serves Vite middleware + /ws WebSocket)
 * - Vite dev server in middleware mode (HMR on the same http server)
 * - WebSocket input bridge (waitForInput / submitInput / abortInput)
 * - Message log for reconnect replay (capped at MAX_LOG_SIZE)
 * - 30s disconnect-reconnect timer
 *
 * Lifecycle:
 *   start(port) → running = true
 *   stop()      → running = false (FIRST) → abortInput() → cleanup servers
 *
 * The running flag is set BEFORE abortInput() in stop(), so WebInputProvider
 * checks hub.isRunning() = false and falls back to terminal — no race.
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
import { setResultCallback } from '../utils/letter-box.js';
import { getMaxUploadMb } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

interface LogEntry {
  type: string;
  content: string;
  /** Optional — omitted for transcript-loaded entries that carry no time. */
  timestamp?: number;
  label?: string;
  /** Tool intent/description (e.g. "RUN USER TO list files"). Outlined in the bubble. */
  detail?: string;
}

interface FileUploadMeta {
  filename: string;
  data: string;
  mimeType: string;
}

interface WsMessage {
  type: 'input' | 'exit' | 'interrupt' | 'card-response' | 'steer';
  text?: string;
  cardId?: string;
  value?: string;
  files?: FileUploadMeta[];
}

interface FileUploadEntry {
  filename: string;
  data: string;
  mimeType: string;
  text?: string;
}

/** A structured interactive card sent to the web UI (replaces ask() prompt). */
export interface CardMessage {
  type: 'card';
  cardId: string;
  query: string;
  kind: 'input' | 'confirm' | 'choice';
  options?: { label: string; value: string; isDefault?: boolean }[];
  initialContent?: string;
  placeholder?: string;
}

/**
 * Strip ANSI escape sequences (CSI/SGR, cursor moves, OSC, etc.) from a
 * string. Verbose logs and direct log() calls carry chalk-formatted text
 * that would render as garbled escape codes in the Web UI; this normalizes
 * everything to plain text at the broadcast boundary so the frontend never
 * sees a TTY escape code.
 */
function stripAnsi(text: string): string {
  // CSI ... (0x40-0x7E terminator) | OSC ... BEL or ST | other escape runs.
  // The regexes intentionally match the ESC control character (0x1b) — that is
  // what an ANSI escape sequence IS — so disable no-control-regex for the
  // whole chain rather than per-line (the original single-line disable was
  // misplaced above the comment, leaving the regex lines un-suppressed).
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
  /* eslint-enable no-control-regex */
}

export class ServeHub {
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
  private clients: Set<WebSocket> = new Set();
  private port = 0;
  // Bound upgrade handler ref, so stop() can remove it cleanly.
  private upgradeHandler: ((req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => void) | null = null;
  // Host set via --host flag. When set, the server binds to this host;
  // when null, defaults to localhost. Stored for getUrl() reporting.
  private host: string | null = null;

  // ── Input bridge — single resolver, no AbortController ──
  private inputResolver: ((input: string | null) => void) | null = null;

  // ── Card bridge — keyed resolvers for interactive cards ──
  // Each ask() serve-mode call gets a unique cardId; the resolver map lets
  // the matching card-response find its promise. Cleared on stop().
  private cardResolvers: Map<string, (value: string | null) => void> = new Map();

  // ── Steering queue — ephemeral in-memory buffer for webui steering notes ──
  // Unlike the mail system (file-backed, for inter-agent communication),
  // steering is ephemeral user mid-task direction: in-memory, cleared on
  // stop(), never persisted. Drained at PROMPT (synthesize with fresh query
  // via forkChat) or COLLECT (inject as REMINDER note).
  private steeringQueue: string[] = [];

  // ── File upload queue — ephemeral in-memory buffer for webui file uploads ──
  // Files uploaded from the chat box are buffered here until the agent loop
  // drains them (COLLECT or PROMPT), saves them to ./.mycc/uploaded/, and
  // mentions them via triologue.note(). Cleared on stop().
  private fileUploadQueue: FileUploadEntry[] = [];

  // ── Message log for reconnect replay ──
  private messageLog: LogEntry[] = [];
  private static readonly MAX_LOG_SIZE = 1000;

  // ── Transcript path (durable history source) ──
  // When set, the /history endpoint reads the triologue JSONL transcript
  // from disk instead of the in-memory messageLog. This survives serve
  // stop/restart and page closes — the messageLog is wiped on stop(), but
  // the transcript file persists for the whole session.
  private transcriptPath: string | null = null;

  // ── User log path (durable real-user-submission source) ──
  // When set, real user submissions (prompt queries + steering notes) are
  // appended to this JSONL file via appendUserLog(). The /history endpoint
  // reads it to reconstruct right-side user bubbles on refresh, instead of
  // mapping every role:'user' from the triologue (which also contains
  // injected system notes like [REMINDER]/[HINT]). This avoids fragile
  // prefix-based filtering and preserves steering bubbles (which never enter
  // the triologue as real user messages).
  private userLogPath: string | null = null;

  // ── Disconnect-reconnect ──
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RECONNECT_TIMEOUT_MS = 30_000;
  // Baseline captured when the disconnect timer starts, so the timeout handler
  // can distinguish a genuine user disconnect (tab closed) from a system
  // suspend/hibernate. During suspend the process is frozen: wall-clock
  // advances but CPU time does not. So if the timer fires after a wall-elapsed
  // much larger than the 30s budget AND cpu-elapsed near zero, the process was
  // suspended — we must NOT tear down the server (the user intends to keep
  // using the WebUI on resume; the browser will auto-reconnect).
  private disconnectTimerWallBaseline: bigint | null = null;
  private disconnectTimerCpuBaseline: { user: number; system: number } | null = null;
  // Tolerance for detecting a system suspend/hibernate. A normal 30s
  // disconnect timer fires within 30s + a few ms of jitter. If the timer
  // fires with wall-elapsed exceeding the 30s budget by more than this
  // margin, the process was frozen during the wait (suspend/hibernate) —
  // because setTimeout does not advance while the process is suspended, the
  // callback simply fires late on resume, inflating wall-elapsed by the
  // suspend duration. The CPU check (near-zero delta) corroborates that the
  // process was genuinely idle/frozen rather than busy.
  private static readonly SUSPEND_EXCESS_MS = 5_000; // 5s beyond the 30s budget ⇒ suspend

  // ── Mode state ──
  private running = false;
  // Re-entrancy guard for stop() — concurrent calls (ESC + exit button +
  // disconnect timeout + serve_shutdown IPC) must not interleave teardown.
  private stopping = false;

  /**
   * Set the triologue transcript path. When set, /history reads the JSONL
   * transcript from disk (durable) instead of the in-memory messageLog
   * (ephemeral, cleared on stop). Called from agent-repl.ts once the session
   * is initialized and triologuePath is known.
   */
  setTranscriptPath(p: string | null): void {
    this.transcriptPath = p;
  }

  /**
   * Set the user-log path. When set, real user submissions (prompt queries +
   * steering notes) are appended here via {@link appendUserLog}, and
   * {@link readHistory} reads it to reconstruct right-side user bubbles on
   * refresh. Lives in the same session directory as the triologue JSONL.
   * Called from agent-repl.ts alongside setTranscriptPath().
   */
  setUserLogPath(p: string | null): void {
    this.userLogPath = p;
  }

  /**
   * Append a real user submission to the user-log JSONL.
   *
   * Real user submissions are: (1) prompt queries — the user's input at the
   * PROMPT state, and (2) steering notes — mid-task direction sent via the
   * chat box while the LLM is working. Both are genuine user-authored text
   * that should render as right-side bubbles on refresh.
   *
   * This is separate from the triologue JSONL because the triologue's
   * role:'user' entries are polluted with injected system notes
   * ([REMINDER]/[HINT]/[WRAP_UP] etc.) that must NOT render as user bubbles.
   * The user log contains ONLY real user text, so no filtering is needed.
   *
   * Each entry carries a `timestamp` so readHistory can merge it with the
   * triologue's assistant/tool entries (which also carry timestamps) into
   * the correct chronological order.
   *
   * @param text - The user's submission text
   * @param kind - 'prompt' for PROMPT-state queries, 'steer' for mid-task notes
   */
  appendUserLog(text: string, kind: 'prompt' | 'steer'): void {
    if (!this.userLogPath) return;
    const entry = JSON.stringify({ type: 'user', content: text, kind, timestamp: Date.now() });
    try {
      fs.appendFileSync(this.userLogPath, `${entry}\n`, 'utf-8');
    } catch {
      // Ignore write errors (e.g. path not yet set during early init)
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  isRunning(): boolean {
    return this.running;
  }

  getUrl(): string | null {
    if (!this.running) return null;
    const displayHost = this.host && this.host !== '0.0.0.0' ? this.host : 'localhost';
    return `http://${displayHost}:${this.port}`;
  }

  async start(port: number, host?: string | null): Promise<void> {
    if (this.running) return;
    this.port = port;
    this.host = host ?? null;

    this.expressApp = express();
    this.httpServer = http.createServer(this.expressApp);

    // Vite in middleware mode — HMR shares the same http server (single port).
    // This is the documented single-port pattern (server.hmr.server). HMR is
    // kept enabled so the web UI can be live-edited while it runs.
    this.viteServer = await createViteServer({
      root: WEB_ROOT,
      plugins: [vue()],
      server: {
        middlewareMode: true,
        hmr: { server: this.httpServer },
      },
      appType: 'custom',
      // Avoid auto-resolving a parent vite.config — use inline config only
      configFile: false,
    });

    // Use Vite middleware for module serving + HMR
    this.expressApp.use(this.viteServer.middlewares);

    // GET / → serve index.html via Vite HTML transforms (injects HMR client,
    // which we WANT for live editing). No stripping — HMR stays functional.
    this.expressApp.get('/', async (_req, res) => {
      try {
        const template = fs.readFileSync(
          path.resolve(WEB_ROOT, 'index.html'),
          'utf-8',
        );
        const html = await this.viteServer!.transformIndexHtml('/', template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).end(`Vite transform error: ${msg}`);
      }
    });

    // GET /history → return the message history as JSON. The client fetches this
    // at page load BEFORE establishing the WebSocket, so the chat history is
    // populated first and live updates layer on top (no race, no replay
    // duplication, and a reconnect after a WS drop restores history via the
    // same endpoint rather than re-sending over the socket).
    //
    // When a transcriptPath is set, history is read from the durable triologue
    // JSONL transcript (survives serve stop/restart and page closes). The
    // in-memory messageLog is used as a fallback when no transcript is
    // available (e.g. serve started before session init).
    this.expressApp.get('/history', (_req, res) => {
      const history = this.readHistory();
      // Return both the message log and the current steering queue so a
      // refreshing/reconnecting client can restore its buffer bar. We peek
      // (getSteeringNotes) rather than drain — the notes stay queued for
      // COLLECT/PROMPT to consume; only the UI copy is restored.
      const payload = JSON.stringify({
        messages: history,
        steeringBuffer: this.getSteeringNotes(),
      });
      res.status(200).set({ 'Content-Type': 'application/json' }).end(payload);
    });

    // GET /config → return client-facing runtime config as JSON. The Web UI
    // fetches this at load to learn server-imposed limits (currently just the
    // per-file upload cap, controlled by --max-upload-mb / MYCC_MAX_UPLOAD_MB).
    // Kept separate from /history so a config change doesn't invalidate the
    // chat cache, and so future flags can be added without touching history.
    this.expressApp.get('/config', (_req, res) => {
      res.status(200).set({ 'Content-Type': 'application/json' }).end(
        JSON.stringify({ maxUploadMb: getMaxUploadMb() }),
      );
    });

    // Chat WebSocket on /ws. We use noServer mode and route the http server's
    // 'upgrade' event by URL: only /ws upgrades are handed to our chat server;
    // every other upgrade (Vite's HMR socket at /) is left untouched so Vite's
    // own upgrade handling continues to work. This avoids two WebSocketServer
    // instances fighting over the same http server's upgrade event.
    this.wsServer = new WebSocketServer({ noServer: true });
    this.wsServer.on('connection', (ws) => this.onWsConnection(ws));
    this.upgradeHandler = (req, socket, head) => {
      if (req.url === '/ws') {
        this.wsServer!.handleUpgrade(req, socket, head, (ws) => {
          this.wsServer!.emit('connection', ws, req);
        });
      }
      // Non-/ws upgrades (e.g. Vite HMR) are intentionally not handled here —
      // Vite registered its own upgrade listener on the http server and will
      // process them. We must NOT call socket.destroy() for those.
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

  async stop(): Promise<void> {
    // Re-entrancy guard: concurrent calls (ESC + exit button + disconnect
    // timer + serve_shutdown IPC) must not interleave teardown sequences.
    if (this.stopping) return;
    this.stopping = true;
    try {
      // 1. Set flag first — isRunning() immediately returns false
      this.running = false;

      // 1b. Notify Coordinator so stdin filtering stops synchronously.
      //     Any path that calls stop() (ESC, exit button, timeout, restart)
      //     now automatically restores terminal input — no per-path IPC needed.
      if (process.send) process.send({ type: 'serve_mode', active: false });

      // 2. Wake blocked waitForInput() with null (before server cleanup)
      this.abortInput();

      // 3. Cancel any pending disconnect timer
      this.cancelDisconnectTimer();

      // 4. Close all WebSocket connections
      for (const ws of this.clients) {
        try { ws.close(); } catch { /* ignore */ }
      }
      this.clients.clear();

      // 5. Remove our upgrade handler and close WS server
      if (this.httpServer && this.upgradeHandler) {
        this.httpServer.removeListener('upgrade', this.upgradeHandler);
        this.upgradeHandler = null;
      }
      if (this.wsServer) {
        try { this.wsServer.close(); } catch { /* ignore — server may already be closing */ }
        this.wsServer = null;
      }

      // 6. Close Vite
      if (this.viteServer) {
        try { await this.viteServer.close(); } catch { /* ignore */ }
        this.viteServer = null;
      }

      // 7. Close HTTP server
      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => resolve());
        });
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
   * Blocks until: a WS message arrives (submitInput), OR stop() calls abortInput().
   * Returns the input string, or null if aborted (serve stopped).
   */
  waitForInput(): Promise<string | null> {
    return new Promise((resolve) => {
      this.inputResolver = (input: string | null) => {
        this.inputResolver = null;
        resolve(input);
      };
    });
  }

  /** Called by WS handler when a client sends an input message. */
  submitInput(text: string): void {
    if (this.inputResolver) {
      this.inputResolver(text);
    }
  }

  /** Resolve blocked waitForInput() with null. Called by stop(). */
  abortInput(): void {
    if (this.inputResolver) {
      this.inputResolver(null);
    }
    // Also resolve all pending card resolvers with null (serve stopped mid-card)
    for (const resolver of this.cardResolvers.values()) {
      resolver(null);
    }
    this.cardResolvers.clear();
  }

  // ===========================================================================
  // Card bridge (called by agent-io ask() serve-mode path)
  // ===========================================================================

  /**
   * Broadcast an interactive card to all connected clients and append to the
   * message log. The card renders as an input field, confirm dialog, or
   * choice buttons in the web UI (see CardItem.vue). The caller then awaits
   * {@link waitForCardResponse} with the same cardId.
   *
   * Card text (`query`, option labels, `initialContent`) often carries chalk
   * color codes — e.g. an ask() prompt embeds a chalk.cyan.bold(id) for the
   * checkpoint hash, and confirm-card option labels may be colorized. Strip
   * every text field at this boundary so no ANSI code ever reaches the Web
   * UI (consistent with {@link broadcast}, which strips `content`/`detail`).
   */
  broadcastCard(card: CardMessage): void {
    const cleanQuery = stripAnsi(card.query);
    const cleanOptions = card.options?.map((opt) => ({
      label: stripAnsi(opt.label),
      value: opt.value,
      isDefault: opt.isDefault,
    }));
    const cleanInitialContent = card.initialContent ? stripAnsi(card.initialContent) : card.initialContent;
    const cleanCard: CardMessage = {
      type: 'card',
      cardId: card.cardId,
      query: cleanQuery,
      kind: card.kind,
      options: cleanOptions,
      initialContent: cleanInitialContent,
      placeholder: card.placeholder,
    };
    const entry: LogEntry = { type: 'card', content: cleanQuery, timestamp: Date.now() };
    // Store the full card payload on the entry so /history can replay it.
    // The LogEntry shape is extended inline — messageLog is internal-only.
    (entry as LogEntry & { card?: CardMessage }).card = cleanCard;
    this.messageLog.push(entry);
    if (this.messageLog.length > ServeHub.MAX_LOG_SIZE) {
      this.messageLog.shift();
    }
    const payload = JSON.stringify(cleanCard);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Block until a matching card-response arrives (submitCardResponse), OR
   * stop() resolves all card resolvers with null. Returns the response value,
   * or null if aborted (serve stopped mid-card).
   */
  waitForCardResponse(cardId: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.cardResolvers.set(cardId, (value: string | null) => {
        this.cardResolvers.delete(cardId);
        resolve(value);
      });
    });
  }

  /** Called by WS handler when a client sends a card-response message. */
  submitCardResponse(cardId: string, value: string): void {
    const resolver = this.cardResolvers.get(cardId);
    if (resolver) {
      resolver(value);
    }
    // If no resolver (stale/duplicate), silently drop — the card UI
    // already disables itself after the first response.
  }

  // ===========================================================================
  // Steering queue (webui-only — user mid-task direction while LLM runs)
  // ===========================================================================

  /**
   * Push a steering note from the web UI (fire-and-forget, non-blocking).
   * Echoes the note to all connected clients via a 'steer-echo' broadcast so
   * the frontend buffer bar displays it immediately. The note is buffered
   * here until consumed by {@link drainSteering} (COLLECT) or
   * {@link getSteeringNotes}+{@link drainSteering} (PROMPT synthesis).
   */
  pushSteer(text: string): void {
    this.steeringQueue.push(text);
    // Persist the steering note to the user log so it survives a page
    // refresh and re-renders as a right-side user bubble. The triologue
    // never receives the raw steering text as a real user message (it is
    // drained and injected as a [REMINDER] note at COLLECT/PROMPT), so
    // without this persistence the steering bubble is lost on refresh.
    this.appendUserLog(text, 'steer');
    // Echo to all clients so the buffer bar shows the queued note.
    // Using broadcast() (not a raw ws.send) ensures the echo is also logged
    // for reconnect replay consistency, though steering echoes are
    // transient by design — they are cleared via 'steer-flush'.
    this.broadcast('steer-echo', text);
  }

  /**
   * Consume and return all queued steering notes, clearing the queue.
   * Broadcasts a 'steer-flush' to all clients so the frontend buffer bar
   * clears. Called from COLLECT (inject as REMINDER) and PROMPT (after
   * forkChat synthesis). Returns an empty array if the queue is empty.
   */
  drainSteering(): string[] {
    if (this.steeringQueue.length === 0) return [];
    const notes = this.steeringQueue;
    this.steeringQueue = [];
    // Notify all clients to clear their buffer bar
    this.broadcast('steer-flush', '');
    return notes;
  }

  /**
   * Peek at queued steering notes without consuming them. Used by PROMPT
   * to decide whether to run forkChat synthesis before draining.
   */
  getSteeringNotes(): string[] {
    return [...this.steeringQueue];
  }

  // ===========================================================================
  // File upload queue (webui-only — user uploads files in the chat box)
  // ===========================================================================

  pushFileUpload(entry: FileUploadEntry): void {
    // Defense-in-depth size guard. The client checks file.size against
    // /config.maxUploadMb before sending, but a stale/malicious client could
    // bypass it. Reject oversized payloads here too — drop silently rather
    // than crash, since this runs inside the WS message handler.
    const maxBytes = getMaxUploadMb() * 1024 * 1024;
    // base64 length → decoded bytes (ignore padding '=' chars). Each base64
    // char encodes 6 bits, so bytes ≈ len * 3/4; subtract padding count.
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

  getFileUploads(): FileUploadEntry[] {
    return [...this.fileUploadQueue];
  }

  // ===========================================================================
  // Output bridge (called by agentIO output callback)
  // ===========================================================================

  /**
   * Read the chat history for the /history endpoint.
   *
   * History is reconstructed from TWO durable sources, merged by timestamp:
   *
   * 1. The triologue JSONL transcript (transcriptPath) — assistant/tool/system
   *    turns. role:'user' entries are SKIPPED here because they are polluted
   *    with injected system notes ([REMINDER]/[HINT]/[WRAP_UP] etc.) that must
   *    NOT render as right-side user bubbles.
   *
   * 2. The user-log JSONL (userLogPath) — real user submissions only (prompt
   *    queries + steering notes), written via appendUserLog(). These are the
   *    genuine right-side user bubbles.
   *
   * Both sources carry a `timestamp` field, so they are merged by timestamp
   * into the correct chronological order. The in-memory messageLog (intermediate
   * brief/log/warn/error + cards) is appended after — it already carries
   * timestamps, so it sorts into the merged sequence too.
   *
   * Falls back to messageLog alone when no transcript is available (e.g. serve
   * started before session init).
   *
   * Role → type mapping (triologue side):
   *   user      → (skipped — user bubbles come from the user log)
   *   assistant → 'result'    (LLM responses)
   *   tool      → 'log'       (tool results)
   *   system    → 'system'    (system messages)
   */
  private readHistory(): LogEntry[] {
    if (this.transcriptPath) {
      try {
        const raw = fs.readFileSync(this.transcriptPath, 'utf-8');
        const entries: LogEntry[] = [];
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let msg: { role?: string; content?: string; timestamp?: number };
          try {
            msg = JSON.parse(trimmed);
          } catch {
            continue; // skip malformed lines
          }
          if (msg.content === undefined || msg.content === null || msg.content === '') continue;
          // Skip role:'user' from the triologue — these are injected system
          // notes ([REMINDER]/[HINT]/[WRAP_UP] etc.), NOT real user input.
          // Real user bubbles come from the user log (read below).
          if (msg.role === 'user') continue;
          const type = this.roleToType(msg.role);
          const label = this.roleToLabel(msg.role);
          const entry: LogEntry = { type, content: stripAnsi(String(msg.content)) };
          if (label) entry.label = label;
          // The triologue Message now carries a timestamp (written by the
          // onMessage callback in agent-repl.ts). Use it for chronological
          // merge with the user log. Older transcripts (pre-timestamp) have
          // no field; omit it rather than emitting a bogus 0.
          if (typeof msg.timestamp === 'number') entry.timestamp = msg.timestamp;
          entries.push(entry);
        }

        // Read the user log (real user submissions) and merge by timestamp.
        // The user log contains ONLY genuine user text (prompt queries +
        // steering notes), so every entry maps to type:'user' (right-side
        // bubble) with no filtering needed.
        const userEntries = this.readUserLog();

        // Merge triologue entries + user entries + in-memory messageLog by
        // timestamp. The messageLog holds intermediate brief/log/warn/error
        // output and cards (which the transcript never stores); it already
        // carries timestamps so it sorts into the merged sequence. Entries
        // without a timestamp (legacy transcript lines) sort first via the
        // `?? 0` fallback so they stay at their natural position.
        const combined = entries.concat(userEntries).concat(this.messageLog);
        combined.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

        // Cap at MAX_LOG_SIZE (keep the most recent entries)
        if (combined.length > ServeHub.MAX_LOG_SIZE) {
          return combined.slice(combined.length - ServeHub.MAX_LOG_SIZE);
        }
        return combined;
      } catch {
        // File missing or unreadable — fall through to messageLog
      }
    }
    return this.messageLog;
  }

  /**
   * Read the user-log JSONL (real user submissions) and map each entry to a
   * 'user'-type LogEntry (right-side bubble). Returns an empty array if the
   * user log path is unset or the file is missing/unreadable.
   *
   * Each user-log line is `{ type: 'user', content, kind, timestamp }`. The
   * `kind` field ('prompt' | 'steer') is informational only — both kinds
   * render identically as right-side user bubbles.
   */
  private readUserLog(): LogEntry[] {
    if (!this.userLogPath) return [];
    try {
      const raw = fs.readFileSync(this.userLogPath, 'utf-8');
      const entries: LogEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: { content?: string; timestamp?: number };
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue; // skip malformed lines
        }
        if (entry.content === undefined || entry.content === null || entry.content === '') continue;
        const logEntry: LogEntry = { type: 'user', content: stripAnsi(String(entry.content)) };
        if (typeof entry.timestamp === 'number') logEntry.timestamp = entry.timestamp;
        entries.push(logEntry);
      }
      return entries;
    } catch {
      return [];
    }
  }

  /** Map a triologue Message role to a WebUI LogEntry type. */
  private roleToType(role: string | undefined): string {
    switch (role) {
      case 'user': return 'user';
      case 'assistant': return 'result';
      case 'tool': return 'log';
      case 'system': return 'system';
      default: return 'log';
    }
  }

  /**
   * Map a triologue Message role to a WebUI display label (shown as
   * [HH:MM:SS] [label] in the UI, mirroring the terminal brief header).
   */
  private roleToLabel(role: string | undefined): string | undefined {
    switch (role) {
      case 'assistant': return 'assistant';
      case 'user': return undefined;   // user bubbles already align right
      default: return undefined;       // tool/system logs: no special label
    }
  }

  /**
   * Broadcast an output message to all connected clients and append to the
   * message log (for reconnect replay).
   *
   * @param type - WS message type ('log' | 'warn' | 'error' | 'result' | 'prompt' | 'system')
   * @param content - message text (ANSI codes are stripped before send/store)
   * @param label - optional tool/module tag (e.g. 'bash', 'brief', 'question',
   *               'assistant'). Plain verbose logs pass no label.
   * @param detail - optional tool intent/description (e.g. bash command
   *                purpose). Rendered as an outlined box inside the bubble.
   */
  broadcast(type: string, content: string, label?: string, detail?: string): void {
    const cleanContent = stripAnsi(content);
    // detail (e.g. the `id:` line on a checkpoint brief) also carries chalk
    // color codes from the caller — strip it too so no field leaks ANSI into
    // the Web UI. Mirrors the cleanContent treatment above.
    const cleanDetail = detail ? stripAnsi(detail) : detail;
    const entry: LogEntry = { type, content: cleanContent, timestamp: Date.now() };
    if (label) entry.label = label;
    if (cleanDetail) entry.detail = cleanDetail;
    this.messageLog.push(entry);
    if (this.messageLog.length > ServeHub.MAX_LOG_SIZE) {
      this.messageLog.shift();
    }
    const payload = JSON.stringify({ type, content: cleanContent, label, timestamp: entry.timestamp, detail: cleanDetail || undefined });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch { /* ignore */ }
      }
    }
  }

  // ===========================================================================
  // WebSocket events
  // ===========================================================================

  private onWsConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.cancelDisconnectTimer(); // reconnect cancels 30s timer

    // History is NOT replayed over the socket. The client fetches /history at
    // page load (before connecting), so replaying here would duplicate every
    // past message. The WS carries only live updates from this point on.
    // On reconnect after a drop, the client re-fetches /history to restore
    // the full record, then re-subscribes — clean and idempotent.

    // Notify client if currently waiting for input
    if (this.inputResolver) {
      try { ws.send(JSON.stringify({ type: 'prompt', content: '' })); } catch { /* ignore */ }
    }

    ws.on('message', (data) => this.onWsMessage(ws, data.toString()));
    ws.on('close', () => this.onWsClose(ws));
    ws.on('error', (err) => this.onWsError(ws, err));
  }

  private onWsMessage(_ws: WebSocket, data: string): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(data) as WsMessage;
    } catch {
      return; // ignore malformed messages
    }

    switch (msg.type) {
      case 'input':
        if (msg.text !== undefined) {
          this.submitInput(msg.text);
        }
        if (msg.files && msg.files.length > 0) {
          for (const f of msg.files) {
            this.pushFileUpload({ filename: f.filename, data: f.data, mimeType: f.mimeType, text: msg.text });
          }
        }
        break;
      case 'exit':
        this.gracefulShutdown().catch((err) => {
          agentIO.verbose('serve', `exit shutdown error: ${String(err)}`);
        });
        break;
      case 'interrupt':
        // Like ESC — forward to agentIO neglection handler.
        // triggerNeglection() runs the same neglection logic the Coordinator
        // IPC 'neglection' message would (see agent-io.ts Step 6c).
        agentIO.triggerNeglection();
        break;
      case 'card-response':
        if (msg.cardId !== undefined && msg.value !== undefined) {
          this.submitCardResponse(msg.cardId, msg.value);
        }
        break;
      case 'steer':
        // Steering note from the web UI while the LLM is working.
        // Buffered in the steering queue; drained at COLLECT (REMINDER note)
        // or PROMPT (forkChat synthesis with fresh query).
        if (msg.text) {
          this.pushSteer(msg.text);
        }
        if (msg.files && msg.files.length > 0) {
          for (const f of msg.files) {
            this.pushFileUpload({ filename: f.filename, data: f.data, mimeType: f.mimeType, text: msg.text });
          }
        }
        break;
    }
  }

  private onWsClose(ws: WebSocket): void {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      this.startDisconnectTimer();
    }
  }

  private onWsError(_ws: WebSocket, err: Error): void {
    // Log but don't crash — individual client errors are non-fatal
    agentIO.verbose('serve', `WebSocket error: ${err.message}`);
  }

  // ===========================================================================
  // Disconnect-reconnect
  // ===========================================================================

  private startDisconnectTimer(): void {
    if (this.disconnectTimer) return; // already counting
    // Capture wall-clock + CPU baselines so the timeout handler can detect a
    // system suspend/hibernate that froze this process during the wait. See
    // onDisconnectTimeout for the detection logic.
    this.disconnectTimerWallBaseline = process.hrtime.bigint();
    this.disconnectTimerCpuBaseline = process.cpuUsage();
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      this.onDisconnectTimeout();
    }, ServeHub.RECONNECT_TIMEOUT_MS);
  }

  private cancelDisconnectTimer(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    this.disconnectTimerWallBaseline = null;
    this.disconnectTimerCpuBaseline = null;
  }

  private onDisconnectTimeout(): void {
    // Detect a system suspend/hibernate that froze this process during the
    // 30s wait. During suspend, wall-clock advances but the process is frozen
    // (CPU time barely moves). If the timer fired wall-elapsed that exceeds
    // the 30s budget by SUSPEND_EXCESS_MS, we treat it as a resume from
    // suspend — NOT a genuine user disconnect — and keep the server alive so
    // the browser can auto-reconnect on resume.
    const wallBaseline = this.disconnectTimerWallBaseline;
    const cpuBaseline = this.disconnectTimerCpuBaseline;
    this.disconnectTimerWallBaseline = null;
    this.disconnectTimerCpuBaseline = null;

    if (wallBaseline !== null && cpuBaseline !== null) {
      const wallElapsedMs = Number(process.hrtime.bigint() - wallBaseline) / 1e6;
      const cpuElapsed = process.cpuUsage(cpuBaseline);
      const cpuElapsedMs = (cpuElapsed.user + cpuElapsed.system) / 1000; // µs → ms
      const expectedWallMs = ServeHub.RECONNECT_TIMEOUT_MS;
      const excessMs = wallElapsedMs - expectedWallMs;
      // Suspend signature: wall ran far longer than the budget (the timer
      // fired late because the process was frozen), and CPU usage during the
      // whole interval is negligible (process was not actually running).
      if (excessMs > ServeHub.SUSPEND_EXCESS_MS && cpuElapsedMs < 5_000) {
        agentIO.verbose('serve', `suspend/resume detected (wall+${Math.round(excessMs / 1000)}s, cpu ${Math.round(cpuElapsedMs)}ms) — keeping Web UI alive for reconnect`);
        // The existing WS clients are dead from the suspend; drop them so the
        // browser's fresh reconnect is the only one tracked. Do NOT call
        // gracefulShutdown — the user intends to keep using the WebUI.
        for (const ws of this.clients) {
          try { ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();
        // Restart the disconnect timer so a *genuine* later disconnect (user
        // actually closes the tab and stays away) still tears down the server.
        this.startDisconnectTimer();
        return;
      }
    }

    // No client reconnected within 30s — graceful shutdown
    this.gracefulShutdown().catch((err) => {
      agentIO.verbose('serve', `disconnect shutdown error: ${String(err)}`);
    });
  }

  // ===========================================================================
  // Graceful shutdown (warm — no neglection, no LLM abort)
  // ===========================================================================

  /**
   * Called by: Exit button ({ type: 'exit' } WS message), disconnect timeout,
   * and the ESC neglection handler in agent-io.ts.
   */
  async gracefulShutdown(): Promise<void> {
    this.cancelDisconnectTimer();
    await this.stop(); // stop() sets running=false + abortInput() internally
    // clean up output hooks
    agentIO.setOutputCallback(null);
    setResultCallback(null);
    // notify Coordinator
    if (process.send) {
      process.send({ type: 'serve_mode', active: false });
    }
    console.log(chalk.yellow('\nWeb UI stopped. Terminal input restored.'));
  }
}