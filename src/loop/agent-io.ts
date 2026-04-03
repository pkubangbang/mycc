/**
 * agent-io.ts - I/O state management singleton for agent loop
 *
 * Manages readline lifecycle, active tool tracking, and abort controllers
 * for handling interactive commands and signal propagation.
 */

import * as readline from 'readline';

/**
 * AgentIO - Singleton for managing I/O state
 * Manages readline lifecycle and provides exec() wrapper for commands
 */
class AgentIO {
  private _activeTool = false;
  private _abortController: AbortController | null = null;
  private _readline: readline.Interface | null = null;
  private _isMainProcess = false;
  private _isShuttingDown = false;

  // Lifecycle

  /**
   * Initialize for main process with readline
   */
  initMain(): void {
    this._isMainProcess = true;
    this._isShuttingDown = false;
    this._readline = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /**
   * Initialize for child process (no readline)
   */
  initChild(): void {
    this._isMainProcess = false;
    this._isShuttingDown = false;
  }

  /**
   * Close readline and cleanup
   */
  close(): void {
    this._isShuttingDown = true;
    if (this._readline) {
      this._readline.close();
      this._readline = null;
    }
  }

  // Type check

  /**
   * Check if running in main process (has readline)
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

  // Question (main process only)

  /**
   * Ask user a question via readline
   * Only available in main process
   */
  async question(query: string): Promise<string> {
    if (!this._isMainProcess) {
      throw new Error('question() only available in main process');
    }
    if (this._isShuttingDown || !this._readline) {
      throw new Error('Agent is shutting down');
    }
    return new Promise((resolve, reject) => {
      const rl = this._readline;
      if (!rl) {
        reject(new Error('readline not available'));
        return;
      }
      // Clear from cursor to end of screen, then show prompt
      process.stdout.write('\x1b[J');
      rl.question(query, (answer) => {
        resolve(answer);
      });
    });
  }

  // Readline management (main process only)

  /**
   * Pause readline to release stdin for child process
   */
  pauseReadline(): void {
    if (!this._isMainProcess || this._isShuttingDown || !this._readline) return;
    try {
      this._readline.pause();
    } catch {
      // Ignore if already closed
    }
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Ignore if stdin not available
      }
    }
  }

  /**
   * Resume readline after child process exits
   */
  resumeReadline(): void {
    if (!this._isMainProcess || this._isShuttingDown) return;
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        // Ignore if stdin not available
      }
    }
    if (this._readline) {
      try {
        this._readline.resume();
      } catch {
        // Ignore if already closed
      }
    }
  }

  // SIGINT handling

  /**
   * Abort the current tool if one is running
   * Called by SIGINT handler when Ctrl+C is pressed
   */
  abort(): boolean {
    if (this._activeTool && this._abortController) {
      this._abortController.abort();
      return true;
    }
    return false;
  }

  /**
   * Execute an execa promise with full lifecycle management.
   * Handles pause/resume, abort controller, and active flag.
   * @param execaFactory - A function that takes a signal and returns an execa promise
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async exec(execaFactory: (signal: AbortSignal) => Promise<any>): Promise<{ result: any; interrupted: boolean }> {
    const abortController = new AbortController();

    this._activeTool = true;
    this._abortController = abortController;
    this.pauseReadline();

    try {
      const result = await execaFactory(abortController.signal);
      return { result, interrupted: false };
    } catch (err) {
      const interrupted = abortController.signal.aborted;
      return { result: err as Error, interrupted };
    } finally {
      this._activeTool = false;
      this._abortController = null;
      this.resumeReadline();
    }
  }
}

// Simple singleton - just export a new instance
export const agentIO = new AgentIO();