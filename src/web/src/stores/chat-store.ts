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
 * Design doc: `docs/webui/webui-phase-fsm-design.md` (peer-reviewed by DeepSeek
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
  //
  // Steering is a REPLICA of a server-owned queue, so it follows one rule:
  // adoptSteering() replaces it wholesale from a versioned snapshot. The two
  // UI surfaces are derived from that one array rather than patched by delta
  // events:
  //   steeringQueue     (authoritative)
  //     ├─ pendingSteeringReview (subset surfaced at PROMPT, pruned to live ids)
  //     └─ steeringBuffer        (the rest — chips in the bar)
  // See src/loop/steering-manager.ts for why the protocol is revisioned.
  const steeringRevision = ref(-1);
  const steeringQueue = ref<SteeringNote[]>([]);
  const steeringBuffer = ref<SteeringNote[]>([]);
  const pendingSteeringReview = ref<SteeringNote[]>([]);
  const messages = ref<ChatMessage[]>([]);
  const teammateMessages = ref<ChatMessage[]>([]);
  // Monotonic counter incremented on every AUTHORITATIVE /history
  // replacement (a 200 that splices the chat arrays) and on a session-change
  // clear (fetchConfig detecting a new sessionId clears the arrays — also an
  // authoritative replacement, to empty). The ChatLog collapse watcher
  // observes this so it can reset the x/t/trackingTail window on a
  // replacement EVEN WHEN the filtered length is unchanged (e.g. the
  // server's 1000-entry cap: old entries leave + new entries enter → count
  // stays 1000, but the list was authoritatively replaced and the old
  // window position is invalid). This separates the "replacement boundary"
  // signal from collection cardinality — the watcher no longer has to infer
  // a replacement from a length delta it may not observe. See #22.
  const historyRevision = ref(0);
  const inputText = ref('');
  const pendingFiles = ref<FileInfo[]>([]);
  const connectionStatus = ref<ConnectionStatus>('disconnected');
  const showRetry = ref(false);
  const verboseLogs = ref(false);
  /** Whether this serve instance is persistent (headless daemon). Defaults
   *  to false so a /config fetch failure degrades to the safe 退出 button. */
  const persistent = ref(false);
  /** Per-file upload size cap (MB), fetched from the server's /config
   *  endpoint. Defaults to 50 so the UI is still usable when /config is
   *  unreachable. Moved here from ChatInput.vue so the fetch is app-level
   *  (alongside persistent) and shared by all components. */
  const maxUploadMb = ref(50);
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

  /**
   * THE adoption rule for the server-owned steering queue.
   *
   * Replaces the old delta protocol (`steer-echo` add / `steer-flush` clear)
   * and, with it, src/web/src/resolve-guard.ts. The invariants it enforces:
   *
   * 1. ORDER — a snapshot is adopted only when its revision is STRICTLY newer.
   *    This is what kills the boomerang: a `/history` response snapshotted
   *    before the user's resolve (or a replayed frame) carries an older
   *    revision and is ignored, instead of splicing the resolved note back
   *    into the bar.
   * 2. REVIEW ⊆ QUEUE — a note still in review whose id the server no longer
   *    holds has been consumed/discarded, so it leaves the card. This is the
   *    whole delivery confirmation: no flush, no guard, no sendIds math. It
   *    also PRESERVES the ESC contract (stop.ts keeps notes queued so they
   *    survive into review) — those ids are still in the snapshot.
   * 3. BUFFER = QUEUE − REVIEW — the bar is a projection, never an independent
   *    copy, so the two surfaces cannot disagree or duplicate an id.
   *
   * @returns true when the snapshot was adopted, false when it was stale.
   */
  function adoptSteering(revision: number, notes: SteeringNote[]): boolean {
    if (revision <= steeringRevision.value) return false;
    steeringRevision.value = revision;
    steeringQueue.value = notes.slice();
    const liveIds = new Set(notes.map((n) => n.id));
    const inReview = new Set(
      pendingSteeringReview.value.filter((n) => liveIds.has(n.id)).map((n) => n.id),
    );
    pendingSteeringReview.value = pendingSteeringReview.value.filter((n) => inReview.has(n.id));
    steeringBuffer.value = steeringQueue.value.filter((n) => !inReview.has(n.id));
    return true;
  }

  /**
   * Forget the adopted revision (session change / new serve process).
   *
   * The revision is per-PROCESS, so a client that outlives the process must
   * reset it or every subsequent snapshot (starting again at 1) would look
   * stale and the bar would freeze empty forever.
   */
  function resetSteering(): void {
    steeringRevision.value = -1;
    steeringQueue.value = [];
    steeringBuffer.value = [];
    pendingSteeringReview.value = [];
  }

  /**
   * Move every still-queued note into the review card (called at PROMPT).
   * Ids are deduped, so a re-delivered `prompt` (reconnect re-send) cannot
   * stack a second card for the same note. In auto mode the notes are
   * ABANDONED instead — the agent processes steering there, there is no
   * review to do.
   */
  function populateSteeringReview(): void {
    if (isAutoMode.value) {
      // Auto mode ABANDONS the review: the agent consumes steering itself, so
      // the notes stay chips in the bar (they are still queued) and no card is
      // surfaced.
      pendingSteeringReview.value.splice(0);
      steeringBuffer.value = steeringQueue.value.slice();
      return;
    }
    const seen = new Set(pendingSteeringReview.value.map((n) => n.id));
    for (const note of steeringQueue.value) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      pendingSteeringReview.value.push(note);
    }
    steeringBuffer.value = steeringQueue.value.filter(
      (n) => !seen.has(n.id),
    );
  }


  return {
    // source of truth
    phase,
    // orthogonal
    isAutoMode,
    steeringBuffer,
    steeringQueue,
    steeringRevision,
    pendingSteeringReview,
    messages,
    teammateMessages,
    historyRevision,
    inputText,
    pendingFiles,
    connectionStatus,
    showRetry,
    verboseLogs,
    connectionError,
    darkMode,
    debugMode,
    lastServerMsg,
    persistent,
    maxUploadMb,
    // derived
    isWaiting,
    isRunning,
    hasPendingCard,
    hasReview,
    // actions
    setPhase,
    setAutoMode,
    adoptSteering,
    resetSteering,
    populateSteeringReview,
  };
});

/** Type alias for the store instance — used by `applyServerMessage` and
 *  `chatApi` so they can call `store.setPhase()` / `store.setAutoMode()`
 *  without importing the store (keeps message-dispatch.ts DOM-free and
 *  testable in node via a stub). */
export type ChatStore = ReturnType<typeof useChatStore>;