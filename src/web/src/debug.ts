/**
 * debug.ts - the `window.__myccDebug` test seam for the web UI
 *
 * The seam is the deterministic entry point for reproducible tests: instead of
 * relying on real WebSocket timing or driving a real LLM, a test (or the
 * in-page debug panel, or an agent-browser `eval`) can inject synthetic server
 * messages in a controlled order and snapshot the resulting reactive state.
 *
 * Design rules (agreed after adversarial review):
 *   - A single namespaced object (`window.__myccDebug`) — no scattered globals.
 *   - Registered only under `import.meta.env.DEV`, and only if the namespace is
 *     not already occupied, so it never leaks into a production bundle or
 *     collides with a real page variable.
 *   - The flag (`state.debugMode`) is OFF by default and is ONLY flipped via
 *     `enable()`/`disable()` — there is no persistent UI toggle. The debug
 *     panel renders only when the flag is on.
 *   - `inject*` routes through `applyServerMessage` (the same single source of
 *     truth as the real WS handler), so injection exercises the exact same
 *     state-transition logic as live events — no drift.
 */

import type { ChatState, ChatMessage, SteeringNote } from './types';
import { applyServerMessage, type DispatchContext } from './message-dispatch';

export interface DebugSnapshot {
  isWaiting: boolean;
  isRunning: boolean;
  isAutoMode: boolean;
  debugMode: boolean;
  steeringBuffer: SteeringNote[];
  pendingSteeringReview: SteeringNote[];
  messageCount: number;
  teammateMessageCount: number;
}

export interface MyccDebug {
  enable(): void;
  disable(): void;
  snapshot(): DebugSnapshot;
  inject(msg: ChatMessage): void;
  injectSequence(msgs: ChatMessage[]): Promise<void>;
  reset(): void;
}

/**
 * Install the debug seam. Called once from main.ts after `state` exists and
 * before (or after) mount; it only touches the global if DEV + free.
 */
export function registerDebugSeam(
  state: ChatState,
  ctx: DispatchContext,
): void {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV) return;
  if (window.__myccDebug) return; // already registered (e.g. HMR re-run)

  const seam: MyccDebug = {
    enable(): void {
      state.debugMode = true;
    },
    disable(): void {
      state.debugMode = false;
    },
    snapshot(): DebugSnapshot {
      return {
        isWaiting: state.isWaiting,
        isRunning: state.isRunning,
        isAutoMode: state.isAutoMode,
        debugMode: state.debugMode,
        steeringBuffer: [...state.steeringBuffer],
        pendingSteeringReview: [...state.pendingSteeringReview],
        messageCount: state.messages.length,
        teammateMessageCount: state.teammateMessages.length,
      };
    },
    inject(msg: ChatMessage): void {
      applyServerMessage(state, msg, ctx);
    },
    async injectSequence(msgs: ChatMessage[]): Promise<void> {
      for (const m of msgs) {
        applyServerMessage(state, m, ctx);
        // Flush Vue's reactivity queue so any watcher (auto-scroll, card
        // visibility) observes the mutation before the next message arrives.
        await nextTick();
      }
    },
    reset(): void {
      state.steeringBuffer.splice(0);
      state.pendingSteeringReview.splice(0);
      state.isWaiting = false;
      state.isRunning = false;
      state.isAutoMode = false;
      state.debugMode = false;
    },
  };

  window.__myccDebug = seam;
}

/** Promise-based nextTick to flush the Vue reactivity queue between injections. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    // Vue's nextTick is preferred, but importing it here would couple debug.ts
    // to a specific Vue scheduler. A microtask (queueMicrotask) flushes the
    // scheduler's pending jobs in the same macrotask boundary for our
    // purposes; components observe state synchronously in tests. Keep the
    // DOM-free inject (applyServerMessage) synchronous and let consumers
    // `await injectSequence` to yield between messages.
    queueMicrotask(resolve);
  });
}

declare global {
  interface Window {
    __myccDebug?: MyccDebug;
  }
}
