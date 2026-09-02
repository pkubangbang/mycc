/**
 * agent-io.ts - I/O state management singleton for agent loop
 *
 * Manages LineEditor lifecycle and signal propagation.
 *
 * Note: stdin is handled by the Coordinator process via IPC, not by this module.
 * LineEditor receives key events via IPC and manipulates stdout directly.
 */

import { LineEditor } from '../utils/line-editor.js';
import type { KeyInfo } from '../utils/key-parser.js';
import { getWrapUpState, tryDisplayWrapUp } from './esc-wrap-up.js';
import chalk from 'chalk';
import { isVerbose } from '../config.js';
import { getToolColor } from '../utils/tool-colors.js';
import { slashRegistry } from '../slashes/index.js';
import { getServeHub } from '../serve/serve-registry.js';
import { autoState } from './auto-state.js';
import { setResultCallback } from '../utils/letter-box.js';
import { runExec } from './agent-exec.js';
import type { ExecOptions, ExecResult } from './agent-exec.js';

/**
 * Error used to reject a blocked {@link AgentIO.ask} (terminal) or
 * {@link ServeHub.waitForInput} (serve) Promise when an external event —
 * currently a peer channel joining — must abort the PROMPT wait and
 * redirect the loop to WAIT without prompting the user.
 *
 * Throwing (rejecting) rather than resolving with a sentinel keeps the
 * PROMPT state handler's listener as a plain `catch` block: it catches
 * this typed error and returns `AgentState.WAIT`, re-throwing anything
 * else so genuine failures still surface. The class is exported so prompt.ts
 * can do an `instanceof` check.
 *
 * Named for its purpose (aborting the PROMPT wait) rather than its sole
 * current trigger (channel join), so future wake events can reuse it
 * without a misnamed error.
 */
export class PromptAbortError extends Error {
  constructor(message = 'PROMPT wait aborted by an external event') {
    super(message);
    this.name = 'PromptAbortError';
  }
}

/**
 * Output callback type — mirrors console output to the web UI (WebSocket).
 * Called by log/warn/error/brief when serve mode is active.
 * @param method - console method ('log' | 'warn' | 'error')
 * @param args - raw console args (may contain chalk/ANSI codes)
 * @param label - optional tool/module tag (e.g. 'bash', 'brief', 'question').
 *               brief() passes its `tool` arg so the web UI can show the same
 *               [HH:MM:SS] [tool] header as the terminal. Plain log/warn/error
 *               leave it undefined (treated as a raw verbose log line).
 */
type OutputCallback = (method: 'log' | 'warn' | 'error', args: unknown[], label?: string, detail?: string) => void;

/**
 * Subcommand hints for slash commands.
 * Keyed by command name — displayed after the user types "<command> ".
 * Commands not listed here have no subcommand hints.
 */
const COMMAND_SUBCOMMANDS: Record<string, string[]> = {
  wiki:      ['edit [date]', 'rebuild', 'delete <hash>', 'domains [add|remove]', 'export [--domain d] [file]', 'import <file>'],
  todos:     ['add', 'clear', 'done', 'undone'],
  issues:    ['[id]'],
  load:      ['[id]'],
  compact:   ['[focus]'],
  mode:      ['plan', 'normal'],
  plan:      ['on', 'off'],
  skills:    ['build'],
  mindmap:   ['compile', 'get', 'patch', 'validate'],
  domain:    ['add'],
};

/**
 * Subprocess execution (filterCliXml, ReplayBuffer, ExecOptions/ExecResult,
 * and the spawn+timeout+kill logic) lives in `agent-exec.ts`. exec() below
 * delegates to runExec() there. The shell is selected once at startup by
 * `shell-detect.ts` — see the windows-shell-strategy skill for the rationale.
 */

/**
 * Options for ask()
 */
export interface AskOptions {
  /** If true, use query as the LineEditor prompt (single line format).
   *  If false (default), print query above and use '> ' as prompt. */
  useAsPrompt?: boolean;
  /** Pre-fill the input line with this content */
  initialContent?: string;
  /** Value to resolve with when ESC is pressed. If not set, ESC is ignored. */
  onEsc?: string;
  /** Value to resolve with when Enter pressed on empty input. If not set, returns ''. */
  onEnter?: string;
  /** If true, the serve-mode card renders as a 'notice' — an instruction
   *  plus a single OK button with NO free-text input. Used for prompts where
   *  the user performs an action outside the chat (e.g. editing the DOSQ
   *  file in /load) and only needs to acknowledge completion. In the
   *  terminal path this flag is inert (Enter-on-empty still resolves to
   *  onEnter or '' as usual); it only changes the webui card kind. */
  notice?: boolean;

}

/**
 * Parse the default token from a trailing [?/?] bracket suffix in a query,
 * following the CLI convention that the UPPERCASE token marks the default
 * (e.g. [y/N] -> 'n', [Y/n] -> 'y', [1/2/3/4] -> '4'). Returns the lowercase
 * default token, or undefined if the query has no such bracket or no
 * uppercase (default-marked) token.
 *
 * This mirrors the serve-mode card classification logic in ask() so that the
 * terminal path honors the same Enter-on-empty convention: when the user
 * presses Enter on an empty input, the question resolves to the bracket's
 * default rather than a bare '' - keeping terminal and serve behavior in
 * sync and removing the need for every caller to patch its own "empty
 * means default" check (the bug that caused git_commit's "User responded:
 * "" when Enter meant No").
 *
 * A trailing CLI prompt marker ("> " or ">") is stripped before matching,
 * so hand_over's "Save tmux session? [y/N] > " still yields 'n'.
 */
function parseBracketDefault(query: string): string | undefined {
  const querySansMarker = query.replace(/\s*>\s*$/, '');
  const bracketMatch = querySansMarker.match(/\[([^\]]+)\]$/);
  if (!bracketMatch) return undefined;
  const tokens = bracketMatch[1].split('/');
  for (const tok of tokens) {
    // An uppercase letter marks the default token (tok !== tok.toLowerCase()).
    if (tok !== tok.toLowerCase()) {
      return tok.toLowerCase();
    }
  }
  return undefined;
}

/**
 * AgentIO - Singleton for managing I/O state
 */
class AgentIO {
  private isMainProcessFlag = false;
  private llmAbortController: AbortController | null = null;

  // Neglected mode tracking (ESC was pressed this round)
  private neglectedModeFlag = false;

  // Neglected callbacks - called when ESC is pressed
  private onNeglectedCallbacks: Set<() => void> = new Set();

  // LineEditor management
  private activeLineEditor: LineEditor | null = null;
  // Default history with common slash commands for easy access
  private lineHistory: string[] = ['/mindmap compile MYCC.md', '/mode plan', 'show me all the tools and skills that you can use'];

  // Double Ctrl+L detection (clear conversation history)
  private static readonly CTRL_L_DOUBLE_PRESS_MS = 3000;  // 3 seconds for double press
  private lastCtrlLTime: number | null = null;
  private onDoubleCtrlLCallback: (() => void) | null = null;
  private onConditionReloadCallback: (() => Promise<void>) | null = null;
  private whisperTimeout: ReturnType<typeof setTimeout> | null = null;

  // Buffer for output during user interaction (prompt displayed or wrapping up)
  private outputBuffer: Array<{
    method: 'log' | 'warn' | 'error';
    args: unknown[];
  }> = [];

  // Output callback — mirrors console output to the web UI (WebSocket).
  // Set when serve mode is active, cleared on exit.
  private outputCallback: OutputCallback | null = null;

  // Flag set while brief() is executing. When true, log/warn/error suppress
  // their own outputCallback call so brief() can fire it once with the
  // clean (non-chalk-formatted) message.
  private inBrief = false;

  // ESC-during-ask() cancellation support
  private askResolver: ((value: string) => void) | null = null;
  private askOnEsc: string | null = null;
  // Rejecter for the currently-blocked ask() Promise. Paired with askResolver
  // so an external wake event (e.g. a peer channel join) can REJECT the
  // blocked ask() with a PromptAbortError instead of resolving it with a
  // sentinel value — the rejection propagates as a thrown exception through
  // getInput() to a catch block in prompt.ts. Nulled alongside askResolver
  // on every completion path (onDone, ESC cancel, catch, abortAsk).
  private askRejecter: ((reason: unknown) => void) | null = null;

  // Re-entrancy guard: queue concurrent ask() calls so the singleton
  // askResolver/askOnEsc/activeLineEditor fields are never
  // overwritten while a previous ask() is still pending.
  //
  // Without this guard, two IPC handlers that both call ask() (e.g.
  // external_path_access from two teammates reading files outside their
  // worktree simultaneously) run concurrently via fire-and-forget
  // handleChildMessage() calls. The second ask() overwrites the first's
  // askResolver, so the first ask()'s Promise never resolves — the first
  // teammate is permanently blocked.
  private askQueue: Array<() => void> = [];

  // Lifecycle

  /**
   * Initialize for main process
   * Sets up IPC message handlers for key events and resize
   */
  initMain(): void {
    this.isMainProcessFlag = true;

    // Register the auto-mode flag getter with the serve hub so a new WS
    // connection can read the current state (without this module and the
    // hub importing each other — the hub imports nothing from agentIO, and
    // agentIO keeps its getServeHub import, breaking the cycle at the
    // callback boundary). Safe to call even when serve isn't running yet:
    // the provider is simply stored and consulted on the next connect.
    getServeHub().setAutoStateProvider(() => autoState.getAuto());

    // Handle IPC messages from coordinator
    process.on('message', (msg: { type: string; key?: KeyInfo; keys?: KeyInfo[]; columns?: number }) => {
      if (msg.type === 'neglection') {
        // ESC during ask(): cancel the question if onEsc was provided
        if (this.activeLineEditor) {
          const resolver = this.askResolver;
          const onEscValue = this.askOnEsc;
          this.askResolver = null;
          this.askOnEsc = null;
          this.askRejecter = null;
          if (onEscValue !== null) {
            // ESC cancels the question with the specified value
            this.activeLineEditor.close();
            this.activeLineEditor = null;
            this.flushOutput();
            if (resolver) resolver(onEscValue);
            // Wake the next queued ask() so it can proceed
            this.drainAskQueue();
          }
          // If onEsc not provided, ESC is ignored (main prompt no-op)
          return;
        }

        // Serve mode: ESC → warm exit (stop serve, NO neglection, NO LLM abort).
        // The user pressed ESC while the Web UI was active. We gracefully shut
        // down serve so the terminal prompt returns. A second ESC (after serve
        // has exited) triggers the standard neglection below.
        if (getServeHub().isRunning()) {
          // gracefulShutdown() awaits hub.stop() internally — the HTTP port
          // is released and serve_mode:false IPC is sent only after cleanup
          // completes, so terminal input isn't restored before the port is free.
          getServeHub().gracefulShutdown().catch((err) => {
            agentIO.verbose('serve', `ESC shutdown error: ${String(err)}`);
          });
          return; // skip standard neglection — do NOT set neglectedMode
        }

        // ESC pressed - set neglected mode and abort LLM call if running.
        // Only process if not already in neglected mode (avoid duplicate messages).
        if (!this.isNeglectedMode()) {
          this.triggerNeglection();
        }
      } else if (msg.type === 'key' && msg.key) {
        // Forward key event to active LineEditor
        this.handleKeyEvent(msg.key);
      } else if (msg.type === 'key-batch' && Array.isArray(msg.keys)) {
        // Batch key events from paste — insert atomically without submitting
        this.handleKeyBatch(msg.keys);
      } else if (msg.type === 'resize' && msg.columns) {
        // Forward resize event to active LineEditor
        this.handleResize(msg.columns);
      } else if (msg.type === 'condition_reload') {
        // skill_compile updated conditions.json — reload runtime registry
        if (this.onConditionReloadCallback) {
          this.onConditionReloadCallback().catch(() => {});
        }
      } else if (msg.type === 'serve_shutdown') {
        // Coordinator asked us to shut down serve before killing us
        // (Ctrl+C with active serve, or /load restart). This prevents
        // Vite orphan on Windows where lead.kill('SIGTERM') calls
        // TerminateProcess — the SIGTERM handler never runs.
        (async () => {
          const hub = getServeHub();
          try { if (hub.isRunning()) await hub.stop(); } catch { /* best effort */ }
          this.setOutputCallback(null);
          setResultCallback(null);
          if (process.send) process.send({ type: 'serve_shutdown_done' });
        })().catch(() => {
          // Even if shutdown fails, tell the Coordinator we tried
          if (process.send) process.send({ type: 'serve_shutdown_done' });
        });
      }
    });
  }

  // Type check

  /**
   * Check if running in main process
   */
  isMainProcess(): boolean {
    return this.isMainProcessFlag;
  }

  // Neglected mode (ESC pressed - quick wrap-up)

  /**
   * Check if in neglected mode (ESC was pressed this round)
   */
  isNeglectedMode(): boolean {
    return this.neglectedModeFlag;
  }

  /**
   * Set neglected mode (true = neglected, false = clear)
   */
  setNeglectedMode(value: boolean): void {
    this.neglectedModeFlag = value;
  }

  /**
   * Whether the lead is in autonomous (auto) mode. Orthogonal to plan/normal.
   * Set by the /auto slash command; cleared when ESC exits auto mode.
   * Tools that call agentIO.ask() directly (bypassing core.question()) check
   * this to avoid blocking on the user during autonomous operation.
   *
   * Delegates to the shared `autoState` singleton — the single source of
   * truth shared with Core (ctx.core). The webui mirror is handled by the
   * singleton's `onAutoChange` callback (registered in agent-repl), not here.
   */
  getAuto(): boolean {
    return autoState.getAuto();
  }

  /**
   * Enable or disable auto mode. Delegates to the `autoState` singleton,
   * which is idempotent (no-op on unchanged value), resets the streak when
   * leaving auto mode, and fires `onAutoChange` to broadcast to the webui.
   * @param value - true to enter auto mode, false to exit
   */
  setAuto(value: boolean): void {
    autoState.setAuto(value);
  }

  /**
   * Trigger neglection: set neglected mode, abort LLM call, fire callbacks.
   * Encapsulates the standard ESC-neglection logic so both the Coordinator
   * IPC 'neglection' handler and ServeHub's WS 'interrupt' message can use it.
   * No-op if already in neglected mode (caller must guard, or this method
   * silently returns when already neglected to avoid duplicate processing).
   */
  triggerNeglection(): void {
    if (this.isNeglectedMode()) {
      return; // already neglecting — avoid duplicate aborts/callbacks
    }
    // Set neglected mode (subsequent logs will be buffered)
    this.setNeglectedMode(true);

    const controller = this.getLlmAbortController();
    if (controller) {
      controller.abort();
    }
    // Notify all neglected listeners (e.g., exec to skip subprocess wait)
    for (const cb of this.onNeglectedCallbacks) {
      // Wrap each callback to prevent unhandled rejections from
      // async callbacks (e.g., escAware's onNeglectedHandler) and
      // sync throws from any listener.
      try {
        const maybePromise: unknown = cb();
        if (maybePromise && typeof (maybePromise as { catch?: unknown }).catch === 'function') {
          (maybePromise as Promise<unknown>).catch(() => {});
        }
      } catch {
        // Sync errors from neglected callbacks are swallowed
      }
    }
    this.onNeglectedCallbacks.clear();
  }

  /**
   * Register a callback to be called when ESC is pressed (neglected)
   * @returns Unsubscribe function to remove the callback
   */
  onNeglected(callback: () => void): () => void {
    this.onNeglectedCallbacks.add(callback);
    return () => {
      this.onNeglectedCallbacks.delete(callback);
    };
  }

  // Output buffering during user interaction

  /**
   * Check if we're in "interaction mode" (should buffer output)
   * Returns true if:
   * - Neglected mode is active (ESC pressed, wrapping up)
   * - LineEditor is active (prompt displayed, waiting for input)
   */
  isInteractionMode(): boolean {
    return this.neglectedModeFlag || this.activeLineEditor !== null;
  }

  /**
   * Console replacement: log (buffers if in interaction mode)
   */
  log(...args: unknown[]): void {
    if (this.isInteractionMode()) {
      this.outputBuffer.push({ method: 'log', args });
    } else {
      console.log(...args);
    }
    if (this.outputCallback && !this.inBrief) {
      this.outputCallback('log', args, undefined);
    }
  }

  /**
   * Console replacement: warn (buffers if in interaction mode)
   */
  warn(...args: unknown[]): void {
    if (this.isInteractionMode()) {
      this.outputBuffer.push({ method: 'warn', args });
    } else {
      console.warn(...args);
    }
    if (this.outputCallback && !this.inBrief) {
      this.outputCallback('warn', args, undefined);
    }
  }

  /**
   * Console replacement: error (buffers if in interaction mode)
   */
  error(...args: unknown[]): void {
    if (this.isInteractionMode()) {
      this.outputBuffer.push({ method: 'error', args });
    } else {
      console.error(...args);
    }
    if (this.outputCallback && !this.inBrief) {
      this.outputCallback('error', args, undefined);
    }
  }

  /**
   * Brief log — always visible, timestamped, color-coded.
   * Used for user-facing status updates (tool execution, milestones, errors).
   * Identical format to Core.brief() but available without ctx.
   * @param level - 'info' | 'warn' | 'error'
   * @param tool - Tool/module name (used for color selection)
   * @param message - Main message text
   * @param detail - Optional greyed detail shown after the tool tag
   */
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string, detail?: string): void {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const colorFn = getToolColor(tool);
    const prefix = `${chalk.gray(`[${timestamp}]`)} ${colorFn(`[${tool}]`)}`;
    const detailPart = detail ? ` ${chalk.gray(detail)}` : '';
    const header = `${prefix}${detailPart}`;

    // Suppress outputCallback inside log/warn/error during brief() — the
    // chalk-formatted header would render as garbled ANSI codes in the WebUI.
    // Instead, brief() fires outputCallback once below with the clean message.
    this.inBrief = true;
    switch (level) {
      case 'error':
        this.error(`${header}\n${chalk.red(message)}`);
        break;
      case 'warn':
        this.warn(`${header}\n${chalk.yellow(message)}`);
        break;
      default:
        this.log(`${header}\n${message}`);
    }
    this.inBrief = false;

    // Mirror to web UI (serve mode) — send the clean message text once,
    // carrying the tool label so the web UI can render the same
    // [HH:MM:SS] [tool] header as the terminal.
    if (this.outputCallback) {
      const method: 'log' | 'warn' | 'error' = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      this.outputCallback(method, [message], tool, detail);
    }
  }

  /**
   * Verbose log — only outputs when -v flag is set.
   * Used for operational detail (tool args, results, load events).
   * Identical format to Core.verbose() but available without ctx.
   * @param tool - Tool/module name for the verbose tag
   * @param message - Log message
   * @param data - Optional data to pretty-print as JSON
   */
  verbose(tool: string, message: string, data?: unknown): void {
    if (!isVerbose()) return;

    const timestamp = new Date().toISOString();
    const prefix = chalk.gray(`[${timestamp}]`) + chalk.magenta(`[verbose][${tool}]`);

    if (data !== undefined) {
      this.log(`${prefix} ${message}`);
      this.log(chalk.gray(JSON.stringify(data, null, 2)));
    } else {
      this.log(`${prefix} ${message}`);
    }
  }

  /**
   * Flush buffered output to console
   * Called after user interaction completes (prompt submitted or wrap-up done)
   */
  flushOutput(): void {
    const buffer = [...this.outputBuffer];
    this.outputBuffer = [];

    for (const { method, args } of buffer) {
      switch (method) {
        case 'log':
          console.log(...args);
          break;
        case 'warn':
          console.warn(...args);
          break;
        case 'error':
          console.error(...args);
          break;
      }
    }
  }

  /**
   * Set callback for double Ctrl+L (clear conversation history)
   * Called from the prompt state handler when Triologue is available
   */
  setDoubleCtrlLCallback(callback: (() => void) | null): void {
    this.onDoubleCtrlLCallback = callback;
  }

  /**
   * Set callback for condition reload (triggered by skill_compile via IPC)
   * Called from agent-repl.ts after creating the ConditionRegistry
   */
  setConditionReloadCallback(callback: (() => Promise<void>) | null): void {
    this.onConditionReloadCallback = callback;
  }

  /**
   * Set the output callback for serve mode (web UI mirroring).
   * When set, log/warn/error/brief also forward to this callback (WebSocket).
   * Pass null to clear (on serve exit).
   */
  setOutputCallback(cb: OutputCallback | null): void {
    this.outputCallback = cb;
  }

  /**
   * Clear whisper line and reset Ctrl+L timing state
   */
  private clearCtrlLState(): void {
    this.lastCtrlLTime = null;
    if (this.whisperTimeout) {
      clearTimeout(this.whisperTimeout);
      this.whisperTimeout = null;
    }
    if (this.activeLineEditor) {
      this.activeLineEditor.setWhisper(null);
    }
  }

  // Key event handling (for LineEditor)

  /**
   * Handle a batch of key events from Coordinator (via IPC)
   * Used for paste — all keys from a single stdin data event are
   * processed atomically. The combined text is inserted into the
   * active LineEditor without submitting.
   */
  handleKeyBatch(keys: KeyInfo[]): void {
    if (!this.activeLineEditor) return;

    // Join all key sequences into a single string.
    // Return/enter keys are mapped to \n (line feed) for insertion
    // into the editor content, so pasted multi-line text renders
    // correctly with visible line breaks.
    const text = keys.map(k =>
      (k.name === 'return' || k.name === 'enter') ? '\n' : k.sequence
    ).join('');
    if (text.length === 0) return;

    // Insert at current cursor position in the line editor
    this.activeLineEditor.insertAtCursor(text);
  }

  /**
   * Handle a key event from Coordinator (via IPC)
   * Intercepts Ctrl+L for double-press detection and whisper line management
   * Forwards other keys to active LineEditor
   */
  handleKeyEvent(key: KeyInfo): void {
    if (!this.activeLineEditor) {
      return;
    }

    // Intercept Ctrl+L for double-press detection
    if (key.ctrl && key.name === 'l') {
      const now = Date.now();
      const timeSinceLast = this.lastCtrlLTime ? now - this.lastCtrlLTime : Infinity;

      // Double Ctrl+L within 3s: clear screen, clear whisper, execute callback
      if (timeSinceLast < AgentIO.CTRL_L_DOUBLE_PRESS_MS && this.onDoubleCtrlLCallback) {
        this.clearCtrlLState();
        this.activeLineEditor.clearScreen();
        try {
          this.onDoubleCtrlLCallback();
        } catch {
          // Ignore callback errors
        }
        this.activeLineEditor.setWhisper(chalk.green('Conversation cleared. Starting fresh.'));
        return;
      }

      // First Ctrl+L: clear screen, show whisper line, track time
      this.lastCtrlLTime = now;
      this.activeLineEditor.clearScreen();

      // Show whisper line with 3s auto-clear
      this.activeLineEditor.setWhisper('Press Ctrl+L again to clear history', AgentIO.CTRL_L_DOUBLE_PRESS_MS);

      // Clear timing state when whisper auto-clears
      this.whisperTimeout = setTimeout(() => {
        this.lastCtrlLTime = null;
        this.whisperTimeout = null;
      }, AgentIO.CTRL_L_DOUBLE_PRESS_MS);

      return;
    }

    // Forward other keys to LineEditor
    this.activeLineEditor.handleKey(key);
  }

  /**
   * Handle terminal resize event from Coordinator
   * Forwards to active LineEditor if one exists and updates COLUMNS env var
   * so subprocesses spawned later inherit the correct terminal width.
   */
  handleResize(columns: number): void {
    process.env.COLUMNS = String(columns);
    if (this.activeLineEditor) {
      this.activeLineEditor.resize(columns);
    }
  }

  // Question (main process only)

  /**
   * Wake the next queued ask() call (if any) so it can proceed now that
   * the current ask() has resolved. Called from every ask() completion
   * path (onDone, ESC cancel, catch, abortAsk).
   */
  private drainAskQueue(): void {
    const next = this.askQueue.shift();
    if (next) next();
  }

  /**
   * Whether a PROMPT wait is currently blocked — i.e. the loop is in the
   * PROMPT state waiting for user input, either via a terminal ask() or a
   * serve waitForInput(). Used by the channel-join callback (agent-repl.ts)
   * to guard setAuto(true)/abortAsk/rejectInput so they only fire when a
   * PROMPT wait is actually blocked, not unconditionally mid-pass (which
   * would flip auto mode while the loop is in COLLECT/LLM/HOOK/TOOL).
   *
   * Terminal path: a blocked ask() has askRejecter set.
   * Serve path: ServeHub.waitForInput has inputRejecter set.
   * Returns false in all other states (COLLECT, LLM, HOOK, TOOL, STOP, WAIT).
   */
  isPromptBlocked(): boolean {
    // Terminal: askRejecter is set only while a terminal ask() is blocked.
    if (this.askRejecter !== null) return true;
    // Serve: delegate to ServeHub (per-card resolvers are NOT a PROMPT wait;
    // only the top-level waitForInput rejecter counts).
    try {
      if (getServeHub().isInputBlocked()) return true;
    } catch {
      // ServeHub may not be initialized — ignore.
    }
    return false;
  }

  /**
   * Reject a blocked terminal `ask()` when an external event (currently a
   * peer channel joining) must abort the PROMPT wait and redirect the loop
   * to WAIT. Rejects the pending ask() Promise with a {@link PromptAbortError}
   * so the rejection propagates as a thrown exception through
   * `UserInputProvider.getInput()` to a `catch` block in prompt.ts, which
   * returns `AgentState.WAIT`.
   *
   * Mirrors the ESC-during-ask() cancel path (agent-io.ts neglection handler):
   * capture the rejecter, close the LineEditor, null the singleton fields,
   * flush buffered output, reject, then wake the next queued ask(). No-op
   * when no ask() is blocked (askRejecter null) — e.g. not in PROMPT, or in
   * serve mode (which uses per-card resolvers and is handled by
   * ServeHub.rejectInput). Safe to call unconditionally from the channel-join
   * callback.
   */
  abortAsk(): void {
    const rejecter = this.askRejecter;
    const lineEditor = this.activeLineEditor;
    if (rejecter === null || lineEditor === null) {
      // No blocked terminal ask() to wake (not in PROMPT, or serve mode which
      // uses per-card resolvers). Nothing to do.
      return;
    }
    // Clear the singleton cancellation state first so a concurrent key event
    // can't double-resolve/reject.
    this.askResolver = null;
    this.askOnEsc = null;
    this.askRejecter = null;
    lineEditor.close();
    this.activeLineEditor = null; // clear FIRST so isInteractionMode() returns false
    this.flushOutput();
    rejecter(new PromptAbortError());
    // Wake the next queued ask() so it can proceed.
    this.drainAskQueue();
  }

  /**
   * Ask user a question via line editor
   * Only available in main process
   *
   * Creates a LineEditor instance and waits for input via IPC key events
   * While waiting, polls for wrap-up completion and displays it above the prompt
   *
   * @param query - The question to display, or the prompt text if useAsPrompt is true
   * @param options - Optional settings: useAsPrompt, initialContent, onEsc, onEnter
   */
  async ask(query: string, options?: AskOptions): Promise<string> {
    if (!this.isMainProcessFlag) {
      throw new Error('question() only available in main process');
    }

    // Serve mode: route input via an interactive card over the WebSocket,
    // bypassing LineEditor entirely. The card renders as a text input, a
    // confirm dialog, or a choice button set in the web UI depending on the
    // AskOptions, so onEsc/onEnter/initialContent are honored — no behavioral
    // divergence from the terminal path.
    //
    // Serve cards use a unique cardId with their own per-card resolver
    // (waitForCardResponse), so concurrent serve asks are inherently safe and
    // do NOT need the askQueue re-entrancy guard below (which only protects
    // the singleton askResolver path of the terminal LineEditor).
    if (getServeHub().isRunning()) {
      const hub = getServeHub();
      const cardId = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Determine card kind + options using the [?/?] trailing-bracket
      // protocol: only queries ending with a bracket suffix like [y/N], [Y/n],
      // [1/2/3/4], or [y/N/path] get enhanced button-card rendering. The
      // bracket encodes the quick-action options; an UPPERCASE token marks the
      // default (highlighted) button, following the CLI convention.
      //
      // A trailing CLI prompt marker ("> " or ">") is stripped before the
      // match so hand_over's "Save tmux session? [y/N] > " still classifies
      // as a choice card.
      //
      // No bracket → fall back to the historical heuristics:
      //  - onEnter set (press-Enter-to-continue style) → confirm
      //  - default                                                → input
      let kind: 'input' | 'confirm' | 'choice' | 'notice' = 'input';
      let cardOptions: { label: string; value: string; isDefault?: boolean }[] | undefined;

      // 'notice' flag takes precedence: render an instruction + a single OK
      // button with NO free-text input. Used by /load & --from DOSQ
      // confirmations where the user edits an external file then
      // acknowledges — a textarea there is useless and misleading. The OK
      // button resolves to onEnter (default '') so the terminal path (which
      // ignores `kind`) behaves identically: Enter-on-empty → onEnter → ''.
      if (options?.notice) {
        kind = 'notice';
        cardOptions = [{ label: 'OK', value: options.onEnter ?? '', isDefault: true }];
      } else {
        // Strip a trailing CLI prompt marker ("> " or ">").
        const querySansMarker = query.replace(/\s*>\s*$/, '');
        // Match a trailing bracket: [a/B/c] or [1/2/3/4] etc.
        const bracketMatch = querySansMarker.match(/\[([^\]]+)\]$/);
        if (bracketMatch) {
          const tokens = bracketMatch[1].split('/');
          // Map well-known letter tokens to human labels; numeric / other
          // tokens pass through as their own label.
          const labelFor = (tok: string): string => {
            const lower = tok.toLowerCase();
            if (lower === 'y') return 'Yes';
            if (lower === 'n') return 'No';
            if (lower === 'q') return 'Quit';
            return tok;
          };
          cardOptions = tokens.map((tok) => {
            const isDefault = tok !== tok.toLowerCase(); // contains an uppercase letter
            return {
              label: labelFor(tok),
              value: tok.toLowerCase(),
              isDefault,
            };
          });
          kind = 'choice';
        } else if (options?.onEnter !== undefined) {
          kind = 'confirm';
          cardOptions = [
            { label: 'Continue', value: options.onEnter },
            { label: 'Cancel', value: options.onEsc ?? '' },
          ];
        }
      }

      hub.broadcastCard({
        type: 'card',
        cardId,
        query,
        kind,
        options: cardOptions,
        initialContent: options?.initialContent,
      });

      const result = await hub.waitForCardResponse(cardId);

      // If serve stopped mid-card (ESC/exit/timeout), the resolver returns
      // null. Fall back to onEsc if provided, else '' (same as terminal
      // returning empty). We do NOT throw — the caller (state machine)
      // expects a string.
      if (result === null) {
        return options?.onEsc ?? '';
      }
      return result;
    }

    // Re-entrancy guard: if another ask() is already active (askResolver set),
    // wait in a queue until it completes. This prevents the singleton
    // askResolver/askOnEsc/askOnEnter/activeLineEditor fields from being
    // overwritten by a concurrent call, which would orphan the first call's
    // Promise and permanently block the caller (e.g. a teammate waiting for
    // an external_path_access or grant_request response).
    if (this.askResolver !== null) {
      await new Promise<void>((release) => {
        this.askQueue.push(release);
      });
    }

    const useAsPrompt = options?.useAsPrompt ?? false;
    const initialContent = options?.initialContent;

    // Clear any pending neglected mode before entering ask()
    // This handles the race condition where ESC is pressed while ask() is waiting:
    // 1. User presses ESC while ask() is waiting
    // 2. Coordinator sends neglection IPC message
    // 3. IPC message is queued but not yet processed
    // 4. User presses Enter to submit answer
    // 5. ask() resolves, activeLineEditor becomes null
    // 6. IPC message is processed - but neglectedModeFlag was already cleared here
    this.neglectedModeFlag = false;
    this.flushOutput();

    const prompt = useAsPrompt ? query : '> ';
    if (!useAsPrompt) {
      // Display query text separately (for questions from children)
      console.log(query);
    }

    return new Promise((resolve, reject) => {
      // Store resolver/rejecter and ESC/Enter options for cancellation support.
      // The rejecter lets abortAsk() reject this Promise with a PromptAbortError
      // when an external event (channel join) aborts the PROMPT wait.
      this.askResolver = resolve;
      this.askRejecter = reject;
      this.askOnEsc = options?.onEsc ?? null;

      // Wrap-up polling timer
      let wrapUpPollTimer: ReturnType<typeof setInterval> | null = null;

      const stopPolling = () => {
        if (wrapUpPollTimer) {
          clearInterval(wrapUpPollTimer);
          wrapUpPollTimer = null;
        }
      };

      // Poll for wrap-up completion and display it above the prompt
      const pollWrapUp = () => {
        if (wrapUpPollTimer) return;

        const timer = setInterval(() => {
          if (tryDisplayWrapUp(this.activeLineEditor)) {
            stopPolling();
          }
        }, 100);

        wrapUpPollTimer = timer;
      };

      // Start polling if there's a pending wrap-up
      if (getWrapUpState().promise) {
        console.log('Mycc is wrapping up...');
        pollWrapUp();
      }

      try {
        this.activeLineEditor = new LineEditor({
          prompt,
          stdout: process.stdout,
          onDone: (value: string) => {
            // Stop wrap-up polling
            stopPolling();

            // Save history
            this.lineHistory = this.activeLineEditor?.getHistory() || [];
            this.activeLineEditor?.close();
            this.activeLineEditor = null;  // Clear FIRST - so isInteractionMode() returns false

            // Clear ask cancellation state
            this.askResolver = null;
            this.askOnEsc = null;
            this.askRejecter = null;

            // Flush buffered output (after clearing activeLineEditor)
            this.flushOutput();

            // On empty input (Enter with no text), resolve to a sensible
            // default so the bracket convention is honored even in the
            // terminal path: 1) explicit onEnter option (caller-provided
            // default), else 2) the [?/?] bracket default token parsed from
            // the query (e.g. [y/N]->'n', [Y/n]->'y', [1/2/3/4]->'4'),
            // else 3) the bare empty string. This keeps terminal behavior in
            // sync with the serve-mode card classification above and removes
            // the need for every caller to patch its own "empty means default"
            // check (the bug that caused git_commit's "User responded: "" when
            // Enter meant No).
            let finalValue = value;
            if (value === '') {
              finalValue = options?.onEnter !== undefined
                ? options.onEnter
                : (parseBracketDefault(query) ?? value);
            }
            resolve(finalValue);

            // Wake the next queued ask() so it can proceed
            this.drainAskQueue();
          },
          history: this.lineHistory,
          onContentChange: (content: string) => {
            if (content.startsWith('/')) {
              const trimmed = content.slice(1);
              const spaceIdx = trimmed.indexOf(' ');

              if (trimmed.length === 0) {
                // State 1: just "/"
                this.activeLineEditor?.setWhisper('slash command: get help by /help');
              } else if (spaceIdx >= 0) {
                // State 4/5/6: command + space + optional subcommand
                const cmdName = trimmed.slice(0, spaceIdx);
                const cmd = slashRegistry.get(cmdName);
                const resolvedName = cmd ? cmd.name : cmdName;
                const subs = COMMAND_SUBCOMMANDS[resolvedName];

                if (subs) {
                  const afterSpace = trimmed.slice(spaceIdx + 1);
                  if (afterSpace.length === 0) {
                    // State 4: just "/wiki " — show all subcommands
                    this.activeLineEditor?.setWhisper(`/${resolvedName} → ${subs.join(', ')}`);
                  } else {
                    // State 5/6: user typing subcommand — filter by prefix
                    const matching = subs.filter(s => s.startsWith(afterSpace));
                    if (matching.length > 0) {
                      // State 5: partial subcommand match
                      this.activeLineEditor?.setWhisper(`/${resolvedName} → ${matching.join(', ')}`);
                    } else if (cmd) {
                      // State 6: no subcommand match — fallback to description
                      this.activeLineEditor?.setWhisper(cmd.description);
                    }
                  }
                } else if (cmd) {
                  // Command has no subcommands, just show description
                  this.activeLineEditor?.setWhisper(cmd.description);
                }
              } else {
                // State 2/3: typing command name (no space yet)
                const cmd = slashRegistry.get(trimmed);
                if (cmd) {
                  // Exact match — show description (with subcommand hint if available)
                  const subs = COMMAND_SUBCOMMANDS[cmd.name];
                  const hint = subs ? `${cmd.description} → ${subs.join(', ')}` : cmd.description;
                  this.activeLineEditor?.setWhisper(hint);
                } else {
                  // Partial match — filter command names by prefix
                  const all = slashRegistry.list();
                  const matches = all.filter(n => n.startsWith(trimmed));
                  if (matches.length > 0) {
                    this.activeLineEditor?.setWhisper(`/${  matches.join(', /')}`);
                  }
                }
              }
            } else if (content.startsWith('!')) {
              this.activeLineEditor?.setWhisper('run command in another terminal');
            } else {
              // Clear whisper when leaving / or ! prefix
              this.activeLineEditor?.setWhisper(null);
            }
          },
        });

        // Pre-fill content if provided
        if (initialContent) {
          this.activeLineEditor.setContent(initialContent);
        }

        // Check if wrap-up already completed while LineEditor was starting
        if (tryDisplayWrapUp(this.activeLineEditor)) {
          stopPolling();
        }
      } catch (e) {
        stopPolling();
        this.askResolver = null;
        this.askOnEsc = null;
        this.askRejecter = null;
        // Wake the next queued ask() so it can proceed
        this.drainAskQueue();
        throw e;
      }
    });
  }

  // LLM Abort handling

  /**
   * Create an AbortController for LLM calls
   * The caller should store the signal and pass it to retryChat
   */
  createLlmAbortController(): AbortController {
    const controller = new AbortController();
    this.llmAbortController = controller;
    return controller;
  }

  /**
   * Clear the LLM abort controller after call completes
   */
  clearLlmAbortController(): void {
    this.llmAbortController = null;
  }

  /**
   * Get the current LLM abort controller (if any)
   * Used for inlining abort logic
   */
  getLlmAbortController(): AbortController | null {
    return this.llmAbortController;
  }

  /**
   * Execute a command in a subprocess (the bash tool). Delegates the spawn +
   * timeout + process-kill logic to runExec() in agent-exec.ts; the only
   * state coupling is the ESC (neglected) callback, which lets an ESC press
   * resolve the wait early with the partial output collected so far (the
   * subprocess keeps running in the background).
   *
   * The shell is selected once at startup by shell-detect.ts; runExec()
   * commits to that choice and does not fall back. See agent-exec.ts and the
   * windows-shell-strategy skill.
   */
  async exec(options: ExecOptions): Promise<ExecResult> {
    return runExec(options, (cb) => this.onNeglected(cb));
  }
}

// Simple singleton - just export a new instance
export const agentIO = new AgentIO();




