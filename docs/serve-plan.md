# Implementation Plan: `/serve` — Web Chat UI for mycc

## Architecture Overview

```
Browser (Vite dev server + HMR client)
  ↕ WebSocket (/ws)
Express HTTP server (single port, middleware mode)
  ↕ ServeHub singleton (orchestrator)
WebInputProvider (sole InputProvider)
  ├─ hub.isRunning() = true  → WebSocket input
  └─ hub.isRunning() = false → UserInputProvider (terminal)
  → AgentStateMachine (unchanged)
agentIO outputCallback → WebSocket → Browser
                        (also continues to terminal stdout)
```

### Core Behavior (per user spec)

1. **`/serve` issued**: Starts Express+Vite+WS server immediately. `/serve` only executes at the PROMPT state boundary (slash commands route from PROMPT→SLASH→PROMPT), so there's no mid-turn switching. Terminal input prompt (LineEditor) is not created — WebInputProvider checks `hub.isRunning()` and routes to `hub.waitForInput()` instead of `agentIO.ask()`. Terminal continues showing output (read-only).

2. **Terminal keys in serve mode**: Coordinator's raw stdin handler must be serve-mode-aware. When serve is active, it only forwards ESC and Ctrl+C; all other keys are silently dropped. This requires the Coordinator (parent process) to know serve mode is active — communicated via IPC message from Lead.

3. **Exiting serve mode** (three ways — all graceful/warm):
   - **ESC key (first press)**: Exits serve mode only. Does NOT set neglectedMode, does NOT abort LLM. ServeHub shuts down. If agent is mid-execution, it completes the current turn naturally; when it returns to PROMPT, WebInputProvider checks `hub.isRunning()` = false → delegates to UserInputProvider → terminal prompt appears. If agent is waiting for input (PROMPT state), `abortInput()` resolves the blocking `waitForInput()`, WebInputProvider checks `hub.isRunning()` = false → delegates to UserInputProvider → terminal prompt appears. A **second ESC** (after serve has exited) triggers normal neglection (interrupt current turn).
   - **WebUI Exit button**: WebSocket sends `{ type: 'exit' }` → same graceful shutdown as ESC. No neglection, no abort. Agent completes current turn naturally.
   - **Ctrl+C**: Existing behavior — kills entire process group. No change needed.

4. **Page close / WebSocket disconnect**: ServeHub starts a 30-second reconnect countdown. During this window, WebInputProvider continues blocking (no abort, no swap). If WebSocket reconnects → countdown cancelled, serve mode continues. If 30s elapse → same graceful shutdown as exit button (warm, no interrupt) → swap back to CLI.

5. **No `/serve off` command**: Only `/serve [port]` to start. Exit is only through the three ways above.

6. **Browser reopen within 30s**: ServeHub maintains a server-side message log. On reconnect, the full history is replayed to the new browser session, restoring the chat record visually.

### Graceful Shutdown Flow (shared by ESC, Exit button, timeout)

All three exit paths perform the same steps:
1. Do NOT set neglectedMode (no interrupt to current operation)
2. Do NOT abort LLM
3. `hub.stop()` — close Express + Vite + WS (internally calls `abortInput()` to wake blocked `waitForInput()`)
4. Clear `outputCallback` / `resultCallback`
5. `process.send({ type: 'serve_mode', active: false })` — notify Coordinator to restore key forwarding

No provider swap needed — WebInputProvider checks `hub.isRunning()` internally and falls back to UserInputProvider when serve is stopped.

After shutdown, two sub-cases:
- **Agent in PROMPT (waiting for input)**: `abortInput()` resolves `waitForInput()` with `null` → WebInputProvider checks `hub.isRunning()` = false → delegates to `UserInputProvider.getInput()` → terminal prompt appears seamlessly.
- **Agent mid-execution (LLM/TOOL)**: No interrupt. Agent completes current turn → returns to PROMPT → `inputProvider.getInput()` → WebInputProvider checks `hub.isRunning()` = false → delegates to UserInputProvider → terminal prompt appears.

---

## Step 1: Add Dependencies

**File**: `package.json`

Add to `dependencies`:
```json
"express": "^4.21.0",
"vue": "^3.5.0",
"ws": "^8.18.0"
```

Add to `devDependencies`:
```json
"@vitejs/plugin-vue": "^5.2.0",
"@types/express": "^4.17.21",
"@types/ws": "^8.5.13",
"vite": "^6.0.0"
```

Run `pnpm install`.

---

## Step 2: ~~Create `SwappableInputProvider`~~ (eliminated)

No wrapper needed. `WebInputProvider` itself handles switching by checking `hub.isRunning()` internally. See Step 4 for the unified design.

---

## Step 3: Create `ServeHub` Singleton

**New file**: `src/serve/serve-hub.ts`

The orchestrator. Manages Express, Vite (middleware mode), WebSocket, input resolution, message log, and disconnect timer.

```typescript
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

export class ServeHub {
  private static instance: ServeHub | null = null;
  static getInstance(): ServeHub { ... }

  private httpServer: http.Server | null = null;
  private expressApp: express.Application | null = null;
  private viteServer: ViteDevServer | null = null;
  private wsServer: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  
  // Input bridge — single resolver, no AbortController needed
  private inputResolver: ((input: string | null) => void) | null = null;
  
  // Message log for reconnect replay
  private messageLog: Array<{ type: string; content: string; timestamp: number }> = [];
  private static readonly MAX_LOG_SIZE = 1000;
  
  // Disconnect-reconnect
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RECONNECT_TIMEOUT_MS = 30_000;
  
  // Mode state
  private running = false;

  // ── Lifecycle ──
  async start(port: number): Promise<void>
  async stop(): Promise<void>  // sets running=false FIRST, then abortInput(), then cleanup
  isRunning(): boolean
  getUrl(): string | null

  // ── Input bridge (called by WebInputProvider) ──
  // Blocks until: WS message arrives, OR stop() calls abortInput()
  waitForInput(): Promise<string | null>
  // Called by WS handler when a message arrives
  submitInput(text: string): void
  // Resolve blocked waitForInput() with null — called by stop()
  abortInput(): void

  // ── Output bridge (called by agentIO) ──
  broadcast(type: string, content: string): void

  // ── WebSocket events ──
  private onWsConnection(ws: WebSocket): void
  private onWsMessage(ws: WebSocket, data: string): void
  private onWsClose(ws: WebSocket): void
  private onWsError(ws: WebSocket, err: Error): void

  // ── Disconnect-reconnect ──
  private startDisconnectTimer(): void
  private cancelDisconnectTimer(): void
  private onDisconnectTimeout(): void

  // ── Graceful shutdown ──
  // Called by: exit button, disconnect timeout, ESC
  private async gracefulShutdown(): Promise<void>
}
```

### `start(port)` key setup:

```typescript
this.expressApp = express();
this.httpServer = http.createServer(this.expressApp);

// Vite in middleware mode, HMR on same http server (single port)
this.viteServer = await createViteServer({
  root: path.resolve(__dirname, '../web'),
  plugins: [vue()],  // @vitejs/plugin-vue for SFC compilation + auto HMR
  server: {
    middlewareMode: true,
    hmr: { server: this.httpServer },
  },
  appType: 'custom',
});

// Use Vite middleware
this.expressApp.use(this.viteServer.middlewares);

// GET / → index.html via Vite transformIndexHtml
this.expressApp.get('/', async (req, res) => {
  const template = fs.readFileSync(path.resolve(__dirname, '../web/index.html'), 'utf-8');
  const html = await this.viteServer.transformIndexHtml('/', template);
  res.send(html);
});

// WebSocket on /ws, on same http server
this.wsServer = new WebSocketServer({ server: this.httpServer, path: '/ws' });
this.wsServer.on('connection', (ws) => this.onWsConnection(ws));

await new Promise<void>((resolve) => this.httpServer.listen(port, resolve));
this.messageLog = []; // clear log on start
this.running = true;
```

### `stop()` — sets running=false FIRST, then aborts input, then cleans up:

```typescript
async stop(): Promise<void> {
  // 1. Set flag first — isRunning() immediately returns false
  this.running = false;
  
  // 2. Wake blocked waitForInput() with null (before server cleanup)
  this.abortInput();
  
  // 3. Cancel any pending disconnect timer
  this.cancelDisconnectTimer();
  
  // 4. Close all WebSocket connections
  for (const ws of this.clients) {
    ws.close();
  }
  this.clients.clear();
  
  // 5. Close WS server
  if (this.wsServer) {
    this.wsServer.close();
    this.wsServer = null;
  }
  
  // 6. Close Vite
  if (this.viteServer) {
    await this.viteServer.close();
    this.viteServer = null;
  }
  
  // 7. Close HTTP server
  if (this.httpServer) {
    await new Promise<void>((resolve) => {
      this.httpServer!.close(() => resolve());
    });
    this.httpServer = null;
  }
  
  this.expressApp = null;
  this.messageLog = [];
}
```

### Input bridge methods:

```typescript
waitForInput(): Promise<string | null> {
  return new Promise((resolve) => {
    this.inputResolver = (input: string | null) => {
      this.inputResolver = null;
      resolve(input);
    };
  });
}

submitInput(text: string): void {
  if (this.inputResolver) {
    this.inputResolver(text);
  }
}

abortInput(): void {
  if (this.inputResolver) {
    this.inputResolver(null);
  }
}
```

No AbortController needed — `abortInput()` directly resolves the blocking promise with `null`.
`stop()` sets `running = false` before calling `abortInput()`, so `WebInputProvider` checks
`hub.isRunning()` = false → falls back to terminal. No race condition.

### `broadcast()` with message log:

```typescript
broadcast(type: string, content: string): void {
  this.messageLog.push({ type, content, timestamp: Date.now() });
  if (this.messageLog.length > ServeHub.MAX_LOG_SIZE) {
    this.messageLog.shift();
  }
  for (const ws of this.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, content }));
    }
  }
}
```

### `onWsConnection()` with history replay:

```typescript
private onWsConnection(ws: WebSocket): void {
  this.clients.add(ws);
  this.cancelDisconnectTimer(); // reconnect cancels 30s timer
  
  // Replay message history to new client
  for (const msg of this.messageLog) {
    ws.send(JSON.stringify(msg));
  }
  
  // Notify client if currently waiting for input
  if (this.inputResolver) {
    ws.send(JSON.stringify({ type: 'prompt', content: '' }));
  }
  
  ws.on('message', (data) => this.onWsMessage(ws, data.toString()));
  ws.on('close', () => this.onWsClose(ws));
  ws.on('error', (err) => this.onWsError(ws, err));
}
```

### WS message handler:

- `{ type: 'input', text }` → `submitInput(text)` — resolves the blocking `waitForInput()`
- `{ type: 'exit' }` → `gracefulShutdown()`
- `{ type: 'interrupt' }` → like ESC: set neglected mode + abort LLM (forwarded to agentIO)

### WS close handler:

- If this was the last client → `startDisconnectTimer()` (30s)
- On WS connect → `cancelDisconnectTimer()` if timer exists

### `gracefulShutdown()` (warm — no neglection, no LLM abort):

Called by: Exit button (`{ type: 'exit' }` WS message), disconnect timeout (30s). ESC uses the same logic but via the agentIO neglection handler (see Step 6c).

```typescript
private async gracefulShutdown(): Promise<void> {
  this.cancelDisconnectTimer();
  await this.stop(); // stop() sets running=false + abortInput() internally
  // No provider swap needed — WebInputProvider checks hub.isRunning()
  // clean up output hooks
  agentIO.setOutputCallback(null);
  setResultCallback(null);
  // notify Coordinator
  process.send({ type: 'serve_mode', active: false });
  console.log(chalk.yellow('\nWeb UI stopped. Terminal input restored.'));
}
```

---

## Step 4: Create `WebInputProvider`

**New file**: `src/serve/web-input-provider.ts`

WebInputProvider is the **sole InputProvider** passed to the state machine. It internally switches between WebSocket and terminal based on `hub.isRunning()`. No wrapper, no swap at runtime.

```typescript
import type { InputProvider } from '../loop/input-provider.js';
import { UserInputProvider } from '../loop/input-provider.js';
import { ServeHub } from './serve-hub.js';

export class WebInputProvider implements InputProvider {
  readonly name = 'web';
  private hub: ServeHub;
  private userProvider: UserInputProvider; // CLI fallback when serve not running

  constructor(hub: ServeHub, userProvider: UserInputProvider) {
    this.hub = hub;
    this.userProvider = userProvider;
  }

  async getInput(initialContent?: string): Promise<string | null> {
    if (!this.hub.isRunning()) {
      // Serve not running — delegate to terminal
      return this.userProvider.getInput(initialContent);
    }
    // Serve running — wait for WebSocket input
    this.hub.broadcast('prompt', initialContent || '');
    const result = await this.hub.waitForInput();
    // After await, check if serve was stopped during the wait
    // (ESC/exit/timeout called abortInput() which resolved waitForInput)
    if (!this.hub.isRunning()) {
      // Serve exited while we were waiting — fall back to terminal
      return this.userProvider.getInput(initialContent);
    }
    return result;
  }

  async promptRetry(errorMessage: string): Promise<boolean> {
    if (!this.hub.isRunning()) {
      return this.userProvider.promptRetry(errorMessage);
    }
    this.hub.broadcast('error', `Error: ${errorMessage}`);
    this.hub.broadcast('prompt', 'Retry? [Y/n]');
    const answer = await this.hub.waitForInput();
    if (!this.hub.isRunning()) {
      return this.userProvider.promptRetry(errorMessage);
    }
    return answer.toLowerCase() !== 'n' && answer.toLowerCase() !== 'no';
  }
}
```

---

## Step 5: Create `serve-registry.ts`

**New file**: `src/serve/serve-registry.ts`

Module-level singleton for ServeHub access only. No UserInputProvider reference needed — WebInputProvider holds its own `userProvider` reference internally.

```typescript
import { ServeHub } from './serve-hub.js';

let serveHub: ServeHub | null = null;

export function getServeHub(): ServeHub {
  if (!serveHub) serveHub = ServeHub.getInstance();
  return serveHub;
}
```

---

## Step 5b: Create `activate.ts` (shared serve activation)

**New file**: `src/serve/activate.ts`

Shared logic used by both `/serve` slash command and `--serve` CLI flag. Eliminates duplication:

```typescript
import { getServeHub } from './serve-registry.js';
import { agentIO } from '../loop/agent-io.js';
import { setResultCallback } from '../utils/letter-box.js';
import chalk from 'chalk';

export async function activateServe(port: number): Promise<void> {
  const hub = getServeHub();
  
  if (hub.isRunning()) {
    console.log(chalk.yellow(`Web UI already running at ${hub.getUrl()}`));
    return;
  }
  
  // Start Express + Vite + WS
  await hub.start(port);
  
  // Set up output mirroring to WebSocket
  agentIO.setOutputCallback((method, args) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    hub.broadcast(method, text);
  });
  setResultCallback((content) => hub.broadcast('result', content));
  
  // Notify Coordinator that serve mode is active (filter stdin)
  process.send({ type: 'serve_mode', active: true });
  
  console.log(chalk.cyan(`\n🌐 Web UI started at ${hub.getUrl()}`));
  console.log(chalk.gray('Terminal input disabled. Press ESC to return to CLI, or use the exit button in the web UI.'));
}
```

**Modify file**: `src/loop/agent-io.ts`

### 6a. Add output callback:

```typescript
private outputCallback: ((method: 'log'|'warn'|'error', args: unknown[]) => void) | null = null;

setOutputCallback(cb: ((method: 'log'|'warn'|'error', args: unknown[]) => void) | null): void {
  this.outputCallback = cb;
}
```

In `log()`, `warn()`, `error()` — after existing logic (console call or buffer), add:
```typescript
if (this.outputCallback) {
  this.outputCallback(method, args);
}
```

In `brief()` — after existing logic, also call:
```typescript
if (this.outputCallback) {
  this.outputCallback(level, [message]);
}
```

### 6b. Web-mode `ask()`:

Add an early check. If `ServeHub.getInstance().isRunning()`, bypass LineEditor entirely — route via WebSocket:

```typescript
async ask(query: string, useAsPrompt: boolean = false, initialContent?: string): Promise<string> {
  // Serve mode: route via WebSocket
  if (getServeHub().isRunning()) {
    if (!useAsPrompt) {
      getServeHub().broadcast('log', query);
    }
    return getServeHub().waitForInput();
  }
  // ... original LineEditor code ...
}
```

### 6c. Serve-mode ESC handler:

In the IPC message handler's neglection block, add serve mode detection. ESC in serve mode is a **warm exit** — no neglectedMode, no LLM abort:

```typescript
if (msg.type === 'neglection') {
  // ... existing LineEditor check ...
  
  // Serve mode: ESC → warm exit (stop serve, no neglection)
  if (getServeHub().isRunning()) {
    const hub = getServeHub();
    hub.stop(); // fire-and-forget — stop() sets running=false + abortInput() internally
    // No provider swap needed — WebInputProvider checks hub.isRunning()
    agentIO.setOutputCallback(null);
    setResultCallback(null);
    process.send({ type: 'serve_mode', active: false });
    return; // skip standard neglection — do NOT set neglectedMode
  }
  
  // Standard neglection (serve not running, or already exited)
  if (!this.isNeglectedMode()) {
    this.setNeglectedMode(true);
    // ... existing abort + callback processing ...
  }
}
```

---

## Step 7: Hook Result Output in `letter-box.ts`

**Modify file**: `src/utils/letter-box.ts`

Add optional result callback:
```typescript
let resultCallback: ((content: string) => void) | null = null;
export function setResultCallback(cb: ((content: string) => void) | null): void { resultCallback = cb; }
```

In `displayLetterBox()` — after existing stdout writes, add:
```typescript
resultCallback?.(stripped);
```

---

## Step 8: Modify `agent-repl.ts`

**Modify file**: `src/loop/agent-repl.ts`

### 8a. Use WebInputProvider as the sole InputProvider:

Change:
```typescript
const inputProvider = new UserInputProvider(() => (ctx.core as Core).getMode());
```
To:
```typescript
import { WebInputProvider } from '../serve/web-input-provider.js';
import { getServeHub } from '../serve/serve-registry.js';

const userInputProvider = new UserInputProvider(() => (ctx.core as Core).getMode());
const inputProvider = new WebInputProvider(getServeHub(), userInputProvider);
```

No swap calls needed anywhere — WebInputProvider checks `hub.isRunning()` internally.

### 8b. Handle `--serve` at startup:

After `process.send({ type: 'ready' })`, before the state machine loop:
```typescript
import { shouldServe, getServePort } from '../config.js';
import { activateServe } from '../serve/activate.js';

if (shouldServe()) {
  await activateServe(getServePort());
}
```

---

## Step 9: Create `/serve` Slash Command

**New file**: `src/slashes/serve.ts`

```typescript
import type { SlashCommand } from '../types.js';
import { activateServe } from '../serve/activate.js';

export const serveCommand: SlashCommand = {
  name: 'serve',
  description: 'Start web chat UI. Usage: /serve [port]',
  handler: async (context) => {
    const portArg = context.args[1];
    const port = parseInt(portArg) || 3173;
    await activateServe(port);
  },
};
```

**Modify file**: `src/slashes/index.ts` — import and register:
```typescript
import { serveCommand } from './serve.js';
slashRegistry.register(serveCommand);
```

---

## Step 10: Handle Serve Mode in `index.ts` (Coordinator)

**Modify file**: `src/index.ts`

### 10a. Add serve mode state:

```typescript
let serveMode = false;
```

### 10b. Initialize from `--serve` CLI flag (no IPC needed for startup):

```typescript
import { shouldServe } from './config.js';

if (shouldServe()) {
  serveMode = true; // Coordinator knows from the start
}
```

This covers the `--serve` startup path. The `/serve` slash command path uses IPC (see 10c).

### 10c. Handle `serve_mode` IPC (for `/serve` command):

In child message handler:
```typescript
child.on('message', (msg: CoordinatorMessage) => {
  if (msg.type === 'serve_mode') {
    serveMode = msg.active;
    return;
  }
  // ... existing handlers ...
});
```

Extend `CoordinatorMessage` type:
```typescript
type CoordinatorMessage =
  | { type: 'ready' }
  | { type: 'restart'; sessionId: string; cwd: string }
  | { type: 'exit' }
  | { type: 'serve_mode'; active: boolean };
```

### 10d. Filter stdin in serve mode:

In the stdin data handler, add serve mode filtering:
```typescript
process.stdin.on('data', (data: Buffer) => {
  // Ctrl+C — always works
  if (isCtrlC(data)) { ... existing ... }
  
  // ESC — always works (serve and non-serve mode)
  if (isEscape(data)) {
    lead?.send({ type: 'neglection' });
    return;
  }
  
  // Serve mode: silently drop all other keys
  if (serveMode) {
    return;
  }
  
  // ... existing key forwarding ...
});
```

Note: `serveMode` in Coordinator is an optimization (avoids unnecessary IPC forwarding).
The real safety boundary is in Lead: when serve is running, WebInputProvider does not
create a LineEditor, so forwarded keys have no receiver and are silently dropped.

### 10e. Reset serve mode on restart:

In `restart()`:
```typescript
async function restart(sessionId: string, cwd: string): Promise<void> {
  serveMode = false; // serve does not survive restart
  // ... existing restart logic ...
}
```

ServeHub is a Lead-process singleton — a new Lead process starts fresh.
The old Lead's Express/Vite/WS servers close when the process exits.

---

## Step 11: Add `--serve` CLI Flag

**Modify file**: `src/config.ts`

Add `'serve'` to minimist boolean array.
```typescript
export function shouldServe(): boolean {
  return args.serve === true;
}
export function getServePort(): number {
  return parseInt(args.port) || 3173;
}
```

---

## Step 12: Create Web UI (Vue 3 SFC + TypeScript)

### 12a. File structure

```
src/web/
├── index.html                     # Vite entry HTML
└── src/
    ├── main.ts                    # Entry (HMR-persistent layer — never hot-replaced)
    │                              # Creates Vue app, manages WebSocket, owns reactive state
    ├── App.vue                    # Root component (layout: StatusBar + ChatLog + ChatInput)
    ├── types.ts                   # Shared type definitions
    └── components/
        ├── StatusBar.vue          # Top bar: connection indicator + title + Exit button + Retry button
        ├── ChatLog.vue            # Message list (scroll container, smart auto-scroll, floating button)
        ├── MessageItem.vue        # Single message bubble (colored by type, left/right aligned)
        └── ChatInput.vue          # Input area (textarea + Send button)
```

### 12b. HMR boundary

```
main.ts           ← Not hot-replaced (HMR-persistent layer)
  ├── createApp(App) mounts Vue
  ├── Owns WebSocket connection (module-level variable, not in any component)
  ├── Owns reactive state (messages, inputText, connectionStatus, showRetry)
  └── WebSocket.onmessage → state.messages.push(msg)
      ↓
App.vue           ← Vue auto HMR (state preserved, render replaced)
  ├── StatusBar.vue    ← Vue auto HMR
  ├── ChatLog.vue      ← Vue auto HMR
  │   └── MessageItem.vue  ← Vue auto HMR
  └── ChatInput.vue    ← Vue auto HMR
```

Vue's built-in HMR (via `@vitejs/plugin-vue`) automatically preserves component state (`ref`/`reactive` values) and only replaces the render function. WebSocket connection and reactive state live in `main.ts` (never hot-replaced). This makes "editing webui while webui is running" safe.

### 12c. `src/web/index.html`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>mycc chat</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

### 12d. `src/web/src/types.ts`

```typescript
export type MessageType = 'user' | 'log' | 'warn' | 'error' | 'result' | 'prompt' | 'system';

export interface ChatMessage {
  type: MessageType;
  content: string;
  timestamp?: number;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

export interface ChatState {
  messages: ChatMessage[];
  inputText: string;
  isWaiting: boolean;
  connectionStatus: ConnectionStatus;
  showRetry: boolean; // true when a retry prompt is pending (network failure)
}
```

### 12e. `src/web/src/main.ts` — Entry point (HMR-persistent)

```typescript
import { createApp, reactive } from 'vue';
import App from './App.vue';
import type { ChatMessage, ChatState } from './types';

// Reactive state — survives HMR (module-level, not in any component)
const state = reactive<ChatState>({
  messages: [],
  inputText: '',
  isWaiting: false,
  connectionStatus: 'disconnected',
  showRetry: false,
});

// WebSocket — survives HMR (module-level)
let ws: WebSocket | null = null;

function connectWebSocket() {
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.onopen = () => {
    state.connectionStatus = 'connected';
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data) as ChatMessage;
    state.messages.push(msg);
    state.isWaiting = (msg.type === 'prompt');
    if (msg.type === 'prompt' && msg.content.includes('Retry')) {
      state.showRetry = true;
    }
  };

  ws.onclose = () => {
    state.connectionStatus = 'reconnecting';
    // Server-side 30s timer handles reconnect/restore
  };
}

connectWebSocket();

// Expose for components (send messages, exit, retry)
export const chatApi = {
  sendInput(text: string) {
    ws?.send(JSON.stringify({ type: 'input', text }));
  },
  sendExit() {
    ws?.send(JSON.stringify({ type: 'exit' }));
  },
  sendRetry(answer: string) {
    state.showRetry = false;
    ws?.send(JSON.stringify({ type: 'input', text: answer }));
  },
};

// Create Vue app
createApp(App, { state }).mount('#app');
```

### 12f. `src/web/src/App.vue`

```vue
<script setup lang="ts">
import { type ChatState } from './types';
import StatusBar from './components/StatusBar.vue';
import ChatLog from './components/ChatLog.vue';
import ChatInput from './components/ChatInput.vue';

defineProps<{ state: ChatState }>();
</script>

<template>
  <div class="app-container">
    <StatusBar :state="state" />
    <ChatLog :messages="state.messages" />
    <ChatInput :state="state" />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #ededed; /* WeChat background gray */
}
</style>
```

### 12g. `src/web/src/components/StatusBar.vue`

WeChat-style top bar with connection indicator, title, exit button, and conditional retry button.

```vue
<script setup lang="ts">
import { type ChatState } from '../types';
import { chatApi } from '../main';

defineProps<{ state: ChatState }>();
</script>

<template>
  <div class="status-bar">
    <div class="status-left">
      <span class="status-dot" :class="state.connectionStatus"></span>
      <span class="status-text">{{ statusText }}</span>
    </div>
    <div class="status-center">mycc chat</div>
    <div class="status-right">
      <button v-if="state.showRetry" class="retry-btn" @click="onRetry">Retry</button>
      <button class="exit-btn" @click="chatApi.sendExit">退出</button>
    </div>
  </div>
</template>

<script lang="ts">
import { computed } from 'vue';

const props = defineProps<{ state: ChatState }>();

const statusText = computed(() => {
  switch (props.state.connectionStatus) {
    case 'connected': return '已连接';
    case 'reconnecting': return '重连中…';
    default: return '未连接';
  }
});

function onRetry() {
  chatApi.sendRetry('y');
}
</script>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: #2e2e2e;
  color: #fff;
  font-size: 14px;
  flex-shrink: 0;
}
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}
.status-dot.connected { background: #07c160; }
.status-dot.reconnecting { background: #faad14; }
.status-dot.disconnected { background: #ff4d4f; }
.status-center { font-weight: 600; }
.retry-btn {
  background: #faad14;
  color: #000;
  border: none;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  margin-right: 8px;
  font-size: 12px;
}
.exit-btn {
  background: #ff4d4f;
  color: #fff;
  border: none;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
</style>
```

### 12h. `src/web/src/components/ChatLog.vue`

WeChat-style message list. **Smart auto-scroll**: only auto-scrolls when the user is already at the bottom. When scrolled up, a floating "scroll to bottom" button appears.

```vue
<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue';
import { type ChatMessage } from '../types';
import MessageItem from './MessageItem.vue';

const props = defineProps<{ messages: ChatMessage[] }>();

const scrollContainer = ref<HTMLElement | null>(null);
const showScrollButton = ref(false);
let userScrolledUp = false;

function isAtBottom(): boolean {
  const el = scrollContainer.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
}

function scrollToBottom() {
  const el = scrollContainer.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
    userScrolledUp = false;
    showScrollButton.value = false;
  }
}

function onScroll() {
  if (isAtBottom()) {
    showScrollButton.value = false;
    userScrolledUp = false;
  } else {
    userScrolledUp = true;
    showScrollButton.value = true;
  }
}

// Watch for new messages — auto-scroll only if user is at bottom
watch(() => props.messages.length, () => {
  if (!userScrolledUp) {
    nextTick(() => scrollToBottom());
  }
});

onMounted(() => {
  scrollToBottom();
});
</script>

<template>
  <div class="chat-log" ref="scrollContainer" @scroll="onScroll">
    <MessageItem
      v-for="(msg, i) in messages"
      :key="i"
      :message="msg"
    />
  </div>
  <div v-if="showScrollButton" class="scroll-bottom-btn" @click="scrollToBottom">
    ↓
  </div>
</template>

<style scoped>
.chat-log {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  background: #ededed;
}
.scroll-bottom-btn {
  position: absolute;
  bottom: 80px;
  right: 24px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 18px;
  color: #07c160;
  z-index: 10;
}
</style>
```

### 12i. `src/web/src/components/MessageItem.vue`

WeChat-style message bubbles. User messages (right-aligned, green), agent messages (left-aligned, white). Different types get distinct colors.

```vue
<script setup lang="ts">
import { type ChatMessage } from '../types';
import { computed } from 'vue';

const props = defineProps<{ message: ChatMessage }>();

const isUser = computed(() => props.message.type === 'user');
const bubbleClass = computed(() => {
  switch (props.message.type) {
    case 'user': return 'bubble-user';
    case 'error': return 'bubble-error';
    case 'result': return 'bubble-result';
    case 'prompt': return 'bubble-prompt';
    case 'system': return 'bubble-system';
    case 'warn': return 'bubble-warn';
    default: return 'bubble-log';
  }
});
</script>

<template>
  <div class="message-row" :class="isUser ? 'row-right' : 'row-left'">
    <div class="message-bubble" :class="bubbleClass">
      {{ message.content }}
    </div>
  </div>
</template>

<style scoped>
.message-row {
  display: flex;
  margin-bottom: 12px;
}
.row-left { justify-content: flex-start; }
.row-right { justify-content: flex-end; }
.message-bubble {
  max-width: 70%;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble-user {
  background: #95ec69; /* WeChat green */
  color: #000;
}
.bubble-log {
  background: #fff;
  color: #333;
}
.bubble-error {
  background: #fff2f0;
  color: #ff4d4f;
  border: 1px solid #ffccc7;
}
.bubble-result {
  background: #e6f7ff;
  color: #1890ff;
  border-left: 3px solid #1890ff;
}
.bubble-prompt {
  background: #f0f0f0;
  color: #888;
  font-style: italic;
}
.bubble-system {
  background: transparent;
  color: #999;
  font-style: italic;
  text-align: center;
  max-width: 100%;
}
.bubble-warn {
  background: #fffbe6;
  color: #faad14;
  border: 1px solid #ffe58f;
}
</style>
```

### 12j. `src/web/src/components/ChatInput.vue`

WeChat-style input area. textarea + Send button. Enter to send, Shift+Enter for newline. Input text persists via `state.inputText` (survives HMR).

```vue
<script setup lang="ts">
import { type ChatState } from '../types';
import { chatApi } from '../main';

const props = defineProps<{ state: ChatState }>();

function send() {
  const text = props.state.inputText.trim();
  if (!text) return;
  props.state.inputText = '';
  props.state.messages.push({ type: 'user', content: text });
  chatApi.sendInput(text);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="chat-input-area">
    <textarea
      v-model="state.inputText"
      class="chat-input"
      placeholder="输入消息…"
      @keydown="onKeydown"
      :disabled="state.showRetry"
    ></textarea>
    <button class="send-btn" @click="send" :disabled="state.showRetry">发送</button>
  </div>
</template>

<style scoped>
.chat-input-area {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  background: #f5f5f5;
  border-top: 1px solid #d9d9d9;
  flex-shrink: 0;
}
.chat-input {
  flex: 1;
  height: 60px;
  padding: 8px 12px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  resize: none;
  font-size: 14px;
  font-family: inherit;
  outline: none;
}
.chat-input:focus { border-color: #07c160; }
.send-btn {
  padding: 8px 20px;
  background: #07c160;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  align-self: flex-end;
}
.send-btn:disabled { background: #ccc; cursor: not-allowed; }
</style>
```

---

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add express, vite, ws dependencies |
| `src/config.ts` | Modify | Add `--serve` flag parsing |
| `src/index.ts` | Modify | serve_mode IPC handler, stdin filtering |
| `src/loop/agent-io.ts` | Modify | outputCallback, web-mode ask(), serve-mode ESC |
| `src/utils/letter-box.ts` | Modify | resultCallback hook |
| `src/loop/agent-repl.ts` | Modify | SwappableInputProvider, registry, --serve handling |
| `src/slashes/index.ts` | Modify | Register /serve |
| `src/serve/serve-hub.ts` | **New** | Express + Vite + WebSocket orchestrator |
| `src/serve/web-input-provider.ts` | **New** | InputProvider bridging WS↔state machine, auto-switches via hub.isRunning() |
| `src/serve/serve-registry.ts` | **New** | ServeHub singleton accessor |
| `src/serve/activate.ts` | **New** | Shared activateServe() used by /serve and --serve |
| `src/slashes/serve.ts` | **New** | /serve slash command (delegates to activateServe) |
| `src/web/index.html` | **New** | Vite entry HTML |
| `src/web/src/main.ts` | **New** | Entry point (HMR-persistent, owns WebSocket + reactive state) |
| `src/web/src/App.vue` | **New** | Root component (StatusBar + ChatLog + ChatInput layout) |
| `src/web/src/types.ts` | **New** | Shared TypeScript type definitions |
| `src/web/src/components/StatusBar.vue` | **New** | Top bar: connection indicator + title + Exit + Retry button |
| `src/web/src/components/ChatLog.vue` | **New** | Message list with smart auto-scroll + floating button |
| `src/web/src/components/MessageItem.vue` | **New** | WeChat-style message bubble (colored by type) |
| `src/web/src/components/ChatInput.vue` | **New** | Input area (textarea + Send button) |

---

## Implementation Order

1. **Dependencies** → `pnpm install`
2. **Core bridges** → `serve-registry.ts`, `web-input-provider.ts`, `activate.ts`
3. **Orchestrator** → `serve-hub.ts` with Express+Vite+WS+message log+reconnect
4. **Output hooks** → modify `agent-io.ts`, `letter-box.ts`
5. **Wiring** → modify `agent-repl.ts` (WebInputProvider, --serve startup)
6. **Slash command** → `src/slashes/serve.ts` + register
7. **Coordinator** → modify `index.ts` (serve_mode filtering)
8. **CLI flag** → `config.ts`
9. **Web UI** → `index.html`, `main.ts`, `App.vue`, components
10. **Test** → run `mycc`, type `/serve`, open browser, send message, verify HMR by editing components, test exit/ESC/reconnect

---

## Key Design Decisions

- **WebInputProvider is the sole InputProvider**: no wrapper, no runtime swap. It checks `hub.isRunning()` internally — when serve is active, it reads from WebSocket; when serve is stopped, it delegates to UserInputProvider (terminal). State machine code unchanged.
- **ServeHub is a singleton**: always exists, but `.isRunning()` gates behavior.
- **Vite middleware mode**: single port for HTTP + WebSocket + HMR. `hmr: { server: httpServer }` ensures HMR WS uses the same port.
- **HMR robustness**: state + WebSocket stored on `window.*` outside `main.js`. Only `chat.js` (render logic) is hot-reloadable.
- **Stdin filtering in Coordinator**: Coordinator receives `serve_mode` IPC from Lead, then filters all keys except ESC and Ctrl+C.
- **30s reconnect window**: last client disconnect starts timer; reconnect cancels it; timeout triggers graceful shutdown. Agent continues processing during the window (WebInputProvider only blocks when getInput() is called, not mid-turn).
- **Message log replay**: ServeHub keeps a capped (1000) message log. On reconnect, full history is replayed to the new browser, restoring the chat record.