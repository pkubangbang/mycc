# WebUI (src/web)

The mycc web chat UI — a Vue 3 single-page app served by an in-process
Express + Vite + WebSocket server (`src/serve/`). It mirrors the terminal
agent REPL over the browser: same agent loop, same LLM, same tools — input
and output are bridged over a WebSocket instead of a TTY.

This document is the developer reference for the WebUI subsystem. For the
original design rationale, see `docs/serve-plan.md`.

---

## 1. Overview

```
 Browser (Vue SPA)                  Lead process (agent loop)
 ┌───────────────┐                  ┌──────────────────────────┐
 │  App.vue      │                  │  agent-repl.ts (main)     │
 │   ├ StatusBar │  HTTP /history   │   └ getServeHub()       │
 │   ├ ChatLog    │◀────GET─────────│       .setTranscriptPath │
 │   └ ChatInput │                  │                          │
 │       │        │  WS /ws (JSON)   │  ServeHub (singleton)    │
 │       ▼        │◀──────┬────────▶│   ├ Express + Vite       │
 │   chatApi      │  input│ result  │   ├ /history endpoint    │
 │   (main.ts)    │───────┘────────▶│   ├ WS input bridge      │
 └───────────────┘                  │   └ messageLog + transcript│
                                    └──────────────────────────┘
```

- **Single port.** Express serves the Vite middleware (HMR + module serving)
  and the `/ws` WebSocket on the same HTTP server. Default port: `3173`.
- **ServeHub** (`src/serve/serve-hub.ts`) is a Lead-process singleton. It owns
  the HTTP server, the WS server, the input bridge, and the message log.
- **WebInputProvider** (`src/serve/web-input-provider.ts`) is the *only*
  `InputProvider` passed to the state machine. It routes between WebSocket
  (serve running) and the terminal `UserInputProvider` (serve stopped) based
  on `hub.isRunning()`.
- **History is durable.** The `/history` endpoint reads the on-disk triologue
  JSONL transcript (set via `setTranscriptPath`) — it survives serve
  stop/restart and page closes. The in-memory `messageLog` is a fallback.

---

## 2. Activation

Serve mode can be activated two ways:

| Way | Code path | When |
|-----|-----------|------|
| CLI flag | `mycc --serve [--port N]` | `agent-repl.ts` calls `activateServe(getServePort())` before the REPL loop |
| Slash command | `/serve [port]` | `src/slashes/serve.ts` → `activateServe(port)` mid-session |

`activateServe(port)` (`src/serve/activate.ts`):
1. `hub.start(port)` — boots Express + Vite + WS.
2. Wires output mirroring: `agentIO.setOutputCallback` → `hub.broadcast(method, text)` (log/warn/error).
3. Wires result mirroring: `setResultCallback` → `hub.broadcast('result', content)` (letter-box final reply).
4. Sends `{ type: 'serve_mode', active: true }` IPC to Coordinator → Coordinator filters terminal stdin (only ESC/Ctrl+C forwarded).

**Deactivation** (all warm — no neglection, no LLM abort):
- In-UI **退出** button → WS `exit` message → `gracefulShutdown()`.
- **ESC** in terminal → Coordinator IPC → Lead serve handler → `hub.stop()` (warm exit, terminal input restored).
- **30s disconnect timeout** — no client reconnected → `gracefulShutdown()`.

> Serve mode does **not** survive a Lead-process restart. A new Lead starts
> fresh (ServeHub is closed on process exit).

---

## 3. Data Flow

### 3.1 Output: Agent → Browser

Agent output flows to the browser through two callbacks set in `activate.ts`:

```
agentIO.brief(level, tool, msg)        letter-box (final reply)
        │                                      │
  setOutputCallback                       setResultCallback
        │                                      │
        ▼                                      ▼
  hub.broadcast(method, text)        hub.broadcast('result', content)
        │                                      │
        ▼                                      ▼
  WS send { type, content }          WS send { type:'result', content }
```

- `agentIO.brief()` calls produce `log` / `warn` / `error` bubbles.
- The letter-box (`src/utils/letter-box.ts`) strips internal markup (FW tags)
  and calls `resultCallback(stripped)` → a `result` bubble (the LLM's final
  reply). This is the bubble with the light-green glow border.

### 3.2 Input: Browser → Agent

```
Browser types text → chatApi.sendInput(text)
        │
        ▼
  WS send { type:'input', text }
        │
        ▼
  ServeHub.onWsMessage → submitInput(text)
        │
        ▼
  inputResolver(text) → resolves WebInputProvider.getInput()
        │
        ▼
  State machine PROMPT state receives the string as the user query
```

### 3.3 History: Browser ← Server (on load & reconnect)

```
Page load / WS reconnect
        │
        ▼
  fetchHistory()  →  GET /history
        │
        ▼
  ServeHub.readHistory()
        │
        ├─ transcriptPath set? → read triologue JSONL from disk
        │     map each Message line → LogEntry (role → type)
        │     cap at MAX_LOG_SIZE (1000)
        │
        └─ fallback → in-memory messageLog[]
        │
        ▼
  JSON array of { type, content, timestamp }
        │
        ▼
  state.messages.splice(...)  → rendered as chat bubbles
```

The client fetches `/history` **before** establishing the WS, so historical
bubbles populate first and live updates layer on top with no duplication.

### 3.4 Interrupt: Browser → Agent

```
Browser clicks 停止 → chatApi.sendInterrupt()
        │
        ▼
  WS send { type:'interrupt' }
        │
        ▼
  ServeHub.onWsMessage → agentIO.triggerNeglection()
        │
        ▼
  aborts the LLM call → escAware cleanup → startWrapUp → return to PROMPT
```

> **Note:** `WebInputProvider.getInput()` clears `neglectedModeFlag` and
> flushes buffered output before showing the next prompt (mirroring the
> terminal `ask()` path). This ensures the conversation can continue after a
> 停止 click — without it, the flag stays stuck and output is swallowed.

---

## 4. HTTP & WebSocket Interfaces

### 4.1 HTTP Endpoints

#### `GET /`
Serves `index.html` transformed by Vite (injects HMR client). Returns HTML.

#### `GET /history`
Returns the message history as a JSON array. Fetched by the client at page
load and on WS reconnect.

**Response** (`200`, `application/json`):
```json
[
  { "type": "user",    "content": "fix the bug",        "timestamp": 1719000000000 },
  { "type": "result",  "content": "I'll look into it…", "timestamp": 0 },
  { "type": "log",     "content": "Reading src/foo.ts", "timestamp": 0 },
  { "type": "prompt",  "content": "",                   "timestamp": 1719000001000 }
]
```

- When `transcriptPath` is set, entries are read from the triologue JSONL
  with `timestamp: 0` (the transcript does not record per-message timestamps).
- Live `broadcast()` entries get a real `Date.now()` timestamp.
- Capped at `MAX_LOG_SIZE` (1000 entries, most recent kept).

### 4.2 WebSocket `/ws`

The WS carries live, single-message updates in both directions. Each
message is a JSON object.

#### Browser → Server (WS messages)

| `type` | `text` field | Action |
|--------|-------------|--------|
| `input` | the user's text | Submit as the next user query (`submitInput`) |
| `exit` | — | Graceful shutdown (`gracefulShutdown()`) |
| `interrupt` | — | Abort current LLM call (`triggerNeglection`, like ESC) |

```json
{ "type": "input", "text": "list the files" }
{ "type": "exit" }
{ "type": "interrupt" }
```

#### Server → Browser (WS messages)

| `type` | Meaning | Source |
|--------|---------|--------|
| `user` | (echoed locally by client on send) | `chatApi.sendInput` |
| `result` | LLM final reply (letter-box) | `setResultCallback` → `broadcast('result', …)` |
| `log` | Tool/log output | `agentIO.setOutputCallback` → `broadcast('log', …)` |
| `warn` | Warning | `broadcast('warn', …)` |
| `error` | Error | `broadcast('error', …)` |
| `system` | System message | `broadcast('system', …)` |
| `prompt` | "waiting for input" signal | `broadcast('prompt', content)` |

```json
{ "type": "result", "content": "Done. Fixed the bug in …" }
{ "type": "log", "content": "Running: grep -r foo src/" }
{ "type": "prompt", "content": "" }
{ "type": "prompt", "content": "Retry? [Y/n]" }
```

> An **empty-content `prompt`** is purely a "waiting for input" signal — the
> client uses it to enable the input box but does **not** render it as a
> bubble. A **non-empty `prompt`** (e.g. `Retry? [Y/n]`) is shown as a bubble.

### 4.3 Type Mapping (transcript → WebUI)

The `/history` endpoint maps triologue `Message.role` → WebUI `LogEntry.type`:

| Triologue `role` | WebUI `type` | Bubble style |
|------------------|--------------|-------------|
| `user` | `user` | WeChat green, right-aligned, markdown |
| `assistant` | `result` | White + green glow border, markdown |
| `tool` | `log` | Light gray, monospace, plain text |
| `system` | `system` | Light gray, plain text |

---

## 5. Page Layout

The SPA is a single full-viewport flex column (`App.vue`):

```
┌─────────────────────────────────────────────────────┐
│ StatusBar  (● 已连接          mycc chat      [退出]) │  ← flex-shrink:0
├─────────────────────────────────────────────────────┤
│                                                     │
│  ChatLog  (scrollable, #ededed WeChat-gray bg)      │  ← flex:1
│                                                     │
│  ┌──────────────────────────────┐                    │
│  │ user bubble (green, right)   │                    │
│  └──────────────────────────────┘                    │
│  ┌──────────────────────────────┐                    │
│  │ result bubble (white+green  │                    │
│  │ glow border, markdown)      │                    │
│  └──────────────────────────────┘                    │
│  ┌──────────────────────────────┐                    │
│  │ log bubble (gray, mono)     │                    │
│  └──────────────────────────────┘                    │
│                                                     │
│            ┌──────────────┐                          │
│            │ ⟳ 停止        │  (only while running)  │
│            └──────────────┘                          │
│                                                     │
├─────────────────────────────────────────────────────┤
│ ChatInput  (#f7f7f7, top border)                    │  ← flex-shrink:0
│ ┌────────────────────────────┐ ┌────────┐           │
│ │ textarea (输入消息…)        │ │ 发送    │          │
│ └────────────────────────────┘ └────────┘           │
└─────────────────────────────────────────────────────┘
```

### Components

| Component | File | Role |
|-----------|------|------|
| `App.vue` | `src/web/src/App.vue` | Root layout: StatusBar + ChatLog + ChatInput. Owns the `#ededed` background. |
| `StatusBar.vue` | `src/web/src/components/StatusBar.vue` | Connection status dot/text, "mycc chat" title, Retry + 退出 buttons. |
| `ChatLog.vue` | `src/web/src/components/ChatLog.vue` | Scrollable message list. Auto-scrolls if user is at bottom; shows ↓ button otherwise. Renders the 停止 (interrupt) button while `isRunning`. |
| `MessageItem.vue` | `src/web/src/components/MessageItem.vue` | Single bubble. Renders markdown for `user`/`result`; plain monospace for `log`/`warn`/`error`. |
| `ChatInput.vue` | `src/web/src/components/ChatInput.vue` | Textarea + 发送 button. Enter sends, Shift+Enter newline. |

### State (`src/web/src/types.ts`)

```ts
type MessageType = 'user' | 'log' | 'warn' | 'error' | 'result' | 'prompt' | 'system';

interface ChatMessage {
  type: MessageType;
  content: string;
  timestamp?: number;
}

interface ChatState {
  messages: ChatMessage[];
  inputText: string;
  isWaiting: boolean;   // prompt pending → input box enabled
  isRunning: boolean;   // agent working (between submit and next prompt)
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
  showRetry: boolean;   // Retry? [Y/n] prompt pending
}
```

The reactive `ChatState` lives in `main.ts` (module-level) so it **survives
Vue component HMR** — editing a `.vue` component while the UI runs does not
lose the chat history or WS connection.

### HMR Architecture

`main.ts` is never hot-replaced by Vite (it owns the WS + state). Vue
components (`App.vue` + children) auto-HMR via `@vitejs/plugin-vue`: their
render functions are replaced while `ref/reactive` state is preserved. This
makes live-editing the WebUI while it runs safe.

---

## 6. Features

### Markdown rendering
`result` (LLM replies) and `user` bubbles are rendered with
[`markdown-it`](https://github.com/markdown-it/markdown-it) (`html: false` for
XSS safety, `linkify: true`, `breaks: true`). Tool output / system / prompt
bubbles stay plain-text monospace. Styled via `:deep()` selectors in
`MessageItem.vue` (headings, lists, code blocks, tables, blockquotes, links).

### Letter-box glow border
`result` bubbles (the LLM's final reply via the letter-box) have a light-green
glow border: `border: 1px solid #b7eb8f; box-shadow: 0 0 6px 1px rgba(122,200,100,0.45)`.

### Durable history
`/history` reads the on-disk triologue JSONL transcript when
`ServeHub.setTranscriptPath(path)` has been called (done in `agent-repl.ts`
right after session init). Reopening the page after a serve stop/restart
restores the full conversation. Falls back to the in-memory `messageLog`
when no transcript is set or the file is unreadable.

### Interrupt (停止)
A 停止 button appears in the chat log while the agent is running. Clicking it
sends an `interrupt` WS message → `triggerNeglection()` → aborts the LLM. The
`neglectedModeFlag` is cleared by `WebInputProvider` on the next prompt so the
conversation continues normally.

### Reconnect
If the WS drops, the client waits 1.5s, re-fetches `/history`, then re-opens
the socket. The server has a 30s disconnect timer — if no client reconnects
within 30s, it performs a warm graceful shutdown.

### Retry
When the agent hits an error and shows a `Retry? [Y/n]` prompt, the StatusBar
shows a Retry button (and the prompt bubble detects `/retry/i` to toggle
`showRetry`).

---

## 7. File Map

### Backend (src/serve/)
| File | Role |
|------|------|
| `serve-hub.ts` | Express + Vite + WS orchestrator singleton. Owns HTTP server, WS server, input bridge, messageLog, transcriptPath, `/history` endpoint, broadcast, 30s disconnect timer, graceful shutdown. |
| `serve-registry.ts` | Module-level singleton accessor (`getServeHub()`), avoids circular imports. |
| `activate.ts` | `activateServe(port)` — starts hub, wires output/result callbacks, notifies Coordinator. Shared by `/serve` and `--serve`. |
| `web-input-provider.ts` | The sole `InputProvider` for the state machine. Routes WS ↔ terminal. Clears `neglectedModeFlag` before each prompt. |

### Frontend (src/web/src/)
| File | Role |
|------|------|
| `main.ts` | Entry. Owns reactive `ChatState` + WS (HMR-persistent). `fetchHistory()`, `connectWebSocket()`, `chatApi`. |
| `style.css` | Global reset (`* { margin:0; padding:0; box-sizing:border-box }`, `html/body/#app height:100%`). |
| `types.ts` | `ChatMessage`, `ChatState`, `MessageType`, `ConnectionStatus`. |
| `App.vue` | Root layout. |
| `components/StatusBar.vue` | Status bar. |
| `components/ChatLog.vue` | Scrollable message list + interrupt/scroll buttons. |
| `components/MessageItem.vue` | Bubble rendering (markdown vs plain) + bubble styles. |
| `components/ChatInput.vue` | Input textarea + send button. |

### Backend hooks (outside src/serve/)
| File | Hook |
|------|------|
| `src/loop/agent-repl.ts` | Calls `getServeHub().setTranscriptPath(triologuePath)` after session init; calls `activateServe()` for `--serve`. |
| `src/slashes/serve.ts` | `/serve [port]` slash command → `activateServe`. |
| `src/config.ts` | `shouldServe()`, `getServePort()` (default 3173). |
| `src/index.ts` | Coordinator: handles `serve_mode` IPC, filters stdin during serve. |
| `src/utils/letter-box.ts` | `setResultCallback` — the `result` bubble source. |

---

## 8. Lifecycle & Disconnect Handling

```
Client connects         → cancelDisconnectTimer()
Client disconnects       → startDisconnectTimer() (30s)
  └ client reconnects   → cancelDisconnectTimer()
  └ 30s elapses          → onDisconnectTimeout() → gracefulShutdown()
                              └ stop() → abortInput() + close all servers
                              └ agentIO.setOutputCallback(null)
                              └ setResultCallback(null)
                              └ IPC serve_mode active:false → Coordinator restores terminal stdin
```

`stop()` sets `running = false` **first**, then aborts blocked
`waitForInput()` with null. `WebInputProvider` checks `hub.isRunning()`
after every await, so it falls back to the terminal the moment serve stops —
no race.

---

## 9. Configuration

| Setting | Source | Default |
|---------|--------|---------|
| Port | `--port N` CLI flag or `/serve N` | `3173` |
| Enable at startup | `--serve` CLI flag | off |
| Transcript path | Auto-set from session init | `.mycc/transcripts/lead-{ts}-triologue.jsonl` |
| History cap | `ServeHub.MAX_LOG_SIZE` | 1000 entries |
| Disconnect timeout | `ServeHub.RECONNECT_TIMEOUT_MS` | 30 000 ms |
| WS reconnect delay | `main.ts` `reconnectTimer` | 1 500 ms |