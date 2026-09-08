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
 *                + running:on    + running:off       + prompt        + card     + auto:on          + auto:off    + card-response
 * idle            → working        (no-op)             → prompt        → card      → await            (no-op)       (n/a)
 * submitted       → working        (no-op)             → prompt        → card      → await            (no-op)       (n/a)
 * working         (no-op)          → idle               → prompt        → card      (stay, flip auto) (no-op)       (n/a)
 * prompt          → working        (no-op)             (stay prompt)   → card      → await            (no-op)       (n/a)
 * card            → working        (no-op)             → prompt        (n/a)      (n/a)              (no-op)       → working
 * await           → working        (no-op)             → prompt        → card      (stay await)       → idle        (n/a)
 * ```
 *
 * Key rules (from peer review):
 *  - `running:off` is a NO-OP unless `phase === 'working'` (→ `idle`) or
 *    `phase === 'submitted'` (→ `idle`). Prevents reconnect reordering from
 *    clobbering a stable `prompt`/`card`/`await` (serve-hub.ts sends `prompt`
 *    BEFORE `running:off` on reconnect).
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
 * `setAutoMode` are the single mutation surface. The orthogonal data arrays
 * (`steeringBuffer` / `pendingSteeringReview` / `messages` /
 * `teammateMessages`) are mutated directly — they are NOT part of the phase
 * enum and have no invalid combinations to guard. `isAutoMode` is read for the
 * auto-abandon branch at `prompt`.
 */
export interface DispatchState {
  phase: WebuiPhase;
  isAutoMode: boolean;
  steeringBuffer: SteeringNote[];
  pendingSteeringReview: SteeringNote[];
  messages: ChatMessage[];
  teammateMessages: ChatMessage[];
  showRetry: boolean;
  lastServerMsg?: { type: string; at: number };
  setPhase: (newPhase: WebuiPhase) => void;
  setAutoMode: (value: boolean) => void;
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
 * steering review card population reads `steeringBuffer` at `prompt` time only.
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
    // Surface the "继续…" review card from steering notes STILL PENDING in the
    // backend queue at PROMPT — i.e. notes the agent never consumed. Move them
    // into pendingSteeringReview (which renders the card) and clear the buffer
    // bar — they are now "in review", no longer just queued.
    //
    // Skipped in auto mode: the agent processes steering automatically there,
    // so the notes are ABANDONED (cleared from the buffer without surfacing a
    // card) rather than stranded.
    if (state.steeringBuffer.length > 0) {
      if (state.isAutoMode) {
        state.steeringBuffer.splice(0, state.steeringBuffer.length);
      } else {
        state.pendingSteeringReview.push(...state.steeringBuffer);
        state.steeringBuffer.splice(0, state.steeringBuffer.length);
      }
    }
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

  if (msg.type === 'steer-echo') {
    // Backend echoed a steering note the user (or another client) queued.
    // Push to the buffer bar with its stable id — do NOT touch phase and do
    // NOT add to the chat message list. (steeringBuffer is orthogonal data,
    // co-occurs with any phase.)
    if (msg.content) {
      // Reuse the id already assigned at the top of this function (msg.id) so
      // a steer-echo with no explicit steerId does not consume a SECOND
      // nextId(). Explicit steerId (from the server echo) always wins.
      const steerId = msg.steerId ?? msg.id ?? ctx.nextId();
      const note: SteeringNote = { id: steerId, text: msg.content };
      state.steeringBuffer.push(note);
    }
    return;
  }

  if (msg.type === 'steer-flush') {
    // Backend drained/resolved the queued steering notes. Clear the buffer bar
    // (but NOT pendingSteeringReview — that is resolved explicitly via
    // steer-resolve, never by a flush). No phase change.
    state.steeringBuffer.splice(0, state.steeringBuffer.length);
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

  if (msg.type === 'running') {
    if (msg.content === 'on') {
      // running:on → working (from any phase that isn't already working;
      // staying working is a harmless no-op).
      state.setPhase('working');
    } else {
      // running:off is a NO-OP unless phase === 'working' or 'submitted'
      // (→ idle). Prevents reconnect reordering from clobbering a stable
      // prompt/card/await (serve-hub sends prompt BEFORE running:off).
      if (state.phase === 'working' || state.phase === 'submitted') {
        state.setPhase('idle');
      }
    }
    return;
  }

  // NOTE: there is no `card-response` branch here — `card-response` is a
  // CLIENT-ONLY outgoing WS message (sent by chatApi.sendCardResponse), NOT
  // an incoming server message. The optimistic `card-response → working`
  // transition is handled in chatApi.sendCardResponse (store.setPhase('working')
  // before the WS send). The server never broadcasts `card-response` back.

  // Any other message means the agent moved past the card/prompt — the agent
  // is producing output, so it is working. (Mirrors the previous default
  // branch that flipped isWaiting=false / hasPendingCard=false.) Route by the
  // @-prefix label convention.
  if (state.phase === 'prompt' || state.phase === 'card') {
    state.setPhase('working');
  }
  if (msg.label?.startsWith('@')) {
    state.teammateMessages.push(msg);
  } else {
    state.messages.push(msg);
  }
}