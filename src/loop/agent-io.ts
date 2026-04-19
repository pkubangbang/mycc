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
import { execa } from 'execa';

/**
 * Options for exec command
 */
export interface ExecOptions {
  cwd: string;
  command: string;
  timeout: number;
}

/**
 * Result of exec command
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  exitCode: number;
  timedOut: boolean;
}

/**
 * AgentIO - Singleton for managing I/O state
 */
class AgentIO {
  private isMainProcessFlag = false;
  private escPressedFlag = false;
  private llmAbortController: AbortController | null = null;

  // Interrupted mode tracking (ESC was pressed this round)
  private interruptedModeFlag = false;

  // LineEditor management
  private activeLineEditor: LineEditor | null = null;
  private lineHistory: string[] = [];

  // Lifecycle

  /**
   * Initialize for main process
   * Sets up IPC message handlers for key events and resize
   */
  initMain(): void {
    this.isMainProcessFlag = true;

    // Handle IPC messages from coordinator
    process.on('message', (msg: { type: string; key?: KeyInfo; columns?: number }) => {
      if (msg.type === 'neglection') {
        // ESC pressed - set flag and abort LLM call if running
        this.setEscPressed();
        const aborted = this.abort();
        if (aborted) {
          console.log('\n[ESC] Interrupting LLM call...');
        } else {
          console.log('\n[ESC] Interrupt requested - will skip remaining work');
        }
      } else if (msg.type === 'key' && msg.key) {
        // Forward key event to active LineEditor
        this.handleKeyEvent(msg.key);
      } else if (msg.type === 'resize' && msg.columns) {
        // Forward resize event to active LineEditor
        this.handleResize(msg.columns);
      }
    });
  }

  /**
   * Initialize for child process
   */
  initChild(): void {
    this.isMainProcessFlag = false;
  }

  // Type check

  /**
   * Check if running in main process
   */
  isMainProcess(): boolean {
    return this.isMainProcessFlag;
  }

  // ESC handling (soft reconsider - interrupt and wrap up)

  /**
   * Check if ESC was pressed
   * When true, current operation should be abandoned and LLM should wrap up
   */
  isEscPressed(): boolean {
    return this.escPressedFlag;
  }

  /**
   * Set ESC pressed flag (called when ESC IPC received)
   * Also enters interrupted mode for the current round
   */
  setEscPressed(): void {
    this.escPressedFlag = true;
    this.interruptedModeFlag = true;
  }

  /**
   * Clear ESC flag (called after handling)
   */
  clearEsc(): void {
    this.escPressedFlag = false;
  }

  // Interrupted mode tracking (for quick wrap-up)

  /**
   * Check if in interrupted mode (ESC was pressed this round)
   */
  isInterruptedMode(): boolean {
    return this.interruptedModeFlag;
  }

  /**
   * Clear interrupted mode (called at start of new agent loop iteration)
   */
  clearInterruptedMode(): void {
    this.interruptedModeFlag = false;
  }

  // Key event handling (for LineEditor)

  /**
   * Handle a key event from Coordinator (via IPC)
   * Forwards to active LineEditor if one exists
   */
  handleKeyEvent(key: KeyInfo): void {
    if (this.activeLineEditor) {
      this.activeLineEditor.handleKey(key);
    }
  }

  /**
   * Handle terminal resize event from Coordinator
   * Forwards to active LineEditor if one exists
   */
  handleResize(columns: number): void {
    if (this.activeLineEditor) {
      this.activeLineEditor.resize(columns);
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
    if (!this.isMainProcessFlag) {
      throw new Error('question() only available in main process');
    }

    const prompt = useAsPrompt ? query : '> ';
    if (!useAsPrompt) {
      // Display query text separately (for questions from children)
      console.log(query);
    }

    return new Promise((resolve) => {
      this.activeLineEditor = new LineEditor({
        prompt,
        stdout: process.stdout,
        onDone: (value: string) => {
          // Save history
          this.lineHistory = this.activeLineEditor?.getHistory() || [];
          this.activeLineEditor?.close();
          this.activeLineEditor = null;
          resolve(value);
        },
        history: this.lineHistory,
      });
    });
  }

  // LLM Abort handling

  /**
   * Abort the current LLM call if one is running
   * Called by SIGINT handler or ESC IPC
   * @returns true if something was aborted, false otherwise
   */
  abort(): boolean {
    if (this.llmAbortController) {
      this.llmAbortController.abort();
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
   * Get the current LLM abort signal (if any)
   */
  getLlmAbortSignal(): AbortSignal | undefined {
    return this.llmAbortController?.signal;
  }

  /**
   * Execute a shell command with timeout.
   * @param options - Command options (cwd, command, timeout in seconds)
   * @returns Result with stdout, stderr, interrupted flag, exit code, and timedOut flag
   */
  async exec(options: ExecOptions): Promise<ExecResult> {
    const { cwd, command, timeout } = options;

    try {
      const result = await execa('bash', ['-c', command], {
        cwd,
        reject: false,
        timeout: timeout * 1000,
        killSignal: 'SIGKILL',
      });

      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        interrupted: false,
        exitCode: result.exitCode ?? 0,
        timedOut: false,
      };
    } catch (err) {
      const error = err as any;
      if (error.timedOut) {
        return {
          stdout: '',
          stderr: '',
          interrupted: false,
          exitCode: 137, // SIGKILL exit code
          timedOut: true,
        };
      }
      return {
        stdout: '',
        stderr: error.message || 'Unknown error',
        interrupted: false,
        exitCode: 1,
        timedOut: false,
      };
    }
  }
}

// Simple singleton - just export a new instance
export const agentIO = new AgentIO();