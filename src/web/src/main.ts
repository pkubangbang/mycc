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
// Whether the client has made LOCAL optimistic changes since the last
// authoritative /history snapshot (sendInput / sendSteer / sendRetry append
// a user bubble BEFORE wsSend). A 304 means "the server's history is
// unchanged since the ETag" — but if we appended a message the server never
// received (e.g. the WS send raced with a disconnect and was lost), a 304
// would wrongly validate our optimistic copy as authoritative. So when
// historyDirty is true, fetchHistory() drops the ETag (sends no
// If-None-Match) to force a 200, then clears the flag once the authoritative
// snapshot replaces the store. Contract: 304 is valid only when the client
// has made no local changes since the last authoritative snapshot.
let historyDirty = false;

// Serialize cache writes so they complete in CALL ORDER, not whichever
// IndexedDB transaction happens to finish first. Without this, two
// fire-and-forget writes from different lifecycle paths (e.g. ws.onclose
// then a /history 200, or beforeunload + visibilitychange firing close
// together) can settle out of order: a NEWER snapshot (B) lands first,
// then an OLDER snapshot (A) overwrites it → a stale-regression cache.
// Each write is chained onto the previous one's promise, so the write that
// was started last always completes last and wins. The chain is failure-
// tolerant: a rejected/void write never breaks the chain for the next one.
let lastCacheWrite: Promise<void> = Promise.resolve();

/**
 * Persist the current store chatlog (messages + teammateMessages) to the
 * IndexedDB cache under `sessionId`. No-op when there is no session key
 * (buildCacheKey returns null). Serialized via `lastCacheWrite` so the
 * latest call always wins the cache (see the comment above). Fire-and-
 * forget from the caller's perspective: returns void and never throws, so
 * it is safe to call from the hide/unload/disconnect paths.
 */
function persistChatlog(): void {
  const key = buildCacheKey(sessionId);
  if (!key) return;
  // Slice to snapshot the current arrays — the I/O is async and the store
  // may keep mutating; we want to persist the state AT this call site.
  const messages = store.messages.slice();
  const teammateMessages = store.teammateMessages.slice();
  // Chain this write after the previous one. `.catch(() => {})` on the
  // predecessor guarantees a prior failure can never reject this chain.
  // The chained write still resolves void on any internal failure
  // (writeCachedChatlog never rejects), so the chain stays healthy.
  lastCacheWrite = lastCacheWrite
    .catch(() => {})
    .then(() => writeCachedChatlog(key, messages, teammateMessages));
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
  // Normalize IDs on cached messages that lack one (#25), mirroring the
  // fetchHistory() 200 path. A cached snapshot may contain legacy messages
  // predating the id scheme; without an id, messageKey falls back to a
  // window-relative "<ts> <label> #<index>" key, which shifts when loadMore
  // prepends older messages → the loadMore scroll anchor
  // (querySelector('[data-msg-key=...]')) can no longer relocate the anchor
  // and the scroll-restore silently no-ops. Assigning a stable nextId() here
  // makes the key "id:<id>" and window-independent, so the anchor key is
  // stable across loadMore — same invariant fetchHistory already enforces.
  for (const m of store.messages) {
    if (typeof m.id !== 'number') m.id = nextId();
  }
  for (const m of store.teammateMessages) {
    if (typeof m.id !== 'number') m.id = nextId();
  }
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
 * replaces the record authoritatively and updates `lastHistoryEtag` ONLY
 * after the body is parsed and the store replaced (so a parse failure cannot
 * advance the ETag and freeze the UI on a stale store via a later 304).
 *
 * Returns true on a successful authoritative update (200 applied) or an
 * unchanged-history short-circuit (304); false on any failure (non-ok,
 * network error, JSON parse error). The caller (reconnect) uses the false
 * signal to NOT connect the WS against a possibly-stale store — see the
 * session-isolation invariant in reconnect().
 */
async function fetchHistory(): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    // historyDirty: a local optimistic message was appended since the last
    // authoritative snapshot. A 304 would wrongly validate that optimistic
    // copy, so drop the ETag to force a full 200 re-fetch. The flag clears
    // below once the authoritative snapshot replaces the store.
    if (lastHistoryEtag && !historyDirty) headers['If-None-Match'] = lastHistoryEtag;
    const res = await fetch('/history', { headers });
    // 304 Not Modified — the hydrated-from-cache record is still current.
    // (Reachable only when !historyDirty: a dirty client forces a 200 by
    // omitting If-None-Match, so a 304 here genuinely means "unchanged AND
    // you have no unconfirmed local changes".) Keep the store; nothing to do.
    if (res.status === 304) return true;
    if (!res.ok) return false;
    // Capture the ETag but do NOT commit it yet — only advance lastHistoryEtag
    // AFTER the body is parsed and the store is replaced, so a parse/processing
    // failure cannot leave the ETag pointing at a version whose body was never
    // applied (which would make the next If-None-Match 304 and freeze a stale
    // store until another history change).
    const etag = res.headers.get('ETag');
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
    // Assign a stable id to any history-loaded message that lacks one (older
    // transcripts predate the id scheme). This MUST happen before the
    // messages enter the store so their v-for key (messageKey → `id:<id>`)
    // is stable across collapse-window shifts (loadMore prepends), not
    // viewport-relative — preserving MessageItem local state (copied, timers).
    // nextId() is monotonic over the page lifetime, so a re-fetched history
    // gets fresh ids (the store is replaced, so there is no key collision
    // with the previous snapshot's ids).
    for (const m of visible) {
      if (typeof m.id !== 'number') m.id = nextId();
    }
    // Split teammate messages from the main chat log by the @-prefix label
    // convention. Teammate messages (@name/tool) go to teammateMessages for
    // the accordion UI; everything else stays in messages. See the
    // "@-prefix teammate label convention" section in MYCC.md.
    const teammateMsgs = visible.filter(m => m.label?.startsWith('@'));
    const mainMsgs = visible.filter(m => !m.label?.startsWith('@'));
    // Replace, not append — on reconnect we want a clean, authoritative snapshot.
    store.messages.splice(0, store.messages.length, ...mainMsgs);
    store.teammateMessages.splice(0, store.teammateMessages.length, ...teammateMsgs);
    // Bump the history revision so the ChatLog collapse watcher resets its
    // x/t/trackingTail window — a 200 is an AUTHORITATIVE replacement, and
    // the new history may have the same filtered length as the old (e.g. the
    // server's 1000-entry cap: old entries leave + new entries enter → count
    // stays 1000). Without this revision signal the watcher would classify
    // the same-length replacement as 'none' and keep a now-invalid window
    // position. See #22.
    store.historyRevision++;
    // Restore the steering buffer bar from the server's current queue (peek,
    // not consume). Survives a page refresh within the same serve session.
    const queued = data.steeringBuffer ?? [];
    store.steeringBuffer.splice(0, store.steeringBuffer.length, ...queued);
    // Restore the agent running state from the server. The backend owns the
    // single source of truth — we set the phase, never a loose flag.
    if (typeof data.isRunning === 'boolean') {
      store.setPhase(data.isRunning ? 'working' : 'idle');
    }
    // The authoritative update fully succeeded — NOW commit the ETag so a
    // later 304 correctly means "the store matches this version". Also clear
    // historyDirty: the store now reflects the server's authoritative
    // snapshot, so any prior optimistic message has been reconciled (the
    // server's version of the same user input is in the snapshot; a lost
    // optimistic message is correctly absent).
    if (etag) lastHistoryEtag = etag;
    historyDirty = false;
    // Persist the authoritative snapshot to the cache so the next lock-screen
    // wake hydrates from it. Only on a 200 (we returned early on 304 above,
    // which means the cache is already current). Fire-and-forget.
    persistChatlog();
    return true;
  } catch {
    // Network/parse failure — leave existing messages; the caller decides
    // whether to retry (reconnect) vs connect the WS.
    return false;
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
 *
 * CONFIG-GATING INVARIANT: returns `true` only on a successful 200 + parse,
 * `false` on any failure (non-ok, network error, JSON parse error). BOTH
 * the bootstrap and reconnect() gate on this boolean: if /config fails, the
 * client CANNOT trust its cached `sessionId` / `lastHistoryEtag` (a serve
 * restart may have started a new session, and the failure left the old
 * identity in place), so it must NOT proceed to fetchHistory() (which could
 * send a stale If-None-Match and 304 against the wrong session) and must
 * NOT connect the WS. Instead it schedules a reconnect retry so the next
 * attempt re-runs config → history → WS. Invariant: no WS connection and
 * no conditional history validation may proceed unless the current session
 * identity has been successfully established via /config. This does NOT
 * affect the instant-cache UX — hydrateFromCache + mount still run during
 * bootstrap before the gated synchronization stages.
 */
async function fetchConfig(): Promise<boolean> {
  try {
    const res = await fetch('/config');
    if (!res.ok) return false;
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
    //
    // SESSION-ISOLATION INVARIANT: once sessionId changes, NO message from
    // the previous session may remain in the active store. The server does
    // NOT replay history over the WebSocket (it only sends prompt/auto/
    // running state on connect), so if the old chatlog were left in place
    // and the WS connected to the new session, live new-session messages
    // would layer on top of old-session history → a mixed log. Clearing the
    // chat arrays HERE (the moment the new sessionId is observed) makes the
    // transition atomic from the UI's perspective: the store is empty of
    // foreign history before fetchHistory() runs, and reconnect() connects
    // the WS only after fetchHistory() succeeds (see reconnect()).
    const newSid = typeof data.sessionId === 'string' ? data.sessionId : null;
    if (newSid !== sessionId) {
      sessionId = newSid;
      lastHistoryEtag = null;
      // Drop the previous session's chatlog immediately. (Steering buffer +
      // pendingSteeringReview are PROMPT-gated transient state cleared by
      // ws.onclose / setPhase; they do not carry cross-session history.)
      store.messages.splice(0, store.messages.length);
      store.teammateMessages.splice(0, store.teammateMessages.length);
      // Bump the history revision — clearing the arrays is an authoritative
      // replacement (to empty), so the collapse watcher must reset its
      // window just as it does on a /history 200. See #22.
      store.historyRevision++;
    }
    return true;
  } catch {
    // /config unreachable — keep defaults (maxUploadMb=50, persistent=false).
    // Return false so the caller does NOT proceed to fetchHistory/WS against
    // a possibly-stale sessionId/ETag (see the CONFIG-GATING INVARIANT above).
    return false;
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
      // Re-establish: config → history → WS. Same config-first order as
      // load (see reconnect() for why config must precede history).
      void reconnect();
    }, 1500);
  };

  ws.onerror = () => {
    // Let onclose handle the reconnect scheduling; just update status.
    store.connectionStatus = 'reconnecting';
  };
}

/** Reconnect sequence: re-fetch config FIRST, then history, then re-open
 *  the WS. Ordering is load-bearing for session fencing: fetchConfig()
 *  detects a sessionId change (a serve restart started a new session),
 *  clears `lastHistoryEtag`, and CLEARS the store's chat arrays so no
 *  previous-session message remains. Only AFTER that is it safe to call
 *  fetchHistory() — otherwise a stale If-None-Match from the previous
 *  session could 304 against the NEW session's history (the /history ETag
 *  is a metadata/state fingerprint that does NOT include the sessionId, so
 *  a fingerprint collision across sessions is possible) and freeze the UI
 *  on a foreign/empty log. With config-first, a session change forces an
 *  unconditional /history fetch (no If-None-Match sent → never a 304
 *  against the wrong session); an unchanged session still benefits from the
 *  304 short-circuit.
 *
 *  WS-GATING INVARIANT: the WebSocket is connected to the new session ONLY
 *  if fetchHistory() succeeds. If /history fails (transient network error)
 *  right after a session change, connecting the WS would let new-session
 *  live events layer on top of an empty (or stale) store with no
 *  authoritative history — and the server does NOT replay history over WS.
 *  On failure we leave the WS CLOSED and schedule another reconnect so the
 *  next attempt re-runs config → history. This keeps the session transition
 *  atomic from the UI's perspective: no live new-session events arrive
 *  until the new session's history is confirmed.
 *
 *  CONFIG-GATING INVARIANT: fetchConfig() must ALSO succeed before
 *  fetchHistory() runs. If /config fails, sessionId/lastHistoryEtag stay
 *  stale (a serve restart may have started a new session unnoticed), so
 *  sending If-None-Match could 304 against the wrong session's history.
 *  On config failure we leave the WS CLOSED and schedule a reconnect retry
 *  (same 1.5s cadence) so the next attempt re-runs config → history → WS. */
async function reconnect(): Promise<void> {
  const configOk = await fetchConfig();
  if (!configOk) {
    // Config unavailable — sessionId/ETag may be stale (a serve restart
    // could have started a new session). Do NOT fetch history (a stale
    // If-None-Match could 304 against the wrong session) or connect the WS.
    // Schedule a retry so the next attempt re-runs config → history → WS.
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void reconnect();
      }, 1500);
    }
    return;
  }
  const ok = await fetchHistory();
  if (!ok) {
    // History unavailable — do NOT connect the WS against a possibly-stale
    // store. Schedule a retry (mirrors ws.onclose's 1.5s cadence) so the
    // next attempt re-runs config → history → WS once /history is reachable.
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void reconnect();
      }, 1500);
    }
    return;
  }
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

// Page load sequence: initialize the Shiki highlighter, fetch config, hydrate
// the chatlog from the IndexedDB cache, mount the Vue app, fetch history, and
// finally establish the WS connection. Mounting is deliberately placed
// INSIDE this async bootstrap — AFTER hydrateFromCache() but BEFORE
// fetchHistory() — so the FIRST render already shows the hydrated/prior
// chatlog instead of a blank screen (the instant-cache UX goal). The
// highlighter is awaited FIRST so the first render's code blocks are already
// syntax-highlighted. The WS connects last so live updates never overtake
// the historical record. BOTH fetchConfig() and fetchHistory() act as GATES:
// if either fails, the WS is NOT connected and a reconnect retry is
// scheduled, while the cache-mounted UI stays visible (see the CONFIG-GATING
// and WS-GATING invariants in the bootstrap body and in reconnect()).
void (async () => {
  store.connectionStatus = 'reconnecting';
  await ensureHighlighterReady();
  // Fetch config first: maxUploadMb + persistent feed the first render (the
  // StatusBar button label and the upload size guard), and sessionId (the
  // IndexedDB cache key) must be known BEFORE hydrateFromCache() so the
  // cache is read from the right key. fetchConfig() also resets
  // lastHistoryEtag on a session change — which must happen before
  // fetchHistory() so a stale If-None-Match is never sent against a new
  // session (see reconnect() for the same ordering rule).
  //
  // CONFIG-GATING INVARIANT (mirrors reconnect): fetchConfig() returns a
  // boolean — true only on a successful 200 + parse. Its SIDE EFFECTS
  // (sessionId / maxUploadMb / persistent / store clear on session change)
  // run unconditionally here so hydration + mount use the freshest values
  // available (and on a first load with no prior session there is nothing
  // stale to misuse). But the boolean gates the SYNCHRONIZATION stages
  // (fetchHistory → connectWebSocket): if /config failed, sessionId/
  // lastHistoryEtag may be stale (a serve restart could have started a new
  // session unnoticed), so we must NOT fetchHistory (a stale If-None-Match
  // could 304 against the wrong session) and must NOT connect the WS. We
  // schedule a reconnect retry instead; the cache-mounted UI stays visible
  // in the meantime (the instant-cache UX goal is preserved — hydrate +
  // mount happen regardless of config's outcome, exactly as they do
  // regardless of history's outcome below).
  const configOk = await fetchConfig();
  // Hydrate the chatlog from the IndexedDB cache BEFORE mounting so the
  // FIRST render is non-blank on a lock-screen wake — the cached chatlog is
  // visible instantly, without waiting for the /history network round trip.
  // fetchHistory() runs AFTER mount to revalidate authoritatively (a 304
  // keeps this hydrated state; a 200 replaces it). The cache intentionally
  // does NOT restore transient state (running/steering/phase), so the first
  // render may briefly show the default interaction state; the /history
  // response (or the live WS) corrects it immediately. That brief transient
  // is preferable to a blank screen while /history is in flight.
  await hydrateFromCache();
  // Mount the Vue app AFTER hydration (cached chatlog already in the store)
  // but BEFORE fetchHistory(), so the user sees the cache instantly and the
  // server revalidation layers on top without a blank-flash gap.
  // The store was already activated via setActivePinia(pinia) at module
  // load, so useChatStore() above is valid; app.use(pinia) installs the
  // same instance for the component tree.
  mountedApp = createApp(App, { state: store });
  mountedApp.use(pinia);
  mountedApp.mount('#app');
  // CONFIG-GATING: if /config failed, do NOT proceed to the synchronization
  // stages. Schedule a reconnect retry (same 1.5s cadence as the history
  // gate below) so the next attempt re-runs config → history → WS. The
  // cache-mounted UI is already on screen, so the user sees content while
  // the retry is in flight.
  if (!configOk) {
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void reconnect();
      }, 1500);
    }
    return;
  }
  // Revalidate with the server AFTER mount — 304 keeps the hydrated state,
  // 200 replaces it authoritatively (Pinia reactivity updates the mounted
  // components via splice, no re-mount needed).
  const historyOk = await fetchHistory();
  // WS-GATING INVARIANT (mirrors reconnect): the WebSocket connects ONLY
  // after /history succeeds. The server does NOT replay history over WS
  // (only prompt/auto/running state + subsequent live events), so opening
  // the WS against a failed /history would show [cached history] + [live
  // events] minus whatever historical events happened while /history was
  // unavailable — a gap in the record. On failure, leave the WS closed and
  // schedule a reconnect retry; the cache-mounted UI stays visible in the
  // meantime (the instant-cache UX goal is preserved — mount happens before
  // fetchHistory regardless of its outcome).
  if (historyOk) {
    connectWebSocket();
  } else if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnect();
    }, 1500);
  }
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
    // Local optimistic mutation — a subsequent /history 304 must NOT be
    // treated as authoritative (the server may never receive this message
    // if the WS send races with a disconnect). See historyDirty in fetchHistory.
    historyDirty = true;
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
    // Local optimistic mutation — see historyDirty in fetchHistory.
    historyDirty = true;
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
    // Local optimistic mutation — see historyDirty in fetchHistory.
    historyDirty = true;
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

// The Vue app is created and mounted INSIDE the async bootstrap above (after
// hydrateFromCache() but before fetchHistory()), so the first render already
// shows the hydrated chatlog. There is no eager mount here — see the
// bootstrap IIFE.