/**
 * main.ts - Web UI entry point (HMR-persistent layer)
 *
 * This module is NEVER hot-replaced by Vite. It owns:
 * - The reactive ChatState (module-level, survives component HMR)
 * - The WebSocket connection (module-level)
 * - The chatApi object exposed to components
 *
 * Vue components (App.vue + children) auto-HMR via @vitejs/plugin-vue:
 * their render functions are replaced while ref/reactive state is preserved.
 * Because the state lives here (not in any component), editing a component
 * while the Web UI is running is safe — the WebSocket stays connected and
 * the chat history is not lost.
 */

import { createApp, reactive } from 'vue';
import type { App } from 'vue';
import App from './App.vue';
import type { ChatMessage, ChatState, CardOption } from './types';
import './style.css';

// Reactive state — survives HMR (module-level, not in any component)
const state = reactive<ChatState>({
  messages: [],
  inputText: '',
  isWaiting: false,
  isRunning: false,
  connectionStatus: 'disconnected',
  showRetry: false,
  verboseLogs: false,
  steeringBuffer: [],
});

// Monotonic id counter for stable v-for keys (avoids array-index keys that
// break when messages are filtered/inserted). See ChatLog.vue.
let msgIdCounter = 0;
function nextId(): number {
  return ++msgIdCounter;
}

/**
 * Whether a given message should be shown given the current 详细日志 setting.
 *
 * The architecture guarantees a clean split:
 *   - brief() ALWAYS passes a label (its `tool` tag, e.g. 'bash', 'brief',
 *     'question', 'tool', 'hook', 'session'…). These are user-facing status
 *     lines and the letterbox reply (label 'assistant') — always visible.
 *   - verbose() and raw log/warn/error calls NEVER pass a label. These are
 *     operational/tool detail — hidden when 详细日志 is off.
 *
 * So: any message WITH a label is shown unconditionally; messages WITHOUT a
 * label are shown only when verboseLogs is on. User/prompt bubbles are
 * always visible regardless.
 */
export function isMessageVisible(msg: ChatMessage, verboseLogs: boolean): boolean {
  if (verboseLogs) return true;
  // User and prompt bubbles always show (drive input state)
  if (msg.type === 'user' || msg.type === 'prompt') return true;
  // Cards always show (they demand interaction)
  if (msg.type === 'card') return true;
  // Any labeled line is a brief/assistant/question status line — always show
  if (msg.label) return true;
  // History-loaded assistant replies have type 'result' but may lack a label
  // (old transcripts). Treat them as always-visible user-facing content.
  if (msg.type === 'result') return true;
  // Unlabeled raw logs/warns/errors/system → hidden when verbose off
  return false;
}

// WebSocket — survives HMR (module-level)
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let mountedApp: App | null = null;

/**
 * Send a JSON object over the WebSocket, guarding against a non-OPEN
 * readyState. Returns true on success, false if the socket isn't usable
 * (connecting/closing/closed). On failure, surfaces a transient error in
 * the StatusBar so the user knows their message wasn't delivered instead
 * of a silent drop.
 */
function wsSend(data: object): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
      // Clear any prior send-error on a successful send
      if (state.connectionError) state.connectionError = undefined;
      return true;
    } catch {
      // fall through to failure path
    }
  }
  state.connectionError = '连接已断开，消息未发送';
  // Auto-clear the error after 3s so it doesn't linger forever
  setTimeout(() => {
    state.connectionError = undefined;
  }, 3000);
  return false;
}

/**
 * Fetch the message history from /history BEFORE establishing the WebSocket.
 * This populates the chat record first, so live WS updates layer cleanly on
 * top with no race and no duplication. On reconnect after a WS drop, this is
 * called again to restore the full record (the server log is the source of
 * truth, not the socket).
 */
async function fetchHistory(): Promise<void> {
  try {
    const res = await fetch('/history');
    if (!res.ok) return;
    const data = await res.json() as { messages: ChatMessage[]; steeringBuffer?: string[] };
    // Empty-content prompts are "waiting for input" signals, not chat content.
    // Drop them from the visible record; non-empty prompts (e.g. 'Retry? [Y/n]')
    // remain visible. Also drop steer-echo/steer-flush entries — those belong
    // in the buffer bar (restored separately below), not the chat log.
    const visible = data.messages.filter(
      m => !(m.type === 'prompt' && !m.content)
        && m.type !== 'steer-echo'
        && m.type !== 'steer-flush',
    );
    // Replace, not append — on reconnect we want a clean, authoritative snapshot.
    state.messages.splice(0, state.messages.length, ...visible);
    // Restore the steering buffer bar from the server's current queue (peek,
    // not consume). Survives a page refresh within the same serve session.
    const queued = data.steeringBuffer ?? [];
    state.steeringBuffer.splice(0, state.steeringBuffer.length, ...queued);
  } catch {
    // Network failure — leave existing messages; WS reconnect will retry.
  }
}

/**
 * Establish the WebSocket connection. Called only AFTER history has been
 * fetched (or the fetch attempt completed), so live updates never overtake
 * the historical record.
 */
function connectWebSocket(): void {
  // Clear any pending reconnect before opening a new socket
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    state.connectionStatus = 'connected';
  };

  ws.onmessage = (event) => {
    let msg: ChatMessage;
    try {
      msg = JSON.parse(event.data) as ChatMessage;
    } catch {
      return; // ignore malformed messages
    }
    // Ensure every live message has a stable id for v-for keys.
    if (msg.id === undefined) msg.id = nextId();

    // A prompt message signals "work done, waiting for user input".
    // An empty-content prompt is purely a waiting signal — not chat content —
    // so it is not shown as a bubble (only its state side-effects apply).
    // Non-prompt messages mean the agent is actively working.
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
    } else if (msg.type === 'card') {
      // An interactive card is pending a response — treat like a prompt:
      // the chat input box hides while the card is shown. The backend sends
      // the card fields flat on the wire (cardId/query/kind/options/...);
      // map them into the nested `card` payload the components expect.
      state.isWaiting = true;
      state.isRunning = false;
      state.showRetry = false;
      const cardId = (msg as { cardId?: string }).cardId;
      const query = (msg as { query?: string }).query ?? msg.content;
      const kind = (msg as { kind?: 'input' | 'confirm' | 'choice' }).kind ?? 'input';
      const cardPayload = {
        cardId: cardId ?? '',
        query,
        kind,
        options: (msg as { options?: CardOption[] }).options,
        initialContent: (msg as { initialContent?: string }).initialContent,
        placeholder: (msg as { placeholder?: string }).placeholder,
      };
      state.messages.push({ type: 'card', content: query, id: nextId(), card: cardPayload });
    } else if (msg.type === 'steer-echo') {
      // Backend echoed a steering note the user (or another client) queued.
      // Push to the buffer bar — do NOT touch isWaiting/isRunning (the LLM
      // is still working) and do NOT add to the chat message list.
      if (msg.content) {
        state.steeringBuffer.push(msg.content);
      }
    } else if (msg.type === 'steer-flush') {
      // Backend consumed the queued steering notes (drained at COLLECT or
      // synthesized at PROMPT). Clear the buffer bar.
      state.steeringBuffer.splice(0, state.steeringBuffer.length);
    } else {
      state.isWaiting = false;
      state.isRunning = true;
      state.messages.push(msg);
    }
  };

  ws.onclose = () => {
    state.connectionStatus = 'reconnecting';
    // Reset stale interaction state so the UI doesn't leave a dead Retry
    // button or spinner while disconnected. The server re-sends a 'prompt'
    // (or 'card') on reconnect if the agent is still waiting, so these
    // get restored correctly after reconnection — no permanent dead-end.
    state.isWaiting = false;
    state.isRunning = false;
    state.showRetry = false;
    // Don't reconnect if the page is being unloaded (navigated away/closed).
    // Also guard against stacking multiple reconnect timers.
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Re-fetch history first, then re-open the socket — same order as load.
      void reconnect();
    }, 1500);
  };

  ws.onerror = () => {
    // Let onclose handle the reconnect scheduling; just update status.
    state.connectionStatus = 'reconnecting';
  };
}

/** Reconnect sequence: refresh history, then re-establish the WS. */
async function reconnect(): Promise<void> {
  await fetchHistory();
  connectWebSocket();
}

// Stop reconnecting when the page is unloaded (avoids a final stale socket)
window.addEventListener('beforeunload', () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
});

// Page load sequence: fetch history FIRST, then establish the WS connection.
// This guarantees the chat record is populated before any live update arrives.
void (async () => {
  state.connectionStatus = 'reconnecting';
  await fetchHistory();
  connectWebSocket();
})();

// Expose for components (send messages, exit, retry)
export const chatApi = {
  sendInput(text: string): void {
    if (!text.trim()) return;
    // Echo the user's input as a local message for immediate feedback
    state.messages.push({ type: 'user', content: text, timestamp: Date.now(), id: nextId() });
    state.inputText = '';
    state.isWaiting = false;
    state.isRunning = true;
    state.showRetry = false;
    wsSend({ type: 'input', text });
  },
  /**
   * Send a mid-task steering note while the LLM is running. The note is
   * buffered in the backend steering queue and consumed at the next COLLECT
   * (injected as a REMINDER) or PROMPT (synthesized with the next query via
   * forkChat after an interrupt). Locally we echo the note as a user bubble
   * for immediate feedback — but DO NOT push to steeringBuffer here: the
   * server's 'steer-echo' broadcast is the single source of truth for the
   * buffer bar (it populates the bar for all clients, including this one).
   * Pushing locally would double-count on the originating client. Also DO
   * NOT flip isWaiting/isRunning: the LLM is still working.
   */
  sendSteer(text: string): void {
    if (!text.trim()) return;
    state.messages.push({ type: 'user', content: text, timestamp: Date.now(), id: nextId() });
    state.inputText = '';
    wsSend({ type: 'steer', text });
  },
  sendExit(): void {
    wsSend({ type: 'exit' });
  },
  sendInterrupt(): void {
    wsSend({ type: 'interrupt' });
  },
  sendRetry(answer: string): void {
    // Echo the chosen retry answer as a user bubble so the user sees their
    // choice reflected in the chat record (matches sendInput feedback).
    state.messages.push({ type: 'user', content: answer, timestamp: Date.now(), id: nextId() });
    state.showRetry = false;
    state.inputText = '';
    state.isWaiting = false;
    state.isRunning = true;
    wsSend({ type: 'input', text: answer });
  },
  /** Respond to an interactive card. Called by CardItem.vue. */
  sendCardResponse(cardId: string, value: string): void {
    state.isWaiting = false;
    state.isRunning = true;
    wsSend({ type: 'card-response', cardId, value });
  },
  toggleVerboseLogs(): void {
    state.verboseLogs = !state.verboseLogs;
  },
};

// Create Vue app
mountedApp = createApp(App, { state });
mountedApp.mount('#app');