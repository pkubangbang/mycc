/**
 * loop-events.ts - LoopEventEmitter singleton
 *
 * A lightweight event emitter for agent-loop observability.
 *
 * CRITICAL design goal: **zero production overhead when no listeners are
 * attached**.  `emit()` performs a single Map lookup and returns immediately
 * if no listeners exist for the event — no array allocation, no trace push,
 * no console output.  In production (no test harness running) the emitter is
 * effectively a no-op.
 *
 * In tests, `captureLoopEvents()` explicitly enables trace retention. Ordinary
 * production listeners (such as the WebUI state mirror) receive events without
 * causing the internal trace array to grow without bound.
 */

// ============================================================================
// Event Types
// ============================================================================

export const LOOP_EVENT_TYPES = [
  'state_transition',
  'llm_call',
  'llm_empty',
  'tool_executed',
  'tool_error',
  'hook_result',
  'compact_triggered',
  'confusion_score',
  'triologue_event',
  'esc_interrupt',
  'brief_message',
  'serve_state',
  'todo_changed',
  'auto_recap',
] as const;

export type LoopEventType = (typeof LOOP_EVENT_TYPES)[number];

// ============================================================================
// Trace Entry
// ============================================================================

export interface TraceEntry<P = unknown> {
  event: LoopEventType;
  payload: P;
  timestamp: number;
}

// ============================================================================
// Payload Types
// ============================================================================

export interface StateTransitionPayload {
  from: string;
  to: string;
}

export interface LlmCallPayload {
  model?: string;
  toolCount: number;
}

export interface LlmEmptyPayload {
  retry: number;
  maxRetries: number;
}

export interface ToolExecutedPayload {
  tool: string;
  outputLength: number;
}

export interface ToolErrorPayload {
  tool: string;
  error: string;
  kind: 'result_too_large' | 'generic';
}

export interface HookResultPayload {
  blocked: boolean;
  compactRequested: boolean;
}

export interface CompactTriggeredPayload {
  reason: 'proactive' | 'deferred';
}

export interface ConfusionScorePayload {
  score: number;
}

export interface TriologueEventPayload {
  kind: 'compact' | 'misorder' | 'tool_misalign';
  detail: string;
}

export interface EscInterruptPayload {
  state: string;
}

/**
 * Auto-recap produced a verdict, and possibly a fold.
 *
 * Fired from `states/hook.ts` step 4a on EVERY qualifying brief turn, including
 * the negative verdicts — the point of the channel is that "the signal looked
 * and said no" is observable, not just "something was folded". A silent `skip`
 * would make a mis-tuned signal indistinguishable from a feature that is off.
 *
 * `verdict` mirrors `RecapSignal['status']` ('failed' included: a thrown
 * retryChat must not look like a deliberate skip). The fold fields are present
 * only when a rewind actually ran.
 */
export interface AutoRecapPayload {
  /**
   * `esc` is the fourth case: the user pressed ESC and the fold was discarded.
   * Reported as its own value so a cancellation is neither recorded as a
   * deliberate `skip` nor as a fault.
   */
  verdict: 'recap' | 'skip' | 'failed' | 'esc';
  /** The hash the signal acted on. Absent when the signal named no target. */
  targetHash?: string;
  reason?: string;
  foldedMessages?: number;
  tokensBefore?: number;
  tokensAfter?: number;
}

/**
 * The todo list changed — one event carrying the WHOLE list.
 *
 * Emitted from inside every `TodoModule` mutation (`create` / `update` / `pin`
 * / `clear`), which is what makes the WebUI panel impossible to bypass: a new
 * mutation path reaches the panel without anyone remembering to emit, because
 * the emit IS part of the mutation.
 *
 * Deliberately ONE `todo_changed` carrying the complete list rather than four
 * granular events:
 *   - the consumer (the WebUI panel, `serve-todos.ts`) needs the CURRENT LIST,
 *     not a diff — it renders a wholesale snapshot, exactly like `/history`;
 *   - granular events would push "reconstruct the list from events" back into
 *     the consumer, which is the bug this channel exists to kill (one item
 *     created + updated + pinned rendered as three rows);
 *   - `source` keeps the observability granularity would have bought — a test
 *     or debug listener can still tell a pin from a clear — for one field, with
 *     no second subscriber to keep in sync.
 *
 * `items` is `TodoModule.getItems()`: a per-item copy (the item object AND its
 * `previousHashes` ring are cloned), so a listener may retain it after the
 * mutation returns without observing later mutations through an alias.
 */
export interface TodoChangedPayload {
  /**
   * Complete current list, ascending by id (a COPY — safe to retain).
   *
   * Structurally typed instead of importing `TodoItem` from `types.ts`: this
   * module is deliberately a ZERO-IMPORT leaf (see the header), and a type-only
   * import is still an edge that invites the next person to import a value.
   * `TodoItem` satisfies this shape.
   */
  items: ReadonlyArray<{ id: number; name: string; done: boolean; note?: string; pinned?: boolean; preventStop?: string }>;
  /**
   * Which mutation produced this snapshot — for logging/tests, not rendering.
   *
   * `'autoclear'` is distinct from `'update'` on purpose (review B6): an update
   * that completes the last open non-pinned item PURGES every non-pinned row, so
   * its emitted list differs from the edited row. Collapsing that into 'update'
   * made "one row changed" and "the checklist was emptied" indistinguishable to
   * a subscriber.
   */
  source: 'create' | 'update' | 'pin' | 'clear' | 'autoclear';
}

/**
 * WebUI serve lifecycle flip — RETIRED as a signal.
 *
 * The flip now travels through the plain boolean holder at the bottom of this
 * file (setWebUiUp/isWebUiUp), which the loop/context layer reads directly. It
 * is deliberately NOT an event: routing it through this emitter required every
 * reader to reach a Core instance that owned the flag, and Core to consult the
 * serve layer — the coupling the holder removes (see the
 * `Reading ServeHub state pulls express/vite/ws…` pitfall).
 *
 * The type entry is kept so the event-type list (and the test harness that
 * subscribes to every type via captureLoopEvents) stays stable; nothing emits
 * it anymore.
 */
export interface ServeStatePayload {
  running: boolean;
}

export type LoopEventPayload =
  | StateTransitionPayload
  | LlmCallPayload
  | LlmEmptyPayload
  | ToolExecutedPayload
  | ToolErrorPayload
  | HookResultPayload
  | CompactTriggeredPayload
  | ConfusionScorePayload
  | TriologueEventPayload
  | EscInterruptPayload
  | ServeStatePayload
  | TodoChangedPayload
  | AutoRecapPayload;

// ============================================================================
// Callback Type
// ============================================================================

export type LoopEventCallback = (payload: unknown, entry: TraceEntry) => void;

// ============================================================================
// LoopEventEmitter
// ============================================================================

class LoopEventEmitter {
  private listeners: Map<LoopEventType, Set<LoopEventCallback>> = new Map();
  private trace: TraceEntry[] = [];
  private traceEnabled = false;

  /** Enable trace retention explicitly (tests/debug tooling only). */
  setTraceEnabled(enabled: boolean): void {
    this.traceEnabled = enabled;
    if (!enabled) this.trace = [];
  }

  /**
   * Subscribe to an event.
   * @returns an unsubscribe function — call it to remove the listener.
   */
  on(event: LoopEventType, cb: LoopEventCallback): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);

    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  /**
   * `true` when at least one listener is subscribed to `event`.
   *
   * Lets a hot emitter SKIP building its payload when nobody listens — the
   * caller can then avoid work (`Todo.emitChanged` materialises the whole
   * list) instead of paying for a payload `emit()` would immediately discard.
   */
  hasListeners(event: LoopEventType): boolean {
    const set = this.listeners.get(event);
    return !!set && set.size > 0;
  }

  /**
   * Emit an event.
   *
   * No listeners: return before allocating an entry. With listeners, notify
   * them regardless of trace mode; retain entries only when tracing is enabled.
   *
   * LISTENER ISOLATION: a throwing listener is caught and reported, so it
   * cannot abort the remaining listeners or propagate into the mutation that
   * emitted. This matters for emitters called from inside state changes (e.g.
   * `Todo.emitChanged` runs inside `createTodo`): without it, one bad
   * subscriber would turn a successful mutation into a thrown error.
   */
  emit(event: LoopEventType, payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return; // silent — zero production overhead

    const entry: TraceEntry = { event, payload, timestamp: Date.now() };
    if (this.traceEnabled) this.trace.push(entry);
    for (const cb of [...set]) {
      try {
        cb(payload, entry);
      } catch (err) {
        // Best-effort diagnostics only (verbose mode); never rethrow.
        if (process.env.MYCC_DEBUG_ANSI === 'trace-listeners') {
          console.error(`[loop-events] listener for '${event}' threw:`, err);
        }
      }
    }
  }

  /**
   * Get a copy of the explicitly captured trace. The array stays empty in
   * production unless trace retention was enabled.
   */
  getTrace(): TraceEntry[] {
    return [...this.trace];
  }

  /**
   * Clear the trace and remove ALL listeners.
   * Called by test cleanup to ensure isolation between tests.
   */
  clear(): void {
    this.listeners.clear();
    this.trace = [];
    this.traceEnabled = false;
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const loopEvents = new LoopEventEmitter();

// ============================================================================
// WebUI serve-state holder
// ============================================================================

/**
 * Process-wide "is the WebUI server up?" flag.
 *
 * This is deliberately a plain boolean in a ZERO-IMPORT leaf module rather
 * than a `loopEvents` event or a field on Core. History:
 *
 *  - It was once a `'serve_state'` event on `loopEvents`; consumers had to
 *    reach a Core instance that owned the flag, and Core had to consult the
 *    serve layer — exactly the cross-layer coupling we work to avoid.
 *  - It was briefly homed in `src/serve/activate.ts`, but the loop layer
 *    importing activate.ts transitively drags in
 *    web-input-provider → agent-io → esc-wrap-up → serve-hub → express/vite/ws,
 *    defeating the lazy-`serve-hub` refactor. Measured: +60 modules / 13
 *    express/vite/ws modules on a plain (non-serving) boot.
 *
 * The invariant is therefore: **serve → holder, never holder → serve**. The
 * serve layer is the sole WRITER (the three seams are `activateServe()`,
 * `ServeHub.stop()`, and `ServeHub.restartServe()`); the loop/context layer
 * only READS via `isWebUiUp()`.
 *
 * Default `false`: a session that never loaded the serve layer is correctly
 * reported as "not up", with no import cost and no throw.
 */
let webUiUp = false;

/** Record whether the WebUI server is up. Called by the serve layer only. */
export function setWebUiUp(value: boolean): void {
  webUiUp = value;
}

/** Is the WebUI server currently up? Read by the loop/context layer. */
export function isWebUiUp(): boolean {
  return webUiUp;
}