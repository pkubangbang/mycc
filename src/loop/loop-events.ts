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
 * In tests, `captureLoopEvents()` (see `src/tests/loop/loop-events-helper.ts`)
 * attaches listeners to every event type, which activates tracing.  The
 * emitter's internal `trace` array is only populated while listeners exist,
 * so memory usage stays flat in production.
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

export interface BriefMessagePayload {
  message: string;
  confidence: number;
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
  | BriefMessagePayload;

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
   * Emit an event.
   *
   * ZERO OVERHEAD when no listeners are attached: a single Map lookup returns
   * early — no trace push, no iteration, no allocation.  When listeners exist,
   * the event is recorded in the trace and every listener is notified.
   */
  emit(event: LoopEventType, payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return; // silent — zero production overhead

    const entry: TraceEntry = { event, payload, timestamp: Date.now() };
    this.trace.push(entry);
    for (const cb of set) {
      cb(payload, entry);
    }
  }

  /**
   * Get a copy of the current trace.
   * Returns an empty array when no listeners were ever attached.
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
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const loopEvents = new LoopEventEmitter();