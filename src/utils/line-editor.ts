/**
 * line-editor.ts - Custom line editor with CURSOR marker approach
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
 * LineEditor - Custom line editor with CURSOR marker approach
 *
 * The cursor is embedded as a "CURSOR" marker in the content array.
 * All operations manipulate the CURSOR position directly.
 */
export class LineEditor {
  // Configuration
  private readonly prompt: string;
  private readonly stdout: NodeJS.WriteStream;
  private readonly onDone: (value: string) => void;
  private readonly promptLength: number;
  private columns: number;

  // Content storage: flat array of graphemes + CURSOR marker
  private content: string[] = [CURSOR];

  // Cached lines (computed from content for display)
  private lines: string[][] = [[]];

  // Screen position tracking (for refresh)
  private screenRow = 0;
  private screenCol = 0;
  private prevScreenRow = 0;

  // History
  private history: string[] = [];
  private historyIndex = -1;
  private savedContent: string[] = [];

  constructor(options: LineEditorOptions) {
    this.prompt = options.prompt;
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
    this.rebuildLines();

    this.refresh();
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
   */
  private getContent(): string {
    return this.content.filter(c => c !== CURSOR).join('');
  }

  /**
   * Rebuild lines array from flat content with wrapping
   */
  private rebuildLines(): void {
    const newLines: string[][] = [];
    let currentLine: string[] = [];
    let currentLineWidth = 0;

    for (let i = 0; i < this.content.length; i++) {
      const char = this.content[i];
      const isCursor = char === CURSOR;

      // Determine max width for this line
      const maxWidth = newLines.length === 0
        ? this.columns - this.promptLength
        : this.columns;

      // Calculate width (CURSOR has width 1 for display)
      const width = isCursor ? 1 : stringWidth(char);

      // Check if we need to wrap
      if (currentLineWidth + width > maxWidth && currentLine.length > 0) {
        newLines.push(currentLine);
        currentLine = [];
        currentLineWidth = 0;
      }

      currentLine.push(char);
      currentLineWidth += width;
    }

    // Push last line
    if (currentLine.length > 0 || newLines.length === 0) {
      newLines.push(currentLine);
    }

    this.lines = newLines;

    // Calculate screen position for CURSOR
    this.calculateScreenPosition();
  }

  /**
   * Calculate screen position (row, col) where CURSOR should appear
   */
  private calculateScreenPosition(): void {
    for (let lineIdx = 0; lineIdx < this.lines.length; lineIdx++) {
      const line = this.lines[lineIdx];
      const cursorPosInLine = line.indexOf(CURSOR);

      if (cursorPosInLine !== -1) {
        // CURSOR is in this line
        this.screenRow = lineIdx;

        // Calculate column: width of chars before CURSOR in this line
        const charsBeforeCursor = line.slice(0, cursorPosInLine).filter(c => c !== CURSOR);
        this.screenCol = stringWidth(charsBeforeCursor.join(''));

        // First line includes prompt
        if (lineIdx === 0) {
          this.screenCol += this.promptLength;
        }
        return;
      }
    }

    // CURSOR not found (shouldn't happen), default to end
    this.screenRow = this.lines.length - 1;
    this.screenCol = 0;
  }

  /**
   * Refresh the display - redraw content and position cursor
   */
  private refresh(): void {
    // Move to the first line of our content
    this.stdout.write('\r');
    if (this.prevScreenRow > 0) {
      this.stdout.write(`\x1b[${this.prevScreenRow}A`);
    }

    // Clear current line and everything below
    this.stdout.write('\x1b[2K\x1b[J');

    // Write all lines (skip CURSOR marker)
    for (let lineIdx = 0; lineIdx < this.lines.length; lineIdx++) {
      if (lineIdx === 0) {
        // Write prompt
        for (const char of this.prompt) {
          this.stdout.write(char);
        }
      }

      // Write content, skipping CURSOR marker
      for (const char of this.lines[lineIdx]) {
        if (char !== CURSOR) {
          this.stdout.write(char);
        }
      }

      if (lineIdx < this.lines.length - 1) {
        this.stdout.write('\n\r');
      }
    }

    // Position terminal cursor at the calculated position
    const linesToMoveUp = this.lines.length - 1 - this.screenRow;
    if (linesToMoveUp > 0) {
      this.stdout.write(`\x1b[${linesToMoveUp}A`);
    }
    this.stdout.write('\r');
    this.stdout.write(`\x1b[${this.screenCol + 1}G`);

    // Save cursor position for next refresh
    this.prevScreenRow = this.screenRow;
  }

  // === Cursor Movement ===

  /**
   * Move cursor left (swap CURSOR with previous element)
   */
  private moveLeft(): void {
    const idx = this.getCursorIndex();
    if (idx === 0) return; // Already at start

    // Swap CURSOR with previous element
    [this.content[idx - 1], this.content[idx]] = [this.content[idx], this.content[idx - 1]];
    this.rebuildLines();
    this.refresh();
  }

  /**
   * Move cursor right (swap CURSOR with next element)
   */
  private moveRight(): void {
    const idx = this.getCursorIndex();
    if (idx === this.content.length - 1) return; // Already at end

    // Swap CURSOR with next element
    [this.content[idx], this.content[idx + 1]] = [this.content[idx + 1], this.content[idx]];
    this.rebuildLines();
    this.refresh();
  }

  /**
   * Move cursor to start
   */
  private moveHome(): void {
    const idx = this.getCursorIndex();
    if (idx === 0) return;

    // Remove CURSOR and insert at start
    this.content.splice(idx, 1);
    this.content.unshift(CURSOR);
    this.rebuildLines();
    this.refresh();
  }

  /**
   * Move cursor to end
   */
  private moveEnd(): void {
    const idx = this.getCursorIndex();
    if (idx === this.content.length - 1) return;

    // Remove CURSOR and append at end
    this.content.splice(idx, 1);
    this.content.push(CURSOR);
    this.rebuildLines();
    this.refresh();
  }

  // === Text Editing ===

  /**
   * Insert character at cursor position (before CURSOR)
   */
  private insertChar(char: string): void {
    const idx = this.getCursorIndex();
    // Insert before CURSOR (CURSOR stays in place, new char goes before)
    this.content.splice(idx, 0, char);
    this.rebuildLines();
    this.refresh();
  }

  /**
   * Delete character before cursor
   */
  private backspace(): void {
    const idx = this.getCursorIndex();
    if (idx === 0) return; // Nothing to delete before CURSOR

    // Remove character before CURSOR
    this.content.splice(idx - 1, 1);
    this.rebuildLines();
    this.refresh();
  }

  /**
   * Delete character at cursor (after CURSOR)
   */
  private delete(): void {
    const idx = this.getCursorIndex();
    if (idx === this.content.length - 1) return; // Nothing after CURSOR

    // Remove character after CURSOR
    this.content.splice(idx + 1, 1);
    this.rebuildLines();
    this.refresh();
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
      this.rebuildLines();
      this.refresh();
    }
  }

  /**
   * Set content from text (for history navigation)
   */
  private setContent(text: string): void {
    const chars = this.splitIntoChars(text);
    this.content = [...chars, CURSOR];
    this.rebuildLines();
    this.moveEnd();
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
      this.prevScreenRow = 0;
      this.refresh();
      return;
    }

    if (key.ctrl && key.name === 'k') {
      // Delete from cursor to end
      const idx = this.getCursorIndex();
      this.content = this.content.slice(0, idx + 1);
      this.rebuildLines();
      this.refresh();
      return;
    }

    if (key.ctrl && key.name === 'u') {
      // Delete from start to cursor
      const idx = this.getCursorIndex();
      this.content = [CURSOR, ...this.content.slice(idx + 1)];
      this.rebuildLines();
      this.refresh();
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
   * Handle terminal resize event
   */
  resize(columns: number): void {
    this.columns = columns;
    if (this.columns < 20) {
      this.columns = 20;
    }
    this.rebuildLines();
    this.refresh();
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
    // No cleanup needed
  }
}