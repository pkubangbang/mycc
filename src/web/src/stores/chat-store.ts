/**
 * chat-store.ts - Pinia store: the single source of truth for web UI phase
 *
 * Replaces the 4 loose boolean flags (`isWaiting` / `isRunning` /
 * `isAutoMode` / `hasPendingCard`) with a single `phase` enum. Most flags
 * become **derived computed getters** — they can never reach an invalid
 * combination because they are projections of one enum value.
 *
 *   phase (source of truth) → isRunning, hasPendingCard, hasReview (derived)
 *   phase + isAutoMode (orthogonal boolean) → isWaiting (derived)
 *
 * `isAutoMode` stays an **orthogonal boolean**, NOT derived from
 * `phase === 'await'`: `working`-in-auto and `working`-in-manual are the
 * same UI phase, but the diagnostic chip row needs to show the auto flag
 * while running. `await` is the idle-auto phase; `auto:on` while `working`
 * flips the boolean without changing phase.
 *
 * Design doc: `docs/webui-phase-fsm-design.md` (peer-reviewed by DeepSeek
 * `26eec3c3` and glm-5.3-flash `51b87cc7`).
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  ChatMessage,
  SteeringNote,
  FileInfo,
  ConnectionStatus,
} from '../types';

/** The 6 phases of the web UI interaction state machine.
 *
 *  | Phase       | Meaning                                      | Server signal(s)              |
 *  |-------------|----------------------------------------------|-------------------------------|
 *  | `idle`      | Transient vacuum between `running:off` & next | (gap)                        |
 *  | `submitted` | Send→running gap; backend doing post-input LLM | (client-side optimistic)     |
 *  | `working`   | Agent actively processing (confirmed by running:on) | `running:on`            |
 *  | `prompt`    | Waiting for user input                       | `prompt` + `running:off`      |
 *  | `card`      | Interactive card pending response            | `card`                        |
 *  | `await`     | Auto mode, idle, waiting for events          | `auto:on` (no running)        |
 *
 *  `idle` is **transient** — the no-deadlock invariant (chaos-monkey harness)
 *  enforces it must be resolved by the next event. `submitted` is the only
 *  phase with a time-based exit (15s expiry safety net → `idle`). */
export type WebuiPhase = 'idle' | 'submitted' | 'working' | 'prompt' | 'card' | 'await';

export const useChatStore = defineStore('chat', () => {
  // ── Source of truth ──
  const phase = ref<WebuiPhase>('idle');

  // ── Orthogonal boolean (NOT derived from phase — see §2.3) ──
  const isAutoMode = ref(false);

  // ── Orthogonal data (co-occurs with any phase) ──
  const steeringBuffer = ref<SteeringNote[]>([]);
  const pendingSteeringReview = ref<SteeringNote[]>([]);
  const messages = ref<ChatMessage[]>([]);
  const teammateMessages = ref<ChatMessage[]>([]);
  const inputText = ref('');
  const pendingFiles = ref<FileInfo[]>([]);
  const connectionStatus = ref<ConnectionStatus>('disconnected');
  const showRetry = ref(false);
  const verboseLogs = ref(false);
  /** Transient error string shown in the StatusBar when a send fails (e.g.
   *  input submitted while the socket isn't OPEN). Cleared on next success.
   *  Set by `wsSend` in main.ts; not part of the phase FSM. */
  const connectionError = ref<string | undefined>(undefined);
  // localStorage is only available in the browser; guard for SSR/node tests.
  const darkMode = ref(
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('mycc-theme') === 'dark'
      : false,
  );
  const debugMode = ref(false);
  const lastServerMsg = ref<{ type: string; at: number } | undefined>(undefined);

  // ── Derived flags (projections of `phase` — can never be invalid) ──
  /** True when a prompt OR card is pending user input (input box enabled). */
  const isWaiting = computed(
    () => phase.value === 'prompt' || phase.value === 'card',
  );
  /** True while the agent is actively working (between submit and next prompt),
   *  INCLUDING the send→running gap (`submitted`). */
  const isRunning = computed(
    () => phase.value === 'working' || phase.value === 'submitted',
  );
  /** True when an interactive card (ask()) is pending a response. */
  const hasPendingCard = computed(() => phase.value === 'card');
  /** True when the steering review "继续…" card has notes pending. */
  const hasReview = computed(
    () => pendingSteeringReview.value.length > 0,
  );

  // ── Store actions (single mutation surface — see §2.7) ──
  // Both `applyServerMessage` (server-driven) and `chatApi` (client-initiated
  // optimistic) call these. The store is the single mutation surface; there
  // are two callers but one mutation API.
  function setPhase(newPhase: WebuiPhase): void {
    phase.value = newPhase;
  }
  /** Set the orthogonal auto-mode flag. Entering auto mode (`value === true`)
   *  abandons any pending steering review — the agent processes steering
   *  automatically there, so stranded notes are dropped rather than surfaced. */
  function setAutoMode(value: boolean): void {
    isAutoMode.value = value;
    if (value) pendingSteeringReview.value.splice(0);
  }

  return {
    // source of truth
    phase,
    // orthogonal
    isAutoMode,
    steeringBuffer,
    pendingSteeringReview,
    messages,
    teammateMessages,
    inputText,
    pendingFiles,
    connectionStatus,
    showRetry,
    verboseLogs,
    connectionError,
    darkMode,
    debugMode,
    lastServerMsg,
    // derived
    isWaiting,
    isRunning,
    hasPendingCard,
    hasReview,
    // actions
    setPhase,
    setAutoMode,
  };
});

/** Type alias for the store instance — used by `applyServerMessage` and
 *  `chatApi` so they can call `store.setPhase()` / `store.setAutoMode()`
 *  without importing the store (keeps message-dispatch.ts DOM-free and
 *  testable in node via a stub). */
export type ChatStore = ReturnType<typeof useChatStore>;