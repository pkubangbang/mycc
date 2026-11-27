/**
 * serve-queues.ts — the hub's three in-memory queues, extracted from
 * serve-hub.ts: the ephemeral file-upload buffer, the auto-mode/mode/running
 * broadcast signals, and the diagnostics ring.
 *
 * WHY: none of these three need Express, Vite, or the input bridge. They only
 * need (a) the client registry to fan out, (b) a few read-only accessors into
 * the hub's state for the diagnostics snapshot. Keeping them in the hub meant
 * every queue tweak sat next to server wiring; keeping them HERE means the
 * hub's remaining surface is the input/card/steering bridges and the
 * lifecycle, and each queue can be unit-tested against a fake registry.
 *
 * OWNERSHIP: the buffers are owned by these classes (`FileUploadQueue`,
 * `DiagnosticsRing`). The hub holds the instances and forwards.
 */

import { agentIO } from '../loop/agent-io.js';
import { getMaxUploadMb } from '../config.js';
import type { ClientRegistry, MessageLogHolder } from './serve-clients.js';
import type { FileUploadEntry } from './serve-types.js';
import {
  InboundFrameRing,
  recordInbound,
  inputStatus,
  buildServerDumpSlice,
  type InboundFrame,
  type ServerDiagnostics
} from './serve-diag.js';

// ===========================================================================
// File upload queue (webui-only)
// ===========================================================================

/**
 * The ephemeral in-memory file-upload buffer. The dispatcher pushes a decoded
 * upload here; the loop drains it when it starts a turn. Bounded by the
 * per-file cap (`MYCC_MAX_UPLOAD_MB`) enforced in {@link push}.
 */
export class FileUploadQueue {
  private queue: FileUploadEntry[] = [];

  /**
   * @param clients - fan-out target for the `file-upload` / `file-flush` /
   *   rejection frames.
   * @param messageLog - LAZY accessor for the hub's message log. It must be a
   *   thunk, not an array: the hub REASSIGNS `messageLog` (start, stop, and
   *   every `/clear` boundary), so a captured array would be the stale object
   *   and these rows would land in a log nothing reads. Supplying it is what
   *   makes the frames reach `/history`'s no-transcript fallback and
   *   `dumpSnapshot().messageLogLength` — HEAD always got this by routing
   *   through `hub.broadcast()`.
   */
  constructor(
    private readonly clients: ClientRegistry,
    private readonly messageLog: () => MessageLogHolder
  ) {}

  /** Buffer a file upload (defense-in-depth size guard; reject oversized). */
  push(entry: FileUploadEntry): void {
    const maxBytes = getMaxUploadMb() * 1024 * 1024;
    const b64 = entry.data ?? '';
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const approxBytes = Math.floor((b64.length * 3) / 4) - padding;
    if (approxBytes > maxBytes) {
      this.clients.broadcast(
        'error',
        `上传被拒绝：「${entry.filename}」超过 ${getMaxUploadMb()}MB 限制`,
        'serve',
        undefined,
        undefined,
        this.messageLog()
      );
      return;
    }
    this.queue.push(entry);
    this.clients.broadcast('file-upload', entry.filename, undefined, undefined, undefined, this.messageLog());
  }

  /** Take every buffered upload (the loop's consume step). Emits `file-flush`. */
  drain(): FileUploadEntry[] {
    if (this.queue.length === 0) return [];
    const files = this.queue;
    this.queue = [];
    this.clients.broadcast('file-flush', '', undefined, undefined, undefined, this.messageLog());
    return files;
  }

  /** A copy of the buffer (diagnostics / dump reads). */
  list(): FileUploadEntry[] {
    return [...this.queue];
  }

  /** Count only — the diagnostics snapshot never needs the payloads. */
  get size(): number {
    return this.queue.length;
  }

  reset(): void {
    this.queue = [];
  }
}

// ===========================================================================
// Auto-mode + running-state signals (session-level, not logged)
// ===========================================================================

/**
 * The transient session-state frames (`auto`, `mode`, `running`,
 * `auto-commit`). None of them is journaled: they describe the SESSION, not a
 * chat row, and they are replayed to a fresh socket by
 * `ServeHub.replayConnectionState`.
 */
export class SessionSignals {
  constructor(private readonly clients: ClientRegistry) {}

  broadcastAuto(value: boolean): void {
    const payload = JSON.stringify({ type: 'auto', content: value ? 'on' : 'off' });
    this.clients.forEachOpen((ws) => ws.send(payload));
  }

  /**
   * Broadcast plan/normal mode (row obs-002): the browser user must be able to
   * see that edits are being refused because the lead is in plan mode.
   * `content` is 'plan' | 'normal'; the optional allowed file rides in
   * `detail` (the one file editable in plan mode).
   */
  broadcastMode(mode: 'plan' | 'normal', allowedFile?: string): void {
    const payload = JSON.stringify({ type: 'mode', content: mode, detail: allowedFile ?? null });
    this.clients.forEachOpen((ws) => ws.send(payload));
  }

  /** Broadcast agent running state (idle PROMPT/AWAIT → off; processing → on). */
  broadcastRunning(value: boolean): void {
    const payload = JSON.stringify({ type: 'running', content: value ? 'on' : 'off' });
    this.clients.forEachOpen((ws) => ws.send(payload));
  }

  /**
   * Broadcast the auto-commit allow-list (after a successful write).
   *
   * `requestId` is always present and always null: a broadcast reports a write
   * that already happened. Sending the field explicitly keeps every
   * `auto-commit` frame the same shape, so a client can test
   * `requestId === null` rather than relying on it being undefined.
   */
  broadcastAutoCommit(branches: string[]): void {
    const payload = JSON.stringify({ type: 'auto-commit', branches, requestId: null });
    this.clients.forEachOpen((ws) => ws.send(payload));
  }
}

// ===========================================================================
// Diagnostics — the server half of `window.$webui.dump()` (serve-diag.ts)
// ===========================================================================

/** What the dump reports about the hub; supplied by the hub as a closure. */
export type DiagnosticsView = () => Omit<ServerDiagnostics, 'fileUploads' | 'messageLogLength'> & {
  fileUploads: number;
  messageLogLength: number;
};

/**
 * The bounded ring of inbound WS frames plus what the input bridge decided
 * about each one. In-memory and manual-only: read when a human types
 * `$webui.dump()`, never streamed or persisted on a schedule.
 */
export class DiagnosticsRing {
  private ring = new InboundFrameRing();
  /**
   * The ring entry waiting for its outcome. `submitInput` resolves
   * synchronously inside the dispatch of the SAME frame, so one slot is
   * sufficient — but it is kept as a slot rather than a global "last status"
   * so a non-input frame can never inherit an earlier submission's verdict.
   */
  private pending: InboundFrame | null = null;

  /**
   * Record one inbound WS frame, sampling the input bridge at ARRIVAL.
   *
   * The sample must precede dispatch: `submitInput` CONSUMES the resolver it is
   * about to be judged by — sampling afterwards would report "nothing armed"
   * for every delivered submission and make the dump lie about the one case it
   * exists to explain.
   */
  record(rawText: string, armed: boolean, cardPending: boolean): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { type: '(malformed JSON)' };
    }
    const frame = recordInbound(
      (parsed && typeof parsed === 'object' ? parsed : {}) as { type?: unknown; text?: unknown; files?: unknown },
      { armed, cardPending }
    );
    this.ring.push(frame);
    this.pending = frame;
  }

  /**
   * Attribute `submitInput`'s decision to the frame that carried the text.
   * The status rule is evaluated where the decision is MADE (serve-diag's
   * `inputStatus` is the single statement of it).
   */
  attribute(armed: boolean, cardPending: boolean): void {
    const frame = this.pending;
    if (!frame) return;
    frame.status = inputStatus(armed, cardPending);
  }

  /** Drop the pending slot so it cannot leak onto the next frame. */
  clearPending(): void {
    this.pending = null;
  }

  /** The server slice of a dump — pure reads, no side effects. */
  snapshot(
    capturedAt: number,
    view: DiagnosticsView
  ): { capturedAt: number; diagnostics: ServerDiagnostics; frames: unknown[] } {
    const diagnostics = view();
    return {
      capturedAt,
      ...buildServerDumpSlice(diagnostics, this.ring.snapshot())
    };
  }
}

/** Verbose-logging helper shared by the hub's extracted queue modules. */
export function logServe(msg: string): void {
  agentIO.verbose('serve', msg);
}
