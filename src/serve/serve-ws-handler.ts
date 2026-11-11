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
  /** Recycle the HTTP/Vite/WS stack in-process on the same port. */
  restartServe(): Promise<void>;
  broadcast(type: string, content: string, label?: string): void;
  /**
   * Broadcast a message to all clients EXCEPT the sender. Used for user-bubble
   * sync across multiple browsers.
   */
  broadcastExcept(sender: WebSocket, type: string, content: string, label?: string): void;
  /** Current auto-mode flag (from the registered provider). */
  getAutoState(): boolean;
  /**
   * The bound transcript writer, or null when none is registered yet.
   *
   * The 'input' echo gates on this: with a writer bound, the journaled user
   * record is the durable copy and an extra echo would be a duplicate; with no
   * writer the echo is the only acknowledgement other browsers ever get.
   */
  getDisplayWriter(): unknown;
  /** Run the combined auto-mode entry; return true if it actually flipped on. */
  enterAuto(): boolean;
  /**
   * The LIVE auto-commit allow-list, encoded (`branch`
   * | `branch:autoAdd`). Answers `auto-commit-get`. `null` when no provider is
   * registered (a stub hub, or serve without the agent loop) — distinct from
   * `[]`, which is a real deny-all.
   */
  getAutoCommitBranches(): string[] | null;
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
      const textToSend =
        msg.text !== undefined && msg.text.trim() !== '' ? msg.text : hasFiles ? '(uploaded files)' : undefined;
      if (textToSend !== undefined) {
        hub.submitInput(textToSend);
        // Multi-browser sync: echo the user bubble to all OTHER clients so a
        // query typed in one browser appears live in every other connected
        // browser. The sending client already has a local optimistic echo.
        //
        // GATED, not unconditional: `submitInput()` only resolves the blocked
        // waitForInput() promise, and the matching journal record is written
        // much later (prompt.ts, after wrap-up evaluation, the steering
        // synthesis round-trip and the per-file upload drain) — seconds on a
        // slow provider. Until that record lands, this echo is the ONLY
        // acknowledgement other browsers have, so deleting it would trade a
        // duplicate for a multi-second silence. With a display writer bound the
        // journaled row is coming and the echo would be that duplicate.
        //
        // The echo is a transient OPTIMISTIC AFFORDANCE, not a data path: it
        // carries no `seq`, so the next /history snapshot discards it by
        // construction. Do not "fix" its disappearance after a reload by
        // re-adding a second data path — the journaled row is the durable copy.
        if (hub.getDisplayWriter() === null) {
          hub.broadcastExcept(ws, 'user', textToSend);
        }
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
    case 'restart-webui':
      // Recycle the HTTP/Vite/WS stack in-process, on the same port. Sent
      // only by a client that read `persistent: true` from /config (Section 5).
      // Never sent in a terminal session — the WebUI renders 退出 there, not
      // 重启. Distinct from 'exit' (which is the real "done with this session"
      // path used by an interactive terminal).
      hub.restartServe().catch((err) => {
        agentIO.verbose('serve', `restart-webui error: ${String(err)}`);
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
        // NO echo here: `pushSteer` journals SYNCHRONOUSLY (it calls
        // journalUserSubmission → triologue → writer → display observer before
        // returning), so the seq-carrying row reaches every other browser on
        // this very tick. An additional broadcastExcept echo would be a second,
        // seq-less copy of the same bubble in those browsers.
        //
        // Contrast the 'input' path above, where the journal write is delayed by
        // an LLM turn and the echo is load-bearing. The two sites look alike and
        // are NOT interchangeable; the unconditional pair was the defect.
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
    case 'auto-commit-get':
      // The 魔法查询 dialog reads the live allow-list before letting the user
      // edit it. Answered only to the asking socket: it is a read the client
      // requested, not a state broadcast. `null` means "no provider is
      // installed" — deliberately distinct from `[]` (deny-all), because the
      // dialog must not render "nothing is allow-listed" for a hub that simply
      // has no agent loop behind it.
      {
        const branches = hub.getAutoCommitBranches();
        // Echo the caller's request id so a client can tell its OWN reply
        // from a broadcast, and from a reply to an earlier read — without it,
        // a stale answer can repaint rows the user has already acted on.
        // Coerced to a string: the client correlates with `!==` against its own
        // string id, so a non-string echo would silently drop a valid reply.
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
        const payload = JSON.stringify({ type: 'auto-commit', branches, requestId });
        try {
          ws.send(payload);
        } catch {
          // The socket died between the read and the reply — nothing to do.
        }
      }
      break;
    // NOTE: there is deliberately NO 'auto-commit-set'. The allow-list is
    // edited through the SLASH command (`/auto-commit on|off|off --all`),
    // which is the same single write path the terminal uses, so there is
    // exactly one writer and one broadcast (AutoState's change callback). A
    // WS "replace the whole list" op was removed because nothing ever sent
    // it, while ANY connected client could invoke it to wipe a launch-seeded
    // `--allow-auto-commit` grant with an exact replace — an unused,
    // unauthenticated destructive write is not a surface worth keeping.
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
