/**
 * triologue.ts - Message management with auto-compact and role validation
 *
 * Triologue manages the conversation history (messages) with:
 * - Automatic compaction when token threshold exceeded
 * - Role transition validation (detect misordered messages)
 * - Bridge response generation for gaps
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Message, ToolCall, Tool, NoteCategory } from '../types.js';
import { ResultTooLargeError } from '../types.js';
import { getLongtextDir, ensureDirs } from '../config.js';
import { agentIO } from './agent-io.js';
import { TpAutoFixer } from './triologue/tp-fix.js';
import { loopEvents } from './loop-events.js';
import type { Role, MisorderWarning, ToolAlignmentWarning, TriologueOptions } from './triologue/types.js';

export type { Role, MisorderWarning, ToolAlignmentWarning, TriologueOptions, CheckpointInfo } from './triologue/types.js';
export { CheckpointManager } from './triologue/checkpoint.js';
export { HintRoundManager } from './triologue/hint-round.js';

import { MessageStore } from './triologue/store.js';
import { PendingToolLedger } from './triologue/pending-tools.js';
import { runAutoCompact as doRunAutoCompact } from './triologue/compact.js';
import { CheckpointManager } from './triologue/checkpoint.js';
import { HintRoundManager } from './triologue/hint-round.js';
import { WrapUpManager } from './triologue/wrap-up.js';

export class Triologue {
  private store: MessageStore = new MessageStore();
  private ledger: PendingToolLedger = new PendingToolLedger();
  private options: TriologueOptions & {
    tokenThreshold: number;
    resultThreshold: number;
    hintThreshold: number;
    onMisorder: (warning: MisorderWarning) => void;
    onToolMisalign: (warning: ToolAlignmentWarning) => void;
    onCompact: (transcriptPath: string) => void;
    onMessage: (messages: Message[]) => void;
  };

  /**
   * Wrap-up management (see triologue/wrap-up.ts): marks the message index
   * at which a wrap-up turn started, enabling commit/rollback within a
   * grace period. Delegated to WrapUpManager; the facade retains the
   * message-side operations (append WRAP_UP message, truncate store).
   */
  private wrapUp: WrapUpManager = new WrapUpManager();

  /**
   * Checkpoint feature domain delegate (see triologue/checkpoint.ts).
   * Created lazily via getCheckpointManager(); bound to the live message
   * store so callers always see the current history.
   */
  private checkpointManager: CheckpointManager | null = null;

  /**
   * Hint-round feature domain delegate (see triologue/hint-round.ts).
   * Created lazily via getHintRoundManager(); bound to the live message
   * store so callers always see the current history (including
   * compact/clear/restore swaps).
   */
  private hintRoundManager: HintRoundManager | null = null;

  /**
   * TP-recovery delegate (see triologue/tp-fix.ts). Owns both the recovery
   * dispatch and the --debug-tp violation-throw path, so the facade keeps
   * no TP-recovery logic of its own. Deps are arrow closures over this
   * facade's private store/ledger — resolved lazily at call time.
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
    const hintThreshold = options.hintThreshold ?? 10;
    const tokenThreshold = options.tokenThreshold ?? 50000;
    this.options = {
      tokenThreshold,
      // default value is about half the TOKEN_THRESHOLD, so there won't be
      // "big blocks" that take more than half of the ctx length.
      resultThreshold: options.resultThreshold ?? Math.floor(tokenThreshold / 2),
      hintThreshold,
      onMisorder: options.onMisorder ?? this.defaultOnMisorder,
      onToolMisalign: options.onToolMisalign ?? this.defaultOnToolMisalign,
      onCompact: options.onCompact ?? this.defaultOnCompact,
      onMessage: options.onMessage ?? (() => {}),

      getWikiDomains: options.getWikiDomains ?? undefined,
      getDuplicationReport: options.getDuplicationReport,
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
   * (e.g. README, mindmap instruction, hook info) to inject between the
   * system prompt and the conversation. Callers register populators ONCE at
   * startup; rebuildProjectContext() re-invokes all of them, so the dynamic
   * content they produce is refreshed at compact()/clear() boundaries (where
   * the conversation prefix already changes, so no additional cache penalty).
   *
   * @returns A disposer function that removes this populator (for cleanup/swap)
   */
  registerProjectContextPopulator(fn: () => Message[]): () => void {
    return this.store.registerPopulator(fn);
  }

  /**
   * Rebuild projectContext from scratch: clear it and re-invoke every
   * registered populator in registration order. Called internally by
   * compact() and clear() so dynamic context (README, mindmap, hooks) stays
   * fresh across those boundaries without external rebuild calls.
   *
   * Cache invariant: this only runs at compact/clear time, where the
   * conversation prefix already changes, so rebuilding projectContext adds no
   * additional cache penalty. It must NOT be called mid-conversation (that
   * would invalidate the cached prefix every turn).
   */
  rebuildProjectContext(): void {
    this.store.rebuildProjectContext();
  }

  /**
   * Load a single restoration pair into the triologue without triggering onMessage callback.
   * Used during session restoration to preload summary context.
   * @param pair - A [user_message, assistant_message] tuple
   */
  loadRestoration(pair: [Message, Message]): void {
    this.store.push(pair[0]);
    this.store.incrementTokenCount(pair[0]);
    this.store.push(pair[1]);
    this.store.incrementTokenCount(pair[1]);
  }

  /**
   * Clear all messages and reset state
   * Called by /clear command
   */
  clear(): void {
    this.store.replaceAll([]);
    this.store.resetTokenCount();
    this.ledger.clear();
    this.wrapUp.reset();
    // Fresh start: rebuild dynamic project context from populators so the
    // cleared conversation still carries current README/mindmap/hook state.
    this.rebuildProjectContext();
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
      // Track the merged user query so auto-compact preserves the
      // complete user intent, not just the pre-merge fragment. Without
      // this, a compact right after a merge loses the latest instruction.
      this.store.setLastUserQuery(lastMsg.content);
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
   *   message) and tagged with `hook_name` so the minifier can emit `ux[hookName]|`.
   *   This preserves per-hook attribution when multiple hooks fire in one move.
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

    // Check result size threshold
    const threshold = this.options.resultThreshold;
    if (result.length > threshold) {
      // Dump to file
      ensureDirs();
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      const filename = `${functionName}_${timestamp}_${randomSuffix}.txt`;
      const filepath = path.join(getLongtextDir(), filename);

      // Add header explaining why this file was created
      const header = `[DUMPED TOOL RESULT]\n` +
        `Tool: ${functionName}\n` +
        `Reason: Result exceeded ${threshold} char threshold (${result.length} chars)\n` +
        `Time: ${new Date(timestamp).toISOString()}\n` +
        `Use read_read tool to summarize, or bash with head/tail to read.\n` +
        `---\n\n`;
      fs.writeFileSync(filepath, header + result, 'utf-8');

      // Throw error with file reference
      throw new ResultTooLargeError(
        functionName,
        filepath,
        result.length,
        threshold,
        result.slice(0, 1000)  // First 1000 chars as preview
      );
    }

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

  /**
   * Skip all pending tool calls with placeholder results.
   * Called when ESC interrupts tool execution.
   *
   * API NOTE (Phase 2.5 audit correction): this method HAS an external
   * consumer — states/tool.ts ESC path (flush remaining pending calls to
   * maintain TP parity before STOP). It therefore stays PUBLIC; the earlier
   * "internal-only" classification was wrong. Documented for accuracy.
   *
   * @param firstMessage - Message for the first interrupted tool
   * @param subsequentMessage - Message for remaining skipped tools (defaults to firstMessage)
   */
  skipPendingTools(firstMessage: string, subsequentMessage?: string): void {
    let isFirst = true;
    for (const id of this.ledger.getOrder()) {
      const tc = this.ledger.getById(id);
      if (tc) {
        const msg = isFirst ? firstMessage : (subsequentMessage || firstMessage);
        this.addMessage({
          role: 'tool',
          tool_name: tc.function.name,
          content: msg,
          tool_call_id: id,
        });
        isFirst = false;
      }
    }
    this.ledger.clear();
  }

  // === Compaction ===

  /**
   * Check if auto-compact is needed.
   * Called by the LLM stage (llm.ts) to detect context overflow.
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
   *   empty, falls back to summary-only (the historical behavior). Callers at
   *   the LLM stage pass `loader.getToolsForScope(scope)` so the fork hits the
   *   exact cache prefix the next LLM call will use.
   */
  async compact(focus?: string, signal?: AbortSignal, tools?: Tool[]): Promise<void> {
    // Inline delegation to the compaction layer (triologue/compact.ts) via a
    // CompactDeps adapter over the facade's own state (single caller).
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
    // Compaction replaces the entire conversation with a 2-message summary,
    // invalidating any active wrap-up turn: the context the wrap-up was part
    // of no longer exists. Without this reset, a stale wrapUpMark (still
    // pointing at the pre-compact length, e.g. 50) would let a later
    // rollbackWrapUp() do `this.messages.length = 50` on the now-2-element
    // array, stretching it with undefined sparse holes that crash the next
    // raw reader (minifyMessages in runAutoCompact, or checkpoint iteration)
    // with "Cannot read properties of undefined (reading 'role')".
    this.wrapUp.reset();
    // Refresh dynamic project context (README, mindmap, hooks) at the compact
    // boundary — the conversation prefix already changed, so no extra cache
    // penalty. Populators re-read current state (e.g. newly-compiled hooks).
    this.rebuildProjectContext();
  }

  /**
   * Generate a hint round with problem analysis
   * Adds user message with analysis (single LLM call, no acknowledgment)
   * Note: Confusion tracking is now handled by ctx.core, not by Triologue
   * @param abortController - Abort controller for ESC handling
   * @param confusionScore - Current confusion score
   * @param confusionBreakdown - Breakdown of confusion factors
   * @param pendingSkills - Skills with 'when' but no compiled condition (for notification)
   * @returns 'aborted' if ESC was pressed, 'success' if the hint was injected,
   *   'compact' if the LLM signalled should_compact (caller triggers compaction).
   */
  async generateHintRound(
    abortController: AbortController,
    confusionScore: number,
    confusionBreakdown: string,
    pendingSkills?: string[]
  ): Promise<'aborted' | 'success' | 'compact'> {
    return this.getHintRoundManager().generate(abortController, confusionScore, confusionBreakdown, pendingSkills);
  }

  // === Wrap-Up Management (ESC interrupt) ===

  /**
   * Begin a wrap-up turn after ESC interrupt.
   * Adds a WRAP_UP user message as a SEPARATE message (never combines with
   * the last user message), ensuring rollbackWrapUp() can work via simple
   * array truncation.
   *
   * If there are stale pending tool calls (e.g., ESC was pressed during tool
   * execution), flushes them via skipPendingTools to maintain TP parity before
   * adding the wrap-up message. Safe to call regardless of current last role.
   */
  beginWrapUp(): void {
    if (this.wrapUp.isActive) return; // already in wrap-up
    // If there are stale pending tool calls (e.g., ESC pressed during tool
    // execution before skipPendingTools resolved them), flush them now to
    // maintain TP parity before adding the WRAP_UP user message.
    if (this.ledger.size > 0) {
      this.skipPendingTools(
        'Tool use interrupted - user pressed ESC.',
        'Tool use skipped due to ESC interruption.',
      );
    }
    this.wrapUp.begin(this.store.length);
    // Always add as SEPARATE message (never combine with last user)
    this.addMessage({
      role: 'user',
      content: `[WRAP_UP] LLM call interrupted. Please wrap up quickly and ask user for next steps.`,
    });
  }

  /**
   * Complete the wrap-up turn with an agent response.
   * The wrapUpMark is kept so rollbackWrapUp() can still undo both the
   * user_wrap and agent_wrap messages during the grace period.
   * This is safe to call even after rollbackWrapUp() has already been
   * called (wrapUpMark === -1) — it becomes a no-op.
   *
   * @param content - The assistant's wrap-up response
   */
  finishWrapUp(content: string): void {
    if (!this.wrapUp.isActive) return; // already committed or rolled back
    // Direct push to bypass TP check (we know last role is user_wrap or tool)
    const message: Message = { role: 'assistant', content };
    this.store.push(message);
    this.store.incrementTokenCount(message);
    if (this.options.onMessage) {
      this.options.onMessage(this.store.getRaw());
    }
    // mark stays — allows rollback to remove both user_wrap and agent_wrap
  }

  /**
   * Permanently keep the wrap-up turn (user_wrap + agent_wrap).
   * Clears the mark so future rollbackWrapUp() calls are no-ops.
   */
  commitWrapUp(): void {
    this.wrapUp.commit();
  }

  /**
   * Roll back the wrap-up turn, removing all messages added since beginWrapUp().
   * Truncates messages to the recorded wrapUpMark via simple array .length,
   * which is instant and race-free.
   * Also clears pending tool calls since any from the wrap-up turn are invalid.
   */
  rollbackWrapUp(): void {
    if (!this.wrapUp.isActive) return; // nothing to roll back
    const mark = this.wrapUp.value;
    // Guard: never STRETCH the array. Normally mark <= messages.length
    // (it was set to the length before the wrap-up messages were appended).
    // But if the array was replaced/shortened between beginWrapUp and this
    // call (e.g. compact() swapped in a 2-message summary), mark could
    // exceed the current length — assigning it would fill the gap with
    // undefined sparse holes. Truncate only; if the mark is stale and past
    // the end, the array is already shorter, so clearing it fully (length=0
    // would lose the compacted summary) is wrong — instead, leave the array
    // as-is (the wrap-up messages are already gone) and just reset the mark.
    if (mark < this.store.length) {
      this.truncateAndRecount(mark);
    } else {
      // Mark is stale and past the end: the array is already shorter, so
      // truncating further is wrong — just recount and clear the ledger.
      this.store.recomputeTokenCount();
      this.ledger.clear();
    }
    this.wrapUp.reset();
  }

  /**
   * Check if a wrap-up turn is currently active (beginWrapUp was called
   * but not yet committed or rolled back).
   */
  hasActiveWrapUp(): boolean {
    return this.wrapUp.isActive;
  }

  // === Accessors ===

  /**
   * Get messages with system prompt and project context prepended.
   *
   * Defensive filtering: any undefined / null / non-object entry that slipped
   * into `projectContext` or `messages` (e.g. via sparse-array length
   * manipulation, wrap-up rollback, TP auto-fixer injection, or session
   * restoration) is dropped here at the source. This prevents the DeepSeek
   * provider from crashing with "Cannot read properties of undefined
   * (reading 'role')" — a DeepSeek-specific failure because the Ollama
   * native binding never reads `.role` from JS. The filter keeps a single
   * chokepoint rather than guarding every possible producer of a hole.
   */
  getMessages(): Message[] {
    return this.store.getFullMessages();
  }

  /**
   * Get raw messages array (for hint round context interface).
   *
   * Defensive filtering: drops any undefined / null / non-object entry that
   * slipped into `messages` (e.g. via sparse-array length manipulation from
   * wrap-up rollback, TP auto-fixer injection, session restoration, or recap
   * slicing). Without this, unguarded raw consumers (hint-round, minifier,
   * checkpoint-recap) that read `.role` / `.content` directly would throw
   * "Cannot read properties of undefined (reading 'role'/'content')" — an
   * intermittent error surfaced most often in the COLLECT state because that
   * is where hint-round runs. Mirrors the guard already present in
   * getMessages() so there is a single chokepoint for ALL message access.
   */
  getMessagesRaw(): Message[] {
    return this.store.getRaw();
  }

  /**
   * Get the duplication report from the embedding tracker (for hint round context interface)
   */
  getDuplicationReport(): string {
    return this.options.getDuplicationReport ? this.options.getDuplicationReport() : '';
  }


  /**
   * Get last message role, or null if empty.
   * Defensive: skip any trailing undefined / sparse-hole entries so a
   * corrupted array tail (e.g. from length-manipulation or restore) cannot
   * crash here with "Cannot read properties of undefined (reading 'role')".
   */
  getLastRole(): Role | null {
    return this.store.lastRole();
  }

  /**
   * Get the last real user query (not system notes).
   * Used by auto-compact to preserve user intent in the summary.
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

  // === Feature Domain Delegates ===

  /**
   * Get the checkpoint feature-domain delegate (see triologue/checkpoint.ts).
   *
   * Checkpoint is an isolated feature domain: instead of the facade offering
   * individual passthrough methods (findOpenCheckpoint/findCheckpointById/
   * findAllCheckpoints/generateCheckpointId/recapMessages), callers obtain
   * this delegate ONCE and interact with it directly for all checkpoint
   * concerns (queries, id generation, and the recap span truncation).
   *
   * The manager is bound to the live message store, so it always reflects
   * the current history (including compact/clear/restore swaps). It is
   * memoized — repeated calls return the same instance.
   */
  getCheckpointManager(): CheckpointManager {
    if (!this.checkpointManager) {
      this.checkpointManager = new CheckpointManager({
        getMessages: () => this.store.getRaw(),
        onRecap: (startIndex: number) => this.truncateAndRecount(startIndex),
      });
    }
    return this.checkpointManager;
  }

  /**
   * Get the hint-round feature-domain delegate (see triologue/hint-round.ts).
   *
   * Hint-round is an isolated feature domain: instead of the facade owning the
   * LLM problem-analysis logic, callers obtain this delegate ONCE and interact
   * with it directly (generate a hint round + inject the HINT note). The
   * facade's generateHintRound() is a thin delegation to this manager so the
   * public method signature (used by collect.ts and test mocks) stays stable.
   *
   * The manager is bound to the live message store + note() injector + the
   * optional wiki-domain and duplication-report callbacks, so it always
   * reflects the current history (including compact/clear/restore swaps). It
   * is memoized — repeated calls return the same instance.
   */
  getHintRoundManager(): HintRoundManager {
    if (!this.hintRoundManager) {
      this.hintRoundManager = new HintRoundManager({
        getMessagesRaw: () => this.store.getRaw(),
        note: (category: NoteCategory, message: string) => this.note(category, message),
        getWikiDomains: this.options.getWikiDomains,
        getDuplicationReport: this.options.getDuplicationReport,
      });
    }
    return this.hintRoundManager;
  }

  // === Private Helpers ===

  /**
   * Truncate the message store to `index` (exclusive of later messages),
   * recalculate the token count from the kept messages, and clear the
   * pending tool ledger (any pending calls from the removed span are now
   * invalid). Used by recap span removal and wrap-up rollback.
   */
  private truncateAndRecount(startIndex: number): void {
    this.store.truncateTo(startIndex);
    this.store.recomputeTokenCount();
    this.ledger.clear();
  }

  /**
   * Add a message to the triologue.
   * Note: Auto-compact is NOT called here to avoid race conditions.
   * Overflow checking is done in the LLM stage (llm.ts) before each call.
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

  private defaultOnMisorder(warning: MisorderWarning): void {
    // Observability: emit triologue_event (silent when no listeners)
    loopEvents.emit('triologue_event', {
      kind: 'misorder',
      detail: `${warning.from} → ${warning.to} (gap: ${warning.gap})`,
    });
    agentIO.brief('warn', 'triologue', `Misordered transition: ${warning.from} → ${warning.to}`, `gap: ${warning.gap}`);
  }

  private defaultOnToolMisalign(warning: ToolAlignmentWarning): void {
    // Observability: emit triologue_event (silent when no listeners)
    loopEvents.emit('triologue_event', {
      kind: 'tool_misalign',
      detail: `${warning.functionName} (issue: ${warning.issue})`,
    });
    agentIO.brief('warn', 'triologue', `Tool alignment issue: ${warning.functionName}`, `issue: ${warning.issue}`);
  }

  private defaultOnCompact(transcriptPath: string): void {
    // Observability: emit triologue_event (silent when no listeners)
    loopEvents.emit('triologue_event', {
      kind: 'compact',
      detail: `Transcript saved: ${transcriptPath}`,
    });
    agentIO.brief('info', 'autoCompact', `Transcript saved: ${transcriptPath}`);
  }
}