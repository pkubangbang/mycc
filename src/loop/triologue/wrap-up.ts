/**
 * triologue/wrap-up.ts - Wrap-up (ESC interrupt) state for the Triologue facade
 *
 * Tracks the wrapUpMark lifecycle: begin → finish → commit | rollback.
 * The mark indexes where the wrap-up turn started so a grace-period
 * rollback can truncate back to it via simple array length assignment
 * (instant and race-free) without stretching the array.
 *
 * Extracted from triologue.ts (Phase 5 of the layered refactor).
 * The facade delegates; guard semantics preserved verbatim.
 */

export class WrapUpManager {
  /**
   * Message index at which the wrap-up turn started; -1 means no active wrap-up.
   */
  private mark: number = -1;

  get isActive(): boolean {
    return this.mark !== -1;
  }

  get value(): number {
    return this.mark;
  }

  /** Begin a wrap-up turn at the given message count. No-op if already active. */
  begin(messageCount: number): void {
    if (this.mark !== -1) return; // already in wrap-up
    this.mark = messageCount;
  }

  /** Permanently keep the wrap-up turn (clears the mark). */
  commit(): void {
    this.mark = -1;
  }

  /** End tracking after a rollback/compact; caller performs the truncation. */
  reset(): void {
    this.mark = -1;
  }
}