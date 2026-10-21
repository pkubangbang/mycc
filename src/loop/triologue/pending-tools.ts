/**
 * triologue/pending-tools.ts - Pending tool-call ledger for the Triologue facade
 *
 * Tracks tool calls announced by the assistant (tool_calls) that are awaiting
 * their tool results. Owns resolution (by ID or function name), alignment
 * validation warnings, and bulk skip/flush (ESC interruption).
 *
 * Extracted from triologue.ts (Phase 3 of the layered refactor).
 * Behavior is byte-identical: the facade delegates to this class.
 */

import type { ToolCall } from '../../types.js';
import type { ToolAlignmentWarning } from './types.js';

export class PendingToolLedger {
  private pending: Map<string, ToolCall> = new Map();
  private order: string[] = []; // Track order for sequential resolution

  /**
   * Observability hook for a duplicate id announced within one assistant turn.
   * The duplicate is dropped (never registered) so the map and `order` stay in
   * lockstep; the callback lets the facade report what it silently ignored.
   */
  onDuplicateId?: (dup: ToolCall) => void;

  // === Registration (from assistant tool_calls) ===

  register(toolCalls: ToolCall[]): void {
    for (const tc of toolCalls) {
      // Duplicate-id guard: the ledger keys by id, but `order` is a list. A
      // second call with an id already pending would overwrite the map entry
      // while pushing a second order slot — the first resolve() would then
      // drop BOTH slots, drive size to 0 early, and let flushDeferredInputs()
      // fire while another result is still unwritten (assistant → tool → user
      // → tool, the TP violation the flush gate prevents). No current provider
      // announces duplicate ids within a turn, so this is unreachable today;
      // the guard keeps an unreachable corruption from becoming reachable.
      if (this.pending.has(tc.id)) {
        this.onDuplicateId?.(tc);
        continue;
      }
      this.pending.set(tc.id, tc);
      this.order.push(tc.id);
    }
  }

  clear(): void {
    this.pending.clear();
    this.order = [];
  }

  // === Queries ===

  get size(): number {
    return this.pending.size;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  getById(id: string): ToolCall | undefined {
    return this.pending.get(id);
  }

  /** Copy of the order array (for tp-auto-fixer iteration). */
  getOrder(): string[] {
    return [...this.order];
  }

  /** Find the next pending tool call matching this function name (in order). */
  findByName(functionName: string): string | undefined {
    for (const id of this.order) {
      const tc = this.pending.get(id);
      if (tc && tc.function.name === functionName) {
        return id;
      }
    }
    return undefined;
  }

  /** Update the function name of the LAST pending entry (tool_no_assistant recovery). */
  updateLastName(functionName: string): void {
    if (this.order.length > 0) {
      const lastId = this.order[this.order.length - 1];
      const tc = this.pending.get(lastId);
      if (tc) {
        tc.function.name = functionName;
      }
    }
  }

  /** Remove a resolved pending call (after its result message is added). */
  resolve(id: string): void {
    if (this.pending.has(id)) {
      this.pending.delete(id);
      this.order = this.order.filter(x => x !== id);
    }
  }

  /**
   * Validate tool call/result alignment; reports issues via the onMisalign
   * callback. Returns nothing — pure observability, never blocks.
   */
  validateAlignment(
    functionName: string,
    toolCallId: string | undefined,
    onMisalign: (warning: ToolAlignmentWarning) => void,
  ): void {
    // No pending tool calls at all - orphan result
    if (this.pending.size === 0) {
      onMisalign({
        functionName,
        toolCallId,
        issue: 'no_pending_calls',
      });
      return;
    }

    // toolCallId provided but not found in pending
    if (toolCallId && !this.pending.has(toolCallId)) {
      onMisalign({
        functionName,
        toolCallId,
        issue: 'id_not_found',
      });
      return;
    }

    // toolCallId provided but name mismatch
    if (toolCallId) {
      const tc = this.pending.get(toolCallId);
      if (tc && tc.function.name !== functionName) {
        onMisalign({
          functionName,
          toolCallId,
          issue: 'name_mismatch',
          expectedName: tc.function.name,
        });
      }
    }
  }
}