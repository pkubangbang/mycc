/**
 * dump.ts - the CLIENT half of `window.$webui.dump()` (observability)
 *
 * ## The interaction this serves
 *
 *   press F12  →  console  →  `$webui.dump()`  →  a JSON file downloads
 *   →  attach the file (drag it into the composer)  →  the agent reads it
 *
 * ## Why a dump at all
 *
 * A WebUI defect is often gone by the time anyone reads the code: the
 * transcript journal holds the query once while the screen showed it twice, and
 * a submission can vanish with no ack. Both are questions about STATE AT AN
 * INSTANT — phase flags, what the cursor had rendered, which frames the gate
 * discarded, what the server thought of each inbound frame — and none of that
 * survives a reload. So the dump captures the instant, from both observers
 * (this file is the browser half; src/serve/serve-diag.ts the server half;
 * `dump()` joins them).
 *
 * ## Design rules
 *
 *  - ONE bounded ring for outbound frames and ONE for inbound frames, recorded
 *    BEFORE the `isAlreadyRendered` gate in main.ts. Frames that gate drops are
 *    precisely the evidence a duplicate-row report needs, so recording after the
 *    gate would erase the witness.
 *  - PURE core (`recordFrame`, `buildClientSlice`, `mergeDump`, `serializeDump`)
 *    with no DOM/WebSocket/store imports, so it is unit-testable in the
 *    node-environment Vitest suite.
 *  - MANUAL INVOCATION ONLY. Nothing here uploads, schedules or beacons: a dump
 *    runs when a human types the command. Automatic capture would quietly turn
 *    this into a conversation-retention mechanism.
 *  - Content is NOT redacted (the file must explain a lost query) but IS
 *    truncated to keep one dump attachable.
 */

/** Bumped when the shape changes incompatibly; readers validate this first. */
export const DUMP_FORMAT = 'mycc.webui.dump/1';

/** Ring capacity for each direction. Enough for a send → ESC → send window. */
export const DEFAULT_RING_CAPACITY = 500;

/** Per-frame content truncation (the server ring keeps more: see serve-diag). */
export const FRAME_CONTENT_LIMIT = 400;

/** Per-message content truncation in the rendered-row list. */
export const MESSAGE_CONTENT_LIMIT = 400;

export type FrameDirection = 'in' | 'out';

/** One frame as this page saw it. */
export interface ClientFrame {
  /** epoch ms — joins with the server ring (same browser clock when posted back). */
  t: number;
  dir: FrameDirection;
  type: string;
  seq?: number;
  label?: string;
  content?: string;
  /** Outbound only: false when wsSend found no OPEN socket (the frame never left). */
  sent?: boolean;
  /**
   * Inbound only: true when the journal cursor gate would drop this frame.
   * Recorded here because the gate's decision is otherwise invisible.
   */
  droppedByGate?: boolean;
}

/** A rendered row, trimmed to what a duplicate-row investigation needs. */
export interface DumpMessage {
  type: string;
  id?: number;
  seq?: number;
  label?: string;
  timestamp?: number;
  /** The local echo marker — the row that must be reconciled by the journal. */
  optimistic?: boolean;
  content: string;
}

/** The browser half of a dump. */
export interface ClientDumpSlice {
  meta: {
    capturedAt: number;
    href: string;
    userAgent: string;
    wsUrl: string | null;
    /** How many times this page re-opened the socket (churn hides frame races). */
    reconnects: number;
  };
  state: {
    phase: string;
    isAutoMode: boolean;
    isPlanMode: boolean;
    isWaiting: boolean;
    isRunning: boolean;
    hasPendingCard: boolean;
    connectionStatus: string;
    inputText: string;
    pendingFiles: string[];
    steeringBuffer: Array<{ id: number; text: string }>;
    pendingSteeringReview: Array<{ id: number; text: string }>;
  };
  cursor: {
    lastRenderedSeq: number;
    /**
     * The last SERVER-STATED `/clear` boundary this page adopted (0 = none).
     * Here because it is the one number that explains why rows vanished from a
     * hydrated store: `seq <= this` was cut by the server, not lost locally.
     */
    clearBoundarySeq: number;
    historyDirty: boolean;
    lastHistoryEtag: string | null;
    sessionId: string | null;
  };
  messages: DumpMessage[];
  teammateMessages: DumpMessage[];
  frames: ClientFrame[];
}

/** The joined artifact. */
export interface WebuiDump {
  format: string;
  capturedAt: number;
  client: ClientDumpSlice;
  /** null when /dump could not be reached — the file still carries a truth. */
  server: unknown | null;
  serverError?: string;
  summary: {
    messages: number;
    framesIn: number;
    framesOut: number;
    /** Rendered user rows with no journal seq — every one is an unreconciled echo. */
    optimisticUserRows: number;
    /** Frames the cursor gate discarded (duplicates it prevented). */
    droppedByGate: number;
  };
}

/**
 * A bounded, oldest-first ring. Same contract as the server ring: constant
 * memory, copy-on-read.
 */
export class FrameRing {
  private frames: ClientFrame[] = [];
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_RING_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  push(frame: ClientFrame): void {
    this.frames.push(frame);
    if (this.frames.length > this.capacity) {
      this.frames.splice(0, this.frames.length - this.capacity);
    }
  }

  snapshot(): ClientFrame[] {
    return this.frames.map((f) => ({ ...f }));
  }

  get size(): number {
    return this.frames.length;
  }

  clear(): void {
    this.frames = [];
  }
}

/** Truncate with a marker that survives a human reading the file. */
export function truncateContent(text: string, limit: number = FRAME_CONTENT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…(${text.length} chars)`;
}

/**
 * Normalise one frame for the ring.
 *
 * Reads the wire shape tolerantly: cards carry their text in `query`, steering
 * snapshots carry `notes`, and a malformed frame must still leave a record that
 * SOMETHING arrived (a missing frame is the one fact a diagnosis cannot
 * recover from).
 */
export function recordFrame(
  raw: unknown,
  dir: FrameDirection,
  extra: { droppedByGate?: boolean; sent?: boolean } = {},
  now: number = Date.now()
): ClientFrame {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const frame: ClientFrame = {
    t: now,
    dir,
    type: typeof m.type === 'string' ? m.type : '(malformed)'
  };
  if (typeof m.seq === 'number' && Number.isFinite(m.seq)) frame.seq = m.seq;
  if (typeof m.label === 'string') frame.label = m.label;
  const text = typeof m.content === 'string' ? m.content : typeof m.query === 'string' ? m.query : undefined;
  if (text !== undefined) frame.content = truncateContent(text);
  if (extra.droppedByGate !== undefined) frame.droppedByGate = extra.droppedByGate;
  if (extra.sent !== undefined) frame.sent = extra.sent;
  return frame;
}

/** Trim one rendered row for the dump. */
export function toDumpMessage(msg: {
  type: string;
  id?: number;
  seq?: number;
  label?: string;
  timestamp?: number;
  optimistic?: boolean;
  content?: string;
}): DumpMessage {
  const out: DumpMessage = { type: msg.type, content: truncateContent(msg.content ?? '', MESSAGE_CONTENT_LIMIT) };
  if (msg.id !== undefined) out.id = msg.id;
  if (msg.seq !== undefined) out.seq = msg.seq;
  if (msg.label !== undefined) out.label = msg.label;
  if (msg.timestamp !== undefined) out.timestamp = msg.timestamp;
  if (msg.optimistic !== undefined) out.optimistic = msg.optimistic;
  return out;
}

/** Inputs the page hands to the pure builder (everything is read, nothing is mutated). */
export interface ClientSliceInputs {
  capturedAt: number;
  href: string;
  userAgent: string;
  wsUrl: string | null;
  reconnects: number;
  state: ClientDumpSlice['state'];
  cursor: ClientDumpSlice['cursor'];
  messages: DumpMessage[];
  teammateMessages: DumpMessage[];
  frames: ClientFrame[];
}

/** Assemble the browser slice. */
export function buildClientSlice(inputs: ClientSliceInputs): ClientDumpSlice {
  return {
    meta: {
      capturedAt: inputs.capturedAt,
      href: inputs.href,
      userAgent: inputs.userAgent,
      wsUrl: inputs.wsUrl,
      reconnects: inputs.reconnects
    },
    state: {
      ...inputs.state,
      steeringBuffer: inputs.state.steeringBuffer.map((n) => ({ ...n })),
      pendingSteeringReview: inputs.state.pendingSteeringReview.map((n) => ({ ...n }))
    },
    cursor: { ...inputs.cursor },
    messages: inputs.messages.map((m) => ({ ...m })),
    teammateMessages: inputs.teammateMessages.map((m) => ({ ...m })),
    frames: inputs.frames.map((f) => ({ ...f }))
  };
}

/**
 * Join the two observers into the artifact the user attaches.
 *
 * The summary is computed HERE, not by the reader: `optimisticUserRows` (user
 * rows with no seq) and `droppedByGate` are the two numbers that answer the
 * "shown twice" / "never arrived" question at a glance, and computing them at
 * capture time keeps them true even if the file is later edited.
 */
export function mergeDump(client: ClientDumpSlice, server: unknown | null, serverError?: string): WebuiDump {
  // Re-copy the browser slice instead of trusting the caller's copy. The page
  // keeps mutating its store while this dump is being serialized, and a dump is
  // evidence: it must describe the instant it was captured, not whatever the
  // live arrays drifted to afterwards.
  const captured: ClientDumpSlice = {
    meta: { ...client.meta },
    state: {
      ...client.state,
      steeringBuffer: client.state.steeringBuffer.map((n) => ({ ...n })),
      pendingSteeringReview: client.state.pendingSteeringReview.map((n) => ({ ...n }))
    },
    cursor: { ...client.cursor },
    messages: client.messages.map((m) => ({ ...m })),
    teammateMessages: client.teammateMessages.map((m) => ({ ...m })),
    frames: client.frames.map((f) => ({ ...f }))
  };
  const framesIn = captured.frames.filter((f) => f.dir === 'in');
  const optimisticUserRows = captured.messages.filter((m) => m.type === 'user' && m.seq === undefined).length;
  const dump: WebuiDump = {
    format: DUMP_FORMAT,
    capturedAt: captured.meta.capturedAt,
    client: captured,
    server,
    summary: {
      messages: captured.messages.length,
      framesIn: framesIn.length,
      framesOut: captured.frames.filter((f) => f.dir === 'out').length,
      optimisticUserRows,
      droppedByGate: framesIn.filter((f) => f.droppedByGate === true).length
    }
  };
  if (serverError !== undefined) dump.serverError = serverError;
  return dump;
}

/** Pretty JSON — a dump is read by a human before it is read by an agent. */
export function serializeDump(dump: WebuiDump): string {
  return JSON.stringify(dump, null, 2);
}

/** `mycc-webui-dump-<session>-<iso>.json`, filesystem-safe on every platform. */
export function dumpFilename(sessionId: string | null, capturedAt: number): string {
  const session = (sessionId ?? 'no-session').replace(/[^A-Za-z0-9-]/g, '');
  const iso = new Date(capturedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `mycc-webui-dump-${session}-${iso}.json`;
}

/** The one-line console summary printed next to the download. */
export function dumpSummaryLine(dump: WebuiDump): string {
  const s = dump.summary;
  const server = dump.server === null ? 'server=UNREACHABLE' : 'server=ok';
  return `[mycc] dump: ${s.messages} rows, in=${s.framesIn} out=${s.framesOut}, optimisticUserRows=${s.optimisticUserRows}, droppedByGate=${s.droppedByGate}, ${server}`;
}
