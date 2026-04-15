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
  private _neglectionWarned = false;

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
    if (value && !wasActive) {
      this._neglectionWarned = true;
      return true; // New activation - show warning
    }
    return false; // Already active - don't repeat warning
  }

  /**
   * Clear neglection mode (called when resuming after bail)
   */
  clearNeglectionMode(): void {
    this._neglectionMode = false;
    this._neglectionWarned = false;
  }

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

  // SIGINT handling

  /**
   * Abort the current tool or LLM call if one is running
   * Called by SIGINT handler when Ctrl+C is pressed
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
   * @param execaFactory - A function that takes a signal and returns an execa promise
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async exec(execaFactory: (signal: AbortSignal) => Promise<any>): Promise<{ result: any; interrupted: boolean }> {
    const abortController = new AbortController();

    this._activeTool = true;
    this._abortController = abortController;

    try {
      const result = await execaFactory(abortController.signal);
      return { result, interrupted: false };
    } catch (err) {
      const interrupted = abortController.signal.aborted;
      return { result: err as Error, interrupted };
    } finally {
      this._activeTool = false;
      this._abortController = null;
    }
  }
}

// Simple singleton - just export a new instance
export const agentIO = new AgentIO();