/**
 * serve-hub.ts - Express + Vite + WebSocket orchestrator for the /serve web UI.
 *
 * This file is the BRIDGE LAYER only; everything else moved to sibling modules:
 * serve-web-stack (Express/Vite/WS + routes), serve-lifecycle (the state
 * machine), serve-ws-events (per-socket handlers), serve-queues (upload buffer,
 * session signals, diagnostics ring), serve-clients (fan-out), serve-history
 * (row projection + ETag), serve-ws-handler (inbound dispatch), serve-banner
 * (display URLs). What remains: the input / card / steering / output bridges.
 *
 * Lifecycle: start(port) → running=true; stop(skipAbortInput?) → running=false
 * (FIRST) → abortInput() (unless skipped) → cleanup. gracefulShutdown() passes
 * skipAbortInput=true and calls abortInput() LAST so the restore message prints
 * before the fallback `agent >>` prompt (the "ESC quit serve" race).
 */

import type { CrossroadCardWire } from '../loop/crossroad-card.js';
import { WebSocket, type RawData } from 'ws';
import chalk from 'chalk';
import { agentIO } from '../loop/agent-io.js';
import { PromptAbortError } from '../loop/agent-io.js';
import { setResultCallback } from '../utils/letter-box.js';
import { sendToParent } from '../utils/parent-ipc.js';
import { shouldDaemon } from '../config.js';
import { getSteeringManager, joinSteeringNotes, type SteeringNote } from '../loop/steering-manager.js';
import { setWebUiUp } from '../loop/loop-events.js';
import { isWrapUpInFlight } from '../loop/wrap-up-state.js';
import type { LogEntry, FileUploadEntry, CardMessage, SteeringDeliveredInput } from './serve-types.js';
export type { CardMessage } from './serve-types.js';
import { stripAnsi } from './serve-utils.js';
import { ClientRegistry } from './serve-clients.js';
import {
  maxSeqOfRecords,
  projectDisplayRecords,
  projectDisplayRecord,
  readTranscriptRecords
} from './serve-history.js';
import { DisconnectTimer } from './serve-disconnect-timer.js';
import type { ServerDiagnostics } from './serve-diag.js';
import { handleWsMessage, type HubHandler } from './serve-ws-handler.js';
import type { WsEventHost } from './serve-ws-events.js';
import { ServeLifecycleState, type LifecycleHost, type LifecycleState } from './serve-lifecycle.js';
import { mountWebStack, type WebStack } from './serve-web-stack.js';
import { displayUrl, displayUrls } from './serve-banner.js';
import { FileUploadQueue, SessionSignals, DiagnosticsRing } from './serve-queues.js';
import { registerServeHubFactory, type ServeHubLike } from './serve-registry.js';
import { wireOutputMirroring } from './activate.js';
import type { DisplayObserverHost, TranscriptRecord } from '../loop/triologue/transcript.js';

export class ServeHub implements HubHandler, ServeHubLike {
  private static instance: ServeHub | null = null;

  static getInstance(): ServeHub {
    if (!ServeHub.instance) {
      ServeHub.instance = new ServeHub();
      // Self-register with the lazy registry: from here on, loop/context
      // modules resolve this instance through getServeHub() with no static
      // import of this file (see src/serve/serve-registry.ts). Registering
      // the accessor (not the instance) matches the factory contract.
      registerServeHubFactory(() => ServeHub.getInstance());
    }
    return ServeHub.instance;
  }

  // ── Server handles ──
  private webStack: WebStack | null = null;
  private clients = new ClientRegistry();

  // ── Input bridge — single resolver, no AbortController ──
  private inputResolver: ((input: string | null, fromSteering?: boolean) => void) | null = null;
  // Rejecter paired with inputResolver: an external wake (peer channel join)
  // REJECTs waitForInput() with PromptAbortError (→ prompt.ts catch → AWAIT),
  // distinct from abortInput() which RESOLVES with null (→ terminal fallback).
  private inputRejecter: ((reason: unknown) => void) | null = null;

  // ── Card bridge — keyed resolvers for interactive cards ──
  private cardResolvers: Map<string, (value: string | null) => void> = new Map();

  // ── Steering — owned by the loop-homed manager, NOT the hub ──
  // ServeHub is the sole WRITER (the only reader of the WS 'steer' frame);
  // loop states READ the process-wide singleton via peek/drain/isNonEmpty
  // (src/loop/steering-manager.ts). The hub holds no queue field anymore.
  //
  // EMISSION is intrinsic to mutation (SteeringManager.onChange), not a
  // call-site duty: this hub registers exactly ONE observer in start() and
  // unsubscribes it in stop(), so every add/drain/resolve/clear — including
  // the ones the loop states perform — reaches the WebUI as one versioned
  // `steer-state` snapshot.
  private unsubscribeSteering: (() => void) | null = null;

  // ── Queues + diagnostics (see serve-queues.ts) ──
  // The upload queue gets a LAZY view of `messageLog` (never the array itself):
  // the hub reassigns the field on start, stop and every `/clear` boundary, so
  // a captured array would be the stale object and the `file-upload` /
  // `file-flush` / rejection rows would land in a log nothing reads.
  private readonly fileUploadQueue = new FileUploadQueue(this.clients, () => this.messageLog);
  private readonly signals = new SessionSignals(this.clients);
  private readonly diagnostics = new DiagnosticsRing();

  // ── Message log for reconnect replay ──
  private messageLog: LogEntry[] = [];
  private static readonly MAX_LOG_SIZE = 1000;

  // ── Durable history source ──
  private transcriptPath: string | null = null;
  /**
   * The loop's transcript writer — the ONE record stream. Bound by agent-repl
   * and subscribed (through wireOutputMirroring) so live WS rows are
   * projections of journaled records, never a parallel push from the printer.
   */
  private displayWriter: DisplayObserverHost | null = null;
  /** Highest positive record timestamp forwarded live (see broadcastDisplayRecord). */
  private lastDisplayTimestamp: number | undefined;
  /**
   * Durable card journal — the transcript writer's `note()`, bound by agent-repl.
   *
   * Bound separately from `displayWriter` because a card is not an observed
   * record: it is CREATED by the hub, so the hub needs a way to write one.
   */
  private cardJournal: ((card: CardMessage) => void) | null = null;
  // Lead-side callback that journals a genuine user submission into the
  // transcript (registered by agent-repl; see setUserJournalProvider).
  private userJournalProvider: ((text: string, source: 'prompt' | 'steer') => void) | null = null;
  /**
   * Count of journaled display records this hub has forwarded. Incremented ONLY
   * in {@link broadcastDisplayRecord}, which the transcript writer calls on the
   * SUCCESS path of `append()` — below its `return false` when the sink throws
   * and below `nextSeq++`. That makes it the hub's only honest answer to "did
   * this record become durable?": neither a provider throw (swallowed by
   * journalUserSubmission) nor a normal return (agent-repl discards append()'s
   * boolean) can tell you. pushSteer compares it across its journal write.
   */
  private journaledRecords = 0;

  // ── Disconnect-reconnect (encapsulated in DisconnectTimer) ──
  //
  // Lifecycle contract: the timer's `persist` predicate (shouldDaemon())
  // guarantees `start()` is a no-op in a daemon, so the timer can NEVER arm
  // and `onGenuineDisconnect` can NEVER fire in persistent mode. The callback
  // therefore has exactly ONE reachable branch — gracefulShutdown() — and
  // does NOT re-check shouldDaemon() to pick restart-vs-shutdown. The "restart
  // instead of kill when persistent" intent lives entirely in restartServe().
  private disconnectTimer = new DisconnectTimer(
    {
      onGenuineDisconnect: () => {
        this.gracefulShutdown().catch((err) => {
          agentIO.verbose('serve', `disconnect shutdown error: ${String(err)}`);
        });
      },
      onSuspend: () => {
        this.clients.closeAll();
      }
    },
    () => shouldDaemon()
  );

  // ── Auto-mode providers (callbacks to avoid a module-load cycle with agent-io) ──
  private autoStateProvider: (() => boolean) | null = null;
  /**
   * Plan/normal mode provider — mirrors the lead's CURRENT mode at display
   * time instead of caching the last broadcast. "The hub mirrors, never owns."
   */
  private modeStateProvider: (() => 'plan' | 'normal') | null = null;
  /** Fallback when no provider is installed (hub without an agent context). */
  private modeState: 'plan' | 'normal' = 'normal';
  private enterAutoProvider: (() => boolean) | null = null;
  /**
   * Auto-commit allow-list provider — a READ-ONLY closure over AutoState,
   * installed by the agent loop through `onServeHubReady`. The hub never owns
   * and never writes the list: it serves `auto-commit-get` replies from here,
   * and every mutation arrives as a `/auto-commit` slash command executed by
   * the agent loop, whose change callback broadcasts the new list out.
   */
  private autoCommitBranchesProvider: { get: () => string[] } | null = null;
  /**
   * The LOOP-side `/clear` routine (agent-repl's `clearConversation`), installed
   * through `onServeHubReady`. Same seam as the auto/mode providers: the hub
   * itself owns no conversation state, so it cannot perform a clear — it can
   * only forward the browser's request to the one body both surfaces share.
   *
   * `null` on a hub with no agent loop behind it (a stub in tests, or serve
   * started before the loop wired its providers). `clearConversation()` then
   * throws instead of silently doing nothing, so the WS handler can report it.
   */
  private clearConversationProvider: (() => void) | null = null;

  // ── Lifecycle state (owned by ServeLifecycleState; declared before it) ──
  /** The mutable lifecycle flags the machine owns (by reference). */
  private readonly lifecycleState: LifecycleState = {
    running: false,
    agentRunning: false,
    stopping: false,
    restarting: false,
    port: 0,
    host: null,
    webUiUp: false
  };

  /**
   * The lifecycle state machine (start / stop / restart / graceful shutdown).
   * Declared AFTER `lifecycleState` — field initializers run in declaration
   * order, so the machine must come second or it would capture `undefined`.
   */
  private readonly lifecycle = new ServeLifecycleState(this.lifecycleState, this.lifecycleHost);

  private get running(): boolean {
    return this.lifecycleState.running;
  }

  private get agentRunning(): boolean {
    return this.lifecycleState.agentRunning;
  }

  /**
   * Whether the serve stack is mid-restart (stop(true) → start(same port)).
   * WebInputProvider reads this in its three-way fallback so a blocked
   * waitForInput() survives a restartServe() cycle instead of falling through
   * to the headless-exit branch.
   */
  isRestarting(): boolean {
    return this.lifecycleState.restarting;
  }

  // ── Bindings the loop installs ──

  /** Set the durable triologue transcript path (read by /history). */
  setTranscriptPath(p: string | null): void {
    this.transcriptPath = p;
  }

  /** Bind the loop's transcript writer — the record stream the socket mirrors. */
  setDisplayWriter(writer: DisplayObserverHost | null): void {
    this.displayWriter = writer;
  }

  /** The bound transcript writer, for the mirroring wiring (may be null). */
  getDisplayWriter(): DisplayObserverHost | null {
    return this.displayWriter;
  }

  /**
   * Bind the durable card journal (the transcript writer's note()). Registered
   * by agent-repl next to setDisplayWriter, so a pending card survives a reload
   * instead of leaving the agent blocked on an invisible question.
   */
  setCardJournal(journal: ((card: CardMessage) => void) | null): void {
    this.cardJournal = journal;
  }

  /**
   * Register the user-input journal provider: the lead-side callback that
   * writes ONE transcript journal record ('user'|'steer') for a genuine user
   * submission. The transcript is the single source of truth for WebUI user
   * bubbles (/history reads it), so this replaces the old serve-only
   * user.jsonl side file. Guarded at every call site so a serve started before
   * the loop wired it is a no-op rather than a crash.
   */
  setUserJournalProvider(cb: ((text: string, source: 'prompt' | 'steer') => void) | null): void {
    this.userJournalProvider = cb;
  }

  /**
   * Append a real user submission to the transcript's user-input journal via
   * the registered provider (see setUserJournalProvider). No-op when no
   * provider is registered yet (serve started before the agent loop wired it).
   */
  journalUserSubmission(text: string, source: 'prompt' | 'steer'): void {
    try {
      this.userJournalProvider?.(text, source);
    } catch (err) {
      // Best-effort: a journal failure must NOT break the live submission, but
      // the transcript is the SINGLE SOURCE OF TRUTH for user bubbles now, so
      // surface the divergence instead of swallowing it silently.
      agentIO.verbose('serve', `user-journal write failed (${source}): ${String(err)}`);
    }
  }

  // ===========================================================================
  // Lifecycle — the transitions live in serve-lifecycle.ts
  // ===========================================================================

  isRunning(): boolean {
    return this.running;
  }

  /** The port the server is bound to (0 when not running), for /reload. */
  getPort(): number {
    return this.lifecycleState.port;
  }

  /** The host the server is bound to (null = localhost-only), for /reload. */
  getHost(): string | null {
    return this.lifecycleState.host;
  }

  getUrl(): string | null {
    if (!this.running) return null;
    return displayUrl(this.lifecycleState.host, this.lifecycleState.port);
  }

  /**
   * Return all display URLs for the startup banner. When bound to 0.0.0.0,
   * yields a local URL (localhost) plus one network URL per non-internal
   * IPv4 so the user can see every reachable address. Returns null when not
   * running.
   */
  getUrls(): { local: string; network: string[] } | { local: string; network: [] } | null {
    if (!this.running) return null;
    return displayUrls(this.lifecycleState.host, this.lifecycleState.port);
  }

  /** Start the Express + Vite + WS stack on a single port. */
  async start(port: number, host?: string | null): Promise<void> {
    return this.lifecycle.start(port, host);
  }

  /**
   * Tear down the serve stack. skipAbortInput=true (gracefulShutdown) defers
   * abortInput() to the caller so the restore message prints first — calling
   * it here would let WebInputProvider draw `agent >>` before the message,
   * clobbering the prompt (the "ESC quit serve" bug). The transition ORDER
   * lives in ServeLifecycleState.stop().
   */
  async stop(skipAbortInput = false): Promise<void> {
    return this.lifecycle.stop(skipAbortInput);
  }

  /** Called by: exit button, disconnect timeout, ESC neglection handler. */
  async gracefulShutdown(): Promise<void> {
    return this.lifecycle.gracefulShutdown();
  }

  /**
   * Recycle the HTTP/Vite/WS stack in-process on the same port (the 重启 button
   * in persistent mode). See ServeLifecycleState.restartServe() for the full
   * ordering contract.
   *
   * NOT `async`: the recycle flag must be armed SYNCHRONOUSLY (before the first
   * await), so this method must not introduce a microtask boundary of its own.
   * The state machine returns the real promise, rejections included.
   */
  restartServe(): Promise<void> {
    return this.lifecycle.restartServe();
  }

  // ── Lifecycle host hooks (ServeLifecycleState's `host` view) ──

  private async startStack(port: number, bindHost: string | null): Promise<void> {
    this.webStack = await mountWebStack(
      {
        clients: this.clients,
        getMode: () => this.getMode(),
        getAutoState: () => this.getAutoState(),
        isRunning: () => this.running,
        agentRunning: () => this.agentRunning,
        port: () => this.lifecycleState.port,
        host: () => this.lifecycleState.host,
        messageLog: () => this.messageLog,
        transcriptPath: () => this.transcriptPath,
        dumpSnapshot: (capturedAt) => this.dumpSnapshot(capturedAt),
        wsEventHost: () => this.wsEventHost,
        hub: this
      },
      port,
      bindHost
    );
  }

  private async disposeStack(): Promise<void> {
    const stack = this.webStack;
    this.webStack = null;
    if (stack) await stack.dispose();
  }

  private publishWebUiDown(): void {
    setWebUiUp(false);
  }

  private publishWebUiUp(): void {
    setWebUiUp(true);
  }

  private notifyParentInactive(): void {
    sendToParent({ type: 'serve_mode', active: false }); // restore stdin filtering
  }

  private cancelDisconnectTimer(): void {
    this.disconnectTimer.cancel();
  }

  private closeAllClients(): void {
    this.clients.closeAll();
  }

  private clearSteering(): void {
    getSteeringManager().clear();
  }

  private resetMessageLog(): void {
    this.messageLog = [];
  }

  /**
   * Drop the ephemeral upload buffer (the teardown half of
   * `FileUploadQueue.reset()`).
   *
   * Paired with `resetMessageLog()` in the lifecycle's teardown group: HEAD's
   * `stop()` did `this.fileUploadQueue = []`, and without an equivalent here a
   * file attached just before a stop / WebUI restart stayed buffered and was
   * drained into the FIRST turn of the NEXT session.
   */
  private resetFileUploads(): void {
    this.fileUploadQueue.reset();
  }

  /**
   * Subscribe the ONE steering observer for this start (unsubscribed in stop).
   * Gated on isRunning() inside the observer: web-input-provider's
   * terminal-fallback paths call getSteeringManager().clear() AFTER the hub
   * began shutting down, and emitting onto a dead hub there would be the
   * 停止-button race the manager was created to kill.
   */
  private subscribeSteering(): void {
    this.unsubscribeSteering = getSteeringManager().onChange((snapshot) => {
      if (!this.isRunning()) return;
      this.clients.broadcastBespoke('steer-state', {
        steeringRevision: snapshot.revision,
        notes: snapshot.notes
      });
    });
  }

  private unsubscribeSteeringObserver(): void {
    this.unsubscribeSteering?.();
    this.unsubscribeSteering = null;
  }

  private rewireOutputMirroringCallback(): void {
    wireOutputMirroring(this, this.displayWriter);
  }

  private printRestored(): void {
    agentIO.setOutputCallback(null);
    setResultCallback(null);
    this.notifyParentInactive();
    console.log(chalk.yellow('\nWeb UI stopped. Terminal input restored.'));
  }

  private log(msg: string): void {
    agentIO.verbose('serve', msg);
  }

  /** The ServeLifecycleState's read-only view of this hub. */
  private get lifecycleHost(): LifecycleHost {
    return {
      startStack: (port, host) => this.startStack(port, host),
      disposeStack: () => this.disposeStack(),
      publishWebUiDown: () => this.publishWebUiDown(),
      notifyParentInactive: () => this.notifyParentInactive(),
      abortInput: () => this.abortInput(),
      cancelDisconnectTimer: () => this.cancelDisconnectTimer(),
      closeAllClients: () => this.closeAllClients(),
      clearSteering: () => this.clearSteering(),
      resetMessageLog: () => this.resetMessageLog(),
      resetFileUploads: () => this.resetFileUploads(),
      subscribeSteering: () => this.subscribeSteering(),
      unsubscribeSteering: () => this.unsubscribeSteeringObserver(),
      rewireOutputMirroring: () => this.rewireOutputMirroringCallback(),
      publishWebUiUp: () => this.publishWebUiUp(),
      log: (msg) => this.log(msg),
      printRestored: () => this.printRestored()
    };
  }

  // ===========================================================================
  // WebSocket events (handlers live in serve-ws-events.ts)
  // ===========================================================================

  /**
   * The narrow surface the extracted WS event handlers may touch (see
   * serve-ws-events.ts). A getter rather than a field so it always reflects the
   * CURRENT state — `inputResolver`, `clients` and `disconnectTimer` all mutate
   * over a connection's lifetime, and a snapshot would hand the handlers stale
   * ones.
   */
  private get wsEventHost(): WsEventHost {
    return {
      clients: this.clients,
      disconnectTimer: this.disconnectTimer,
      isRunning: () => this.running,
      replayConnectionState: (ws) => this.replayConnectionState(ws),
      recordInboundFrame: (rawText) => this.recordInboundFrame(rawText),
      clearPendingDiagFrame: () => this.diagnostics.clearPending(),
      dispatch: (ws, rawText) => handleWsMessage(this, ws, rawText)
    };
  }

  /**
   * Re-send the transient state a fresh socket needs and /history does not
   * carry: a blocked PROMPT wait, auto, running and plan/normal mode.
   */
  private replayConnectionState(ws: WebSocket): void {
    if (this.inputResolver) {
      try {
        ws.send(JSON.stringify({ type: 'prompt', content: '' }));
      } catch {
        /* ignore */
      }
    }
    // A late-joining/reconnecting client picks up the flags without waiting
    // for the next flip.
    if (this.autoStateProvider) {
      try {
        if (this.autoStateProvider()) {
          ws.send(JSON.stringify({ type: 'auto', content: 'on' }));
        }
      } catch {
        /* ignore */
      }
    }
    try {
      ws.send(JSON.stringify({ type: 'running', content: this.agentRunning ? 'on' : 'off' }));
    } catch {
      /* ignore */
    }
    // A browser joining mid-plan must be told that edits are prohibited instead
    // of guessing why a request was refused. getMode() is provider-first, so a
    // flip that happened BEFORE the hub existed (plan_on → /serve) is reported.
    try {
      ws.send(JSON.stringify({ type: 'mode', content: this.getMode(), detail: null }));
    } catch {
      /* ignore */
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
  waitForInput(): Promise<SteeringDeliveredInput> {
    return new Promise((resolve, reject) => {
      this.inputResolver = (input: string | null, fromSteering?: boolean) => {
        this.inputResolver = null;
        this.inputRejecter = null;
        resolve({ text: input, fromSteering: fromSteering === true });
      };
      this.inputRejecter = reject;
      // Arm-point delivery (plan §5, seam B instant 2 of 3): a note that was
      // HELD because no PROMPT wait was armed yet (or the wrap-up window was
      // still open) must ride the wait the moment it arms — a parked PROMPT
      // cannot poll. Re-runs the same pure takeForDelivery check.
      this.flushSteeringAtSeam();
    });
  }

  /**
   * Resolve a blocked waitForInput() with the submitted text.
   *
   * @param opts.fromSteering - the text is steering notes being DELIVERED (not a
   *   freshly typed query). The notes' ids are recorded as delivered, together
   *   with whether each note's own `'steer'` row is durable, so PROMPT can
   *   journal the query without minting a second user bubble. Recorded ONLY in
   *   the branch that really invokes the resolver: a delivery that lands
   *   nowhere must not arm provenance for a turn that will never run.
   */
  submitInput(text: string, opts?: { fromSteering?: boolean; notes?: readonly SteeringNote[] }): void {
    // Diagnostics: attribute the outcome to the frame that carried this text
    // BEFORE the branches below consume the state they are judged by.
    this.diagnostics.attribute(this.inputResolver !== null, this.cardResolvers.size > 0);
    if (this.inputResolver) {
      const fromSteering = opts?.fromSteering === true;
      if (fromSteering && opts.notes && opts.notes.length > 0) {
        getSteeringManager().markDelivered(
          opts.notes.map((n) => n.id),
          opts.notes.map((n) => n.journaled === true),
          text
        );
      }
      this.inputResolver(text, fromSteering);
    } else if (this.cardResolvers.size > 0) {
      // A card is pending and the user typed in the chat box instead — dialog
      // input can't reach the TOOL-blocked card resolver. Surface a warning.
      this.broadcast('warn', '当前有卡片等待回复，请在卡片上操作（对话框输入未送达）', 'serve');
    }
    // else: neither prompt nor card pending — silently drop (stale client race).
  }

  /** Resolve blocked waitForInput() with null + clear all card resolvers. */
  abortInput(): void {
    if (this.inputResolver) {
      this.inputResolver(null);
    }
    for (const resolver of this.cardResolvers.values()) {
      resolver(null);
    }
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

  /**
   * Whether a PROMPT wait (waitForInput) is currently blocked.
   *
   * Judged by the RESOLVER, not by inputRejecter: the resolver is the single
   * source of truth for "a wait is parked". In production both were assigned
   * together, but the rejecter is nulled by `rejectInput`/the resolver tail, so
   * reading it here made the steering seams unable to see a parked wait when a
   * caller (or a test, or a restarted hub) armed only the resolve half.
   */
  isInputBlocked(): boolean {
    return this.inputResolver !== null;
  }

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
      options: card.options?.map((opt) => ({
        label: stripAnsi(opt.label),
        value: opt.value,
        isDefault: opt.isDefault
      })),
      initialContent: card.initialContent ? stripAnsi(card.initialContent) : card.initialContent,
      placeholder: card.placeholder
    };
    const entry: LogEntry = { type: 'card', content: cleanCard.query, timestamp: Date.now() };
    (entry as LogEntry & { card?: CardMessage }).card = cleanCard;
    this.messageLog.push(entry);
    if (this.messageLog.length > ServeHub.MAX_LOG_SIZE) {
      this.messageLog.shift();
    }
    // JOURNAL the card as a note carrying its payload: without it a pending
    // card had a live frame and NO replay — the page refreshed, the widget
    // disappeared, and waitForCardResponse stayed blocked on a question the
    // browser could no longer show.
    this.journalCard(cleanCard);
    // SEND the flat payload — ONLY as the no-journal fallback. The card reaches
    // the client by EXACTLY ONE of two channels: the journaled row (carrying
    // `seq`, read through msg.card?.cardId) or this flat send. Sending
    // unconditionally produced two widgets per question (round-2 blocker);
    // skipping BOTH produced none. The pair is pinned by
    // card-journal-roundtrip.test.ts.
    if (!this.cardJournal) {
      const payload = JSON.stringify(cleanCard);
      this.clients.forEachOpen((ws) => ws.send(payload));
    }
  }

  /**
   * Journal a card as a durable display note. A no-op when no writer is bound
   * (teammate workers, tests), because the messageLog copy still serves that
   * path — and a journal failure must never stop the card reaching the client.
   */
  private journalCard(card: CardMessage): void {
    if (!this.cardJournal) return;
    try {
      this.cardJournal(card);
    } catch {
      /* the live send below still delivers it */
    }
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
    if (resolver) {
      resolver(value);
    }
  }

  // ===========================================================================
  // Steering (webui-only — user mid-task direction while LLM runs)
  //
  // The hub is the sole WRITER of the shared manager; loop states are READERS
  // (docs/archived/steering-manager-plan.md §2). Queue state, the monotonic id
  // counter and the queue REVISION live in src/loop/steering-manager.ts.
  //
  // No broadcast calls remain in this section: every mutation (addNote /
  // drainNotes / resolveBoomerang / clear) emits through the observer
  // registered in start(), so the loop states' drains reach the WebUI too.
  // ===========================================================================

  /** Buffer a steering note and journal it. The clients learn about it from
   *  the manager's onChange observer (start()), not from a local echo.
   *
   *  @returns true iff the note's `'steer'` journal row became DURABLE. The
   *  caller stamps this on the note (markJournaled) so a later delivery can drop
   *  its own display row only when the submission's row provably exists.
   *
   *  The verdict comes from the hub's journal counter, not from the provider's
   *  return: journalUserSubmission swallows provider throws, and agent-repl
   *  discards append()'s boolean. A failed sink and a healthy write look
   *  identical from there — but not from broadcastDisplayRecord, which only runs
   *  after a successful write. */
  pushSteer(text: string): boolean {
    const note = getSteeringManager().addNote(text);
    // Journaled at SUBMISSION time: the text is a genuine user submission the
    // moment it is typed, whether COLLECT later injects it as a [REMINDER] note
    // or PROMPT folds it into a synthesised query.
    const before = this.journaledRecords;
    this.journalUserSubmission(text, 'steer');
    const journaled = this.journaledRecords > before;
    // Stamp BEFORE any seam can run: the flush below may deliver this note
    // synchronously, and the delivery reads `note.journaled`.
    getSteeringManager().markJournaled(note.id, journaled);
    // Write-point delivery (plan §5, seam B instant 1 of 3): when a PROMPT wait
    // is already parked and the wrap-up window is closed, the note can ride the
    // wait immediately; takeForDelivery otherwise HOLDS it.
    this.flushSteeringAtSeam();
    return journaled;
  }

  /**
   * The shared delivery check, re-run at each of the three plan §5 instants:
   * WRITE (pushSteer), ARM (waitForInput armed), WAKE (onWrapUpSettled).
   * takeForDelivery is pure w.r.t. the hub — it drains the manager only when
   * the queue is non-empty AND a PROMPT wait is parked AND the wrap-up window
   * is closed; otherwise it is a stateless null and nothing happens. Three
   * instants re-running one pure check cannot collapse into a missed window.
   */
  private flushSteeringAtSeam(): void {
    const deliverable = getSteeringManager().takeForDelivery(this.isInputBlocked(), isWrapUpInFlight());
    if (deliverable) {
      // No broadcast: takeForDelivery drained the manager, whose onChange
      // observer reports the new (empty) snapshot as 'steer-state'. `notes`
      // carries the drained notes so submitInput records, at the moment it
      // really resolves the parked wait, that they were DELIVERED.
      this.submitInput(joinSteeringNotes(deliverable), { fromSteering: true, notes: deliverable });
    }
  }

  /**
   * Wrap-up settle wake seam (A1, plan §5 instant 3 of 3): esc-wrap-up.ts calls
   * this DIRECTLY the moment the background wrap-up promise settles. Gated on
   * isRunning(): a settle racing a terminal stop() must not ride a dead hub.
   * Safe to double-call: takeForDelivery drains, so the second call is a no-op.
   */
  onWrapUpSettled(): void {
    if (!this.isRunning()) return;
    this.flushSteeringAtSeam();
  }

  /**
   * Atomically resolve the queue: sendIds declares which notes to SEND; the
   * rest are discarded. The whole queue drains in one step so PROMPT never
   * re-synthesizes. The drain is reported to clients by the manager's
   * onChange observer as a 'steer-state' snapshot.
   */
  resolveSteering(sendIds: number[] = []): string[] {
    if (!getSteeringManager().isNonEmpty()) {
      // ACK the resolve even though there is nothing to drain: a silent return
      // would leave a client that resolved an already-consumed note staring at
      // a card the server will never re-report.
      getSteeringManager().clear();
      return [];
    }
    // Boomerang is atomic: one drain splits the note set into selected (to
    // submit) + discarded (for observability only). Filter-by-id semantics —
    // duplicate sendIds entries select BOTH notes (A4, no dedupe).
    const { selected, discarded } = getSteeringManager().resolveBoomerang(sendIds);
    // Source-side observability for the implicitly-discarded notes: makes
    // "which steering notes vanished" diagnosable under -v.
    if (discarded.length > 0) {
      agentIO.verbose(
        'serve',
        `Steering notes discarded (not sent): ids=[${discarded.map((n) => n.id).join(',')}] count=${discarded.length}`
      );
    }
    if (selected.length > 0) {
      this.submitInput(joinSteeringNotes(selected), { fromSteering: true, notes: selected });
    }
    return selected.map((n) => n.text);
  }

  // NOTE: no getSteeringNotes()/drainSteering() facades here — loop consumers
  // read getSteeringManager() directly (peek/drain/isNonEmpty) per plan §6 /
  // pitfall Δ3. The hub keeps only its WRITER/RESOLVER surface: pushSteer,
  // resolveSteering (also enforced by the steering-boundary test's allowlist).

  // ── Diagnostics (ring lives in serve-queues.ts) ──

  private recordInboundFrame(rawText: string): void {
    this.diagnostics.record(rawText, this.inputResolver !== null, this.cardResolvers.size > 0);
  }

  /** The server slice of a dump — pure reads, no side effects. */
  dumpSnapshot(capturedAt: number): { capturedAt: number; diagnostics: ServerDiagnostics; frames: unknown[] } {
    const records = this.transcriptPath ? readTranscriptRecords(this.transcriptPath) : [];
    const steering = getSteeringManager().snapshot();
    return this.diagnostics.snapshot(capturedAt, () => ({
      running: this.running,
      port: this.lifecycleState.port,
      host: this.lifecycleState.host,
      agentRunning: this.agentRunning,
      auto: this.getAutoState(),
      mode: this.getMode(),
      clients: this.clients.size,
      inputArmed: this.inputResolver !== null,
      cardResolvers: this.cardResolvers.size,
      steeringRevision: steering.revision,
      steeringNotes: steering.notes.map((n) => ({ id: n.id, text: n.text })),
      fileUploads: this.fileUploadQueue.size,
      messageLogLength: this.messageLog.length,
      historyRows: records.length > 0 ? projectDisplayRecords(records).length : this.messageLog.length,
      historyMaxSeq: maxSeqOfRecords(records)
    }));
  }

  // ===========================================================================
  // File upload queue (webui-only) — the buffer lives in serve-queues.ts
  // ===========================================================================

  /** Buffer a file upload (defense-in-depth size guard; reject oversized). */
  pushFileUpload(entry: FileUploadEntry): void {
    this.fileUploadQueue.push(entry);
  }

  drainFileUploads(): FileUploadEntry[] {
    return this.fileUploadQueue.drain();
  }

  getFileUploads(): FileUploadEntry[] {
    return this.fileUploadQueue.list();
  }

  // ===========================================================================
  // Auto-mode + running-state signals (session-level, not logged)
  // ===========================================================================

  /** Broadcast auto-mode state to all clients (keeps chat box enabled in AWAIT). */
  broadcastAuto(value: boolean): void {
    this.signals.broadcastAuto(value);
  }

  /** Broadcast plan/normal mode to all clients (row obs-002). */
  broadcastMode(mode: 'plan' | 'normal', allowedFile?: string): void {
    this.modeState = mode;
    this.signals.broadcastMode(mode, allowedFile);
  }

  /** Current plan/normal mode — provider-first (live), cache as fallback. */
  getMode(): 'plan' | 'normal' {
    try {
      return this.modeStateProvider ? this.modeStateProvider() : this.modeState;
    } catch {
      return this.modeState;
    }
  }

  /** Install the plan/normal mode provider (mirror of setAutoStateProvider). */
  setModeStateProvider(provider: (() => 'plan' | 'normal') | null): void {
    this.modeStateProvider = provider;
  }

  /** Broadcast agent running state (idle PROMPT/AWAIT → off; processing → on). */
  setAgentRunning(value: boolean): void {
    if (value === this.agentRunning) return;
    this.lifecycleState.agentRunning = value;
    this.signals.broadcastRunning(value);
  }

  setAutoStateProvider(provider: (() => boolean) | null): void {
    this.autoStateProvider = provider;
  }

  setEnterAutoProvider(provider: (() => boolean) | null): void {
    this.enterAutoProvider = provider;
  }

  /**
   * READ provider for the auto-commit allow-list (魔法查询 editor).
   *
   * Same seam as the auto/mode providers above: the hub stays ignorant of
   * AutoState, and the agent loop installs a closure over the singleton. There
   * is no `replace` half — the list is written only through the `/auto-commit`
   * slash command, so the terminal and the WebUI share one writer and one
   * broadcast (AutoState's change callback). With no provider installed the
   * getter answers `null` (unknown), never `[]` (which would read as deny-all).
   */
  setAutoCommitBranchesProvider(provider: { get: () => string[] } | null): void {
    this.autoCommitBranchesProvider = provider;
  }

  /**
   * Install the LOOP-side `/clear` routine (agent-repl's `clearConversation`).
   *
   * The hub cannot clear anything itself: the transcript marker, the fresh-
   * session reset and the live `clear-history` broadcast all live in the agent
   * loop's scope. It therefore only FORWARDS. Passing `null` uninstalls it (a
   * serve teardown), after which {@link clearConversation} throws.
   */
  setClearConversationProvider(provider: (() => void) | null): void {
    this.clearConversationProvider = provider;
  }

  /**
   * Run the browser's `/clear`.
   *
   * Called from serve-ws-handler's `clear-conversation` case — the WebUI's only
   * route into the clear. There is deliberately NO second copy of the clear
   * body here: the ordered sequence (`triologue.clear()` → the transcript
   * marker → `clearDisplayedHistory()` → the fresh-session reset) lives in
   * ONE function in agent-repl.ts, and both the terminal (double Ctrl+L) and
   * the browser call it. Two entry points with two bodies is how the browser
   * clear ended up unreachable in the first place.
   *
   * Throws when no provider is installed — a hub with no agent loop behind it
   * cannot honour a clear, and the WS handler reports that via agentIO.verbose
   * rather than pretending it worked.
   */
  clearConversation(): void {
    if (!this.clearConversationProvider) {
      throw new Error('clearConversation: no provider installed (serve without the agent loop)');
    }
    this.clearConversationProvider();
  }

  /**
   * `null` means "no provider installed" — NOT an empty allow-list. The two
   * must stay distinguishable on the wire: `[]` is a real deny-all the user
   * can act on, `null` is "this hub has no agent loop behind it".
   */
  getAutoCommitBranches(): string[] | null {
    return this.autoCommitBranchesProvider ? this.autoCommitBranchesProvider.get() : null;
  }

  /** Broadcast the auto-commit allow-list (after a successful write). */
  broadcastAutoCommit(branches: string[]): void {
    this.signals.broadcastAutoCommit(branches);
  }

  // ===========================================================================
  // Output bridge (called by agentIO output callback)
  // ===========================================================================

  broadcast(
    type: string,
    content: string,
    label?: string,
    detail?: string,
    synthetic?: boolean,
    crossroad?: CrossroadCardWire
  ): void {
    this.clients.broadcast(type, content, label, detail, synthetic, this.messageLog, crossroad);
  }

  /**
   * Live display fan-out: one journaled transcript record → one WS frame.
   *
   * Subscribed by {@link wireOutputMirroring} to the triologue writer's display
   * observer, so the socket renders the SAME record /history projects from the
   * file — not a second copy pushed by the printer. The row rule is
   * `projectDisplayRecord`, shared with the history endpoint, so a live row and
   * a replayed row can never disagree and a record can never arrive twice.
   *
   * Never appended to `messageLog`: the transcript IS the store, and the hub
   * keeps no parallel copy of what it already journaled.
   */
  broadcastDisplayRecord(record: TranscriptRecord): void {
    // A record reaching this observer is DURABLE: the writer's append() only
    // notifies the display stream after its sink write succeeded (it returns
    // early on failure, before `nextSeq++` and this callback). Counting here is
    // therefore the only truthful "the journal landed" signal the hub has.
    this.journaledRecords++;
    // Emission-order timestamp inheritance across the LIVE stream, matching
    // projectDisplay's file-order walk.
    const row = projectDisplayRecord(record, this.lastDisplayTimestamp);
    if (typeof record.timestamp === 'number' && record.timestamp > 0) {
      this.lastDisplayTimestamp = record.timestamp;
    }
    if (!row) return;
    this.clients.broadcastRow(row);
  }

  /**
   * Drop every in-memory display source at a `/clear` boundary and tell the
   * open browsers to do the same.
   *
   * THREE holders must be reset together, or the clear is only half effective:
   *   1. `messageLog` — the serve-lifetime fallback that /history serves while
   *      the transcript holds no records. Left intact, the next reload would
   *      resurrect pre-clear lines from it.
   *   2. `lastDisplayTimestamp` — the live emission-order cursor; carrying it
   *      across the boundary would let a pre-clear time label a post-clear row.
   *   3. every connected client's chat array — the visible log the user wants
   *      gone. `clear-history` carries NO `seq`, so the client's display cursor
   *      gate cannot drop it, and it cannot be mistaken for a chat row.
   *
   * AND THE PENDING CARD: an unresolved card is a question the user can no
   * longer see once its row is cut, so its resolver is drained here too
   * (`abortInput` resolves them with null, the same "stop waiting" answer a
   * serve stop gives). Without this the agent sits in waitForCardResponse()
   * forever behind a widget that no longer exists.
   *
   * NOT truncated: the transcript. It is append-only and the /clear marker is
   * the durability record; serve-history cuts the projection at the LAST marker
   * (lastClearIndex), so a reload re-derives exactly this emptied view.
   *
   * WHO CALLS THIS: the `/clear` path itself — `Triologue.clear()` emits the
   * boundary through `onMessage` → the writer, but the writer deliberately does
   * NOT forward boundary records to the display observer (see
   * display-record-seam.test.ts:56), so this hub cannot learn about a clear by
   * sniffing the display stream. It is a direct call from agent-repl's
   * double-Ctrl+L callback instead.
   */
  clearDisplayedHistory(): void {
    this.messageLog = [];
    this.lastDisplayTimestamp = undefined;
    this.abortInput();
    this.clients.broadcastState('clear-history');
  }

  /** Broadcast to all clients EXCEPT the sender (multi-browser user-bubble sync). */
  broadcastExcept(sender: WebSocket, type: string, content: string, label?: string, detail?: string): void {
    this.clients.broadcastExcept(sender, type, content, label, detail);
  }

  getAutoState(): boolean {
    return this.autoStateProvider ? this.autoStateProvider() : false;
  }

  /** Run the combined auto entry; return true if a provider ran, false if none registered. */
  enterAuto(): boolean {
    if (this.enterAutoProvider) {
      this.enterAutoProvider();
      return true;
    }
    return false;
  }
}

export type { RawData };
