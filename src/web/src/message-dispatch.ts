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
 */

import type { ChatMessage, ChatState, SteeringNote } from './types';

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
 * Apply a single parsed server message to the reactive `state`, mirroring the
 * previous `ws.onmessage` logic exactly. Returns nothing — all effects are
 * direct mutations of `state` (and, for send-as-query, a `chatApi.sendInput`
 * side effect carried through the caller's context).
 *
 * This is the single chokepoint for message handling. Keep the branching here
 * exhaustive and deterministic: id assigment uses `ctx.nextId()`, and the
 * steering review card population reads `steeringBuffer` at `prompt` time only.
 */
export function applyServerMessage(
  state: ChatState,
  msg: ChatMessage,
  ctx: DispatchContext,
): void {
  // Ensure every live message has a stable id for v-for keys.
  if (msg.id === undefined) msg.id = ctx.nextId();

  // A prompt message signals "work done, waiting for user input".
  if (msg.type === 'prompt') {
    state.isWaiting = true;
    state.isRunning = false;
    // Retry button appears when the prompt is a Retry? [Y/n] question
    if (/retry/i.test(msg.content)) {
      state.showRetry = true;
    } else {
      state.showRetry = false;
    }
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
    // An interactive card is pending a response — treat like a prompt.
    // Incoming card messages carry cardId/query/kind as top-level wire
    // fields (the backend's flat CardMessage shape); assemble them into the
    // `card` payload on the persisted message.
    state.isWaiting = true;
    state.showRetry = false;
    state.hasPendingCard = true;
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
    // Push to the buffer bar with its stable id — do NOT touch
    // isWaiting/isRunning and do NOT add to the chat message list.
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
    // steer-resolve, never by a flush).
    state.steeringBuffer.splice(0, state.steeringBuffer.length);
    return;
  }

  if (msg.type === 'file-upload' || msg.type === 'file-flush') {
    // File upload echo/drain — no client-side effects (handled server-side).
    return;
  }

  if (msg.type === 'auto') {
    state.isAutoMode = msg.content === 'on';
    // Entering auto mode abandons any pending steering review.
    if (state.isAutoMode) {
      state.pendingSteeringReview.splice(0);
    }
    return;
  }

  if (msg.type === 'running') {
    state.isRunning = msg.content === 'on';
    return;
  }

  // Any other message means the agent moved past the card.
  state.isWaiting = false;
  state.hasPendingCard = false;
  // Route by the @-prefix label convention.
  if (msg.label?.startsWith('@')) {
    state.teammateMessages.push(msg);
  } else {
    state.messages.push(msg);
  }
}
