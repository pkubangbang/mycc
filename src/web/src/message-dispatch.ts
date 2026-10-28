/**
 * message-dispatch.ts - DOM-free message dispatch logic for the web UI
 *
 * This module owns the state-transition logic for a single incoming
 * server message. It is intentionally free of any DOM / browser side effects
 * (no `document`, `localStorage`, `window`, `WebSocket`, `fetch`) so it can be
 * imported and unit-tested directly in the existing node-environment Vitest
 * suite, without adding jsdom/@vue/test-utils/Playwright dependencies.
 *
 * `main.ts` is responsible for the I/O shell (WebSocket, fetch, localStorage,
 * `createApp`) and delegates the pure "given a message, mutate state" logic to
 * {@link applyServerMessage}. The debug seam (`window.__myccDebug.inject`) and
 * the real WS handler both call this same function, so there is a single
 * source of truth for message handling — no drift between live events, debug
 * injection, and tests.
 *
 * ## Phase Transition Table (design doc §2.5)
 *
 * The `phase` enum is the single source of truth. Server messages drive phase
 * transitions via `store.setPhase()`; `isAutoMode` is an orthogonal boolean
 * driven via `store.setAutoMode()`. Derived flags (`isWaiting` / `isRunning` /
 * `hasPendingCard` / `hasReview`) are computed in the store and are NEVER
 * mutated here.
 *
 * ```
 *                + running:on    + running:off        + prompt        + card     + auto:on          + auto:off    + card-response
 * idle            → working        (no-op)             → prompt        → card      → await            (no-op)       (n/a)
 * submitted       → working        → auto?await:idle   → prompt        → card      → await            (no-op)       (n/a)
 * working         (no-op)          → auto?await:idle   → prompt        → card      (stay, flip auto) (no-op)       (n/a)
 * prompt          → working        (no-op)             (stay prompt)   → card      → await            (no-op)       (n/a)
 * card            → working        (no-op)             → prompt        (n/a)      (n/a)              (no-op)       → working
 * await           → working        (no-op)             → prompt        → card      (stay await)       → idle        (n/a)
 * ```
 *
 * running:off from working/submitted routes to `await` when isAutoMode (the
 * backend returns to AWAIT after a turn in auto mode — no 'prompt' broadcast
 * follows), else to `idle` (manual mode: the imminent 'prompt' corrects it).
 *
 * Key rules (from peer review):
 *  - `running:off` is a NO-OP unless `phase === 'working'` (→ auto?await:idle)
 *    or `phase === 'submitted'` (→ auto?await:idle). Prevents reconnect
 *    reordering from clobbering a stable `prompt`/`card`/`await` (serve-hub.ts
 *    sends `prompt` BEFORE `running:off` on reconnect).
 *  - `auto:off` is a NO-OP unless `phase === 'await'` (→ `idle`, then corrected
 *    by imminent `prompt`). Does NOT clear `pendingSteeringReview` (only
 *    `auto:on` abandons review).
 *  - `card-response → working` is a CLIENT-SIDE optimistic transition only
 *    (handled in chatApi.sendCardResponse); the server never broadcasts it
 *    back, so there is no `card-response` branch in the dispatch below.
 *  - NO `esc` column — there is no `esc` wire message. ESC is derived from the
 *    server's subsequent `running:off` / `auto:off` / `prompt` broadcasts.
 */

import type { ChatMessage, SteeringNote, WebuiPhase } from './types';

/**
 * The minimal store surface `applyServerMessage` consumes. This is satisfied
 * by the Pinia `ChatStore` instance (see `stores/chat-store.ts`), but typed as
 * a structural interface so the function stays DOM-free and testable in node
 * without an active Pinia — tests can pass a plain reactive stub OR a real
 * store via `setActivePinia(createPinia())`.
 *
 * `phase` is read to guard transitions (NO-OP rules). `setPhase` /
 * `setAutoMode` are the single mutation surface for the FSM. The steering
 * replica has its own single surface: `adoptSteering` (a versioned snapshot —
 * never patched directly) and `populateSteeringReview` (the PROMPT projection).
 * `messages` / `teammateMessages` are the plain chat arrays.
 */
export interface DispatchState {
  phase: WebuiPhase;
  isAutoMode: boolean;
  /** Plan/normal mode of the lead (mirrored `mode` broadcast). */
  isPlanMode: boolean;
  steeringBuffer: SteeringNote[];
  steeringQueue: SteeringNote[];
  pendingSteeringReview: SteeringNote[];
  messages: ChatMessage[];
  teammateMessages: ChatMessage[];
  showRetry: boolean;
  lastServerMsg?: { type: string; at: number };
  setPhase: (newPhase: WebuiPhase) => void;
  setAutoMode: (value: boolean) => void;
  /** Set the orthogonal plan-mode flag (mirrored `mode` broadcast). */
  setPlanMode: (value: boolean) => void;
  adoptSteering: (revision: number, notes: SteeringNote[]) => boolean;
  populateSteeringReview: () => void;
}

/**
 * Minimal dependency surface injected by the caller so this module stays DOM-free.
 * `nextId` produces stable ids for live messages; `chatApi` is the send surface
 * (only `.sendInput` is strictly needed for send-as-query side effects today,
 * but the full object is passed to avoid duplicating its shape).
 */
export interface DispatchContext {
  nextId: () => number;
  chatApi: {
    sendInput: (text: string) => void;
    // The other chatApi methods are intentionally not referenced here; the
    // dispatch logic only needs sendInput. Kept minimal so tests can stub it.
  };
}

/**
 * Apply a single parsed server message to the store, mirroring the previous
 * `ws.onmessage` logic exactly but routing phase changes through
 * `store.setPhase()` / `store.setAutoMode()` per the transition table. Returns
 * nothing — all effects are direct mutations of the store (and, for
 * send-as-query, a `chatApi.sendInput` side effect carried through the
 * caller's context).
 *
 * This is the single chokepoint for message handling. Keep the branching here
 * exhaustive and deterministic: id assignment uses `ctx.nextId()`, and the
 * steering surfaces are only ever produced by the store's adoption rule
 * (`adoptSteering`) and its PROMPT projection (`populateSteeringReview`).
 */
export function applyServerMessage(
  state: DispatchState,
  msg: ChatMessage,
  ctx: DispatchContext,
): void {
  // Ensure every live message has a stable id for v-for keys.
  if (msg.id === undefined) msg.id = ctx.nextId();

  // Record the last server message BEFORE any branching so EVERY wire type —
  // the explicitly-handled ones below AND anything falling through the default
  // branch — is observable in the ChatInput state-tag row (detailed-logs mode
  // only). This is the diagnostic hook for phase desync: the tag row shows
  // which message type last touched the phase after a 'prompt'.
  state.lastServerMsg = { type: msg.type, at: Date.now() };

  // A prompt message signals "work done, waiting for user input".
  if (msg.type === 'prompt') {
    state.setPhase('prompt');
    // Retry button appears when the prompt is a Retry? [Y/n] question
    state.showRetry = /retry/i.test(msg.content);
    if (msg.content) {
      state.messages.push(msg);
    }
    // Surface the "继续…" review card from the steering notes STILL QUEUED in
    // the server's snapshot at PROMPT — i.e. notes the agent never consumed.
    // Reads `steeringQueue` (authoritative), NOT `steeringBuffer` (which is
    // derived FROM review): reading the bar here would be circular. The auto
    // mode abandon and the per-id dedupe live in the store action. The server
    // re-sends `prompt` on reconnect, so `populateSteeringReview` must be
    // idempotent — it is (dedupe by id).
    state.populateSteeringReview();
    return;
  }

  if (msg.type === 'card') {
    // An interactive card is pending a response — transition to the `card`
    // phase (derived `isWaiting` + `hasPendingCard` both become true).
    // Incoming card messages carry cardId/query/kind as top-level wire
    // fields (the backend's flat CardMessage shape); assemble them into the
    // `card` payload on the persisted message.
    state.setPhase('card');
    state.showRetry = false;
    const cardId = msg.cardId;
    const query = msg.query ?? msg.content;
    const kind = msg.kind ?? 'input';
    const cardPayload = {
      cardId: cardId ?? '',
      query,
      kind,
      options: msg.options,
      initialContent: msg.initialContent,
      placeholder: msg.placeholder,
    };
    state.messages.push({ type: 'card', content: query, id: ctx.nextId(), card: cardPayload });
    return;
  }

  if (msg.type === 'steer-state') {
    // THE steering wire event (replaces 'steer-echo' + 'steer-flush'): the
    // server's full queue plus its revision. The store's adoption rule decides
    // whether it is newer than what we hold — a stale snapshot (an in-flight
    // /history reply, a replayed frame) is dropped, which is what stops an
    // already-resolved note from reappearing in the bar.
    //
    // MUST return here: `steer-state` is a state report, never chat content. A
    // client that fell through to the chat-log branch would render the whole
    // queue as a bubble.
    state.adoptSteering(msg.steeringRevision ?? -1, msg.notes ?? []);
    return;
  }

  if (msg.type === 'file-upload' || msg.type === 'file-flush') {
    // File upload echo/drain — no client-side effects (handled server-side).
    return;
  }

  if (msg.type === 'auto') {
    // `auto:on` abandons any pending steering review (setAutoMode does this).
    // Phase transition per the table:
    //   - from `working`  → stay `working` (just flip the boolean)
    //   - from `await`    → stay `await`
    //   - otherwise       → `await` (idle-auto phase)
    const turningOn = msg.content === 'on';
    state.setAutoMode(turningOn);
    if (turningOn) {
      if (state.phase !== 'working' && state.phase !== 'await') {
        state.setPhase('await');
      }
    } else {
      // auto:off is a NO-OP unless phase === 'await' (→ idle, then corrected
      // by the imminent 'prompt'). Do NOT clear pendingSteeringReview here.
      if (state.phase === 'await') {
        state.setPhase('idle');
      }
    }
    return;
  }

  if (msg.type === 'mode') {
    // Plan/normal mode (row obs-002). A state report, never chat content: the
    // browser must be able to see that edits are prohibited (or that plan mode
    // ended) without it costing a chat bubble. Phase is intentionally untouched
    // — mode is orthogonal to prompt/working/await.
    state.setPlanMode(msg.content === 'plan');
    return;
  }

  if (msg.type === 'running') {
    if (msg.content === 'on') {
      // running:on → working (from any phase that isn't already working;
      // staying working is a harmless no-op).
      state.setPhase('working');
    } else {
      // running:off is a NO-OP unless phase === 'working' or 'submitted'.
      // Prevents reconnect reordering from clobbering a stable
      // prompt/card/await (serve-hub sends prompt BEFORE running:off).
      //
      // Destination is auto-aware (peer-reviewed fix for the 空窗 vacuum):
      // in auto mode the loop returns to AWAIT after a turn — prompt.ts
      // redirects to AWAIT BEFORE getInput(), so no 'prompt' broadcast
      // follows, and the idempotent setAuto(true) fires no corrective
      // 'auto:on'. Routing to 'idle' here stranded long-lived clients at
      // idle+auto → the stage row flagged 空窗(疑似失同步) forever. 'await'
      // is the backend's true resting phase when isAutoMode. Manual mode
      // keeps 'idle': PROMPT DOES call getInput() → the imminent 'prompt'
      // broadcast corrects idle→prompt (self-healing within milliseconds).
      if (state.phase === 'working' || state.phase === 'submitted') {
        state.setPhase(state.isAutoMode ? 'await' : 'idle');
      }
    }
    return;
  }

  // NOTE: there is no `card-response` branch here — `card-response` is a
  // CLIENT-ONLY outgoing WS message (sent by chatApi.sendCardResponse), NOT
  // an incoming server message. The optimistic `card-response → working`
  // transition is handled in chatApi.sendCardResponse (store.setPhase('working')
  // before the WS send). The server never broadcasts `card-response` back.

  // C5 fix (plan §7 / gate A3): the wrap-up letterbox path broadcasts 'result'
  // while the frontend phase is 'prompt' (the wrap-up completes AFTER the
  // prompt broadcast). The old default branch flipped prompt → working,
  // killing the send button and stranding the parked-prompt turn ("vacuum
  // working" stage row). In manual mode with phase !== 'working' a 'result'
  // is either the wrap-up letterbox or a straggler from the just-finished
  // turn — display-only: NO phase flip. Under auto mode (the agent is
  // autonomous; a result means the next stage is running) and from
  // working/submitted (genuine work output) the flip behavior is preserved.
  const isWrapUpLetterboxResult = state.phase !== 'working'
    && state.phase !== 'submitted'
    && !state.isAutoMode;
  if (!isWrapUpLetterboxResult) {
    if (state.phase === 'prompt' || state.phase === 'card') {
      state.setPhase('working');
    }
  }
  // Synthetic messages (machine-originated briefs: hook engine, debug
  // evaluator) update the phase (a hook brief still
  // proves the agent is working) but are NOT pushed into the chat log —
  // they are routine machinery output, not LLM/user content. The /history
  // path filters them identically in main.ts fetchHistory().
  if (msg.synthetic) return;
  if (msg.label?.startsWith('@')) {
    state.teammateMessages.push(msg);
  } else {
    state.messages.push(msg);
  }
}