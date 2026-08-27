/**
 * triologue-lite.ts - Teammate-only simplified Triologue facade
 *
 * Used by child/teammate processes (src/context/teammate-worker.ts) instead of
 * the full Triologue (src/loop/triologue.ts). It composes the SAME submodule
 * layer (store / compact / pending-tools / tp-fix) but omits the lead-only
 * feature domains:
 *   - wrap-up lifecycle (ESC interrupt paths are main-process only)
 *   - checkpoint manager (checkpoint/recap is a lead-loop concern)
 *   - hint round (children request guidance via mail_to instead)
 *   - result-threshold longtext dump (teammates accept large tool results as-is)
 *   - loadRestoration / clear (teammate transcripts are write-only JSONL)
 *
 * NOTE ON CO-EVOLUTION: this facade and the full triologue.ts intentionally
 * keep their own copies of the append logic (user/note/agent/tool) so each can
 * evolve independently. The shared invariants they must BOTH preserve are:
 *   1. JSONL persistence format via options.onMessage — restoration.ts reads
 *      teammate transcripts ([READY] marker + fixOrphanedToolCalls).
 *   2. tool() must run TpAutoFixer for tool→tool gaps before ledger resolve.
 *   3. compact() must swap the store, recompute tokens, clear the ledger,
 *      and rebuildProjectContext() at the boundary.
 * If you change one of these in triologue.ts, check triologue-lite.ts too
 * (and vice versa).
 */

import type { Message, ToolCall, Tool, NoteCategory } from '../types.js';
import { TpAutoFixer } from './triologue/tp-fix.js';
import { MessageStore } from './triologue/store.js';
import { PendingToolLedger } from './triologue/pending-tools.js';
import { runAutoCompact as doRunAutoCompact } from './triologue/compact.js';
import type { Role, MisorderWarning, ToolAlignmentWarning, TriologueOptions } from './triologue/types.js';

export type { Role, MisorderWarning, ToolAlignmentWarning, TriologueOptions } from './triologue/types.js';

export class TriologueLite {
  private store: MessageStore = new MessageStore();
  private ledger: PendingToolLedger = new PendingToolLedger();
  private options: TriologueOptions & {
    tokenThreshold: number;
    onMisorder: (warning: MisorderWarning) => void;
    onToolMisalign: (warning: ToolAlignmentWarning) => void;
    onCompact: (transcriptPath: string) => void;
    onMessage: (messages: Message[]) => void;
    getWikiDomains?: () => Promise<Array<{ domain_name: string; description?: string }>>;
  };

  /**
   * TP-recovery delegate (see triologue/tp-fix.ts), wired the same way as the
   * full facade: deps are arrow closures over this facade's private
   * store/ledger — resolved lazily at call time.
   */
  private tpFix = new TpAutoFixer({
    injectBypass: (message: Message): void => {
      this.addMessage(message);
    },
    registerPending: (toolCalls: ToolCall[]): void => {
      this.ledger.register(toolCalls);
    },
    getPendingOrder: (): string[] => this.ledger.getOrder(),
    getPendingById: (id: string): ToolCall | undefined => this.ledger.getById(id),
    clearPending: (): void => {
      this.ledger.clear();
    },
  });

  constructor(options: TriologueOptions = {}) {
    const tokenThreshold = options.tokenThreshold ?? 50000;
    this.options = {
      tokenThreshold,
      onMisorder: options.onMisorder ?? this.defaultOnMisorder,
      onToolMisalign: options.onToolMisalign ?? this.defaultOnToolMisalign,
      onCompact: options.onCompact ?? this.defaultOnCompact,
      onMessage: options.onMessage ?? (() => {}),

      getWikiDomains: options.getWikiDomains ?? undefined,
    };
  }

  // === Lifecycle & Configuration ===

  /**
   * Set or update the system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.store.setSystemPrompt(prompt);
  }

  /**
   * Register a project-context populator.
   *
   * A populator is a `() => Message[]` closure that produces context pairs
   * (e.g. platform/calendar info) to inject between the system prompt and the
   * conversation. Callers register populators ONCE at startup;
   * rebuildProjectContext() re-invokes them at compact() boundaries so the
   * dynamic content is refreshed where the prompt-cache prefix changes anyway.
   *
   * @returns A disposer function that removes this populator (for cleanup/swap)
   */
  registerProjectContextPopulator(fn: () => Message[]): () => void {
    return this.store.registerPopulator(fn);
  }

  /**
   * Rebuild projectContext from scratch: clear it and re-invoke every
   * registered populator in registration order. Called internally by
   * compact() so dynamic context stays fresh across that boundary.
   *
   * Cache invariant: this only runs at compact time, where the conversation
   * prefix already changes, so rebuilding projectContext adds no additional
   * cache penalty. It must NOT be called mid-conversation (that would
   * invalidate the cached prefix every turn).
   */
  rebuildProjectContext(): void {
    this.store.rebuildProjectContext();
  }

  // === Message Producers ===

  /**
   * Add a user message (real user input - clears temporary hint)
   */
  user(content: string): void {
    const lastRole = this.getLastRole();
    if (lastRole === 'tool') {
      const fixResult = this.tpFix.handle('user_after_tool', lastRole, 'cannot add user message after tool role');
      if (fixResult === 'allowed') {
        // Provider supports tool → user natively — skip bridge, just append
        this.addMessage({ role: 'user', content });
        return;
      }
      // 'recovered': bridge was injected, fall through to add user message
    }
    if (lastRole === 'user') {
      // Combine: append to last user message, then fire onMessage so
      // the JSONL transcript records this combined state. Note: writing
      // combines into the same message creates duplicate content in the
      // transcript, but ensures every note()/user() call is recorded.
      const lastMsg = this.store.last()!;
      lastMsg.content += `\n${content}`;
      this.store.recomputeTokenCount();
      this.options.onMessage(this.store.getRaw());
      return;
    }
    // Track last real user query for auto-compact context preservation
    this.store.setLastUserQuery(content);
    this.addMessage({ role: 'user', content });
  }

  /**
   * Add a system-generated note message (not from actual user).
   * These are injected by the agent system for reminders, notifications, etc.
   * Internally uses role: 'user' with note_category metadata for filtering.
   * The category is prepended as a [TITLE] prefix on the content.
   *
   * @param category - The note category (REMINDER, HINT, URGENT, SYSTEM, MAIL)
   * @param message - The note content
   * @param hookName - Optional: the originating hook skill name. When set, the
   *   note is stored as a SEPARATE message (never combined with the last user
   *   message) and tagged with `hook_name`.
   */
  note(category: NoteCategory, message: string, hookName?: string): void {
    const lastRole = this.getLastRole();
    if (lastRole === 'tool') {
      const fixResult = this.tpFix.handle('note_after_tool', lastRole, 'cannot add note after tool role');
      if (fixResult === 'allowed') {
        // Provider supports tool → note natively — skip bridge, just append
        this.addMessage({ role: 'user', content: `[${category}] ${message}`, ...(hookName ? { hook_name: hookName } : {}) });
        return;
      }
      // 'recovered': bridge was injected, now lastRole is 'assistant'
    }
    const noteContent = `[${category}] ${message}`;
    // Hook-originated notes are always separate messages (never combined) so
    // each hook retains its own attribution in the minifier output.
    if (lastRole === 'user' && !hookName) {
      // Combine: append to last user message, then fire onMessage so
      // the JSONL transcript records this combined state.
      const lastMsg = this.store.last()!;
      lastMsg.content += `\n${noteContent}`;
      this.store.recomputeTokenCount();
      this.options.onMessage(this.store.getRaw());
      return;
    }
    this.addMessage({ role: 'user', content: noteContent, ...(hookName ? { hook_name: hookName } : {}) });
  }

  /**
   * Add a tool response message
   * @param functionName - The name of the tool that was called (becomes tool_name)
   * @param result - The result/output from the tool call (becomes content)
   * @param toolCallId - Optional ID from model's tool_calls (resolved from pending if not provided)
   */
  tool(functionName: string, result: string, toolCallId?: string): void {
    // Check for missing assistant with tool_calls
    const lastRole = this.getLastRole();
    if (lastRole !== 'assistant' && lastRole !== 'tool') {
      this.tpFix.handle('tool_no_assistant', lastRole, `cannot add tool message after ${lastRole} role (gap: missing_assistant)`);
      // Recovered: a synthetic assistant with tool_calls was injected.
      // After injection, the pending tool call map has an entry, but it's empty-named.
      // We need to update it so pending-ledger name resolution works for this functionName.
      this.ledger.updateLastName(functionName);
    }

    // NOTE: no result-threshold longtext dump here — teammates accept large
    // tool results as-is (model context window > TOKEN_THRESHOLD covers the
    // one-extra-result case; compaction handles the rest).

    // Resolve toolCallId if not provided
    let resolvedId = toolCallId;
    if (!resolvedId) {
      // Find the next pending tool call matching this function name
      resolvedId = this.ledger.findByName(functionName);
    }

    // Validate alignment
    this.ledger.validateAlignment(functionName, resolvedId, (w) => this.options.onToolMisalign(w));

    // Add the tool response with both tool_name and tool_call_id
    this.addMessage({
      role: 'tool',
      tool_name: functionName,
      content: result,
      tool_call_id: resolvedId,
    });

    // Remove from pending after adding result
    if (resolvedId) {
      this.ledger.resolve(resolvedId);
    }
  }

  /**
   * Add an assistant message
   */
  agent(content: string, toolCalls?: ToolCall[], reasoningContent?: string): void {
    const lastRole = this.getLastRole();

    // Reject invalid transitions
    if (lastRole === 'assistant') {
      this.tpFix.handle('duplicate_assistant', lastRole, 'cannot add assistant message after assistant role (duplicate)');
      // Recovered: pending tool calls cleared, fall through to add new assistant message
    }
    if (lastRole === 'system') {
      this.tpFix.handle('agent_after_system', lastRole, 'cannot add assistant message after system role');
      // Recovered: bridge user message injected, fall through to add assistant message
      // Note: lastRole is still 'system' locally, but the last message in the array
      // is now the bridge user message. getLastRole() would return 'user'.
    }

    this.addMessage({
      role: 'assistant',
      content: content || '',
      tool_calls: toolCalls,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    });

    // Track pending tool calls in order
    if (toolCalls) {
      this.ledger.register(toolCalls);
    }
  }

  // === Compaction ===

  /**
   * Check if auto-compact is needed.
   */
  needsCompact(): boolean {
    return this.store.tokenCount > this.options.tokenThreshold;
  }

  /**
   * Force auto-compact now
   * @param focus - Optional focus topic to include in summarization
   * @param signal - Optional AbortSignal to abort the summarization LLM call.
   *   When aborted, runAutoCompact's retryChat throws StreamAbortedError which
   *   propagates here — callers should catch it and treat compact as skipped.
   * @param tools - Optional full tool list for forkChat-based working-memory
   *   extraction. When provided (and non-empty), a concurrent forkChat forks
   *   from the full un-minified messages (with this tools schema, preserving
   *   the prompt cache) and extracts recent working memory, which is appended
   *   to the summary as a `### Recent Working Memory` section. When omitted or
   *   empty, falls back to summary-only (the historical behavior).
   */
  async compact(focus?: string, signal?: AbortSignal, tools?: Tool[]): Promise<void> {
    // Inline delegation to the compaction layer (triologue/compact.ts) via a
    // CompactDeps adapter over this facade's own state (single caller).
    const compacted = await doRunAutoCompact(
      {
        getRawMessages: () => this.store.getRaw(),
        getFullMessages: () => this.store.getFullMessages(),
        lastUserQuery: () => this.store.lastUserQuery,
        onCompact: (p) => this.options.onCompact(p),
        getWikiDomains: this.options.getWikiDomains,
      },
      focus,
      signal,
      tools,
    );
    this.store.replaceAll(compacted);
    this.store.recomputeTokenCount();
    this.ledger.clear();
    // Refresh dynamic project context at the compact boundary — the
    // conversation prefix already changed, so no extra cache penalty.
    // Populators re-read current state.
    this.rebuildProjectContext();
  }

  // === Accessors ===

  /**
   * Get messages with system prompt and project context prepended.
   *
   * Defensive filtering: any undefined / null / non-object entry that slipped
   * into `projectContext` or `messages` is dropped here at the source (same
   * chokepoint as the full facade's getMessages).
   */
  getMessages(): Message[] {
    return this.store.getFullMessages();
  }

  /**
   * Get raw messages array (no system prompt / project context).
   *
   * Defensive filtering: drops any undefined / null / non-object entry that
   * slipped into `messages`. Mirrors the guard in getMessages() so there is a
   * single chokepoint for ALL message access.
   */
  getMessagesRaw(): Message[] {
    return this.store.getRaw();
  }

  /**
   * Get last message role, or null if empty.
   * Defensive: skip any trailing undefined / sparse-hole entries so a
   * corrupted array tail cannot crash here with
   * "Cannot read properties of undefined (reading 'role')".
   */
  getLastRole(): Role | null {
    return this.store.lastRole();
  }

  /**
   * Get the last real user query (not system notes).
   */
  getLastUserQuery(): string {
    return this.store.lastUserQuery;
  }

  /**
   * Get current token count
   */
  getTokenCount(): number {
    return this.store.tokenCount;
  }

  /**
   * Get token threshold
   */
  getTokenThreshold(): number {
    return this.options.tokenThreshold;
  }

  // === Private Helpers ===

  /**
   * Add a message to the triologue.
   * Note: Auto-compact is NOT called here to avoid race conditions.
   * Overflow checking is done by the caller (teammate worker LLM stage).
   */
  private addMessage(message: Message): void {
    this.store.push(message);
    this.store.incrementTokenCount(message);

    // Call onMessage callback if set
    if (this.options.onMessage) {
      this.options.onMessage(this.store.getRaw());
    }
  }

  // === Default Callbacks ===

  // NOTE: unlike the full Triologue, the lite facade does NOT import agentIO
  // or loopEvents — child processes cannot use agentIO.brief() (it throws in
  // non-main processes), and loopEvents wiring is a lead-loop concern. The
  // defaults below keep warnings observable without those dependencies.

  private defaultOnMisorder(warning: MisorderWarning): void {
    // Best-effort stderr write: child processes have no terminal UI of their
    // own; stderr is captured by the parent's pipe and shown under -v.
     
    console.error(`[triologue-lite] Misordered transition: ${warning.from} → ${warning.to} (gap: ${warning.gap})`);
  }

  private defaultOnToolMisalign(warning: ToolAlignmentWarning): void {
     
    console.error(`[triologue-lite] Tool alignment issue: ${warning.functionName} (issue: ${warning.issue})`);
  }

  private defaultOnCompact(transcriptPath: string): void {
     
    console.error(`[triologue-lite] Auto-compact transcript saved: ${transcriptPath}`);
  }
}