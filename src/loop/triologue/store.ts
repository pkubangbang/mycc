/**
 * triologue/store.ts - Message storage layer for the Triologue facade
 *
 * Owns the conversation history array, token accounting, project context
 * populators, and the defensive sparse-hole filter that guards all message
 * access (DeepSeek provider crashes on undefined entries; Ollama's native
 * binding never reads .role from JS so it masks the issue).
 *
 * Extracted from triologue.ts (Phase 2 of the layered refactor).
 * Behavior is byte-identical: the facade delegates to this class.
 */

import type { Message } from '../../types.js';
import type { Role } from './types.js';
import { estimateTokens, estimateTokensForMessages } from '../../utils/token.js';
import { agentIO } from '../agent-io.js';

export class MessageStore {
  private messages: Message[] = [];
  private tokens: number = 0;
  private sysPrompt: string | null = null;

  // Project context files (in-memory only, not persisted)
  private projectContext: Message[] = [];

  /**
   * Populator registry: functions that produce project-context Message[] pairs.
   * Callers (agent-repl, hook-bootstrap) register closures ONCE at startup.
   * rebuildProjectContext() clears projectContext and re-invokes all populators
   * in registration order, so compact() and clear() can refresh dynamic content
   * (README, mindmap instruction, hook info) without external rebuild calls.
   * Each populator returns a Message[] (typically a user/assistant context pair).
   */
  private populators: Array<() => Message[]> = [];

  /**
   * The last real user query (not system notes).
   * Tracked to preserve user intent during auto-compaction.
   */
  private lastQuery: string = '';

  // === Conversation array access ===

  get length(): number {
    return this.messages.length;
  }

  at(index: number): Message | undefined {
    return this.messages[index];
  }

  /** Last element or undefined (defensive: skips sparse holes) */
  last(): Message | undefined {
    return this.messages[this.messages.length - 1];
  }

  /**
   * Last VALID role, skipping trailing sparse holes (undefined/null/non-object).
   * Defensive walk backwards so a corrupted array tail (e.g. from
   * length-manipulation or restore) cannot crash with
   * "Cannot read properties of undefined (reading 'role')".
   */
  lastRole(): Role | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m && typeof m === 'object' && m.role) return m.role as Role;
    }
    return null;
  }

  /**
   * Defensive raw copy: drops any undefined / null / non-object entry that
   * slipped into `messages` (e.g. via sparse-array length manipulation from
   * wrap-up rollback, TP auto-fixer injection, session restoration, or recap
   * slicing). Single chokepoint for ALL message access — unguarded raw
   * consumers (hint-round, minifier, checkpoint-recap) that read `.role` /
   * `.content` directly would otherwise throw "Cannot read properties of
   * undefined (reading 'role'/'content')".
   */
  getRaw(): Message[] {
    const result: Message[] = [];
    for (const m of this.messages) {
      if (m && typeof m === 'object' && m.role) result.push(m);
    }
    return result;
  }

  push(message: Message): void {
    this.messages.push(message);
  }

  /** Direct array-length truncation (wrap-up rollback). Instant and race-free. */
  truncateTo(mark: number): void {
    this.messages.length = mark;
  }

  replaceAll(messages: Message[]): void {
    this.messages = messages;
  }

  // === Token accounting ===

  get tokenCount(): number {
    return this.tokens;
  }

  incrementTokenCount(message: Message): void {
    const increment = estimateTokens(message);
    this.tokens += increment;
    agentIO.verbose('triologue', `Token count: ${this.tokens} (+${increment} from ${message.role})`);
  }

  recomputeTokenCount(): void {
    this.tokens = estimateTokensForMessages(this.messages);
  }

  resetTokenCount(): void {
    this.tokens = 0;
  }

  // === System prompt ===

  setSystemPrompt(prompt: string): void {
    this.sysPrompt = prompt;
  }

  get systemPrompt(): string | null {
    return this.sysPrompt;
  }

  // === Last user query ===

  setLastUserQuery(content: string): void {
    this.lastQuery = content;
  }

  get lastUserQuery(): string {
    return this.lastQuery;
  }

  // === Project context populators ===

  registerPopulator(fn: () => Message[]): () => void {
    this.populators.push(fn);
    return () => {
      const idx = this.populators.indexOf(fn);
      if (idx !== -1) this.populators.splice(idx, 1);
    };
  }

  rebuildProjectContext(): void {
    this.projectContext = [];
    for (const populator of this.populators) {
      try {
        const produced = populator();
        if (Array.isArray(produced)) {
          for (const m of produced) {
            if (m && typeof m === 'object' && m.role) this.projectContext.push(m);
          }
        }
      } catch (err) {
        agentIO.brief('error', 'triologue', `project-context populator failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Full message view for LLM calls: system prompt + project context +
   * filtered conversation. Same defensive filtering as getRaw().
   */
  getFullMessages(): Message[] {
    const result: Message[] = [];

    if (this.sysPrompt) {
      result.push({ role: 'system', content: this.sysPrompt });
    }

    // Inject project context (README, mindmap instructions, etc.)
    for (const m of this.projectContext) {
      if (m && typeof m === 'object' && m.role) result.push(m);
    }

    // Conversation history
    for (const m of this.messages) {
      if (m && typeof m === 'object' && m.role) result.push(m);
    }

    return result;
  }
}