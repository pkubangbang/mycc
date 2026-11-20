/**
 * serve-diag.ts - the SERVER half of `window.$webui.dump()` (observability)
 *
 * ## Why this module exists
 *
 * Two WebUI defects proved undiagnosable from the artifacts we collected after
 * the fact: the transcript journal showed the query ONCE while the screen
 * showed it TWICE, and a submission could vanish with no record anywhere that
 * it had ever existed. The missing witnesses were both server-side:
 *
 *   1. every inbound WS frame, in order, with what `submitInput` decided about
 *      it — today the `else` branch of ServeHub.submitInput SILENTLY drops a
 *      submission (no ack, no log, no journal row), so a dropped query leaves
 *      no trace at all;
 *   2. the live input-bridge state AT THE INSTANT the frame arrived (was a
 *      prompt armed? a card pending?) — the only fact that separates "the
 *      client misrouted" from "the server dropped it".
 *
 * This ring is deliberately in-memory and bounded: a dump is a MANUAL
 * post-incident capture (the user presses F12, types `$webui.dump()`), never a
 * continuous upload. Keeping it here instead of in `ServeHub` means the ring
 * arithmetic is pure and testable in the node-environment Vitest suite without
 * the Express + Vite + agent-io module graph.
 */

/** What `save()` decided. Mirrors ServeHub.submitInput's return status. */
export type InputStatus = 'delivered' | 'card-pending' | 'dropped';

/** One inbound WS frame, recorded BEFORE dispatch. */
export interface InboundFrame {
  /** epoch ms — the dump's join key with the browser ring (same process clock). */
  t: number;
  type: string;
  /** Truncated text, or undefined for frames that carry none (exit/interrupt). */
  text?: string;
  /** File names only — the payload is base64 and would swamp the dump. */
  fileNames?: string[];
  /** True when a prompt wait was armed (inputResolver) at arrival. */
  armed?: boolean;
  /** True when at least one card resolver was pending at arrival. */
  cardPending?: boolean;
  /** What the handler did with it. Absent for frames that never reach input. */
  status?: InputStatus;
}

/** The hub-side facts the dump reports. All reads, no side effects. */
export interface ServerDiagnostics {
  running: boolean;
  port: number;
  host: string | null;
  agentRunning: boolean;
  auto: boolean;
  mode: 'plan' | 'normal';
  clients: number;
  inputArmed: boolean;
  cardResolvers: number;
  steeringRevision: number;
  steeringNotes: Array<{ id: number; text: string }>;
  fileUploads: number;
  messageLogLength: number;
  historyRows: number;
  historyMaxSeq: number;
}

/** The whole server slice of a dump. */
export interface ServerDumpSlice {
  diagnostics: ServerDiagnostics;
  frames: InboundFrame[];
}

/** Default ring capacity: enough for a full send → ESC → send window. */
export const DEFAULT_DIAG_CAPACITY = 500;

/** Text truncation bound for a recorded frame (the client ring uses 200). */
export const FRAME_TEXT_LIMIT = 1000;

/**
 * A bounded, oldest-first ring of inbound frames.
 *
 * `push` evicts from the head once at capacity, so memory is constant no matter
 * how long the serve runs — a diagnostic that can itself become a leak is not a
 * diagnostic. `snapshot` returns a COPY: the dump must not let a caller mutate
 * the ring, and a frozen view keeps concurrent pushes from tearing a dump that
 * is being serialized.
 */
export class InboundFrameRing {
  private frames: InboundFrame[] = [];
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_DIAG_CAPACITY) {
    // A non-positive capacity would make `push` drop everything while still
    // claiming to record; clamp instead of trusting the caller.
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  push(frame: InboundFrame): void {
    this.frames.push(frame);
    if (this.frames.length > this.capacity) {
      this.frames.splice(0, this.frames.length - this.capacity);
    }
  }

  /** Oldest→newest copy of the recorded frames. */
  snapshot(): InboundFrame[] {
    return this.frames.map((f) => ({ ...f }));
  }

  get size(): number {
    return this.frames.length;
  }

  clear(): void {
    this.frames = [];
  }
}

/**
 * Build the recorded frame for an inbound WS message, BEFORE dispatch.
 *
 * The input-bridge state is sampled here — not after the handler runs —
 * because `submitInput` consumes the resolver: reading it afterwards would
 * report "nothing armed" for every delivered frame and make the dump lie about
 * exactly the case it exists to explain.
 *
 * @param raw     - the parsed inbound message (typed loosely to stay free of
 *                  serve-types; the caller passes the parsed WsMessage).
 * @param bridge  - the LIVE state of the input bridge at arrival.
 * @param now     - injectable clock (tests pin it).
 */
export function recordInbound(
  raw: { type?: unknown; text?: unknown; files?: unknown },
  bridge: { armed: boolean; cardPending: boolean },
  now: number = Date.now()
): InboundFrame {
  const frame: InboundFrame = {
    t: now,
    type: typeof raw.type === 'string' ? raw.type : '(malformed)',
    armed: bridge.armed,
    cardPending: bridge.cardPending
  };
  if (typeof raw.text === 'string') {
    frame.text =
      raw.text.length > FRAME_TEXT_LIMIT
        ? `${raw.text.slice(0, FRAME_TEXT_LIMIT)}…(${raw.text.length} chars)`
        : raw.text;
  }
  if (Array.isArray(raw.files)) {
    // Names ONLY: the base64 bodies are megabytes and would bury the dump.
    frame.fileNames = raw.files.map((f) =>
      f && typeof f === 'object' && typeof (f as { filename?: unknown }).filename === 'string'
        ? (f as { filename: string }).filename
        : '(unnamed)'
    );
  }
  return frame;
}

/**
 * The status a submission actually received.
 *
 * This is the ONE rule the whole diagnosis turns on, so it is written down
 * once, here, and pinned by a test: a submission is delivered iff a prompt wait
 * is armed; otherwise it becomes a card warning iff a card is pending; and
 * otherwise it is DROPPED (ServeHub.submitInput's silent `else`).
 */
export function inputStatus(armed: boolean, cardPending: boolean): InputStatus {
  if (armed) return 'delivered';
  if (cardPending) return 'card-pending';
  return 'dropped';
}

/**
 * Assemble the server slice.
 *
 * @param diagnostics - the live hub facts (see ServerDiagnostics).
 * @param frames      - the ring snapshot.
 */
export function buildServerDumpSlice(diagnostics: ServerDiagnostics, frames: InboundFrame[]): ServerDumpSlice {
  return { diagnostics: { ...diagnostics }, frames: frames.map((f) => ({ ...f })) };
}

/** Count frames by status — the one-line summary printed next to the download. */
export function summarizeFrames(frames: readonly InboundFrame[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of frames) {
    const key = f.status ?? `${f.type}:no-status`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
