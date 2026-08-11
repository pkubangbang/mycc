/**
 * loop-events-helper.ts - Test helper for LoopEventEmitter
 *
 * Provides `captureLoopEvents()` to subscribe to ALL event types and collect
 * the trace, and `getStateSequence()` to extract the state sequence from a
 * trace (filtering `state_transition` events).
 */

import { loopEvents, LOOP_EVENT_TYPES, type TraceEntry, type LoopEventType } from '../../loop/loop-events.js';
import type { AgentState } from '../../loop/state-machine.js';

/**
 * Subscribe to all loop event types and collect the trace.
 *
 * @returns `{ trace, cleanup }`:
 *  - `trace`: a getter array — call `trace` (it returns a fresh copy each
 *    time) to inspect captured events.
 *  - `cleanup`: call to unsubscribe all listeners and reset the emitter trace.
 *    MUST be called in `afterEach` to maintain test isolation.
 */
export function captureLoopEvents(): {
  trace: TraceEntry[];
  cleanup: () => void;
} {
  // Clear any previous state so each capture starts fresh
  loopEvents.clear();

  const unsubs: Array<() => void> = [];

  for (const eventType of LOOP_EVENT_TYPES) {
    unsubs.push(loopEvents.on(eventType as LoopEventType, () => {}));
  }

  return {
    /** Returns a copy of the current trace */
    get trace(): TraceEntry[] {
      return loopEvents.getTrace();
    },
    /** Unsubscribe all listeners and clear the trace */
    cleanup(): void {
      for (const unsub of unsubs) unsub();
      loopEvents.clear();
    },
  };
}

/**
 * Extract the state sequence from a trace by filtering `state_transition`
 * events and mapping their `to` values to AgentState.
 *
 * @param trace - The trace array from `captureLoopEvents()`
 * @returns An array of AgentState values representing the transition targets
 */
export function getStateSequence(trace: TraceEntry[]): AgentState[] {
  return trace
    .filter((entry) => entry.event === 'state_transition')
    .map((entry) => (entry.payload as { to: string }).to as AgentState);
}