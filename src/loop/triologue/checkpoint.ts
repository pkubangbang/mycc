/**
 * triologue/checkpoint.ts - Checkpoint feature domain for the Triologue facade
 *
 * The CheckpointManager is the delegate returned by Triologue.getCheckpointManager().
 * Callers talk to THIS object instead of reaching out to the facade for
 * individual checkpoint operations (findOpen/findById/findAll/generateId/recap).
 *
 * It is bound to a live message provider (() => Message[]) so it always sees
 * the facade's current message history (including compact/clear/restore swaps),
 * plus an onRecap callback so recap() can clear the pending tool ledger —
 * any pending calls from the recapped span are invalid once the span is gone.
 *
 * Pure query helpers (parseCheckpointMessage) are exported for reuse.
 * Regex patterns preserved verbatim from the original implementation.
 */

import type { Message } from '../../types.js';
import type { CheckpointInfo } from './types.js';

/**
 * Check if a message is a checkpoint by its [CHECKPOINT] content prefix
 * or legacy regex for backwards compatibility
 *
 * Parses the `if_abandoned` direction from the "Original direction:" line.
 * Legacy checkpoints (pre-if_abandoned) yield `if_abandoned: undefined`.
 */
export function parseCheckpointMessage(msg: Message): CheckpointInfo | null {
  // Checkpoint tool responses have role='tool' and tool_name='checkpoint'
  if (msg.role !== 'tool' || (msg as unknown as Record<string, unknown>).tool_name !== 'checkpoint' || !msg.content) return null;

  // Content format: "Checkpoint created: abc12345\n\nDescription: ...\nOriginal direction: ..."
  const idMatch = msg.content.match(/^Checkpoint created: ([a-z0-9]{8})/m);
  const descMatch = msg.content.match(/^Description: (.+)$/m);
  const dirMatch = msg.content.match(/^Original direction: (.+)$/m);
  if (idMatch) {
    return {
      id: idMatch[1],
      description: descMatch?.[1] || '',
      if_abandoned: dirMatch?.[1],
    };
  }

  return null;
}

/** Dependencies the CheckpointManager needs from the facade's private state. */
export interface CheckpointManagerDeps {
  /** Live view of the raw message array (always current — never a stale snapshot). */
  getMessages: () => Message[];
  /** Called by recap() with the truncation index; clears the pending ledger too. */
  onRecap: (startIndex: number) => void;
}

/**
 * Delegate for the checkpoint feature domain.
 * Returned by Triologue.getCheckpointManager(); callers interact with this
 * object for ALL checkpoint concerns (query + generate id + recap mutation).
 */
export class CheckpointManager {
  private deps: CheckpointManagerDeps;

  constructor(deps: CheckpointManagerDeps) {
    this.deps = deps;
  }

  /**
   * Find the last open checkpoint in message history
   * @returns Checkpoint info if found, null otherwise
   */
  findOpen(): CheckpointInfo | null {
    const messages = this.deps.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const result = parseCheckpointMessage(messages[i]);
      if (result) return result;
    }
    return null;
  }

  /**
   * Find all checkpoints in message history
   * @returns Array of checkpoint info
   */
  findAll(): CheckpointInfo[] {
    const checkpoints: CheckpointInfo[] = [];
    for (const msg of this.deps.getMessages()) {
      const result = parseCheckpointMessage(msg);
      if (result) checkpoints.push(result);
    }
    return checkpoints;
  }

  /**
   * Find a checkpoint by ID in message history.
   * Returns the index of the ASSISTANT message that originally called the checkpoint,
   * so that recap() can remove the entire span (assistant → checkpoint tool →
   * subtask → recap call → recap tool) and replace it with a single note().
   *
   * @param id - The checkpoint ID to find
   * @returns Checkpoint info with assistant message index if found, null otherwise
   */
  findById(id: string): CheckpointInfo & { index: number } | null {
    const messages = this.deps.getMessages();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const result = parseCheckpointMessage(msg);
      if (result && result.id === id) {
        // Scan backwards from the checkpoint tool message to find the
        // assistant message whose tool_calls include the checkpoint call.
        for (let j = i - 1; j >= 0; j--) {
          const candidate = messages[j];
          if (candidate.role === 'assistant' && candidate.tool_calls) {
            const hasCheckpointCall = candidate.tool_calls.some(
              (tc: { function: { name: string } }) => tc.function.name === 'checkpoint'
            );
            if (hasCheckpointCall) {
              return { id, description: result.description, if_abandoned: result.if_abandoned, index: j };
            }
          }
        }
        // Fallback: if no assistant found (shouldn't happen in normal flow),
        // return index after the checkpoint tool message.
        return { id, description: result.description, if_abandoned: result.if_abandoned, index: i + 1 };
      }
    }
    return null;
  }

  /**
   * Generate a random checkpoint ID (8 lowercase alphanumeric characters)
   */
  generateId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  /**
   * Truncate messages from startIndex onwards (inclusive).
   * Used by recap tool to remove the checkpoint span before appending ?recap, !recap.
   * @param startIndex - Index of checkpoint message (inclusive)
   */
  recap(startIndex: number): void {
    this.deps.onRecap(startIndex);
  }
}
