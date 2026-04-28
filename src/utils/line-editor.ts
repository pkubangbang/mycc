/**
 * line-editor.ts - Optimized custom line editor with CURSOR marker approach
 *
 * Storage Model:
 * - A flat array of graphemes with an embedded "CURSOR" marker
 * - Cursor position is implicit: wherever "CURSOR" is in the array
 * - Lines are computed from the flat array based on wrapping
 *
 * Wrapping:
 * - First line: columns - promptLength
 * - Other lines: columns
 *
 * IPC Flow:
 *   Terminal → Coordinator (parseKeys) → IPC → AgentIO.handleKeyEvent() → LineEditor.handleKey()
 *
 * Performance Optimizations:
 * - Batch write operations instead of character-by-character
 * - Incremental updates for common operations (typing at end, backspace at end)
 * - Cached line computations
 * - Minimal screen updates
 */

import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { KeyInfo } from './key-parser.js';

/** Sentinel marker for cursor position (multi-char string, won't clash with graphemes) */
const CURSOR = 'CURSOR';

/**
 * Options for creating a LineEditor
 */
export interface LineEditorOptions {
  prompt: string;                  // The prompt string to display
  stdout: NodeJS.WriteStream;      // Usually process.stdout
  onDone: (value: string) => void; // Callback when user presses Enter
  history?: string[];              // Optional history array for up/down navigation
}

/**
 * Cached line info for display optimization
 */
interface LineInfo {
  lines: string[][];         // Lines of graphemes (without CURSOR)
  widths: number[];          // Width of each line
  cursorLine: number;        // Line index where cursor is
  cursorCol: number;         // Column offset in that line (absolute, including prompt for first line)
}

/**
 * LineEditor - Optimized custom line editor with CURSOR marker approach
 *
 * The cursor is embedded as a "CURSOR" marker in the content array.
 * All operations manipulate the CURSOR position directly.
 */
/**
 * LineEditor - Optimized custom line editor with CURSOR marker approach
 *
 * The cursor is embedded as a "CURSOR" marker in the content array.
 * All operations manipulate the CURSOR position directly.
 *
 * Bang command handling:
 * - When content starts with '!', the prompt changes to bang mode
 * - The leading '!' is hidden from display but preserved in the returned value
 */
export class LineEditor {
  // Default prompts for bang command mode
  private static readonly BANG_PROMPT = '\x1b[45m\x1b[30mrun cmd ! \x1b[0m';  // Magenta background, black text

  // Configuration
  private prompt: string;  // Changed from readonly to allow dynamic updates
  private readonly stdout: NodeJS.WriteStream;
  private readonly onDone: (value: string) => void;
  private promptLength: number;  // Changed from readonly
  private columns: number;
  private readonly originalPrompt: string;  // Store original prompt for switching back

  // Content storage: flat array of graphemes + CURSOR marker
  private content: string[] = [CURSOR];

  // Cached line info
  private lineInfo: LineInfo;

  // Screen tracking for incremental updates
  private screenStartRow = 0;  // Row where our content starts

  // Debounce timer for resize events
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RESIZE_DEBOUNCE_MS = 50;
  
  // Render throttling to prevent race conditions during rapid typing
  private lastRenderTime = 0;
  private renderQueued = false;
  private static readonly RENDER_THROTTLE_MS = 16;  // ~60fps

  // History
  private history: string[] = [];
  private historyIndex = -1;
  private savedContent: string[] = [];

  constructor(options: LineEditorOptions) {
    this.prompt = options.prompt;
    this.originalPrompt = options.prompt;
    this.stdout = options.stdout;
    this.onDone = options.onDone;
    this.history = options.history ? [...options.history] : [];
    this.promptLength = stringWidth(stripAnsi(this.prompt));

    // Get columns from environment (set by Coordinator) or default
    this.columns = parseInt(process.env.COLUMNS || '80', 10);
    if (this.columns < 20) {
      this.columns = 80;
    }

    // Initialize: empty content with CURSOR at start
    this.content = [CURSOR];
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  /**
   * Split text into grapheme clusters for proper CJK handling
   */
  private splitIntoChars(text: string): string[] {
    // Use Intl.Segmenter for grapheme clusters (modern Node.js)
    if (global.Intl && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(segmenter.segment(text), seg => seg.segment);
    }
    // Fallback to array from string (handles basic Unicode)
    return [...text];
  }

  /**
   * Get cursor position (index in content array)
   */
  private getCursorIndex(): number {
    return this.content.indexOf(CURSOR);
  }

  /**
   * Get content without CURSOR marker (for output/history)
   * Note: Returns the ORIGINAL content, including '!' prefix if present.
   * The '!' is hidden from display but preserved in the returned value.
   */
  /**
   * Get content without CURSOR marker
   * @param _forOutput - If true and in bang mode, return content with '!' prefix preserved.
   *                    If false, return the displayed content (for prompt change detection).
   *                    Default is true (for backward compatibility).
   */
  private getContent(_forOutput: boolean = true): string {
    const displayed = this.content.filter(c => c !== CURSOR).join('');
    // In bang mode, content already has '!' stored, return as-is
    return displayed;
  }

  /**
   * Compute line info from content - single pass, cached
   */
  private computeLineInfo(): LineInfo {
    const lines: string[][] = [];
    const widths: number[] = [];
    let currentLine: string[] = [];
    let currentLineWidth = 0;
    let cursorLine = 0;
    let cursorCol = 0;

    // In bang mode, skip leading '!' from display
    const inBangMode = this.prompt === LineEditor.BANG_PROMPT;
    const skipLeadingBang = inBangMode && this.content[0] === '!';

    for (let i = 0; i < this.content.length; i++) {
      const char = this.content[i];
      const isCursor = char === CURSOR;

      // Skip leading '!' in bang mode for display (but never skip CURSOR)
      if (skipLeadingBang && i === 0 && char === '!') {
        continue;
      }

      // Determine max width for this line
      const maxWidth = lines.length === 0
        ? this.columns - this.promptLength
        : this.columns;

      // Calculate width (CURSOR has width 0 for line computation)
      const width = isCursor ? 0 : stringWidth(char);

      // Check if we need to wrap
      if (currentLineWidth + width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        widths.push(currentLineWidth);
        currentLine = [];
        currentLineWidth = 0;
      }

      // Track cursor position (adjust for skipped '!')
      if (isCursor) {
        cursorLine = lines.length;
        cursorCol = currentLineWidth;
        if (lines.length === 0) {
          cursorCol += this.promptLength;
        }
        // Don't add CURSOR to currentLine
        continue;
      }

      currentLine.push(char);
      currentLineWidth += width;
    }

    // Push last line
    if (currentLine.length > 0 || lines.length === 0) {
      lines.push(currentLine);
      widths.push(currentLineWidth);
    }

    return { lines, widths, cursorLine, cursorCol };
  }

  /**
   * Full render - throttled to prevent race conditions during rapid typing
   */
  private render(): void {
    const now = Date.now();
    const timeSinceLastRender = now - this.lastRenderTime;
    
    // If enough time has passed, render immediately
    if (timeSinceLastRender >= LineEditor.RENDER_THROTTLE_MS) {
      this.doRender();
      this.lastRenderTime = now;
      this.renderQueued = false;
      return;
    }
    
    // Otherwise, queue a render if not already queued
    if (!this.renderQueued) {
      this.renderQueued = true;
      const delay = LineEditor.RENDER_THROTTLE_MS - timeSinceLastRender;
      setTimeout(() => {
        this.doRender();
        this.lastRenderTime = Date.now();
        this.renderQueued = false;
      }, delay);
    }
  }
  
  /**
   * Actual render implementation
   *
   * To prevent visual artifacts (line duplication) when input wraps across multiple lines,
   * we always render an empty line below the content. This creates a consistent visual buffer
   * that clears any stale content from previous renders.
   *
   * Cursor tracking model:
   * - screenStartRow stores which content line the cursor was on after the previous render
   * - After render, cursor is positioned within content (at cursorLine)
   * - Empty line is rendered below content, but cursor is NOT on it
   */
  private doRender(): void {
    const info = this.lineInfo;
    const totalLines = info.lines.length;
    const cursorLine = info.cursorLine;
    const cursorCol = info.cursorCol;

    // Build output buffer
    const output: string[] = [];

    // Move to starting position - go to beginning of our content area
    // Cursor is currently at (cursorLine, cursorCol) within content
    // We need to move up cursorLine lines to reach line 0 (content start)
    const linesToMoveUp = this.screenStartRow;
    output.push('\r');
    if (linesToMoveUp > 0) {
      output.push(`\x1b[${linesToMoveUp}A`);
    }

    // Clear current line and everything below
    output.push('\x1b[2K\x1b[J');

    // Write all lines
    for (let i = 0; i < totalLines; i++) {
      if (i === 0) {
        output.push(this.prompt);
      }
      output.push(info.lines[i].join(''));
      if (i < totalLines - 1) {
        output.push('\n');
      }
    }

    // Always add an empty line below content to prevent visual artifacts
    // This ensures stale content from previous renders is cleared
    output.push('\n');

    // Position cursor - move up from the end to where cursor should be
    // We're at the empty line (below all content), cursor should be at cursorLine
    // Move up (totalLines - cursorLine) lines
    const linesUp = totalLines - cursorLine;
    if (linesUp > 0) {
      output.push(`\x1b[${linesUp}A`);
    }
    output.push(`\r\x1b[${cursorCol + 1}G`);

    // Single write operation
    this.stdout.write(output.join(''));

    // Update screen tracking - cursor is now at cursorLine within content
    this.screenStartRow = cursorLine;
  }

  // === Cursor Movement ===

  /**
   * Move cursor left (swap CURSOR with previous element)
   */
  private moveLeft(): void {
    const idx = this.getCursorIndex();
    if (idx === 0) return;

    [this.content[idx - 1], this.content[idx]] = [this.content[idx], this.content[idx - 1]];
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  /**
   * Move cursor right (swap CURSOR with next element)
   */
  private moveRight(): void {
    const idx = this.getCursorIndex();
    if (idx === this.content.length - 1) return;

    [this.content[idx], this.content[idx + 1]] = [this.content[idx + 1], this.content[idx]];
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  /**
   * Move cursor to start
   */
  private moveHome(): void {
    const idx = this.getCursorIndex();
    if (idx === 0) return;

    this.content.splice(idx, 1);
    this.content.unshift(CURSOR);
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  /**
   * Move cursor to end
   */
  private moveEnd(): void {
    const idx = this.getCursorIndex();
    if (idx === this.content.length - 1) return;

    this.content.splice(idx, 1);
    this.content.push(CURSOR);
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  /**
   * Check if prompt should change based on current content
   * Called after content modifications (insertChar, backspace, delete, setContent)
   *
   * Bang command handling:
   * - If content starts with '!', switch to bang prompt
   * - If content is empty and we're in bang mode, switch back to original prompt
   */
  private checkPromptChange(): void {
    const content = this.getContent(false);
    const inBangMode = this.prompt === LineEditor.BANG_PROMPT;

    // Switch to bang prompt if content starts with '!'
    if (content.startsWith('!') && !inBangMode) {
      this.prompt = LineEditor.BANG_PROMPT;
      this.promptLength = stringWidth(stripAnsi(this.prompt));
      this.lineInfo = this.computeLineInfo();
    }
    // Switch back to original prompt if content is empty while in bang mode
    else if (content.length === 0 && inBangMode) {
      this.prompt = this.originalPrompt;
      this.promptLength = stringWidth(stripAnsi(this.prompt));
      this.lineInfo = this.computeLineInfo();
    }
  }

  // === Text Editing ===

  /**
   * Insert character at cursor position (before CURSOR)
   */
  private insertChar(char: string): void {
    const idx = this.getCursorIndex();

    // Insert before CURSOR
    this.content.splice(idx, 0, char);

    // Check for prompt change
    this.checkPromptChange();

    // Always use full render for simplicity and reliability
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  /**
   * Delete character before cursor
   */
  private backspace(): void {
    const idx = this.getCursorIndex();
    if (idx === 0) return;

    // Remove character before CURSOR
    this.content.splice(idx - 1, 1);

    // Check for prompt change
    this.checkPromptChange();

    // Always use full render for simplicity and reliability
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  /**
   * Delete character at cursor (after CURSOR)
   */
  private delete(): void {
    const idx = this.getCursorIndex();
    if (idx === this.content.length - 1) return;

    this.content.splice(idx + 1, 1);

    // Check for prompt change
    this.checkPromptChange();

    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  // === History Navigation ===

  /**
   * Navigate to previous history entry
   */
  private historyUp(): void {
    if (this.historyIndex < this.history.length - 1) {
      if (this.historyIndex === -1) {
        this.savedContent = [...this.content];
      }
      this.historyIndex++;
      const text = this.history[this.history.length - 1 - this.historyIndex];
      this.setContent(text);
    }
  }

  /**
   * Navigate to next history entry
   */
  private historyDown(): void {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      const text = this.history[this.history.length - 1 - this.historyIndex];
      this.setContent(text);
    } else if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.content = this.savedContent;
      this.lineInfo = this.computeLineInfo();
      this.render();
    }
  }

  /**
   * Set content from text (for history navigation)
   */
  private setContent(text: string): void {
    const chars = this.splitIntoChars(text);
    this.content = [...chars, CURSOR];
    this.checkPromptChange();
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  // === Key Handler ===

  /**
   * Handle a key event from IPC (Coordinator)
   */
  handleKey(key: KeyInfo): void {
    if (key.name === 'left') {
      this.moveLeft();
      return;
    }

    if (key.name === 'right') {
      this.moveRight();
      return;
    }

    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      this.moveHome();
      return;
    }

    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      this.moveEnd();
      return;
    }

    if (key.name === 'up') {
      this.historyUp();
      return;
    }

    if (key.name === 'down') {
      this.historyDown();
      return;
    }

    if (key.name === 'backspace') {
      this.backspace();
      return;
    }

    if (key.name === 'delete') {
      this.delete();
      return;
    }

    if (key.ctrl && key.name === 'l') {
      this.stdout.write('\x1b[2J\x1b[H');
      this.screenStartRow = 0;
      this.render();
      return;
    }

    if (key.ctrl && key.name === 'k') {
      // Delete from cursor to end
      const idx = this.getCursorIndex();
      this.content = this.content.slice(0, idx + 1);
      this.checkPromptChange();
      this.lineInfo = this.computeLineInfo();
      this.render();
      return;
    }

    if (key.ctrl && key.name === 'u') {
      // Delete from start to cursor
      const idx = this.getCursorIndex();
      this.content = [CURSOR, ...this.content.slice(idx + 1)];
      this.checkPromptChange();
      this.lineInfo = this.computeLineInfo();
      this.render();
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      this.stdout.write('\n');
      const finalContent = this.getContent();
      this.addToHistory(finalContent);
      this.onDone(finalContent);
      return;
    }

    // Insert printable character
    if (key.sequence && !key.ctrl && !key.meta) {
      this.insertChar(key.sequence);
      return;
    }
  }

  /**
   * Add line to history (deduplicated, limited)
   */
  private addToHistory(line: string): void {
    if (line.trim() && line !== this.history[this.history.length - 1]) {
      this.history.push(line);
      if (this.history.length > 1000) {
        this.history.shift();
      }
    }
    this.historyIndex = -1;
  }

  /**
   * Handle terminal resize event (with debounce)
   */
  resize(columns: number): void {
    // Debounce: clear pending timer and set new one
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
    }
    
    this.resizeTimer = setTimeout(() => {
      this.doResize(columns);
    }, LineEditor.RESIZE_DEBOUNCE_MS);
  }

  /**
   * Actual resize handling - smart redraw preserving scrollback
   *
   * Strategy:
   * 1. Store old line count (M) and old cursor position
   * 2. Recompute lines with new width, get new line count (N)
   * 3. From current cursor position (on empty line below content), move up to content start
   * 4. Clear and redraw N lines + empty line
   * 5. Position cursor correctly
   */
  private doResize(columns: number): void {
    this.resizeTimer = null;

    const oldColumns = this.columns;
    this.columns = columns;
    if (this.columns < 20) {
      this.columns = 20;
    }

    // If column width didn't change, skip
    if (oldColumns === this.columns) {
      return;
    }

    // Recompute lines with new width
    this.lineInfo = this.computeLineInfo();
    const newLineCount = this.lineInfo.lines.length;
    const newCursorLine = this.lineInfo.cursorLine;
    const newCursorCol = this.lineInfo.cursorCol;

    // Build output
    const output: string[] = [];

    // From current cursor position (within old content), move up to content start
    if (this.screenStartRow > 0) {
      output.push(`\x1b[${this.screenStartRow}A`);
    }
    output.push('\r');

    // Clear from here down
    output.push('\x1b[J');

    // Write all lines
    for (let i = 0; i < newLineCount; i++) {
      if (i === 0) {
        output.push(this.prompt);
      }
      output.push(this.lineInfo.lines[i].join(''));
      if (i < newLineCount - 1) {
        output.push('\n');
      }
    }

    // Add empty line below content (consistent with doRender)
    output.push('\n');

    // Position cursor - move up from empty line to where cursor should be
    const linesUp = newLineCount - newCursorLine;
    if (linesUp > 0) {
      output.push(`\x1b[${linesUp}A`);
    }
    output.push(`\r\x1b[${newCursorCol + 1}G`);

    // Write all at once
    this.stdout.write(output.join(''));

    // Update tracking - cursor is now at newCursorLine within content
    this.screenStartRow = newCursorLine;
  }

  /**
   * Get copy of history array
   */
  getHistory(): string[] {
    return [...this.history];
  }

  /**
   * Cleanup
   */
  close(): void {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
  }
}