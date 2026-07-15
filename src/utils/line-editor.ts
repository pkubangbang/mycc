/**
 * line-editor.ts - Custom line editor with embedded CURSOR marker
 *
 * Cursor is stored as a sentinel in a flat grapheme array.
 * Lines are computed from the flat array with wrapping:
 *   First line: columns - promptLength
 *   Other lines: columns
 *
 * IPC: Terminal → Coordinator → IPC → AgentIO → LineEditor.handleKey()
 */

import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { KeyInfo } from './key-parser.js';

const CURSOR = 'CURSOR';
const BLANK_LINE = '';
// const BLANK_LINE = '\x1b[90m[--blank--]\x1b[0m';
const BANG_PROMPT = '\x1b[45m\x1b[30mrun cmd ! \x1b[0m';

interface LineEditorOptions {
  prompt: string;
  stdout: NodeJS.WriteStream;
  onDone: (value: string) => void;
  history?: string[];
  onContentChange?: (content: string) => void;
}

interface LineInfo {
  lines: string[][];
  cursorLine: number;
  cursorCol: number;  // absolute column, includes promptLength for line 0
}

/**
 * LineEditor with CURSOR marker for cursor tracking.
 * Bang mode: content starting with '!' switches to bang prompt; '!' is hidden but preserved.
 */
export class LineEditor {
  private prompt: string;
  private promptLength: number;
  private columns: number;
  private readonly originalPrompt: string;
  private readonly stdout: NodeJS.WriteStream;
  private readonly onDone: (value: string) => void;
  private readonly onContentChange: ((content: string) => void) | undefined;

  private content: string[] = [CURSOR];
  private lineInfo: LineInfo;
  private screenStartRow = 0;

  // Selection anchor: index into content[] (same space as CURSOR sentinel).
  // null = no selection. Set on Shift+arrow; cursor is the active end.
  private selectionAnchor: number | null = null;

  private whisperText: string | null = null;
  private whisperTimer: ReturnType<typeof setTimeout> | null = null;

  private history: string[] = [];
  private historyIndex = -1;
  private savedContent: string[] = [];

  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderTime = 0;
  private renderQueued = false;

  private static readonly RESIZE_DEBOUNCE_MS = 50;
  private static readonly RENDER_THROTTLE_MS = 16;

  /** Clear editor area so external content can be written above, then restore on rerender(). */
  prepareForExternalContentAbove(): void {
    const linesUp = this.screenStartRow;
    let output = '\r';
    if (linesUp > 0) {
      output += `\x1b[${linesUp}A`;
    }
    output += '\r\x1b[J';
    this.stdout.write(output);
    this.screenStartRow = 0;
  }

  rerender(): void {
    this.doRender();
    this.lastRenderTime = Date.now();
    this.renderQueued = false;
  }

  setWhisper(text: string | null, duration?: number): void {
    if (this.whisperTimer) {
      clearTimeout(this.whisperTimer);
      this.whisperTimer = null;
    }

    this.whisperText = text;
    this.doRender();
    this.lastRenderTime = Date.now();
    this.renderQueued = false;

    if (text !== null && duration !== undefined) {
      this.whisperTimer = setTimeout(() => {
        this.whisperText = null;
        this.whisperTimer = null;
        this.doRender();
        this.lastRenderTime = Date.now();
        this.renderQueued = false;
      }, duration);
    }
  }

  clearScreen(): void {
    this.stdout.write('\x1b[H\x1b[J');
    this.screenStartRow = 0;
    this.doRender();
    this.lastRenderTime = Date.now();
    this.renderQueued = false;
  }

  constructor(options: LineEditorOptions) {
    this.prompt = options.prompt;
    this.originalPrompt = options.prompt;
    this.stdout = options.stdout;
    this.onDone = options.onDone;
    this.onContentChange = options.onContentChange;
    this.history = options.history ? [...options.history] : [];
    this.promptLength = stringWidth(stripAnsi(this.prompt));

    this.columns = parseInt(process.env.COLUMNS || '80', 10);
    if (this.columns < 20) this.columns = 80;
    if (this.columns > 120) this.columns = 120;

    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  private splitIntoChars(text: string): string[] {
    if (global.Intl && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(segmenter.segment(text), seg => seg.segment);
    }
    return [...text];
  }

  private getCursorIndex(): number {
    return this.content.indexOf(CURSOR);
  }

  getContent(_forOutput: boolean = true): string {
    return this.content.filter(c => c !== CURSOR).join('');
  }

  private computeLineInfo(): LineInfo {
    const lines: string[][] = [];
    let currentLine: string[] = [];
    let currentLineWidth = 0;
    let cursorLine = 0;
    let cursorCol = 0;

    const inBangMode = this.prompt === BANG_PROMPT;
    const skipLeadingBang = inBangMode && this.content[0] === '!';

    // Selection range (content[] indices, inclusive of both ends, excluding CURSOR).
    // Computed once so doRender gets consistent highlighting.
    const cursorIdx = this.content.indexOf(CURSOR);
    const hasSelection = this.selectionAnchor !== null && this.selectionAnchor !== cursorIdx;
    const selStart = hasSelection ? Math.min(this.selectionAnchor!, cursorIdx) : -1;
    const selEnd = hasSelection ? Math.max(this.selectionAnchor!, cursorIdx) : -1;

    for (let i = 0; i < this.content.length; i++) {
      const char = this.content[i];
      const isCursor = char === CURSOR;

      if (skipLeadingBang && i === 0 && char === '!') continue;

      // Hard line break on \n (inserted by paste or multi-line input)
      if (char === '\n' && !isCursor) {
        lines.push(currentLine);
        currentLine = [];
        currentLineWidth = 0;
        continue;
      }

      const maxWidth = lines.length === 0
        ? this.columns - this.promptLength
        : this.columns;

      // Width is always computed on the raw char (pre-ANSI) so wrapping
      // is unaffected by inverse-video highlighting.
      const width = isCursor ? 0 : stringWidth(char);

      if (currentLineWidth + width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = [];
        currentLineWidth = 0;
      }

      if (isCursor) {
        cursorLine = lines.length;
        cursorCol = currentLineWidth + (lines.length === 0 ? this.promptLength : 0);
        continue;
      }

      // Apply inverse video to selected graphemes (excluding CURSOR index).
      if (hasSelection && i >= selStart && i <= selEnd) {
        currentLine.push(`\x1b[7m${char}\x1b[0m`);
      } else {
        currentLine.push(char);
      }
      currentLineWidth += width;
    }

    if (currentLine.length > 0 || lines.length === 0) {
      lines.push(currentLine);
    }

    return { lines, cursorLine, cursorCol };
  }

  private render(): void {
    const now = Date.now();
    if (now - this.lastRenderTime >= LineEditor.RENDER_THROTTLE_MS) {
      this.doRender();
      this.lastRenderTime = now;
      this.renderQueued = false;
      return;
    }

    if (!this.renderQueued) {
      this.renderQueued = true;
      const delay = LineEditor.RENDER_THROTTLE_MS - (now - this.lastRenderTime);
      setTimeout(() => {
        this.doRender();
        this.lastRenderTime = Date.now();
        this.renderQueued = false;
      }, delay);
    }
  }

  /**
   * Truncate text so its display width fits within maxWidth columns.
   * If truncation is needed, appends an ellipsis ('…', width 1) and keeps
   * the result within maxWidth. Returns the (possibly truncated) text.
   */
  private truncateToWidth(text: string, maxWidth: number): string {
    if (maxWidth <= 0) return '';
    const width = stringWidth(text);
    if (width <= maxWidth) return text;

    // Reserve 1 column for the ellipsis; fill the rest with leading chars.
    const target = maxWidth - 1;
    if (target <= 0) return '…';

    const chars = this.splitIntoChars(text);
    let acc = '';
    let accWidth = 0;
    for (const ch of chars) {
      const w = stringWidth(ch);
      if (accWidth + w > target) break;
      acc += ch;
      accWidth += w;
    }
    return `${acc  }…`;
  }

  // Layout: whisper (1 line) + prompt/content (1+ lines) + blank (1 line) + cursor row
  private doRender(): void {
    const { lines, cursorLine, cursorCol } = this.lineInfo;
    const totalLines = lines.length;

    const output: string[] = [];

    output.push('\r');
    if (this.screenStartRow > 0) output.push(`\x1b[${this.screenStartRow}A`);
    output.push('\x1b[2K\x1b[J');
    const whisper = this.whisperText !== null
      ? this.truncateToWidth(this.whisperText, this.columns)
      : '';
    output.push(`\x1b[90m${whisper}\x1b[0m\n`);

    for (let i = 0; i < totalLines; i++) {
      if (i === 0) output.push(this.prompt);
      // The blank_line is always shown, so each line ends with \n.
      output.push(lines[i].join(''), '\n');
    }

    output.push(BLANK_LINE);

    const linesUp = totalLines - cursorLine;
    if (linesUp > 0) output.push(`\x1b[${linesUp}A`);
    output.push(`\r\x1b[${cursorCol + 1}G`);

    this.stdout.write(output.join(''));
    this.screenStartRow = 1 + cursorLine;
  }

  // === Selection ===

  /** True if a non-empty selection is active (anchor set and != cursor). */
  private hasSelection(): boolean {
    return this.selectionAnchor !== null && this.selectionAnchor !== this.getCursorIndex();
  }

  /** Clear the current selection (anchor = null). Does not render. */
  private clearSelection(): void {
    this.selectionAnchor = null;
  }

  /**
   * Get the selection range as [start, end] content[] indices (inclusive),
   * or null if no active selection. Excludes the CURSOR sentinel index.
   */
  private getSelectionRange(): [number, number] | null {
    if (!this.hasSelection()) return null;
    const cursorIdx = this.getCursorIndex();
    return [
      Math.min(this.selectionAnchor!, cursorIdx),
      Math.max(this.selectionAnchor!, cursorIdx),
    ];
  }

  /**
   * Delete the currently selected range (if any) and place the cursor at
   * the low end of the deleted range. Clears the anchor, recomputes line
   * info, and re-renders so all callers see consistent post-deletion state.
   * No-op for empty or absent selection.
   */
  private deleteSelection(): void {
    const range = this.getSelectionRange();
    if (!range) return;
    const [selStart, selEnd] = range;
    // Remove all chars in [selStart, selEnd] except CURSOR (which lives at
    // either selStart or selEnd since it's one of the range endpoints).
    this.content = this.content.filter((c, i) => c === CURSOR || i < selStart || i > selEnd);
    // Move CURSOR to the low end of the deleted range.
    const curIdx = this.getCursorIndex();
    if (curIdx !== selStart) {
      this.content.splice(curIdx, 1);
      this.content.splice(selStart, 0, CURSOR);
    }
    this.selectionAnchor = null;
    this.checkPromptChange();
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  /** Shift+Left: set anchor if none, then move cursor left. */
  private extendSelectionLeft(): void {
    if (this.selectionAnchor === null) {
      this.selectionAnchor = this.getCursorIndex();
    }
    this.moveLeft();
  }

  /** Shift+Right: set anchor if none, then move cursor right. */
  private extendSelectionRight(): void {
    if (this.selectionAnchor === null) {
      this.selectionAnchor = this.getCursorIndex();
    }
    this.moveRight();
  }

  /** Shift+Home: set anchor if none, then move cursor to start. */
  private extendSelectionHome(): void {
    if (this.selectionAnchor === null) {
      this.selectionAnchor = this.getCursorIndex();
    }
    this.moveHome();
  }

  /** Shift+End: set anchor if none, then move cursor to end. */
  private extendSelectionEnd(): void {
    if (this.selectionAnchor === null) {
      this.selectionAnchor = this.getCursorIndex();
    }
    this.moveEnd();
  }

  // === Cursor Movement ===

  private moveLeft(): void {
    const idx = this.getCursorIndex();
    if (idx === 0) return;
    [this.content[idx - 1], this.content[idx]] = [this.content[idx], this.content[idx - 1]];
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  private moveRight(): void {
    const idx = this.getCursorIndex();
    if (idx === this.content.length - 1) return;
    [this.content[idx], this.content[idx + 1]] = [this.content[idx + 1], this.content[idx]];
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  private moveHome(): void {
    const idx = this.getCursorIndex();
    if (idx === 0) return;
    this.content.splice(idx, 1);
    this.content.unshift(CURSOR);
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  private moveEnd(): void {
    const idx = this.getCursorIndex();
    if (idx === this.content.length - 1) return;
    this.content.splice(idx, 1);
    this.content.push(CURSOR);
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  // === Prompt Management ===

  private checkPromptChange(): void {
    const content = this.getContent(false);
    const inBangMode = this.prompt === BANG_PROMPT;

    if (content.startsWith('!') && !inBangMode) {
      this.prompt = BANG_PROMPT;
      this.promptLength = stringWidth(stripAnsi(this.prompt));
      this.lineInfo = this.computeLineInfo();
    } else if (!content.startsWith('!') && inBangMode) {
      this.prompt = this.originalPrompt;
      this.promptLength = stringWidth(stripAnsi(this.prompt));
      this.lineInfo = this.computeLineInfo();
    }
  }

  // === Text Editing ===

  private insertChar(char: string): void {
    const idx = this.getCursorIndex();
    this.content.splice(idx, 0, char);
    this.checkPromptChange();
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  private backspace(): void {
    const idx = this.getCursorIndex();
    if (idx === 0) return;
    this.content.splice(idx - 1, 1);
    this.checkPromptChange();
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  private delete(): void {
    const idx = this.getCursorIndex();
    if (idx === this.content.length - 1) return;
    this.content.splice(idx + 1, 1);
    this.checkPromptChange();
    this.lineInfo = this.computeLineInfo();
    this.render();
  }

  // === History Navigation ===

  private historyUp(): void {
    if (this.historyIndex >= this.history.length - 1) return;

    if (this.historyIndex === -1) this.savedContent = [...this.content];
    this.historyIndex++;
    this.setContent(this.history[this.history.length - 1 - this.historyIndex]);
  }

  private historyDown(): void {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.setContent(this.history[this.history.length - 1 - this.historyIndex]);
    } else if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.content = this.savedContent;
      this.lineInfo = this.computeLineInfo();
      this.render();
    }
  }

  setContent(text: string): void {
    this.selectionAnchor = null;
    this.content = [...this.splitIntoChars(text), CURSOR];
    this.checkPromptChange();
    this.lineInfo = this.computeLineInfo();
    this.render();
    this.notifyContentChange();
  }

  /**
   * Insert text at the current cursor position.
   * Used for paste — inserts all characters at cursor without submitting.
   * Embedded \n characters cause visible line breaks in the editor.
   */
  insertAtCursor(text: string): void {
    const chars = this.splitIntoChars(text);
    if (chars.length === 0) return;

    // Paste replaces the active selection (standard editor behavior).
    if (this.hasSelection()) {
      this.deleteSelection();
    }

    const idx = this.getCursorIndex();
    this.content.splice(idx, 0, ...chars);
    this.checkPromptChange();
    this.lineInfo = this.computeLineInfo();
    this.render();
    this.notifyContentChange();
  }

  // === Key Handler ===

  private notifyContentChange(): void {
    if (this.onContentChange) this.onContentChange(this.getContent());
  }

  handleKey(key: KeyInfo): void {
    // Phase 1 — Replace-guard: if a non-empty selection is active and the key
    // is destructive, delete the selection first. Backspace/Delete return;
    // typing/Enter/Ctrl+K/Ctrl+U fall through to their handlers below.
    if (this.hasSelection()) {
      if (key.name === 'backspace' || key.name === 'delete') {
        this.deleteSelection();
        this.notifyContentChange();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        this.deleteSelection();
        // fall through to return handler below
      } else if (key.ctrl && (key.name === 'k' || key.name === 'u')) {
        this.deleteSelection();
        // fall through to ctrl+k/ctrl+u handlers below
      } else if (key.sequence && !key.ctrl && !key.meta) {
        // Typing a printable char replaces the selection, then inserts.
        this.deleteSelection();
        this.insertChar(key.sequence);
        this.notifyContentChange();
        return;
      }
    }

    // Phase 2 — Shift+arrow/home/end: extend selection (anchor stays fixed).
    if (key.shift && !key.ctrl) {
      if (key.name === 'left') { this.extendSelectionLeft(); return; }
      if (key.name === 'right') { this.extendSelectionRight(); return; }
      if (key.name === 'home') { this.extendSelectionHome(); return; }
      if (key.name === 'end') { this.extendSelectionEnd(); return; }
    }

    // Phase 3 — Non-shift movement: clear selection, then move.
    if (!key.shift) {
      if (key.name === 'left') { this.clearSelection(); this.moveLeft(); return; }
      if (key.name === 'right') { this.clearSelection(); this.moveRight(); return; }
      if (key.name === 'home' || (key.ctrl && key.name === 'a')) { this.clearSelection(); this.moveHome(); return; }
      if (key.name === 'end' || (key.ctrl && key.name === 'e')) { this.clearSelection(); this.moveEnd(); return; }
      if (key.name === 'up') { this.clearSelection(); this.historyUp(); return; }
      if (key.name === 'down') { this.clearSelection(); this.historyDown(); return; }
    } else {
      // Shift is held but not an extendable movement key — still clear so a
      // stale selection doesn't persist through unrelated shift+key combos.
      if (key.name === 'up' || key.name === 'down') { this.clearSelection(); }
      if (key.name === 'home' || key.name === 'end' ||
          (key.ctrl && (key.name === 'a' || key.name === 'e'))) {
        this.clearSelection();
      }
    }

    // Phase 4 — Existing handlers for non-movement keys.
    if (key.name === 'backspace') {
      this.backspace();
      this.notifyContentChange();
      return;
    }

    if (key.name === 'delete') {
      this.delete();
      this.notifyContentChange();
      return;
    }

    if (key.ctrl && key.name === 'k') {
      this.clearSelection();
      this.content = this.content.slice(0, this.getCursorIndex() + 1);
      this.checkPromptChange();
      this.lineInfo = this.computeLineInfo();
      this.render();
      this.notifyContentChange();
      return;
    }

    if (key.ctrl && key.name === 'u') {
      this.clearSelection();
      const idx = this.getCursorIndex();
      this.content = [CURSOR, ...this.content.slice(idx + 1)];
      this.checkPromptChange();
      this.lineInfo = this.computeLineInfo();
      this.render();
      this.notifyContentChange();
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      this.clearSelection();
      this.doRender();
      this.stdout.write('\n');
      const val = this.getContent();
      this.addToHistory(val);
      this.onDone(val);
      return;
    }

    if (key.sequence && !key.ctrl && !key.meta) {
      // Typing always resets selection state. This covers the case where
      // the anchor was set but equals the cursor (empty selection): without
      // this clear, insertChar would move the cursor and retroactively make
      // the stale anchor look like an active selection.
      this.clearSelection();
      this.insertChar(key.sequence);
      this.notifyContentChange();
    }
  }

  private addToHistory(line: string): void {
    if (line.trim() && line !== this.history[this.history.length - 1]) {
      this.history.push(line);
      if (this.history.length > 1000) this.history.shift();
    }
    this.historyIndex = -1;
  }

  // === Resize ===

  resize(columns: number): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.doResize(columns), LineEditor.RESIZE_DEBOUNCE_MS);
  }

  private doResize(columns: number): void {
    this.resizeTimer = null;
    const oldColumns = this.columns;
    this.columns = Math.max(columns, 20);
    if (this.columns > 120) this.columns = 120;
    if (oldColumns === this.columns) return;
    // Update env var so subprocesses spawned later inherit the correct width
    process.env.COLUMNS = String(this.columns);
    this.lineInfo = this.computeLineInfo();
    this.doRender();
  }

  getHistory(): string[] {
    return [...this.history];
  }

  close(): void {
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); this.resizeTimer = null; }
    if (this.whisperTimer) { clearTimeout(this.whisperTimer); this.whisperTimer = null; }
  }
}
