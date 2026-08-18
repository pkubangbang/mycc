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
import type { App as VueApp } from 'vue';
import App from './App.vue';
import type { ChatMessage, ChatState, CardOption, FileInfo, SteeringNote } from './types';
import { applyServerMessage } from './message-dispatch';
import { registerDebugSeam } from './debug';
import './style.css';

// Reactive state — survives HMR (module-level, not in any component)
const state = reactive<ChatState>({
  messages: [],
  inputText: '',
  isWaiting: false,
  isRunning: false,
  isAutoMode: false,
  connectionStatus: 'disconnected',
  showRetry: false,
  hasPendingCard: false,
  verboseLogs: false,
  steeringBuffer: [],
  pendingSteeringReview: [],
  pendingFiles: [],
  teammateMessages: [],
  darkMode: localStorage.getItem('mycc-theme') === 'dark',
  debugMode: false,
});

// Monotonic id counter for stable v-for keys (avoids array-index keys that
// break when messages are filtered/inserted). See ChatLog.vue.
let msgIdCounter = 0;
function nextId(): number {
  return ++msgIdCounter;
}

// pendingSteeringReview lifecycle: notes surfaced as the "继续…" card persist
// across PROMPT cycles until the user explicitly acts on the card (send as
// query / discard). They are populated ONLY from steeringBuffer at the moment
// a 'prompt' message flips isWaiting true (notes still pending in the backend
// queue — the agent never consumed them), NOT from the 'steer-flush' event
// (which fires AFTER the agent already consumed the notes, so capturing there
// would resurface already-received notes — the original bug). The array is
// cleared only at explicit abandon events (auto-mode entry and the ws.onclose
// handler below), so unhandled notes resurface at the next PROMPT instead of
// being silently lost.

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
let mountedApp: VueApp | null = null;

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
    const data = await res.json() as { messages: ChatMessage[]; steeringBuffer?: SteeringNote[]; isRunning?: boolean };
    // Empty-content prompts are "waiting for input" signals, not chat content.
    // Drop them from the visible record; non-empty prompts (e.g. 'Retry? [Y/n]')
    // remain visible. Also drop steer-echo/steer-flush entries — those belong
    // in the buffer bar (restored separately below), not the chat log.
    const visible = data.messages.filter(
      m => !(m.type === 'prompt' && !m.content)
        && m.type !== 'steer-echo'
        && m.type !== 'steer-flush'
        && m.type !== 'file-upload'
        && m.type !== 'file-flush',
    );
    // Split teammate messages from the main chat log by the @-prefix label
    // convention. Teammate messages (@name/tool) go to teammateMessages for
    // the accordion UI; everything else stays in messages. See the
    // "@-prefix teammate label convention" section in MYCC.md.
    const teammateMsgs = visible.filter(m => m.label?.startsWith('@'));
    const mainMsgs = visible.filter(m => !m.label?.startsWith('@'));
    // Replace, not append — on reconnect we want a clean, authoritative snapshot.
    state.messages.splice(0, state.messages.length, ...mainMsgs);
    state.teammateMessages.splice(0, state.teammateMessages.length, ...teammateMsgs);
    // Restore the steering buffer bar from the server's current queue (peek,
    // not consume). Survives a page refresh within the same serve session.
    const queued = data.steeringBuffer ?? [];
    state.steeringBuffer.splice(0, state.steeringBuffer.length, ...queued);
    // Restore the agent running state from the server. The backend owns the
    // single source of truth — we never set isRunning locally.
    if (typeof data.isRunning === 'boolean') {
      state.isRunning = data.isRunning;
    }
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
    // Delegate the pure state-transition logic to the DOM-free dispatch module.
    applyServerMessage(state, msg, { nextId, chatApi });
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
    state.hasPendingCard = false;
    // Disconnect abandons any pending steering review: the review card is
    // PROMPT-gated (isWaiting), which is now false, and the user can't act
    // on it while disconnected. On reconnect the server re-sends 'prompt' if
    // the agent is still waiting, and the continue card is repopulated from
    // the (still-pending) steeringBuffer at that point — but stale notes
    // captured before the drop may have since been consumed by the agent, so
    // resurfacing them would be misleading. Drop them.
    state.pendingSteeringReview.splice(0);
    // Do NOT reset isAutoMode here: it is a durable session-level flag the
    // server resends on reconnect (see the on-connect broadcast in
    // serve-hub.ts). Clearing it would flicker the chat input box disabled
    // and the 停止 button off for the gap between close and reconnect,
    // then back on — worse than a brief stale-but-correct display.
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

// Apply the persisted (or default) theme class on startup so the page
// renders in the correct theme immediately — no flash of wrong colors.
document.documentElement.classList.toggle('dark', state.darkMode);

// Expose for components (send messages, exit, retry)
export const chatApi = {
  sendInput(text: string, files?: FileInfo[]): void {
    if (!text.trim() && (!files || files.length === 0)) return;
    // Echo the user's input as a local message for immediate feedback
    state.messages.push({ type: 'user', content: text || '(uploaded files)', timestamp: Date.now(), id: nextId() });
    state.inputText = '';
    state.pendingFiles = [];
    state.isWaiting = false;
    state.showRetry = false;
    wsSend({ type: 'input', text: text || undefined, files: files && files.length > 0 ? files : undefined });
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
  sendSteer(text: string, files?: FileInfo[]): void {
    if (!text.trim() && (!files || files.length === 0)) return;
    state.messages.push({ type: 'user', content: text || '(uploaded files)', timestamp: Date.now(), id: nextId() });
    state.inputText = '';
    state.pendingFiles = [];
    wsSend({ type: 'steer', text: text || undefined, files: files && files.length > 0 ? files : undefined });
  },
  /**
   * Resolve the pending steering-review card with positive "boomerang"
   * semantics: `sendIds` declares which note ids the user wants to SEND; every
   * note NOT in `sendIds` is implicitly discarded. The backend atomically
   * drains the whole queue on 'steer-resolve', so no note is re-synthesized at
   * the next PROMPT. Locally we clear the review card (and buffer bar) so the
   * UI reflects the resolution immediately, then send the single WS message.
   *
   * - sendIds = all remaining ids → "发送为查询" (send-as-query)
   * - sendIds = subset → partial discard (send the rest)
   * - sendIds = [] → discard-all (drain without submitting)
   */
  resolveSteering(sendIds: number[]): void {
    // Local optimistic clear: the card disappears and the input box re-enables.
    state.pendingSteeringReview.splice(0);
    state.steeringBuffer.splice(0);
    // The backend owns the authoritative queue; this is a single positive
    // message (no separate discard-then-input ordering problem).
    wsSend({ type: 'steer-resolve', sendIds });
  },
  sendExit(): void {
    wsSend({ type: 'exit' });
  },
  sendInterrupt(): void {
    wsSend({ type: 'interrupt' });
  },
  /**
   * One-way "enter auto mode" request from the webui lightning-bolt button.
   * The backend 'auto' handler runs the combined entry (core.setAuto +
   * agentIO.setAuto) when not already in auto mode, or broadcasts a
   * "已经是自动模式了" warning when it is. The client also guards locally
   * (see ChatInput.vue) so the toast shows without a round-trip in the
   * common case, but the server re-checks for multi-client races.
   */
  sendAuto(): void {
    wsSend({ type: 'auto' });
  },
  sendRetry(answer: string): void {
    // Echo the chosen retry answer as a user bubble so the user sees their
    // choice reflected in the chat record (matches sendInput feedback).
    state.messages.push({ type: 'user', content: answer, timestamp: Date.now(), id: nextId() });
    state.showRetry = false;
    state.inputText = '';
    state.isWaiting = false;
    wsSend({ type: 'input', text: answer });
  },
  /** Respond to an interactive card. Called by CardItem.vue. */
  sendCardResponse(cardId: string, value: string): void {
    state.isWaiting = false;
    state.hasPendingCard = false;
    wsSend({ type: 'card-response', cardId, value });
  },
  toggleVerboseLogs(): void {
    state.verboseLogs = !state.verboseLogs;
  },
  toggleTheme(): void {
    state.darkMode = !state.darkMode;
    document.documentElement.classList.toggle('dark', state.darkMode);
    localStorage.setItem('mycc-theme', state.darkMode ? 'dark' : 'light');
  },
};

// Install the debug seam so reproducible tests (and the debug panel) can
// inject synthetic server messages through the same dispatch path as the real
// WS handler. Registered only under import.meta.env.DEV; a no-op otherwise.
registerDebugSeam(state, { nextId, chatApi });

// Create Vue app
mountedApp = createApp(App, { state });
mountedApp.mount('#app');