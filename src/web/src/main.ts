/**
 * main.ts - Web UI entry point (HMR-persistent layer)
 *
 * This module is NEVER hot-replaced by Vite. It owns:
 * - The Pinia chat store (module-level, survives component HMR)
 * - The WebSocket connection (module-level)
 * - The chatApi object exposed to components
 *
 * Vue components (App.vue + children) auto-HMR via @vitejs/plugin-vue:
 * their render functions are replaced while the Pinia store is preserved.
 * Because the store lives here (not in any component), editing a component
 * while the Web UI is running is safe — the WebSocket stays connected and
 * the chat history is not lost.
 */

import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { App as VueApp } from 'vue';
import App from './App.vue';
import type { ChatMessage, CardOption, FileInfo, SteeringNote } from './types';
import { applyServerMessage } from './message-dispatch';
import { registerDebugSeam } from './debug';
import { ensureHighlighterReady } from './highlight';
import { useChatStore } from './stores/chat-store';
import {
  readCachedChatlog,
  writeCachedChatlog,
  buildCacheKey,
} from './chatlog-cache';
import type { ChatlogCacheRecord } from './chatlog-cache';
import './style.css';

// Pinia + chat store — survives HMR (module-level, not in any component).
// useChatStore() runs here OUTSIDE any component setup, so Pinia requires an
// explicitly-activated instance: createPinia() only *creates* the pinia —
// the "active pinia" is installed by app.use(pinia) (bottom of this file,
// too late for this module-level call) or by setActivePinia(). Without the
// activation, getActivePinia() throws "no active Pinia" at page load and the
// whole Web UI fails to boot.
const pinia = createPinia();
setActivePinia(pinia);
const store = useChatStore();

// Monotonic id counter for stable v-for keys (avoids array-index keys that
// break when messages are filtered/inserted). See ChatLog.vue.
let msgIdCounter = 0;
function nextId(): number {
  return ++msgIdCounter;
}

// pendingSteeringReview lifecycle: notes surfaced as the "继续…" card persist
// across PROMPT cycles until the user explicitly acts on the card (send as
// query / discard). They are populated ONLY from steeringBuffer at the moment
// a 'prompt' message transitions to the `prompt` phase (notes still pending in
// the backend queue — the agent never consumed them), NOT from the
// 'steer-flush' event (which fires AFTER the agent already consumed the
// notes, so capturing there would resurface already-received notes — the
// original bug). The array is cleared only at explicit abandon events
// (auto-mode entry via setAutoMode, and the ws.onclose handler below), so
// unhandled notes resurface at the next PROMPT instead of being silently lost.

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

// ── Chatlog cache (lock-screen instant wake) ──
// The current wire session id (the IndexedDB cache key). Set from /config at
// load; null when no wire session (caching is skipped — no stable key to bind
// a log to, and a foreign log must never be shown).
let sessionId: string | null = null;
// The ETag the server last sent for /history. Sent back as If-None-Match on
// the next fetch so an unchanged history returns 304 (0 bytes) and the
// hydrated-from-cache copy stays on screen. Null until the first successful
// /history response sets it.
let lastHistoryEtag: string | null = null;

/**
 * Persist the current store chatlog (messages + teammateMessages) to the
 * IndexedDB cache under `sessionId`. No-op when there is no session key
 * (buildCacheKey returns null). Fire-and-forget: the write is failure-
 * tolerant (resolves void on any error) and never blocks the caller, so it
 * is safe to call from the hide/unload/disconnect paths.
 */
function persistChatlog(): void {
  const key = buildCacheKey(sessionId);
  if (!key) return;
  // Slice to snapshot the current arrays — the I/O is async and the store
  // may keep mutating; we want to persist the state AT this call site.
  void writeCachedChatlog(key, store.messages.slice(), store.teammateMessages.slice());
}

/**
 * Hydrate the store from the IndexedDB cache BEFORE the first render, so a
 * lock-screen wake shows the prior chatlog instantly instead of a blank
 * screen + full re-fetch. No-op when there is no session key or no cached
 * record (the first render then waits for /history as before).
 *
 * Only the durable chat arrays are restored here — NOT the transient phase
 * / steering buffer / running state. Those come from /history (which runs
 * next) and the live WS; restoring them from a stale cache would show a
 * dead "停止" button or stale buffer bar until the server responds.
 */
async function hydrateFromCache(): Promise<void> {
  const key = buildCacheKey(sessionId);
  if (!key) return;
  const record: ChatlogCacheRecord | null = await readCachedChatlog(key);
  if (!record) return;
  // Replace the store arrays with the cached snapshot. Splice (not
  // reassignment) so Pinia reactivity propagates to mounted components.
  store.messages.splice(0, store.messages.length, ...record.messages);
  store.teammateMessages.splice(0, store.teammateMessages.length, ...record.teammateMessages);
}

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
      if (store.connectionError) store.connectionError = undefined;
      return true;
    } catch {
      // fall through to failure path
    }
  }
  store.connectionError = '连接已断开，消息未发送';
  // Auto-clear the error after 3s so it doesn't linger forever
  setTimeout(() => {
    store.connectionError = undefined;
  }, 3000);
  return false;
}

/**
 * Fetch the message history from /history BEFORE establishing the WebSocket.
 * This populates the chat record first, so live WS updates layer cleanly on
 * top with no race and no duplication. On reconnect after a WS drop, this is
 * called again to restore the full record (the server log is the source of
 * truth, not the socket).
 *
 * Caching: sends the last-seen ETag as `If-None-Match`. A 304 response means
 * the server's history is unchanged since that ETag — the already-hydrated
 * (from IndexedDB cache) record stays on screen and we do NOT touch the
 * store (avoids a blank flash + full re-fetch on lock-screen wake). A 200
 * replaces the record authoritatively and updates `lastHistoryEtag`. Network
 * failure leaves the hydrated record in place (the WS reconnect retries).
 */
async function fetchHistory(): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (lastHistoryEtag) headers['If-None-Match'] = lastHistoryEtag;
    const res = await fetch('/history', { headers });
    // 304 Not Modified — the hydrated-from-cache record is still current.
    // Keep it on screen; do not touch the store. Just refresh the steering
    // buffer + running state? No — a 304 means the WHOLE payload (messages
    // + steeringBuffer + isRunning) is unchanged, so there is nothing to do.
    if (res.status === 304) return;
    if (!res.ok) return;
    // Capture the ETag for the next If-None-Match revalidation.
    const etag = res.headers.get('ETag');
    if (etag) lastHistoryEtag = etag;
    const data = await res.json() as { messages: ChatMessage[]; steeringBuffer?: SteeringNote[]; isRunning?: boolean };
    // Empty-content prompts are "waiting for input" signals, not chat content.
    // Drop them from the visible record; non-empty prompts (e.g. 'Retry? [Y/n]')
    // remain visible. Also drop steer-echo/steer-flush entries — those belong
    // in the buffer bar (restored separately below), not the chat log.
    // Synthetic messages (machine-originated briefs: hook engine, debug
    // evaluator, checkpoint bookkeeping) are dropped too — the live WS path
    // filters them in applyServerMessage; this mirrors that for /history.
    const visible = data.messages.filter(
      m => !(m.type === 'prompt' && !m.content)
        && m.type !== 'steer-echo'
        && m.type !== 'steer-flush'
        && m.type !== 'file-upload'
        && m.type !== 'file-flush'
        && !m.synthetic,
    );
    // Split teammate messages from the main chat log by the @-prefix label
    // convention. Teammate messages (@name/tool) go to teammateMessages for
    // the accordion UI; everything else stays in messages. See the
    // "@-prefix teammate label convention" section in MYCC.md.
    const teammateMsgs = visible.filter(m => m.label?.startsWith('@'));
    const mainMsgs = visible.filter(m => !m.label?.startsWith('@'));
    // Replace, not append — on reconnect we want a clean, authoritative snapshot.
    store.messages.splice(0, store.messages.length, ...mainMsgs);
    store.teammateMessages.splice(0, store.teammateMessages.length, ...teammateMsgs);
    // Restore the steering buffer bar from the server's current queue (peek,
    // not consume). Survives a page refresh within the same serve session.
    const queued = data.steeringBuffer ?? [];
    store.steeringBuffer.splice(0, store.steeringBuffer.length, ...queued);
    // Restore the agent running state from the server. The backend owns the
    // single source of truth — we set the phase, never a loose flag.
    if (typeof data.isRunning === 'boolean') {
      store.setPhase(data.isRunning ? 'working' : 'idle');
    }
    // Persist the authoritative snapshot to the cache so the next lock-screen
    // wake hydrates from it. Only on a 200 (we returned early on 304 above,
    // which means the cache is already current). Fire-and-forget.
    persistChatlog();
  } catch {
    // Network failure — leave existing messages; WS reconnect will retry.
  }
}

/**
 * Fetch the server config (/config) at app load. Populates two store fields:
 *   - `maxUploadMb` — the per-file upload size cap (MB), driven server-side
 *     by --max-upload-mb / MYCC_MAX_UPLOAD_MB (default 50). ChatInput.vue
 *     reads this from the store instead of its own inline fetch, so the cap
 *     is fetched once app-level and shared by all components.
 *   - `persistent` — whether this serve instance is a headless daemon with
 *     no terminal fallback (shouldDaemon(), i.e. launched with --daemon).
 *     When true, the StatusBar renders 重启 (restart-webui) instead of 退出
 *     (exit); a fetch failure degrades to the safe 退出 button (default false).
 *
 * Called in the load sequence alongside fetchHistory() — before the WS
 * connects — so the store is populated before the first render.
 */
async function fetchConfig(): Promise<void> {
  try {
    const res = await fetch('/config');
    if (!res.ok) return;
    const data = await res.json() as { maxUploadMb?: number; persistent?: boolean; sessionId?: string | null };
    if (Number.isFinite(data.maxUploadMb) && (data.maxUploadMb as number) > 0) {
      store.maxUploadMb = data.maxUploadMb as number;
    }
    if (typeof data.persistent === 'boolean') {
      store.persistent = data.persistent;
    }
    // Capture the wire session id — the IndexedDB cache key. null when no
    // wire session (caching is skipped). When it changes across a reconnect
    // (a serve restart started a new session), reset the last ETag so the
    // next /history fetch does NOT send a stale If-None-Match from a
    // previous session (which would 304 against the wrong session's history
    // and freeze the UI on a foreign/empty log).
    const newSid = typeof data.sessionId === 'string' ? data.sessionId : null;
    if (newSid !== sessionId) {
      sessionId = newSid;
      lastHistoryEtag = null;
    }
  } catch {
    // /config unreachable — keep defaults (maxUploadMb=50, persistent=false)
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
    store.connectionStatus = 'connected';
  };

  ws.onmessage = (event) => {
    let msg: ChatMessage;
    try {
      msg = JSON.parse(event.data) as ChatMessage;
    } catch {
      return; // ignore malformed messages
    }
    // Delegate the pure state-transition logic to the DOM-free dispatch module.
    // The store is the single mutation surface; applyServerMessage calls
    // store.setPhase() / store.setAutoMode() per the transition table.
    applyServerMessage(store, msg, { nextId, chatApi });
  };

  ws.onclose = () => {
    store.connectionStatus = 'reconnecting';
    // Persist the chatlog on disconnect — a WS drop is often a precursor to
    // the user locking the screen / the tab being backgrounded, so capture
    // the visible log now (the IndexedDB write is fire-and-forget). On
    // reconnect, fetchHistory revalidates with If-None-Match; a 304 keeps
    // this snapshot, a 200 replaces it.
    persistChatlog();
    // Reset stale interaction state so the UI doesn't leave a dead Retry
    // button or spinner while disconnected. The server re-sends a 'prompt'
    // (or 'card') on reconnect if the agent is still waiting, so these
    // get restored correctly after reconnection — no permanent dead-end.
    store.setPhase('idle');
    store.showRetry = false;
    // Disconnect abandons any pending steering review: the review card is
    // PROMPT-gated (isWaiting), which is now false, and the user can't act
    // on it while disconnected. On reconnect the server re-sends 'prompt' if
    // the agent is still waiting, and the continue card is repopulated from
    // the (still-pending) steeringBuffer at that point — but stale notes
    // captured before the drop may have since been consumed by the agent, so
    // resurfacing them would be misleading. Drop them.
    store.pendingSteeringReview.splice(0);
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
    store.connectionStatus = 'reconnecting';
  };
}

/** Reconnect sequence: refresh history, then re-establish the WS. */
async function reconnect(): Promise<void> {
  await fetchHistory();
  // Re-fetch config too — a serve restart could have flipped persistent or
  // changed the upload cap, so don't trust the prior values across a
  // disconnect/reconnect boundary.
  await fetchConfig();
  connectWebSocket();
}

// Stop reconnecting when the page is unloaded (avoids a final stale socket).
// Also persist the chatlog to the IndexedDB cache so the next load (incl. a
// lock-screen wake) hydrates instantly. The write is fire-and-forget and
// failure-tolerant; on mobile the pagehide/visibilitychange(hidden) paths
// below are more reliable than beforeunload, so we persist on all three.
window.addEventListener('beforeunload', () => {
  persistChatlog();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
});

// Mobile lock-screen / tab-switch: when the page becomes hidden, persist the
// chatlog immediately. visibilitychange(hidden) is the signal iOS/Android
// fire on lock-screen — beforeunload is unreliable there. pagehide covers
// older browsers / the bfcache path. Both are cheap (the write is async and
// failure-tolerant) and idempotent, so registering both is safe.
window.addEventListener('pagehide', () => { persistChatlog(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistChatlog();
});

// Page load sequence: initialize the Shiki highlighter, fetch history, then
// establish the WS connection. The highlighter is awaited FIRST so the first
// render (history bubbles, which may contain code blocks) already has
// syntax highlighting — markdown-it's sync `highlight` callback calls into a
// ready singleton. Fetching history and connecting the WS follow; the
// highlighter init is non-blocking to the WS (it resolves quickly and only
// gates rendering, which happens at mount below).
void (async () => {
  store.connectionStatus = 'reconnecting';
  await ensureHighlighterReady();
  // Fetch config before history: maxUploadMb + persistent feed the first
  // render (the StatusBar button label and the upload size guard), so they
  // must be populated before the components mount and start reading the
  // store. fetchConfig() also captures the wire sessionId (the IndexedDB
  // cache key). fetchHistory() and the WS connection follow.
  await fetchConfig();
  // Hydrate the chatlog from the IndexedDB cache BEFORE the first render +
  // before fetchHistory, so a lock-screen wake shows the prior chatlog
  // instantly. fetchHistory then revalidates with If-None-Match — a 304
  // keeps this hydrated state; a 200 replaces it authoritatively.
  await hydrateFromCache();
  await fetchHistory();
  connectWebSocket();
})();

// Apply the persisted (or default) theme class on startup so the page
// renders in the correct theme immediately — no flash of wrong colors.
document.documentElement.classList.toggle('dark', store.darkMode);

// Expose for components (send messages, exit, retry)
export const chatApi = {
  sendInput(text: string, files?: FileInfo[]): void {
    if (!text.trim() && (!files || files.length === 0)) return;
    // Echo the user's input as a local message for immediate feedback
    store.messages.push({ type: 'user', content: text || '(uploaded files)', timestamp: Date.now(), id: nextId() });
    store.inputText = '';
    store.pendingFiles = [];
    // Optimistic: phase → submitted (send→running gap). The backend is now
    // inside the PROMPT handler doing post-input LLM work before it
    // broadcasts 'running on'. The 15s expiry safety net lives in
    // ChatInput.vue's justSubmitted latch (kept as a UI diagnostic).
    store.setPhase('submitted');
    store.showRetry = false;
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
   * NOT change phase: the LLM is still working.
   */
  sendSteer(text: string, files?: FileInfo[]): void {
    if (!text.trim() && (!files || files.length === 0)) return;
    store.messages.push({ type: 'user', content: text || '(uploaded files)', timestamp: Date.now(), id: nextId() });
    store.inputText = '';
    store.pendingFiles = [];
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
    store.pendingSteeringReview.splice(0);
    store.steeringBuffer.splice(0);
    // The backend owns the authoritative queue; this is a single positive
    // message (no separate discard-then-input ordering problem).
    wsSend({ type: 'steer-resolve', sendIds });
  },
  sendExit(): void {
    wsSend({ type: 'exit' });
  },
  /** Send a "restart Web UI" request — only meaningful in persistent (headless
   *  daemon) mode, where the StatusBar renders 重启 instead of 退出. The
   *  backend's restart-webui handler calls ServeHub.restartServe(), which
   *  stops and re-starts the Vite dev server on the same port without killing
   *  the daemon process. The WS closes during the swap and the client's
   *  normal reconnect logic re-establishes it once the new server is up. */
  sendRestartWebui(): void {
    wsSend({ type: 'restart-webui' });
  },
  /** Safety-net expiry for the `submitted` phase. Called by ChatInput.vue's
   *  15s latch when no server message (running:on / prompt / card) transitioned
   *  the phase away from `submitted` in time — a sign the backend is genuinely
   *  desynced (e.g. the input was silently dropped by a stale-client race).
   *  Falls back to `idle` so the vacuum diagnostic surfaces instead of being
   *  masked forever. No WS message — purely a frontend recovery. */
  expireSubmitted(): void {
    store.setPhase('idle');
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
    store.messages.push({ type: 'user', content: answer, timestamp: Date.now(), id: nextId() });
    store.showRetry = false;
    store.inputText = '';
    // Optimistic: the retry answer is a fresh input → submitted phase.
    store.setPhase('submitted');
    wsSend({ type: 'input', text: answer });
  },
  /** Respond to an interactive card. Called by CardItem.vue. */
  sendCardResponse(cardId: string, value: string): void {
    // Optimistic: card-response → working always (agent resumes TOOL→LLM).
    // Matches the transition table; the server confirms via subsequent
    // broadcasts (running:on / prompt).
    store.setPhase('working');
    wsSend({ type: 'card-response', cardId, value });
  },
  toggleVerboseLogs(): void {
    store.verboseLogs = !store.verboseLogs;
  },
  toggleTheme(): void {
    store.darkMode = !store.darkMode;
    document.documentElement.classList.toggle('dark', store.darkMode);
    localStorage.setItem('mycc-theme', store.darkMode ? 'dark' : 'light');
  },
};

// Install the debug seam so reproducible tests (and the debug panel) can
// inject synthetic server messages through the same dispatch path as the real
// WS handler. Registered only under import.meta.env.DEV; a no-op otherwise.
registerDebugSeam(store, { nextId, chatApi });

// Create Vue app — install Pinia, then pass the store as the `state` prop.
// The store satisfies the `ChatState` interface (its reactive refs/computeds
// are unwrapped by Vue's template renderer, and the prop typing accepts the
// store's shape). Components read `state.phase` / `state.isWaiting` etc. and
// call `chatApi` to mutate; only applyServerMessage and chatApi call the
// store actions directly.
mountedApp = createApp(App, { state: store });
mountedApp.use(pinia);
mountedApp.mount('#app');