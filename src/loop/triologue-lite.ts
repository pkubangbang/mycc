/**
 * triologue-lite.ts - Teammate-only simplified Triologue facade
 *
 * Used by child/teammate processes (src/context/teammate-worker.ts) instead of
 * the full Triologue (src/loop/triologue.ts). It composes the SAME submodule
 * layer (store / compact / pending-tools / tp-fix) but omits the lead-only
 * feature domains:
 *   - wrap-up lifecycle (ESC interrupt paths are main-process only)
 *   - the wrap-up rollback path that rewinds to a checkpoint
 *   - hint round (children request guidance via mail_to instead)
 *   - result-threshold longtext dump (teammates accept large tool results as-is)
 *   - loadRestoration / clear (teammate transcripts are write-only JSONL)
 *
 * NOTE ON CO-EVOLUTION: this facade and the full triologue.ts keep their own
 * copies of the append path (addMessage/agent/tool/compact) so the lead-only
 * domains stay out of the child process. The shared invariants they must BOTH
 * preserve are:
 *   1. JSONL persistence via options.onMessage — the callback receives ONE
 *      message PIECE (a shallow copy stamped kind/user_origin) per appended
 *      message, and ZERO events for a mere in-memory mutation (the {A, AB}
 *      fix; the transcript is an append-only piece log — see
 *      triologue/transcript.ts). restoration.ts reads teammate transcripts
 *      ([READY] marker + fixOrphanedToolCalls).
 *   2. ONE call = ONE message: user()/note() never merge into a preceding
 *      message. The host += fragment combine was the lite-facade DOUBLE WRITE:
 *      the fragment landed twice (folded into the host object, then journaled
 *      again as a 'merge'/'user' fragment piece), so a provider payload
 *      re-serialised from the live objects and a collated replay disagreed
 *      about what the conversation said. The lead facade removed the combine
 *      (no-merge contract); this facade now matches it — see the producer
 *      section below.
 *   3. tool() must run TpAutoFixer for tool→tool gaps before ledger resolve.
 *   4. compact() must swap the store, recompute tokens, clear the ledger,
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
import { type PieceKind } from './triologue/transcript.js';

export type { Role, MisorderWarning, ToolAlignmentWarning, TriologueOptions } from './triologue/types.js';

/**
 * A note / user submission held back because tool_calls are still
 * outstanding (see deferInput). REPLAYED through the producer at flush time
 * (never hand-appended, never merged into a host) — the same discriminated
 * union the lead facade uses, so the two facades' deferral policies cannot
 * drift.
 */
type DeferredInput =
  | { kind: 'user'; text: string }
  | { kind: 'note'; category: NoteCategory; hookName?: string; text: string };

export class TriologueLite {
  private store: MessageStore = new MessageStore();
  private ledger: PendingToolLedger = new PendingToolLedger();
  /** Submissions deferred while tool_calls are outstanding (see deferInput). */
  private deferredInputs: DeferredInput[] = [];
  private options: TriologueOptions & {
    tokenThreshold: number;
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
   * lazy-binding pattern as the feature-domain delegates).
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
   * Journal a live-log boundary for the child transcript (control-event
   * contract — see triologue/transcript.ts). The lite facade only ever
   * truncates at compact(), so only the 'compact' boundary is journaled
   * here (the event name IS the kind — conflated, no 'control' pseudo-kind).
   */
  private emitControl(event: 'compact'): void {
    this.options.onMessage(
      { kind: event } as unknown as Message,
      () => this.store.getRaw(),
    );
  }

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
    // Recovery ANSWERS the open block (a tool result per pending id), so the
    // deferred submissions' context completes here — FLUSH is the matching
    // policy, exactly as tool() does at its own flush point (parity with the
    // lead facade).
    flushDeferredInputs: (): void => {
      this.flushDeferredInputs();
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
   *
   * ONE call = ONE message (the no-merge / anti-double-write contract shared
   * with the lead facade's user()): a second genuine query always becomes its
   * OWN message. The previous combine branch appended the fragment to the
   * preceding user message in memory AND journaled it, so the same input
   * reached the conversation twice. Two consecutive user messages are a legal
   * wire shape on both supported providers (ollama, deepseek); a provider that
   * objects is bridged by tpFix.
   */
  user(content: string): void {
    // Guard 1 — tool_calls outstanding: DEFER. A user message may not be
    // interposed between an assistant's tool_calls and their results (the
    // provider rejects it), so it is replayed by tool() once the ledger drains.
    // Checked BEFORE the lastRole==='tool' branch: the mid-batch case
    // (assistant(p1,p2) → tool(p1) → here) has lastRole==='tool' with p2 still
    // outstanding, and an assistant-only guard would orphan p2.
    if (this.ledger.size > 0) {
      this.deferInput({ kind: 'user', text: content });
      return;
    }
    const lastRole = this.getLastRole();
    if (lastRole === 'tool') {
      const fixResult = this.tpFix.handle('user_after_tool', lastRole, 'cannot add user message after tool role');
      if (fixResult === 'allowed') {
        // Provider supports tool → user natively — skip bridge, just append.
        // Fresh turn: the pre-tool user turn is complete, this input starts a
        // new conversation turn. lastUserQuery MUST be updated here too: this
        // path returns before the tail setLastUserQuery below.
        this.store.setLastUserQuery(content);
        this.addMessage({ role: 'user', content }, { isUserOrigin: true });
        return;
      }
      // 'recovered': bridge was injected, fall through to add user message
    }
    // Track last real user query for auto-compact context preservation
    this.store.setLastUserQuery(content);
    this.addMessage({ role: 'user', content }, { isUserOrigin: true });
  }

  /**
   * Buffer a note/user submission because tool_calls are outstanding, and
   * schedule it for replay once the ledger drains. Nothing is appended here:
   * the submission is RE-ROUTED through the producer at flush time, so it
   * takes the same provider-aware paths and emits the same single journal
   * piece it would have emitted directly. (Parity with the lead facade.)
   */
  private deferInput(input: DeferredInput): void {
    this.deferredInputs.push(input);
  }

  /**
   * Replay every deferred submission — called ONLY once the ledger is empty
   * (all pending tool calls answered), so the legal shape is
   * assistant(tool_calls) → tool… → user.
   *
   * The array is snapshotted and cleared BEFORE replay, so re-entering a
   * producer can never extend the list being iterated; the ledger is empty at
   * this cutpoint, so the submissions cannot be deferred a second time.
   */
  private flushDeferredInputs(): void {
    if (this.deferredInputs.length === 0) return;
    const pending = this.deferredInputs;
    this.deferredInputs = [];
    for (const item of pending) {
      if (item.kind === 'user') {
        this.user(item.text);
      } else {
        this.note(item.category, item.text, item.hookName);
      }
    }
  }

  /**
   * Drop every deferred submission WITHOUT replaying it — used at boundaries
   * that invalidate the context the submission was queued for (compact).
   * Replaying there would inject a note into a conversation whose pending tool
   * call no longer exists (parity with the lead facade's dropDeferredInputs).
   */
  private dropDeferredInputs(): void {
    this.deferredInputs = [];
  }

  /**
   * Journal a genuine user submission WITHOUT touching the conversation:
   * emits exactly ONE 'user'|'steer' journal record (stamped
   * `user_origin: true`) and nothing else. Mirror of Triologue.submitUser —
   * see there for the rationale (a typed steering note has no message of its
   * own; this is what makes it survive a WebUI refresh).
   *
   * CONTRACT: only pass `'prompt'` for a query the livelog ALSO records as a
   * user message (the restoration projection folds a 'user' record onto the
   * last user host); `'steer'` is skipped by collateMessages and rendered as
   * its own serve bubble.
   */
  submitUser(text: string, source: 'prompt' | 'steer' = 'prompt'): void {
    if (text.trim() === '') return;
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
   *   message) and tagged with `hook_name`.
   */
  note(category: NoteCategory, message: string, hookName?: string): void {
    // Guard 1 — tool_calls outstanding: DEFER (same invariant as user(); a note
    // must not be interposed between the assistant's tool_calls and their
    // results). Deferring here also prevents the cascade: because nothing is
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
    // INVARIANT (shared with the lead facade): one note = one message, each
    // starting with its '[CATEGORY] ' prefix, NEVER merged into a neighbouring
    // message. The old merge branch wrote the note TWICE — once by growing the
    // preceding user host in memory, once as a 'merge' transcript piece — so a
    // live payload and a collated replay disagreed. Readers also anchor on the
    // '[CATEGORY] ' prefix, and a merged note makes lastUserQuery ambiguous.
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
      // Prefer a name match, but a provider/model can omit the ID and return
      // a mismatched function name. Still close the oldest pending slot so the
      // ledger cannot remain wedged forever (parity with the lead facade's
      // tool() in triologue.ts); validateAlignment records the mismatch.
      resolvedId = this.ledger.findByName(functionName);
      if (!resolvedId) {
        resolvedId = this.ledger.getOrder()[0];
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

    // Flush trigger: replay deferred submissions ONLY once the ledger is empty
    // — i.e. after the LAST pending call is answered. Flushing after the first
    // of N would itself produce assistant → tool → user → tool, the very
    // violation the deferral prevents. Placed after the append + resolve, so
    // the tool result is already in history when the deferred note/user lands
    // (they then take the legal tool → user path).
    if (this.ledger.size === 0) {
      this.flushDeferredInputs();
    }
  }

  /**
   * Add an assistant message
   *
   * Signature mirrors the lead facade's `Triologue.agent` (triologue.ts): the
   * message itself is positional, all optional metadata travels in `opts`, so
   * the two classes stay interchangeable at their shared call sites.
   */
  agent(
    content: string,
    toolCalls?: ToolCall[],
    opts?: { reasoningContent?: string; synthetic?: boolean },
  ): void {
    const reasoningContent = opts?.reasoningContent;
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
      ...(opts?.synthetic ? { synthetic: true } : {}),
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
   * @param domains - Optional wiki domain list for the summary's
   *   knowledge-persistence instruction, supplied by the caller (which holds
   *   the wiki module) so this facade stays free of the RAG layer.
   */
  async compact(focus?: string, signal?: AbortSignal, tools?: Tool[], domains: Array<{ domain_name: string; description?: string }> = []): Promise<void> {
    // Inline delegation to the compaction layer (triologue/compact.ts) via a
    // CompactDeps adapter over this facade's own state (single caller).
    const compacted = await doRunAutoCompact(
      {
        getRawMessages: () => this.store.getRaw(),
        getFullMessages: () => this.store.getFullMessages(),
        lastUserQuery: () => this.store.lastUserQuery,
        onCompact: (p) => this.options.onCompact(p),
        domains,
      },
      focus,
      signal,
      tools,
    );
    this.store.replaceAll(compacted);
    this.store.recomputeTokenCount();
    this.ledger.clear();
    // Boundary DROP (parity with the lead facade's compact): a submission
    // deferred against the pre-compact tool block has no referent in the new
    // context — replaying it would inject an orphan user message.
    this.dropDeferredInputs();
    // Journal the swap boundary + replay parity (same contract as the full
    // facade's compact): the control event is an observable boundary marker,
    // and the summary messages are emitted as 'new' pieces so the transcript
    // records the post-compact summary (the collated view is deliberately a
    // superset — durable-full-history semantics — so this is journaling
    // completeness, NOT snapshot parity with the livelog).
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
   *
   * Emits ONE 'new' piece per appended message (per-piece contract).
   * Replay is purely positional — no turn identity is needed.
   */
  private addMessage(
    message: Message,
    opts?: { isUserOrigin?: boolean },
  ): void {
    this.store.push(message);
    this.store.incrementTokenCount(message);

    this.emit(message, 'new', {
      userOrigin: opts?.isUserOrigin,
    });
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