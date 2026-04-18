/**
 * agent-io.ts - I/O state management singleton for agent loop
 *
 * Manages active tool tracking, abort controllers, and LineEditor lifecycle
 * for handling interactive commands and signal propagation.
 *
 * Note: stdin is handled by the Coordinator process via IPC, not by this module.
 * LineEditor receives key events via IPC and manipulates stdout directly.
 */

import { LineEditor } from '../utils/line-editor.js';
import type { KeyInfo } from '../utils/key-parser.js';
import type { Subprocess } from 'execa';

/**
 * AgentIO - Singleton for managing I/O state
 * Provides exec() wrapper for commands with abort handling
 */
class AgentIO {
  private _activeTool = false;
  private _abortController: AbortController | null = null;
  private _llmAbortController: AbortController | null = null;
  private _isMainProcess = false;
  private _isShuttingDown = false;
  private _neglectionMode = false;
  private _escPressed = false;

  // Passthrough mode
  private _passthroughMode = false;
  private _subprocessStdin: NodeJS.WritableStream | null = null;
  private _subprocess: Subprocess | null = null;
  private _stdoutBuffer: Buffer[] = [];
  private _stderrBuffer: Buffer[] = [];
  private _stdoutBufferFull = false;
  private _stderrBufferFull = false;

  // LineEditor management
  private _activeLineEditor: LineEditor | null = null;
  private _lineHistory: string[] = [];

  // Lifecycle

  /**
   * Initialize for main process
   */
  initMain(): void {
    this._isMainProcess = true;
    this._isShuttingDown = false;
  }

  /**
   * Initialize for child process
   */
  initChild(): void {
    this._isMainProcess = false;
    this._isShuttingDown = false;
  }

  /**
   * Cleanup on shutdown
   */
  close(): void {
    this._isShuttingDown = true;
    if (this._activeLineEditor) {
      this._activeLineEditor.close();
      this._activeLineEditor = null;
    }
  }

  // Type check

  /**
   * Check if running in main process
   */
  isMainProcess(): boolean {
    return this._isMainProcess;
  }

  /**
   * Check if agent is shutting down
   */
  isShuttingDown(): boolean {
    return this._isShuttingDown;
  }

  // Neglection mode (ESC key pressed during tool execution)

  /**
   * Check if neglection mode is active
   * When true, remaining tools in the current loop will be bailed
   */
  isNeglectionMode(): boolean {
    return this._neglectionMode;
  }

  /**
   * Set neglection mode (called when ESC is detected)
   * Returns true if this is a new activation (warning should be shown)
   */
  setNeglectionMode(value: boolean): boolean {
    const wasActive = this._neglectionMode;
    this._neglectionMode = value;
    return value && !wasActive; // New activation - show warning
  }

  /**
   * Clear neglection mode (called when resuming after bail)
   */
  clearNeglectionMode(): void {
    this._neglectionMode = false;
  }

  // ESC handling (soft reconsider - interrupt and wrap up)

  /**
   * Check if ESC was pressed
   * When true, current operation should be abandoned and LLM should wrap up
   */
  isEscPressed(): boolean {
    return this._escPressed;
  }

  /**
   * Set ESC pressed flag (called when ESC IPC received)
   */
  setEscPressed(): void {
    this._escPressed = true;
  }

  /**
   * Clear ESC flag (called after handling)
   */
  clearEsc(): void {
    this._escPressed = false;
  }

  // Passthrough mode (for interactive subprocess interaction)

  /**
   * Check if passthrough mode is active
   */
  isPassthroughMode(): boolean {
    return this._passthroughMode;
  }

  /**
   * Set passthrough mode
   */
  setPassthroughMode(value: boolean): void {
    this._passthroughMode = value;
  }

  /**
   * Get subprocess stdin for passthrough input
   */
  getSubprocessStdin(): NodeJS.WritableStream | null {
    return this._subprocessStdin;
  }

  /**
   * Set subprocess stdin reference
   */
  setSubprocessStdin(stdin: NodeJS.WritableStream | null): void {
    this._subprocessStdin = stdin;
  }

  /**
   * Get subprocess reference
   */
  getSubprocess(): Subprocess | null {
    return this._subprocess;
  }

  /**
   * Set subprocess reference
   */
  setSubprocess(subprocess: Subprocess | null): void {
    this._subprocess = subprocess;
  }

  /**
   * Handle passthrough stdin data from Coordinator
   * Writes raw bytes to subprocess stdin
   */
  handlePassthroughStdin(base64Data: string): void {
    if (this._subprocessStdin && this._passthroughMode) {
      this._subprocessStdin.write(Buffer.from(base64Data, 'base64'));
    }
  }

  // Output buffer management (for smart buffering + passthrough replay)

  /**
   * Add a chunk to stdout buffer
   * Returns true if buffer is now full (caller should flush to stdout)
   */
  addStdoutChunk(chunk: Buffer): boolean {
    if (this._stdoutBufferFull) {
      return true;
    }
    this._stdoutBuffer.push(chunk);
    const total = this._stdoutBuffer.reduce((sum, b) => sum + b.length, 0);
    if (total >= this.BUFFER_LIMIT) {
      this._stdoutBufferFull = true;
      return true;
    }
    return false;
  }

  /**
   * Add a chunk to stderr buffer
   * Returns true if buffer is now full
   */
  addStderrChunk(chunk: Buffer): boolean {
    if (this._stderrBufferFull) {
      return true;
    }
    this._stderrBuffer.push(chunk);
    const total = this._stderrBuffer.reduce((sum, b) => sum + b.length, 0);
    if (total >= this.BUFFER_LIMIT) {
      this._stderrBufferFull = true;
      return true;
    }
    return false;
  }

  /**
   * Check if stdout buffer is full
   */
  isStdoutBufferFull(): boolean {
    return this._stdoutBufferFull;
  }

  /**
   * Check if stderr buffer is full
   */
  isStderrBufferFull(): boolean {
    return this._stderrBufferFull;
  }

  /**
   * Get stdout buffer (for replay)
   */
  getStdoutBuffer(): Buffer[] {
    return this._stdoutBuffer;
  }

  /**
   * Get stderr buffer (for replay)
   */
  getStderrBuffer(): Buffer[] {
    return this._stderrBuffer;
  }

  /**
   * Flush stdout buffer to process.stdout
   */
  flushStdoutBuffer(): void {
    for (const chunk of this._stdoutBuffer) {
      process.stdout.write(chunk);
    }
  }

  /**
   * Flush stderr buffer to process.stderr
   */
  flushStderrBuffer(): void {
    for (const chunk of this._stderrBuffer) {
      process.stderr.write(chunk);
    }
  }

  /**
   * Clear terminal and replay buffers (for passthrough mode)
   */
  replayBuffers(): void {
    // Clear terminal
    process.stdout.write('\x1b[2J\x1b[H');
    // Replay buffered output
    for (const chunk of this._stdoutBuffer) {
      process.stdout.write(chunk);
    }
    for (const chunk of this._stderrBuffer) {
      process.stderr.write(chunk);
    }
  }

  /**
   * Clear all buffers
   */
  clearBuffers(): void {
    this._stdoutBuffer = [];
    this._stderrBuffer = [];
    this._stdoutBufferFull = false;
    this._stderrBufferFull = false;
  }

  // Buffer limit constant
  private readonly BUFFER_LIMIT = 16 * 1024; // 16KB

  // Key event handling (for LineEditor)

  /**
   * Handle a key event from Coordinator (via IPC)
   * Forwards to active LineEditor if one exists
   */
  handleKeyEvent(key: KeyInfo): void {
    if (this._activeLineEditor) {
      this._activeLineEditor.handleKey(key);
    }
  }

  /**
   * Handle terminal resize event from Coordinator
   * Forwards to active LineEditor if one exists
   */
  handleResize(columns: number): void {
    if (this._activeLineEditor) {
      this._activeLineEditor.resize(columns);
    }
  }

  // Question (main process only)

  /**
   * Ask user a question via line editor
   * Only available in main process
   *
   * Creates a LineEditor instance and waits for input via IPC key events
   * @param query - The question to display, or the prompt text if useAsPrompt is true
   * @param useAsPrompt - If true, use query as the LineEditor prompt (single line format)
   *                      If false, print query above and use '> ' as prompt (split format)
   */
  async ask(query: string, useAsPrompt: boolean = false): Promise<string> {
    if (!this._isMainProcess) {
      throw new Error('question() only available in main process');
    }
    if (this._isShuttingDown) {
      throw new Error('Agent is shutting down');
    }

    const prompt = useAsPrompt ? query : '> ';
    if (!useAsPrompt) {
      // Display query text separately (for questions from children)
      console.log(query);
    }

    return new Promise((resolve) => {
      this._activeLineEditor = new LineEditor({
        prompt,
        stdout: process.stdout,
        onDone: (value: string) => {
          // Save history
          this._lineHistory = this._activeLineEditor?.getHistory() || [];
          this._activeLineEditor?.close();
          this._activeLineEditor = null;
          resolve(value);
        },
        history: this._lineHistory,
      });
    });
  }

  // Abort handling (used by SIGINT handler in agent-loop.ts and ESC/neglection IPC)

  /**
   * Abort the current tool or LLM call if one is running
   * Called by SIGINT handler (external signal) or ESC/neglection IPC
   * @returns true if something was aborted, false otherwise
   */
  abort(): boolean {
    // First try to abort active tool
    if (this._activeTool && this._abortController) {
      this._abortController.abort();
      return true;
    }
    // Then try to abort LLM call
    if (this._llmAbortController) {
      this._llmAbortController.abort();
      return true;
    }
    return false;
  }

  /**
   * Create an AbortController for LLM calls
   * The caller should store the signal and pass it to retryChat
   */
  createLlmAbortController(): AbortController {
    const controller = new AbortController();
    this._llmAbortController = controller;
    return controller;
  }

  /**
   * Clear the LLM abort controller after call completes
   */
  clearLlmAbortController(): void {
    this._llmAbortController = null;
  }

  /**
   * Get the current LLM abort signal (if any)
   */
  getLlmAbortSignal(): AbortSignal | undefined {
    return this._llmAbortController?.signal;
  }

  /**
   * Execute an execa promise with full lifecycle management.
   * Handles abort controller and active flag for signal propagation.
   * Stores subprocess reference for passthrough mode.
   * @param execaFactory - A function that takes a signal and returns an execa subprocess
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async exec(execaFactory: (signal: AbortSignal) => Promise<any> & { stdin?: NodeJS.WritableStream | null }): Promise<{ result: any; interrupted: boolean }> {
    const abortController = new AbortController();

    this._activeTool = true;
    this._abortController = abortController;

    try {
      const subprocess = execaFactory(abortController.signal);
      // Store subprocess reference for passthrough mode
      this._subprocess = subprocess as any;
      this._subprocessStdin = subprocess.stdin ?? null;
      const result = await subprocess;
      return { result, interrupted: false };
    } catch (err) {
      const interrupted = abortController.signal.aborted;
      return { result: err as Error, interrupted };
    } finally {
      this._activeTool = false;
      this._abortController = null;
      this._subprocess = null;
      this._subprocessStdin = null;
    }
  }
}

// Simple singleton - just export a new instance
export const agentIO = new AgentIO();