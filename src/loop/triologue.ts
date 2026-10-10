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
import { type PieceKind } from './triologue/transcript.js';

export type { Role, MisorderWarning, ToolAlignmentWarning, TriologueOptions, CheckpointInfo } from './triologue/types.js';
export { CheckpointManager } from './triologue/checkpoint.js';
export { HintRoundManager } from './triologue/hint-round.js';

import { MessageStore } from './triologue/store.js';
import { PendingToolLedger } from './triologue/pending-tools.js';
import { runAutoCompact as doRunAutoCompact } from './triologue/compact.js';
import { CheckpointManager } from './triologue/checkpoint.js';
import { HintRoundManager } from './triologue/hint-round.js';
import { WrapUpManager } from './triologue/wrap-up.js';

/**
 * A note / user submission held back because tool_calls are still
 * outstanding. See Triologue.deferInput / flushDeferredInputs.
 *
 * A deferred submission is REPLAYED at flush time (not merged into a host):
 * every note gets its own message, so replay can never bury a genuine query
 * under a note or pollute lastUserQuery (the Review A attribution inversion
 * was a symptom of merging, and merging no longer exists).
 */
type DeferredInput =
  | { kind: 'user'; text: string }
  | { kind: 'note'; category: NoteCategory; hookName?: string; text: string };

export class Triologue {
  private store: MessageStore = new MessageStore();
  private ledger: PendingToolLedger = new PendingToolLedger();

  /**
   * Submissions held back because tool_calls are outstanding (ledger non-empty).
   *
   * The provider rule is absolute: an assistant's tool_calls must be answered
   * by tool messages before ANY other role. Appending a note/user here would
   * violate it — DeepSeek rejects with HTTP 400, Ollama tolerates (which is
   * why the defect survived). Buffered in ARRIVAL order and replayed once the
   * LAST pending call resolves, so the sequence stays legal:
   * assistant(tool_calls) → tool… → user.
   *
   * Replay matters for a second reason beyond legality: each replayed piece
   * must reach the transcript exactly as a direct call would have, or the
   * journal and the livelog drift.
   */
  private deferredInputs: DeferredInput[] = [];
  private options: TriologueOptions & {
    tokenThreshold: number;
    resultThreshold: number;
    hintThreshold: number;
    onMisorder: (warning: MisorderWarning) => void;
    onToolMisalign: (warning: ToolAlignmentWarning) => void;
    onCompact: (transcriptPath: string) => void;
    onMessage: (msg: Message, getTriologue: () => Message[]) => void;
  };

  /**
   * Private per-piece dispatcher for the onMessage contract.
   *
   * Stamps the collation metadata (kind + user_origin for GENUINE user
   * pieces) onto a SHALLOW COPY of the piece and invokes onMessage with the
   * copy — the livelog message object inside the store is never touched, so
   * `Message` gains zero new fields and nothing extra can reach the LLM
   * provider payload.
   *
   * `getTriologue` is bound to `() => this.store.getRaw()` — re-read at CALL
   * time, so it keeps working across compact()/clear() store swaps (same
   * lazy-binding pattern as the feature-domain delegates). None of the three
   * transcript writers use it; it is the lazy full-state escape hatch for
   * future full-state consumers and tests.
   */
  private emit(piece: Message, kind: PieceKind, opts?: { userOrigin?: boolean }): void {
    const copy: Message = { ...piece };
    if (opts?.userOrigin) {
      (copy as { user_origin?: true }).user_origin = true;
    }
    (copy as { kind?: PieceKind }).kind = kind;
    this.options.onMessage(copy, () => this.store.getRaw());
  }

  /**
   * Journal a live-log truncation/boundary (the control-event contract):
   * invokes onMessage with a bare boundary piece (no message fields) that
   * the writer records as `{ kind, timestamp }` — the event name IS the
   * kind (conflated; no 'control' pseudo-kind, no event field). Journaled
   * events: 'clear' (replay resets the collated view — /clear meaning is
   * preserved across restoration), 'compact', 'recap', 'rollback' (boundary
   * markers; the durable collated history stays intact).
   */
  private emitControl(event: 'clear' | 'compact' | 'recap' | 'rollback'): void {
    this.options.onMessage(
      { kind: event } as unknown as Message,
      () => this.store.getRaw(),
    );
  }

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
    // duplicate_assistant recovery clears the ledger, which would strand a
    // note()/user() deferred against the block it just answered. Replay them
    // through the SAME flush the tool()/skipPendingTools paths use (this is
    // the facade's private flushDeferredInputs, bound lazily).
    flushDeferredInputs: (): void => {
      this.flushDeferredInputs();
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
   * Load a single restoration pair into the triologue as TWO 'new' pieces
   * (par-by-construction parity — review F1: the pair must reach the
   * transcript exactly like any other appended message, or a chained
   * restore A → work → restore B would silently drop A's summary from
   * B's transcript and from serve-history).
   * Used during session restoration to preload summary context.
   * @param pair - A [user_message, assistant_message] tuple
   */
  loadRestoration(pair: [Message, Message]): void {
    for (const message of pair) {
      this.addMessage(message);
    }
  }

  /**
   * Clear all messages and reset state
   * Called by /clear command
   */
  clear(): void {
    this.store.replaceAll([]);
    this.store.resetTokenCount();
    this.ledger.clear();
    this.dropDeferredInputs('clear()');
    this.wrapUp.reset();
    // Journal the truncation boundary: the writer records a control event
    // so read-time collation resets its view here — restored context honors
    // the /clear instead of resurrecting the cleared material.
    this.emitControl('clear');
    // Fresh start: rebuild dynamic project context from populators so the
    // cleared conversation still carries current README/mindmap/hook state.
    this.rebuildProjectContext();
  }

  // === Message Producers ===

  /**
   * Add a user message (real user input - clears temporary hint)
   */
  user(content: string): void {
    // Guard 1 — tool_calls outstanding: DEFER. A user message may not be
    // interposed between an assistant's tool_calls and their results (the
    // provider rejects it; see the deferredInputs field note). Checked BEFORE
    // the lastRole==='tool' branch, because the mid-batch case
    // (assistant(p1,p2) → tool(p1) → here) has lastRole==='tool' with p2
    // still outstanding — an assistant-only guard would let it through and
    // orphan p2. `forceStandalone` keeps the deferred query from merging into
    // a deferred note's host at replay.
    if (this.ledger.size > 0) {
      this.deferInput({ kind: 'user', text: content });
      return;
    }
    const lastRole = this.getLastRole();
    if (lastRole === 'tool') {
      const fixResult = this.tpFix.handle('user_after_tool', lastRole, 'cannot add user message after tool role');
      if (fixResult === 'allowed') {
        // Provider supports tool → user natively — skip bridge, just append.
        // Fresh turn: the pre-tool turn is complete; this input starts a new
        // conversation turn (guards the F1 collapse where two queries
        // collated into one turn).
        this.addMessage({ role: 'user', content }, { isUserOrigin: true });
        return;
      }
      // 'recovered': bridge was injected, fall through to add user message
    }
    if (lastRole === 'user') {
      // NOTE: no combine. A second genuine query in the same move stays its
      // OWN message (previously the fragments were concatenated into one
      // host, with a 'user' journal piece emitted for the fragment).
      // Rationale: the combine was the *user-side* half of the merge design
      // and produced the same coupling defects as the note merge —
      // lastUserQuery had to be re-read from the grown host, and the merged
      // text was indistinguishable from a note block once a note joined it.
      // Two consecutive user messages are a legal wire shape on ollama and
      // deepseek (tools are flushed by tool()/skipPendingTools before any
      // producer runs, so lastRole==='user' here means NO call is pending);
      // for any provider that rejects user → user, tpFix bridges it.
      // lastUserQuery therefore always holds exactly the latest query.
      void lastRole;
    }
    // Track last real user query for auto-compact context preservation
    this.store.setLastUserQuery(content);
    this.addMessage({ role: 'user', content }, { isUserOrigin: true });
  }

  /**
   * Buffer a note/user submission because tool_calls are outstanding, and
   * schedule it for replay once the ledger drains.
   *
   * Nothing is appended here — that is the whole point. The submission is
   * RE-ROUTED through the producer at flush time, so it takes the same
   * provider-aware paths (note_after_tool 'allowed' on ollama/deepseek) and
   * emits the same single journal piece it would have emitted directly.
   */
  private deferInput(input: DeferredInput): void {
    this.deferredInputs.push(input);
    agentIO.verbose(
      'tp',
      `Deferred ${input.kind}() while ${this.ledger.size} tool call(s) outstanding — will replay after they settle`,
    );
  }

  /**
   * Replay every deferred submission — called ONLY once the ledger is empty
   * (all pending tool calls answered), so the legal shape is
   * assistant(tool_calls) → tool… → user.
   *
   * Replay re-enters note()/user() instead of hand-appending. Their ordinary
   * transition guards are important here: on providers that reject tool→user,
   * the producer must insert its TP bridge before delivering the deferred input.
   * Each submission remains a separate message, so a genuine query cannot be
   * folded into a preceding note or lose its lastUserQuery attribution.
   *
   * The deferred array is snapshotted and cleared BEFORE replay, so re-entering
   * a producer can never extend the list being iterated. The ledger is already
   * empty at this cutpoint, so the submissions cannot be deferred a second time.
   */
  private flushDeferredInputs(): void {
    if (this.deferredInputs.length === 0) return;
    const pending = this.deferredInputs;
    this.deferredInputs = [];
    agentIO.verbose('tp', `Replaying ${pending.length} deferred submission(s)`);

    // Re-enter the public producers rather than hand-appending messages. The
    // ledger is empty here, so they won't requeue these items; the producers
    // still apply provider-aware TP bridging for tool→user/tool→note paths.
    for (const item of pending) {
      if (item.kind === 'user') {
        this.user(item.text);
      } else {
        this.note(item.category, item.text, item.hookName);
      }
    }
  }

  /**
   * Drop every deferred submission WITHOUT replaying it.
   *
   * Used at boundaries that invalidate the context the submission was queued
   * for (clear/compact/wrap-up/truncate). Replaying there would inject a note
   * into a conversation whose pending tool call no longer exists — an orphan
   * user message with no referent. Dropping is the correct, documented policy;
   * the verbose line makes it observable rather than silent.
   */
  private dropDeferredInputs(reason: string): void {
    if (this.deferredInputs.length === 0) return;
    const n = this.deferredInputs.length;
    this.deferredInputs = [];
    agentIO.verbose('tp', `Dropped ${n} deferred submission(s) at ${reason}`);
  }

  /**
   * Journal a genuine user submission WITHOUT touching the conversation:
   * emits exactly ONE 'user'|'steer' journal record (stamped
   * `user_origin: true`) and nothing else.
   *
   * Used for inputs that reach the LLM through another channel and therefore
   * have no message of their own to append:
   *   - 'steer' — a webui steering note, whose text the livelog records as a
   *     [REMINDER] steering note when COLLECT drains it (or which PROMPT
   *     folds into a synthesised query).
   *   - 'prompt' — reserved for a query that was recorded elsewhere.
   *
   * It deliberately does NOT push to the store, touch the TP ledger, or set
   * `lastUserQuery`: it is a pure journal write, so it is safe to call while
   * the agent is running (no role-transition risk mid-run). The transcript is
   * the single source of truth for WebUI user bubbles, so this is what makes
   * a steering note survive a page refresh.
   *
   * CONTRACT: a `'user'` record (the `'prompt'` source) carries user_origin:true
   * and is FOLDED onto the last user host by the restoration projection
   * (collateMessages) for livelog parity. Only pass `'prompt'` for a query
   * that the livelog ALSO records as a user message (so the fold is accurate);
   * a `'prompt'` record with no preceding user host trips the projection's
   * no-host anomaly path. `'steer'` is skipped by collateMessages (its text
   * already reached the LLM as the synthesised [REMINDER] note) and rendered
   * as its own bubble by the serve projection.
   */
  submitUser(text: string, source: 'prompt' | 'steer' = 'prompt'): void {
    if (text.trim() === '') return; // nothing to journal
    // 'prompt' is journaled as the 'user' kind (the journal kind is named for
    // the RECORD, not for the submission source); only notes stay 'steer'.
    this.emit({ role: 'user', content: text }, source === 'steer' ? 'steer' : 'user', { userOrigin: true });
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
    // Guard 1 — tool_calls outstanding: DEFER (same invariant as user(); the
    // note must not be interposed between the assistant's tool_calls and their
    // results). Deferring here ALSO prevents the cascade: because nothing is
    // appended, tool() still sees lastRole==='assistant' and tool_no_assistant
    // never fires a second synthetic assistant.
    if (this.ledger.size > 0) {
      this.deferInput({ kind: 'note', category, text: message, hookName });
      return;
    }
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
    // NOTE: no merge. Every note is its OWN message — including the case
    // where the last role is 'user'. This is deliberate:
    //
    //  - The merge existed only to keep ONE host message per move. It bought
    //    that at the cost of a coupled, fragile contract: a sorted block
    //    whose FIRST fragment had to stay pinned so the leading '[CATEGORY] '
    //    prefix stayed stable for the ^-anchored raw readers (hint-round
    //    noise filter, collect-skill isHintNote), plus a WeakMap of side-state
    //    keyed by message object.
    //  - It also produced an attribution inversion: once a note joined a host
    //    holding genuine user text, the query and the note became one message
    //    and lastUserQuery was read off the combined text (Review A).
    //  - Going standalone makes EVERY reader's job exact: one message = one
    //    '[CATEGORY] ' prefix, so the anchored filters fire precisely per
    //    note; lastUserQuery is written only by user(); the transcript emits
    //    an ordinary 'new' piece (the 'merge' kind is now written by nobody —
    //    it survives only as a legacy read shape).
    //  - Legality: a note may only land after an assistant that has NO
    //    outstanding tool_calls (the ledger guard above + the tool()/
    //    skipPendingTools flush points guarantee that), so 'user' after
    //    'assistant'/'user'/'tool' is legal on ollama and deepseek. For any
    //    provider that would reject it, tpFix recovers (handled above for the
    //    tool case; the delegate covers the rest).
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
      // Prefer a name match, but a provider/model can omit the ID and return
      // a mismatched function name. Still close the oldest pending slot so the
      // ledger cannot remain wedged forever; validateAlignment below records
      // the mismatch rather than leaving deferred inputs stranded.
      resolvedId = this.ledger.findByName(functionName);
      if (!resolvedId) {
        resolvedId = this.ledger.getOrder()[0];
        if (resolvedId) {
          agentIO.verbose('tp', `No pending call matched "${functionName}"; resolving oldest pending call ${resolvedId}`);
        }
      }
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

    // Flush trigger: replay deferred submissions ONLY once the ledger is
    // empty — i.e. after the LAST pending call is answered. Flushing after the
    // first of N would itself produce assistant → tool → user → tool, the very
    // violation this guard exists to prevent. Placed after the message append
    // and the resolve, so the tool result is already in the history when the
    // deferred note/user lands (they then take the legal tool → user path).
    if (this.ledger.size === 0) {
      this.flushDeferredInputs();
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
    // The interrupt path ANSWERS every pending call with a placeholder, so the
    // sequence completes here: replay anything deferred rather than stranding
    // it. (Contrast the reset points below, which DROP because the context the
    // submission was queued for is being discarded.)
    this.flushDeferredInputs();
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
    // A deferred submission was queued against a conversation that no longer
    // exists after compaction — its referent (the pending tool call) is gone.
    // Drop rather than replay: injecting it would strand a note with no
    // context.
    this.dropDeferredInputs('compact()');
    // Journal the swap boundary + replay parity: a compact replaces the
    // entire conversation with the summary round-trip, so the livelog and
    // the transcript must BOTH change here. The control event is an
    // observable boundary marker (the collated full history is kept), and
    // the summary messages are emitted as 'new' pieces — without them the
    // transcript would silently miss the post-compact summary the livelog
    // now holds (the livelog keeps ONLY the summary; the collated view is
    // deliberately a superset — durable-full-history semantics — so this is
    // journaling completeness, NOT snapshot parity with the livelog).
    this.emitControl('compact');
    // NOTE: the summary messages are ALREADY in the store — replaceAll()
    // installs `compacted` by reference, so pushing them again here would
    // append into the very array this for-of is iterating (a push during
    // iteration feeds the iterator a new element every round → the loop
    // never terminates and the process OOMs). Emit-only: the transcript
    // sees the post-compact summary as 'new' pieces, the livelog keeps 3.
    for (const summaryMsg of compacted) {
      this.emit(summaryMsg, 'new', { userOrigin: false });
    }
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
   * @returns 'aborted' if ESC was pressed, 'compact' when compaction is requested,
   *   'failed' after bounded malformed-output retries, or a success object.
   */
  async generateHintRound(
    abortController: AbortController,
    confusionScore: number,
    confusionBreakdown: string,
    pendingSkills?: string[]
  ): Promise<'aborted' | 'compact' | 'failed' | { status: 'success'; focusOn: string }> {
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
    // The wrap-up assistant closes the turn. Normally the last role is the
    // [WRAP_UP] user (or a flushed tool, if beginWrapUp had to skipPendingTools),
    // so this appends cleanly. But it MUST NOT stream an `assistant` while a
    // tool_call is still outstanding: that interposes a second block inside an
    // open one — exactly the interposition DeepSeek 400s on. beginWrapUp()
    // flushes pending calls before marking, so the ledger is empty on the
    // normal path; this guard makes the producer itself enforce the invariant
    // (previously this pushed to the store DIRECTLY, bypassing addMessage and
    // every check — a second entry point that could slip an assistant mid-block
    // if beginWrapUp's flush was ever bypassed or a call arrived between the
    // two). If anything is somehow still pending, flush it first so the turn
    // completes legally rather than emit an illegal shape.
    if (this.ledger.size > 0) {
      this.skipPendingTools(
        'Tool use interrupted - wrap-up began before the call resolved.',
        'Tool use skipped to close the block before wrap-up.',
      );
    }
    // Route through addMessage (the single append chokepoint) instead of a raw
    // store.push + manual increment: one door means one place where the ledger
    // invariant and the transcript emit are honored together.
    this.addMessage({ role: 'assistant', content }, { isUserOrigin: false });
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
      this.truncateAndRecount(mark, 'rollback');
    } else {
      // Mark is stale and past the end: the array is already shorter, so
      // truncating further is wrong — just recount and clear the ledger.
      this.store.recomputeTokenCount();
      this.ledger.clear();
      this.emitControl('rollback');
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
   * invalid). Used by recap span removal and wrap-up rollback. Journals a
   * control event ('recap' or 'rollback') so the transcript carries the
   * boundary marker — replay keeps the durable full history (markers do not
   * cut the collated view), but observers can see exactly where the live
   * context was truncated.
   */
  private truncateAndRecount(startIndex: number, event: 'recap' | 'rollback' = 'recap'): void {
    this.store.truncateTo(startIndex);
    this.store.recomputeTokenCount();
    this.ledger.clear();
    // Recap/rollback discard messages, so a deferred submission's referent may
    // be gone — drop it rather than replay into a truncated context.
    this.dropDeferredInputs(`truncateAndRecount(${event})`);
    this.emitControl(event);
  }

  /**
   * Add a message to the triologue.
   * Note: Auto-compact is NOT called here to avoid race conditions.
   * Overflow checking is done in the LLM stage (llm.ts) before each call.
   */
  private addMessage(
    message: Message,
    opts?: { isUserOrigin?: boolean },
  ): void {
    this.store.push(message);
    this.store.incrementTokenCount(message);

    // ONE 'new' piece per appended message (per-piece contract). Covers
    // agent(), tool() results (including skipPendingTools' flushed items),
    // TP-bridge injections via injectBypass, and standalone notes — each is
    // a real livelog message, so each gets its own line (parity).
    this.emit(message, 'new', {
      userOrigin: opts?.isUserOrigin,
    });
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