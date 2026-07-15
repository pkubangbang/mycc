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
import { retryChat, MODEL } from '../engine/chat-provider.js';
import type { Message, ToolCall, WikiModule, NoteCategory, Skill } from '../types.js';
import { minifyMessages } from '../utils/llm-chat-minifier.js';
import { estimateTokens, estimateTokensForMessages } from '../utils/token.js';
import { ResultTooLargeError } from '../types.js';
import { getLongtextDir, ensureDirs, getTokenThreshold, isDebuggingTp, getSessionContext, getSessionDir } from '../config.js';
import { agentIO } from './agent-io.js';
import { attemptAutoFix } from './tp-auto-fixer.js';

type Role = 'system' | 'user' | 'assistant' | 'tool';

interface MisorderWarning {
  from: Role;
  to: Role;
  gap: 'missing_assistant' | 'missing_tool_response' | 'unexpected_duplicate' | 'invalid_sequence';
  context: { lastMessage?: Message; newMessage?: Partial<Message> };
}

interface ToolAlignmentWarning {
  functionName: string;
  toolCallId?: string;
  issue: 'no_pending_calls' | 'id_not_found' | 'name_mismatch' | 'orphan_result';
  expectedId?: string;
  expectedName?: string;
}

interface TriologueOptions {
  /** Token threshold for auto-compact (default: 50000) */
  tokenThreshold?: number;
  /** Result size threshold in chars (default: 20000) */
  resultThreshold?: number;
  /** Message threshold for hint round (default: 10) */
  hintThreshold?: number;
  /** Called when misordered role transition detected */
  onMisorder?: (warning: MisorderWarning) => void;
  /** Called when tool call/result alignment issue detected */
  onToolMisalign?: (warning: ToolAlignmentWarning) => void;
  /** Called when auto-compact is triggered */
  onCompact?: (transcriptPath: string) => void;
  /** Called after each message is added */
  onMessage?: (messages: Message[]) => void;

  /** Wiki module for domain list during compact */
  wiki?: WikiModule;
  /** Optional duplication report provider for hint round */
  getDuplicationReport?: () => string;
}

import { generateHintRound as doHintRound } from './hint-round.js';

export class Triologue {
  private messages: Message[] = [];
  private pendingToolCalls: Map<string, ToolCall> = new Map();
  private pendingToolCallOrder: string[] = []; // Track order for sequential resolution
  private tokenCount: number = 0;
  private systemPrompt: string | null = null;
  private options: Required<Omit<TriologueOptions, 'wiki' | 'getDuplicationReport'>> & Pick<TriologueOptions, 'wiki' | 'getDuplicationReport'>;
  // Project context files (in-memory only, not persisted)
  private projectContext: Message[] = [];

  /**
   * The last real user query (not system notes).
   * Tracked to preserve user intent during auto-compaction.
   */
  private lastUserQuery: string = '';

  /**
   * Wrap-up management: marks the message index at which a wrap-up turn started.
   * - beginWrapUp() sets this to messages.length, adds a WRAP_UP user message
   * - finishWrapUp() adds an agent message (keeps mark for potential rollback)
   * - commitWrapUp() clears the mark (keep wrap-up permanently)
   * - rollbackWrapUp() truncates messages to this mark (remove wrap-up turn)
   * Value of -1 means no active wrap-up.
   */
  private wrapUpMark: number = -1;

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

      wiki: options.wiki,
      getDuplicationReport: options.getDuplicationReport,
    };
  }

  // === Core API ===

  /**
   * Set or update the system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Set README.md content (project context)
   * Appends context pair to project context (appears after MYCC.md if both set)
   * If content is too large, skips it entirely.
   */
  setReadmeMd(content: string): void {
    // Use 10% of TOKEN_THRESHOLD (converted to chars) as max size
    const maxChars = Math.floor(getTokenThreshold() * 4 * 0.1);
    if (content.length > maxChars) {
      agentIO.brief('info', 'triologue', 'README.md is too large to load, skipping');
      return;
    }
    this.projectContext.push(
      { role: 'user', content: `[Project Context - README.md from project root, FYI]\n\n${content}` },
      { role: 'assistant', content: 'Understood. I have read the project context from README.md.' }
    );
  }

  /**
   * Add instruction when mindmap is loaded
   * Tells LLM to use the recall tool to explore the mindmap
   */
  setMindmapInstruction(): void {
    this.projectContext.push(
      { role: 'user', content: '[System] A mindmap (knowledge tree) is available. Use the `recall` tool to explore it. Start with `recall("/")` to see top-level nodes, then drill down into children. The mindmap contains compiled project knowledge and guidance.' },
      { role: 'assistant', content: 'Understood. I will use the recall tool to explore the mindmap. Starting with recall("/") to see the top-level structure.' }
    );
  }

  /**
   * Add instruction when no mindmap exists
   * Tells LLM to read MYCC.md directly and NOT use the recall tool
   */
  setNoMindmapInstruction(): void {
    this.projectContext.push(
      { role: 'user', content: '[System] No mindmap found. Please read MYCC.md to understand the project context and structure. IMPORTANT: The recall tool will not work without a mindmap, so do NOT use it. Use read_file tool to explore MYCC.md instead.' },
      { role: 'assistant', content: 'Understood. I will read MYCC.md using read_file to understand the project. I will NOT use the recall tool since no mindmap is available.' }
    );
  }

  /**
   * Add instructions for pending hookish skills (skills with "when" but no compiled condition).
   * Lists each pending skill with its name, description, and when-condition, along with
   * the skill_compile command to activate it. Only adds content if there are pending skills.
   *
   * Injected into projectContext so the LLM always sees which hooks could be activated
   * - closing the gap on fresh installations where hooks are loaded but not yet compiled.
   */
  setPendingHooksInfo(hooks: Skill[]): void {
    if (hooks.length === 0) return;

    const lines: string[] = [
      '[Hooks Pending] The following skills have "when" conditions that can be compiled into proactive hooks. They are NOT active yet - use skill_compile to activate them:',
      '',
    ];

    for (const hook of hooks) {
      lines.push(`- ${hook.name}: ${hook.description}`);
      if (hook.when) {
        lines.push(`  When: ${hook.when}`);
      }
      if (hook.keywords && hook.keywords.length > 0) {
        lines.push(`  Keywords: ${hook.keywords.join(', ')}`);
      }
      lines.push(`  Activate: skill_compile(name="${  hook.name  }")`);
      lines.push('');
    }

    lines.push('Not all hooks need to be compiled upfront. Only compile the ones relevant to your current task. A compiled hook stays in effect until the skill file changes.');
    lines.push('');

    this.projectContext.push(
      { role: 'user', content: lines.join('\n') },
      { role: 'assistant', content: 'Understood. I know which hooks are available but not yet active. I can compile them when needed using the skill_compile tool.' }
    );
  }

  /**
   * Add a user message (real user input - clears temporary hint)
   */
  user(content: string): void {
    const lastRole = this.getLastRole();
    if (lastRole === 'tool') {
      const fixResult = attemptAutoFix(this, 'user_after_tool', lastRole);
      if (fixResult === 'debug_throw') {
        this.throwTpViolation('cannot add user message after tool role');
      }
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
      const lastMsg = this.messages[this.messages.length - 1];
      lastMsg.content += `\n${content}`;
      this.tokenCount = estimateTokensForMessages(this.messages);
      this.options.onMessage(this.messages);
      return;
    }
    // Track last real user query for auto-compact context preservation
    this.lastUserQuery = content;
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
      const fixResult = attemptAutoFix(this, 'note_after_tool', lastRole);
      if (fixResult === 'debug_throw') {
        this.throwTpViolation('cannot add note after tool role');
      }
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
      const lastMsg = this.messages[this.messages.length - 1];
      lastMsg.content += `\n${noteContent}`;
      this.tokenCount = estimateTokensForMessages(this.messages);
      this.options.onMessage(this.messages);
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
      if (attemptAutoFix(this, 'tool_no_assistant', lastRole) === 'debug_throw') {
        this.throwTpViolation(`cannot add tool message after ${lastRole} role (gap: missing_assistant)`);
      }
      // Recovered: a synthetic assistant with tool_calls was injected.
      // After injection, the pending tool call map has an entry, but it's empty-named.
      // We need to update it so findPendingToolCall works for this functionName.
      // Update the last pending tool call entry with the correct function name.
      this.updateLastPendingToolCall(functionName);
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
      resolvedId = this.findPendingToolCall(functionName);
    }

    // Validate alignment
    this.validateToolAlignment(functionName, resolvedId);

    // Add the tool response with both tool_name and tool_call_id
    this.addMessage({
      role: 'tool',
      tool_name: functionName,
      content: result,
      tool_call_id: resolvedId,
    });

    // Remove from pending after adding result
    if (resolvedId && this.pendingToolCalls.has(resolvedId)) {
      this.pendingToolCalls.delete(resolvedId);
      this.pendingToolCallOrder = this.pendingToolCallOrder.filter(id => id !== resolvedId);
    }
  }

  /**
   * Skip all pending tool calls with placeholder results.
   * Called when ESC interrupts tool execution.
   * @param firstMessage - Message for the first interrupted tool
   * @param subsequentMessage - Message for remaining skipped tools (defaults to firstMessage)
   */
  skipPendingTools(firstMessage: string, subsequentMessage?: string): void {
    let isFirst = true;
    for (const id of this.pendingToolCallOrder) {
      const tc = this.pendingToolCalls.get(id);
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
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
  }

  /**
   * Find pending tool call by function name (returns first match in order)
   */
  private findPendingToolCall(functionName: string): string | undefined {
    for (const id of this.pendingToolCallOrder) {
      const tc = this.pendingToolCalls.get(id);
      if (tc && tc.function.name === functionName) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Validate tool call/result alignment
   */
  private validateToolAlignment(functionName: string, toolCallId?: string): void {
    // No pending tool calls at all - orphan result
    if (this.pendingToolCalls.size === 0) {
      this.options.onToolMisalign({
        functionName,
        toolCallId,
        issue: 'no_pending_calls',
      });
      return;
    }

    // toolCallId provided but not found in pending
    if (toolCallId && !this.pendingToolCalls.has(toolCallId)) {
      this.options.onToolMisalign({
        functionName,
        toolCallId,
        issue: 'id_not_found',
      });
      return;
    }

    // toolCallId provided but name mismatch
    if (toolCallId) {
      const tc = this.pendingToolCalls.get(toolCallId);
      if (tc && tc.function.name !== functionName) {
        this.options.onToolMisalign({
          functionName,
          toolCallId,
          issue: 'name_mismatch',
          expectedName: tc.function.name,
        });
      }
    }
  }

  /**
   * Add an assistant message
   */
  agent(content: string, toolCalls?: ToolCall[], reasoningContent?: string): void {
    const lastRole = this.getLastRole();

    // Reject invalid transitions
    if (lastRole === 'assistant') {
      if (attemptAutoFix(this, 'duplicate_assistant', lastRole) === 'debug_throw') {
        this.throwTpViolation('cannot add assistant message after assistant role (duplicate)');
      }
      // Recovered: pending tool calls cleared, fall through to add new assistant message
    }
    if (lastRole === 'system') {
      if (attemptAutoFix(this, 'agent_after_system', lastRole) === 'debug_throw') {
        this.throwTpViolation('cannot add assistant message after system role');
      }
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
      for (const tc of toolCalls) {
        this.pendingToolCalls.set(tc.id, tc);
        this.pendingToolCallOrder.push(tc.id);
      }
    }
  }

  /**
   * Force auto-compact now
   * @param focus - Optional focus topic to include in summarization
   * @param signal - Optional AbortSignal to abort the summarization LLM call.
   *   When aborted, runAutoCompact's retryChat throws StreamAbortedError which
   *   propagates here — callers should catch it and treat compact as skipped.
   */
  async compact(focus?: string, signal?: AbortSignal): Promise<void> {
    const compacted = await this.runAutoCompact(focus, signal);
    this.messages = compacted;
    this.tokenCount = estimateTokensForMessages(this.messages);
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
  }

  /**
   * Check if auto-compact is needed.
   * Called by tool.ts after each tool execution to detect context overflow.
   */
  needsCompact(): boolean {
    return this.tokenCount > this.options.tokenThreshold;
  }

  /**
   * Clear all messages and reset state
   * Called by /clear command
   */
  clear(): void {
    this.messages = [];
    this.tokenCount = 0;
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
    this.wrapUpMark = -1;
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
    if (this.wrapUpMark !== -1) return; // already in wrap-up
    // If there are stale pending tool calls (e.g., ESC pressed during tool
    // execution before skipPendingTools resolved them), flush them now to
    // maintain TP parity before adding the WRAP_UP user message.
    if (this.pendingToolCalls.size > 0) {
      this.skipPendingTools(
        'Tool use interrupted - user pressed ESC.',
        'Tool use skipped due to ESC interruption.',
      );
    }
    this.wrapUpMark = this.messages.length;
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
    if (this.wrapUpMark === -1) return; // already committed or rolled back
    // Direct push to bypass TP check (we know last role is user_wrap or tool)
    this.messages.push({ role: 'assistant', content });
    this.updateTokenCount(this.messages[this.messages.length - 1]);
    if (this.options.onMessage) {
      this.options.onMessage(this.messages);
    }
    // wrapUpMark stays — allows rollback to remove both user_wrap and agent_wrap
  }

  /**
   * Permanently keep the wrap-up turn (user_wrap + agent_wrap).
   * Clears the wrapUpMark so future rollbackWrapUp() calls are no-ops.
   */
  commitWrapUp(): void {
    this.wrapUpMark = -1;
  }

  /**
   * Roll back the wrap-up turn, removing all messages added since beginWrapUp().
   * Truncates messages to the recorded wrapUpMark via simple array .length,
   * which is instant and race-free.
   * Also clears pending tool calls since any from the wrap-up turn are invalid.
   */
  rollbackWrapUp(): void {
    if (this.wrapUpMark === -1) return; // nothing to roll back
    this.messages.length = this.wrapUpMark;
    this.tokenCount = estimateTokensForMessages(this.messages);
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
    this.wrapUpMark = -1;
  }

  /**
   * Check if a wrap-up turn is currently active (beginWrapUp was called
   * but not yet committed or rolled back).
   */
  hasActiveWrapUp(): boolean {
    return this.wrapUpMark !== -1;
  }

  /**
   * Generate a hint round with problem analysis
   * Adds user message with analysis (single LLM call, no acknowledgment)
   * Note: Confusion tracking is now handled by ctx.core, not by Triologue
   * @param abortController - Abort controller for ESC handling
   * @param confusionScore - Current confusion score
   * @param confusionBreakdown - Breakdown of confusion factors
   * @param pendingSkills - Skills with 'when' but no compiled condition (for notification)
   * @returns 'aborted' if ESC was pressed, 'success' if completed
   */
  async generateHintRound(
    abortController: AbortController,
    confusionScore: number,
    confusionBreakdown: string,
    pendingSkills?: string[]
  ): Promise<'aborted' | 'success'> {
    return doHintRound(this, abortController, confusionScore, confusionBreakdown, pendingSkills);
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
    const result: Message[] = [];

    if (this.systemPrompt) {
      result.push({ role: 'system', content: this.systemPrompt });
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
    const result: Message[] = [];
    for (const m of this.messages) {
      if (m && typeof m === 'object' && m.role) result.push(m);
    }
    return result;
  }

  /**
   * Get the wiki module if available (for hint round context interface)
   */
  getWiki(): WikiModule | undefined {
    return this.options.wiki;
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
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m && typeof m === 'object' && m.role) return m.role as Role;
    }
    return null;
  }

  /**
   * Get the last real user query (not system notes).
   * Used by auto-compact to preserve user intent in the summary.
   */
  getLastUserQuery(): string {
    return this.lastUserQuery;
  }

  /**
   * Get current token count
   */
  getTokenCount(): number {
    return this.tokenCount;
  }

  /**
   * Get token threshold
   */
  getTokenThreshold(): number {
    return this.options.tokenThreshold;
  }

  /**
   * Load a single restoration pair into the triologue without triggering onMessage callback.
   * Used during session restoration to preload summary context.
   * @param pair - A [user_message, assistant_message] tuple
   */
  loadRestoration(pair: [Message, Message]): void {
    this.messages.push(pair[0]);
    this.updateTokenCount(pair[0]);
    this.messages.push(pair[1]);
    this.updateTokenCount(pair[1]);
  }

  // === Internal Methods ===

  /**
   * INTERNAL: Add a message to the triologue bypassing TP validation.
   * Used by tp-auto-fixer.ts only. Prefixed with _ to signal "internal use only".
   *
   * Pushes the message directly, updates token count, and calls onMessage callback.
   */
  _injectBypass(message: Message): void {
    this.messages.push(message);
    this.updateTokenCount(message);
    if (this.options.onMessage) {
      this.options.onMessage(this.messages);
    }
  }

  /**
   * INTERNAL: Clear all pending tool calls.
   * Used by tp-auto-fixer.ts to clean up stale pending calls after recovery.
   */
  _clearPendingToolCalls(): void {
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
  }

  /**
   * INTERNAL: Get pending tool call order (copy).
   * Used by tp-auto-fixer.ts to iterate over pending calls for recovery.
   */
  _getPendingToolCallOrder(): string[] {
    return [...this.pendingToolCallOrder];
  }

  /**
   * INTERNAL: Get a pending tool call by ID.
   * Used by tp-auto-fixer.ts to look up pending calls for recovery.
   */
  _getPendingToolCall(id: string): ToolCall | undefined {
    return this.pendingToolCalls.get(id);
  }

  /**
   * INTERNAL: Update the function name of the last pending tool call entry.
   * Used after tool_no_assistant recovery where a synthetic tool_call was injected
   * with an empty function name. This updates it to match the actual tool being called.
   */
  private updateLastPendingToolCall(functionName: string): void {
    if (this.pendingToolCallOrder.length > 0) {
      const lastId = this.pendingToolCallOrder[this.pendingToolCallOrder.length - 1];
      const tc = this.pendingToolCalls.get(lastId);
      if (tc) {
        tc.function.name = functionName;
      }
    }
  }

  /**
   * Add a message to the triologue.
   * Note: Auto-compact is NOT called here to avoid race conditions.
   * Overflow checking is done in tool.ts after each tool result.
   */
  private addMessage(message: Message): void {
    this.messages.push(message);
    this.updateTokenCount(message);

    // Call onMessage callback if set
    if (this.options.onMessage) {
      this.options.onMessage(this.messages);
    }
  }

  /**
   * Throw a TP violation error, with optional stack trace when --debug-tp is enabled.
   */
  private throwTpViolation(message: string): never {
    if (isDebuggingTp()) {
      const stack = new Error().stack;
      agentIO.brief('error', 'tp', `${message}\nCall site:\n${stack}`);
    }
    throw new Error(`TP violation: ${message}`);
  }

  /**
   * Update token count incrementally
   */
  private updateTokenCount(message: Message): void {
    const increment = estimateTokens(message);
    this.tokenCount += increment;
    agentIO.verbose('triologue', `Token count: ${this.tokenCount} (+${increment} from ${message.role})`);
  }

  /**
   * Run auto-compact: save transcript and summarize with LLM
   * @param focus - Optional focus topic to emphasize in summary
   * @param signal - Optional AbortSignal passed to retryChat so a stuck
   *   summarization can be aborted (e.g. by the teammate turn watchdog)
   *   rather than blocking mail polling indefinitely.
   */
  private async runAutoCompact(focus?: string, signal?: AbortSignal): Promise<Message[]> {
    // Ensure transcript directory exists (session dir)
    const sessionId = getSessionContext();
    const transcriptDir = getSessionDir(sessionId);
    if (!fs.existsSync(transcriptDir)) {
      fs.mkdirSync(transcriptDir, { recursive: true });
    }

    // Save full transcript to disk
    const timestamp = Math.floor(Date.now() / 1000);
    const transcriptPath = path.join(transcriptDir, `transcript-lead-${timestamp}.jsonl`);

    const writeStream = fs.createWriteStream(transcriptPath);
    for (const msg of this.messages) {
      writeStream.write(`${JSON.stringify(msg)}\n`);
    }
    writeStream.end();

    this.options.onCompact(transcriptPath);

    // Get wiki domains for knowledge persistence instruction
    const domains = this.options.wiki ? await this.options.wiki.listDomains() : [];
    const domainList = domains.length > 0
      ? domains.map(d => `- ${d.domain_name}${d.description ? `: ${d.description}` : ''}`).join('\n')
      : '';

    // Ask LLM to summarize
    const conversationText = minifyMessages(this.messages);

    const knowledgeInstruction = domains.length > 0
      ? `### Knowledge Persistence\n` +
      `Available wiki domains:\n${domainList}\n\n` +
      `IMPORTANT: Only persist knowledge that matches one of the available domains above.\n` +
      `For knowledge worth remembering, note as: "Knowledge: [domain] - [fact/rule]"\n` +
      `Skip opinions, temporary details, or knowledge that does not fit any domain.\n\n`
      : '';

    const focusInstruction = focus
      ? `\n**Focus Area:** Pay special attention to information related to "${focus}" and ensure the summary captures all relevant details about this topic.\n`
      : '';

    const userQueryInstruction = this.lastUserQuery
      ? `\n**User's Last Instruction:** "${this.lastUserQuery}"\nEnsure the summary preserves ALL constraints, pending tasks, and requests from this instruction. The agent should continue working on this after the compact.\n`
      : '';

    const response = await retryChat(
      {
        model: MODEL,
        messages: [
          {
            role: 'user',
            content:
              `Summarize this conversation for continuity. Cover the following sections:\n\n` +
              `### 1) What Was Accomplished\n` +
              `Key actions taken, files created/modified, findings made.\n\n` +
              `### 2) Current State\n` +
              `What the agent now knows — be specific enough that subsequent turns do NOT need to re-verify findings already made.\n` +
              `Include any pending or unfinished tasks.\n\n` +
              `### 3) Key Decisions Made\n` +
              `Design choices, fix strategies, or workflow decisions.\n\n` +
              `${knowledgeInstruction}` +
              `${focusInstruction}` +
              `${userQueryInstruction}` +
              `${conversationText}`,
          },
        ],
      },
      { signal, noSpinner: true },
    );

    const summary = response.message.content || '(no summary)';

    // Build a compact summary pair that includes user intent preservation
    const focusPrefix = focus ? `Focus: ${focus}. ` : '';
    const userQueryNote = this.lastUserQuery
      ? `\n\n**Previous user instruction:** ${this.lastUserQuery}`
      : '';

    const summaryPrefix = `[Conversation compressed. ${focusPrefix}Transcript: ${transcriptPath}]\n\n`;

    return [
      {
        role: 'user',
        content: `${summaryPrefix}${summary}${userQueryNote}`,
      },
      {
        role: 'assistant',
        content: 'Understood. I have the context from the summary. Continuing.',
      },
    ];
  }
  // === Default Callbacks ===

  private defaultOnMisorder(warning: MisorderWarning): void {
    agentIO.brief('warn', 'triologue', `Misordered transition: ${warning.from} → ${warning.to}`, `gap: ${warning.gap}`);
  }

  private defaultOnToolMisalign(warning: ToolAlignmentWarning): void {
    agentIO.brief('warn', 'triologue', `Tool alignment issue: ${warning.functionName}`, `issue: ${warning.issue}`);
  }

  private defaultOnCompact(transcriptPath: string): void {
    agentIO.brief('info', 'autoCompact', `Transcript saved: ${transcriptPath}`);
  }

  // === Checkpoint Methods ===

  /**
   * Check if a message is a checkpoint by its [CHECKPOINT] content prefix
   * or legacy regex for backwards compatibility
   */
  private isCheckpointMessage(msg: Message): { id: string; description: string } | null {
    // Checkpoint tool responses have role='tool' and tool_name='checkpoint'
    if (msg.role !== 'tool' || (msg as unknown as Record<string, unknown>).tool_name !== 'checkpoint' || !msg.content) return null;

    // Content format: "Checkpoint created: abc12345\n\nDescription: ..."
    const idMatch = msg.content.match(/^Checkpoint created: ([a-z0-9]{8})/m);
    const descMatch = msg.content.match(/^Description: (.+)$/m);
    if (idMatch) {
      return { id: idMatch[1], description: descMatch?.[1] || '' };
    }

    return null;
  }

  /**
   * Find the last open checkpoint in message history
   * @returns Checkpoint info if found, null otherwise
   */
  findOpenCheckpoint(): { id: string; description: string } | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const result = this.isCheckpointMessage(this.messages[i]);
      if (result) return result;
    }
    return null;
  }

  /**
   * Find all checkpoints in message history
   * @returns Array of checkpoint info
   */
  findAllCheckpoints(): Array<{ id: string; description: string }> {
    const checkpoints: Array<{ id: string; description: string }> = [];
    for (const msg of this.messages) {
      const result = this.isCheckpointMessage(msg);
      if (result) checkpoints.push(result);
    }
    return checkpoints;
  }

  /**
   * Find a checkpoint by ID in message history.
   * Returns the index of the ASSISTANT message that originally called the checkpoint,
   * so that recapMessages can remove the entire span (assistant → checkpoint tool →
   * subtask → recap call → recap tool) and replace it with a single note().
   *
   * @param id - The checkpoint ID to find
   * @returns Checkpoint info with assistant message index if found, null otherwise
   */
  findCheckpointById(id: string): { id: string; description: string; index: number } | null {
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const result = this.isCheckpointMessage(msg);
      if (result && result.id === id) {
        // Scan backwards from the checkpoint tool message to find the
        // assistant message whose tool_calls include the checkpoint call.
        for (let j = i - 1; j >= 0; j--) {
          const candidate = this.messages[j];
          if (candidate.role === 'assistant' && candidate.tool_calls) {
            const hasCheckpointCall = candidate.tool_calls.some(
              (tc: { function: { name: string } }) => tc.function.name === 'checkpoint'
            );
            if (hasCheckpointCall) {
              return { id, description: result.description, index: j };
            }
          }
        }
        // Fallback: if no assistant found (shouldn't happen in normal flow),
        // return index after the checkpoint tool message.
        return { id, description: result.description, index: i + 1 };
      }
    }
    return null;
  }

  /**
   * Generate a random checkpoint ID (8 lowercase alphanumeric characters)
   */
  static generateCheckpointId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  /**
   * Get messages from a specific index to the end
   * @param startIndex - The starting index
   * @returns Messages from startIndex to end
   */
  getMessagesFrom(startIndex: number): Message[] {
    return this.messages.slice(startIndex);
  }

  /**
   * Slice messages from startIndex onwards (inclusive).
   * Used by recap tool to remove the checkpoint span before appending ?recap, !recap.
   * @param startIndex - Index of checkpoint message (inclusive)
   */
  recapMessages(startIndex: number): void {
    // Keep messages before startIndex, discard the rest
    this.messages = this.messages.slice(0, startIndex);

    // Recalculate token count from kept messages
    this.tokenCount = estimateTokensForMessages(this.messages);

    // Clear pending tool calls (any calls from the recapped messages are now invalid)
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
  }
}
