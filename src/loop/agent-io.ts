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
import { spawn } from 'child_process';
import { pollAndDisplayWrapUp, getWrapUpState } from './esc-wrap-up.js';

/**
 * ReplayBuffer - Buffer for collecting stdout/stderr bytes
 * Supports both string and base64 output formats.
 */
class ReplayBuffer {
  private chunks: Buffer[] = [];

  /**
   * Write bytes into buffer
   */
  write(data: Buffer | string): void {
    if (typeof data === 'string') {
      this.chunks.push(Buffer.from(data));
    } else {
      this.chunks.push(data);
    }
  }

  /**
   * Get content as string (for ctx.core.brief())
   */
  getString(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }

  /**
   * Get content as base64 (for IPC transmission)
   */
  getBase64(): string {
    return Buffer.concat(this.chunks).toString('base64');
  }
}

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
  private llmAbortController: AbortController | null = null;

  // Neglected mode tracking (ESC was pressed this round)
  private neglectedModeFlag = false;

  // Neglected callbacks - called when ESC is pressed
  private onNeglectedCallbacks: Array<() => void> = [];

  // LineEditor management
  private activeLineEditor: LineEditor | null = null;
  // Default history with common slash commands for easy access
  private lineHistory: string[] = ['/help', '/load'];

  // Buffer for output during user interaction (prompt displayed or wrapping up)
  private outputBuffer: Array<{
    method: 'log' | 'warn' | 'error';
    args: unknown[];
  }> = [];

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
        // Don't set neglected mode if user is in a LineEditor prompt (ask())
        if (this.activeLineEditor) {
          return; // ESC during ask() - just ignore
        }

        // ESC pressed - set neglected mode and abort LLM call if running
        // Only process if not already in neglected mode (avoid duplicate messages)
        if (!this.isNeglectedMode()) {
          // Now set neglected mode (subsequent logs will be buffered)
          this.setNeglectedMode(true);
          
          const controller = this.getLlmAbortController();
          if (controller) {
            controller.abort();
          }
          // Notify all neglected listeners (e.g., exec to skip subprocess wait)
          for (const cb of this.onNeglectedCallbacks) {
            cb();
          }
          this.onNeglectedCallbacks = [];
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
   * Register a callback to be called when ESC is pressed (neglected)
   * Used by exec() to skip subprocess wait and return premature output
   */
  onNeglected(callback: () => void): void {
    this.onNeglectedCallbacks.push(callback);
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
   * While waiting, polls for wrap-up completion and displays it above the prompt
   *
   * @param query - The question to display, or the prompt text if useAsPrompt is true
   * @param useAsPrompt - If true, use query as the LineEditor prompt (single line format)
   *                      If false, print query above and use '> ' as prompt (split format)
   */
  async ask(query: string, useAsPrompt: boolean = false): Promise<string> {
    if (!this.isMainProcessFlag) {
      throw new Error('question() only available in main process');
    }

    // Clear any pending neglected mode before entering ask()
    // This handles the race condition where ESC is pressed while ask() is waiting:
    // 1. User presses ESC while ask() is waiting
    // 2. Coordinator sends neglection IPC message
    // 3. IPC message is queued but not yet processed
    // 4. User presses Enter to submit answer
    // 5. ask() resolves, activeLineEditor becomes null
    // 6. IPC message is processed - but neglectedModeFlag was already cleared here
    this.neglectedModeFlag = false;

    const prompt = useAsPrompt ? query : '> ';
    if (!useAsPrompt) {
      // Display query text separately (for questions from children)
      console.log(query);
    }

    return new Promise((resolve) => {
      // Wrap-up polling timer
      let wrapUpPollTimer: ReturnType<typeof setInterval> | null = null;

      // Poll for wrap-up completion and display it above the prompt
      const pollWrapUp = () => {
        if (wrapUpPollTimer) return;

        wrapUpPollTimer = setInterval(() => {
          const content = pollAndDisplayWrapUp();
          if (content) {
            // Stop polling
            if (wrapUpPollTimer) {
              clearInterval(wrapUpPollTimer);
              wrapUpPollTimer = null;
            }
            // Re-render prompt after letter-box display
            if (this.activeLineEditor) {
              this.activeLineEditor.rerender();
            }
          }
        }, 100);
      };

      // Start polling if there's a pending wrap-up
      if (getWrapUpState().promise) {
        console.log('Mycc is wrapping up...');
        pollWrapUp();
      }

      this.activeLineEditor = new LineEditor({
        prompt,
        stdout: process.stdout,
        onDone: (value: string) => {
          // Stop wrap-up polling
          if (wrapUpPollTimer) {
            clearInterval(wrapUpPollTimer);
            wrapUpPollTimer = null;
          }

          // Save history
          this.lineHistory = this.activeLineEditor?.getHistory() || [];
          this.activeLineEditor?.close();
          this.activeLineEditor = null;  // Clear FIRST - so isInteractionMode() returns false

          // Flush buffered output (after clearing activeLineEditor)
          this.flushOutput();

          resolve(value);
        },
        history: this.lineHistory,
      });

      // Check if wrap-up already completed while LineEditor was starting
      const content = pollAndDisplayWrapUp();
      if (content) {
        this.activeLineEditor.rerender();
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
   * Get the current LLM abort signal (if any)
   */
  getLlmAbortSignal(): AbortSignal | undefined {
    return this.llmAbortController?.signal;
  }

  /**
   * Execute a shell command with strict timeout enforcement.
   * Uses spawn with bash -c for full control over subprocess lifecycle.
   * @param options - Command options (cwd, command, timeout in seconds)
   * @returns Result with stdout, stderr, interrupted flag, exit code, and timedOut flag
   * @throws Error if timeout is invalid (not integer between 1-30)
   */
  async exec(options: ExecOptions): Promise<ExecResult> {
    const { cwd, command, timeout } = options;

    // 1. Validate timeout: must be positive integer between 1 and 30
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) {
      throw new Error(`timeout must be an integer between 1 and 30, got: ${timeout}`);
    }

    const timeoutMs = timeout * 1000;

    // 2. Create stdout/stderr buffers using ReplayBuffer
    const stdoutBuffer = new ReplayBuffer();
    const stderrBuffer = new ReplayBuffer();

    // 3. Create subprocess with platform-appropriate shell
    // Unix: setsid + bash -c runs in a new session without controlling terminal
    // Windows: cmd /c with chcp 65001 for UTF-8 output encoding
    const isWin = process.platform === 'win32';
    const proc = isWin
      ? spawn('cmd', ['/c', `chcp 65001 >nul && ${command}`], { cwd, windowsHide: true })
      : spawn('setsid', ['bash', '-c', command], { cwd });

    // Collect stdout and stderr
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer.write(chunk);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer.write(chunk);
    });

    // 4. Set up timer and race with subprocess
    return new Promise((resolve) => {
      let completed = false;

      const timer = setTimeout(() => {
        if (!completed) {
          completed = true;
          proc.kill('SIGKILL');
          resolve({
            stdout: '',
            stderr: '',
            interrupted: false,
            exitCode: 137,
            timedOut: true,
          });
        }
      }, timeoutMs);

      // Register callback for ESC (neglected) - skip subprocess wait
      this.onNeglected(() => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          // Return premature output, let subprocess continue in background
          resolve({
            stdout: stdoutBuffer.getString(),
            stderr: stderrBuffer.getString(),
            interrupted: true,
            exitCode: -1, // Unknown - subprocess still running
            timedOut: false,
          });
        }
      });

      // Handle subprocess completion
      proc.on('close', (code) => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          resolve({
            stdout: stdoutBuffer.getString(),
            stderr: stderrBuffer.getString(),
            interrupted: false,
            exitCode: code ?? 1,
            timedOut: false,
          });
        }
      });

      // Handle spawn errors
      proc.on('error', (err) => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          resolve({
            stdout: '',
            stderr: err.message,
            interrupted: false,
            exitCode: 1,
            timedOut: false,
          });
        }
      });
    });
  }
}

// Simple singleton - just export a new instance
export const agentIO = new AgentIO();