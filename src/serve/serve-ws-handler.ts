/**
 * serve-ws-handler.ts - WebSocket inbound message dispatch
 *
 * Extracted from ServeHub.onWsMessage. The switch/case that routes an incoming
 * client WS message to the right hub method lives here as a free function
 * `handleWsMessage(hub, ws, data)`. The hub implements {@link HubHandler} so
 * this module has a narrow, mockable dependency surface — no Express, Vite, or
 * agent-io graph needed to reason about the dispatch logic.
 *
 * This is also where multi-browser user-bubble sync is applied: the 'input'
 * and 'steer' cases broadcast a `type:'user'` message to all OTHER clients
 * via `hub.broadcastExcept(ws, 'user', text)` so a query typed in one browser
 * appears live in every other connected browser (the sending client already
 * has a local optimistic echo via sendInput/sendSteer in main.ts).
 */
import { WebSocket } from 'ws';
import { agentIO } from '../loop/agent-io.js';
import { autoState } from '../loop/auto-state.js';
import type { WsMessage, FileUploadEntry } from './serve-types.js';

/**
 * The subset of ServeHub the WS handler needs. Kept minimal so the dispatch
 * logic is unit-testable with a stub.
 */
export interface HubHandler {
  submitInput(text: string): void;
  submitCardResponse(cardId: string, value: string): void;
  pushSteer(text: string): void;
  pushFileUpload(entry: FileUploadEntry): void;
  resolveSteering(sendIds: number[]): void;
  gracefulShutdown(): Promise<void>;
  broadcast(type: string, content: string, label?: string): void;
  /**
   * Broadcast a message to all clients EXCEPT the sender. Used for user-bubble
   * sync across multiple browsers.
   */
  broadcastExcept(sender: WebSocket, type: string, content: string, label?: string): void;
  /** Current auto-mode flag (from the registered provider). */
  getAutoState(): boolean;
  /** Run the combined auto-mode entry; return true if it actually flipped on. */
  enterAuto(): boolean;
}

/**
 * Parse and route a single inbound WS message from `ws`.
 *
 * @param hub  - the ServeHub (implements HubHandler)
 * @param ws   - the sending socket (used to exclude it from user-bubble echo)
 * @param data - raw message string
 */
export function handleWsMessage(hub: HubHandler, ws: WebSocket, data: string): void {
  let msg: WsMessage;
  try {
    msg = JSON.parse(data) as WsMessage;
  } catch {
    return; // ignore malformed messages
  }

  switch (msg.type) {
    case 'input': {
      // Files attached with NO comment arrive as { text: undefined, files: [...] }
      // (the frontend sends `text: text || undefined`, so an empty comment
      // becomes undefined). Without a text branch that resolves the blocked
      // waitForInput(), the loop would NEVER start: submitInput() would be
      // skipped, the PROMPT wait would stay blocked, and the uploaded file
      // would sit stranded in the file queue (only drained during a loop
      // that never begins). The frontend also optimistically flips
      // isWaiting=false on send, so the user's NEXT message then routes
      // through sendSteer (buffered) instead of sendInput — everything
      // buffers and nothing runs.
      //
      // Fix: when files are present but text is empty/undefined, submit a
      // non-empty placeholder so waitForInput() resolves and the loop
      // starts. The PROMPT handler drains fileUploads separately and injects
      // a [REMINDER] listing each saved file, so the LLM still sees the
      // upload — the placeholder only needs to be non-empty to drive the
      // loop. A real comment (non-empty text) is submitted verbatim.
      const hasFiles = msg.files !== undefined && msg.files.length > 0;
      const textToSend = msg.text !== undefined && msg.text.trim() !== ''
        ? msg.text
        : (hasFiles ? '(uploaded files)' : undefined);
      if (textToSend !== undefined) {
        hub.submitInput(textToSend);
        // Multi-browser sync: echo the user bubble to all OTHER clients so a
        // query typed in one browser appears live in every other connected
        // browser. The sending client already has a local optimistic echo.
        hub.broadcastExcept(ws, 'user', textToSend);
      }
      if (hasFiles) {
        for (const f of msg.files!) {
          hub.pushFileUpload({ filename: f.filename, data: f.data, mimeType: f.mimeType, text: msg.text });
        }
      }
      break;
    }
    case 'exit':
      hub.gracefulShutdown().catch((err) => {
        agentIO.verbose('serve', `exit shutdown error: ${String(err)}`);
      });
      break;
    case 'interrupt':
      // Like ESC — forward to agentIO neglection handler.
      // triggerNeglection() runs the same neglection logic the Coordinator
      // IPC 'neglection' message would (see agent-io.ts Step 6c).
      agentIO.triggerNeglection();
      break;
    case 'card-response':
      if (msg.cardId !== undefined && msg.value !== undefined) {
        hub.submitCardResponse(msg.cardId, msg.value);
      }
      break;
    case 'steer':
      // Steering note from the web UI while the LLM is working.
      // Buffered in the steering queue; drained at COLLECT (REMINDER note)
      // or PROMPT (forkChat synthesis with fresh query).
      if (msg.text) {
        hub.pushSteer(msg.text);
        // Multi-browser sync: echo the steering user bubble to all OTHER
        // clients (in addition to the steer-echo buffer-bar broadcast inside
        // pushSteer). The sending client already has a local optimistic echo.
        hub.broadcastExcept(ws, 'user', msg.text);
      }
      if (msg.files && msg.files.length > 0) {
        for (const f of msg.files) {
          hub.pushFileUpload({ filename: f.filename, data: f.data, mimeType: f.mimeType, text: msg.text });
        }
      }
      break;
    case 'steer-resolve':
      // Boomerang resolve: the client declares which steering note ids to
      // SEND; everything not declared is implicitly discarded. Atomically
      // drains the whole queue so PROMPT never re-synthesizes these notes.
      hub.resolveSteering(msg.sendIds ?? []);
      break;
    case 'auto':
      // One-way "enter auto mode" request from the webui lightning bolt
      // button. If already in auto mode, tell the client so it can surface
      // "已经是自动模式了"; otherwise run the combined entry (autoState
      // singleton, which both Core and AgentIO delegate to) registered by
      // agent-repl. Falls back to flipping autoState directly when no
      // provider is registered (e.g. serve started before the agent loop
      // wired the callback) so the flag still flips. The streak is reset
      // so this manual entry doesn't immediately count toward a re-autofly.
      if (hub.getAutoState()) {
        hub.broadcast('warn', '已经是自动模式了', 'serve');
      } else if (!hub.enterAuto()) {
        // No enterAutoProvider registered — flip autoState directly so the
        // flag still flips (e.g. serve started before the agent loop wired it).
        autoState.resetStreak();
        autoState.setAuto(true);
      }
      break;
  }
}