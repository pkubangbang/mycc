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

import type { Message, ToolCall } from '../../types.js';
import type { Role } from './types.js';
import { estimateTokens, estimateTokensForMessages } from '../../utils/token.js';
import { agentIO } from '../agent-io.js';

/**
 * Message storage layer.
 *
 * Provenance of an infrastructure-injected `brief`: some `brief` round-trips
 * are not the model talking to itself — two producers inject one purely to
 * give it a thinking step: `llm.ts` (empty-output recovery) and `hook.ts`
 * (crossroad). Their `message` is boilerplate ("Let me see what to do next."),
 * so a reader must never treat one as the model's own checkpoint.
 *
 * HOW THE DISTINCTION IS MADE: a property of the MESSAGE. See
 * `Message.synthetic` (types.ts); the rule itself is applied in
 * `briefIndices()` below (which lists the candidates) and completed by
 * Triologue.currentAnchorIndex (which requires activity after the brief).
 */
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

  /**
   * Copy of the messages from `from` to the end, for a consumer that holds a
   * TRUE-array index (briefIndices, at(), length) and must slice there —
   * getRaw() would shift the index left by the number of sparse holes.
   *
   * Returns a COPY and filters holes, so the store never hands out its mutable
   * backing array: a caller slicing the live array could observe (or hold) a
   * reference that later pushes/truncation mutate underneath it. Out-of-range
   * `from` yields an empty array, so callers need no `Math.min` clamp.
   */
  sliceFrom(from: number): Message[] {
    const result: Message[] = [];
    for (let i = Math.max(0, from); i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m && typeof m === 'object' && m.role) result.push(m);
    }
    return result;
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
   * wrap-up rollback, TP auto-fixer injection, or session restoration).
   * slicing). Single chokepoint for ALL message access — unguarded raw
   * consumers (hint-round, minifier) that read `.role` /
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

  /**
   * TRUE-array indices of every NON-SYNTHETIC assistant message that called
   * `brief`, in message order — the complete candidate set for anchor
   * selection.
   *
   * This is only the FIRST half of the anchor rule: the second half (at least
   * one message after the brief's round-trip) needs the tool result, so it is
   * applied by Triologue.currentAnchorIndex, the sole consumer.
   */
  briefIndices(): number[] {
    const result: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (!m || m.role !== 'assistant' || !m.tool_calls) continue;
      // Provenance is a property of the MESSAGE (types.ts Message.synthetic),
      // never a flag in `arguments` and never a call-id convention.
      if (m.synthetic) continue;
      if (!(m.tool_calls as ToolCall[]).some((tc) => tc.function?.name === 'brief')) continue;
      result.push(i);
    }
    return result;
  }

  /**
   * Index of the tool result answering call `id` (and optionally `toolName`),
   * searching from `fromIndex`; -1 when none.
   *
   * A provider call id is unique only WITHIN one assistant turn, so an id-only
   * search can bind a call to another tool's result after a replay/reuse.
   * Callers that REWRITE or truncate on the answer must
   * pass the name too and compare against the result's `tool_name`.
   *
   * `fromIndex` is INCLUSIVE: the search starts AT that index. A caller that
   * truncates to `resultIndex + 1` and then rewrites the surviving result must
   * pass `resultIndex` (not `resultIndex + 1`) — after that truncation nothing
   * follows it, so an off-by-one matches nothing and loses the write.
   */
  findToolResultIndex(id: string | undefined, fromIndex = 0, toolName?: string): number {
    if (!id) return -1;
    for (let i = Math.max(0, fromIndex); i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m && m.role === 'tool' && m.tool_call_id === id && (!toolName || m.tool_name === toolName)) return i;
    }
    return -1;
  }

  /** First index strictly after `index` that holds a valid message, or length. */
  firstMessageIndexAfter(index: number): number {
    for (let i = index + 1; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m && typeof m === 'object' && m.role) return i;
    }
    return this.messages.length;
  }

  /**
   * REWRITE (in place) the tool result answering call `id` to `content`.
   *
   * Used to rewrite a brief result in place (e.g. a section appended to it),
   * not appended as a new message. In place, because the assistant→tool pairing
   * must not change — position, `tool_call_id` and `tool_name` stay as the
   * provider saw them. Returns false (modifying nothing) when no result exists.
   *
   * `fromIndex` matters: a call id is unique only within one assistant turn, so
   * a restored or replayed history can carry the SAME id on two `brief` calls.
   * A search from 0 would then find the OLDER result and write the note into it.
   * Callers that already resolved the target pass its index, so the write lands
   * on the occurrence they resolved and on nothing else.
   */
  rewriteToolResult(id: string | undefined, content: string, fromIndex = 0): boolean {
    const i = this.findToolResultIndex(id, fromIndex);
    if (i < 0) return false;
    this.messages[i].content = content;
    return true;
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
   * The system-prompt contributor to the full request, as a one-element array
   * (empty when no system prompt is set). Used by token-budget accounting so
   * the system prompt can be measured independently of the conversation.
   */
  getSystemMessages(): Message[] {
    return this.sysPrompt ? [{ role: 'system', content: this.sysPrompt }] : [];
  }

  /**
   * The project-context contributor to the full request (README, mindmap
   * instructions, platform/calendar, hook info, …), filtered defensively.
   * Used by token-budget accounting so projectContext can be measured apart
   * from the system prompt and the conversation.
   */
  getProjectContextMessages(): Message[] {
    const result: Message[] = [];
    for (const m of this.projectContext) {
      if (m && typeof m === 'object' && m.role) result.push(m);
    }
    return result;
  }

  /**
   * Full message view for LLM calls: system prompt + project context +
   * filtered conversation. Same defensive filtering as getRaw().
   *
   * This is the OUTBOUND path (llm.ts retryChat, explorer-agent, esc-wrap-up),
   * so every message is passed through {@link toProviderMessage}, which keeps
   * ONLY the provider-visible fields (PROVIDER_MESSAGE_KEYS) and drops
   * everything else — including the in-memory-only `synthetic` marker
   * (types.ts). Filtering on egress rather than on ingress keeps the mark
   * readable at its consumers (briefIndices / currentAnchorIndex, which read the true
   * array) while guaranteeing it never reaches a provider — and so can never
   * be echoed back as model output. It is an ALLOW-list, not a deny-list: a
   * future internal field is excluded by default instead of having to be
   * remembered here.
   */
  getFullMessages(): Message[] {
    const result: Message[] = [];

    if (this.sysPrompt) {
      result.push({ role: 'system', content: this.sysPrompt });
    }

    // Inject project context (README, mindmap instructions, etc.)
    for (const m of this.projectContext) {
      if (m && typeof m === 'object' && m.role) result.push(toProviderMessage(m));
    }

    // Conversation history
    for (const m of this.messages) {
      if (m && typeof m === 'object' && m.role) result.push(toProviderMessage(m));
    }

    return result;
  }
}

/**
 * The fields a provider may see — an ALLOW-LIST, not a deny-list.
 *
 * The payload is rebuilt from these keys only, so any runtime-only field is
 * dropped BY DEFAULT, including ones added later: `synthetic` (infrastructure
 * provenance, types.ts), `hook_name` (minifier attribution), `imageMime`
 * (multimodal hint), transcript envelope fields (`kind`, `user_origin`,
 * `timestamp`), and the extended `Message.tool_call_id` / `reasoning_content`
 * … which DO belong to the wire and are listed here explicitly.
 *
 * A deny-list was the earlier shape (strip `synthetic`, spread the rest). It
 * is strictly weaker: every new internal field silently starts reaching the
 * model unless someone remembers to exclude it, and a leaked marker can be
 * imitated as model output — the same forgery hazard that ruled out a flag
 * inside `arguments`. With an allow-list a forgotten field is merely absent
 * from the payload, which is observable, rather than leaking.
 *
 * Keys cover BOTH provider shapes this runtime talks to:
 *   - ollama: role, content, thinking, images, tool_calls, tool_name
 *   - deepseek (engine/deepseek.ts normalizeMessage): + tool_call_id,
 *     reasoning_content, imageMime (data-URL media type for `images[]`)
 */
const PROVIDER_MESSAGE_KEYS = [
  'role',
  'content',
  'thinking',
  'images',
  'tool_calls',
  'tool_name',
  'tool_call_id',
  'reasoning_content',
  'imageMime',
] as const;

const PROVIDER_MESSAGE_KEY_SET: ReadonlySet<string> = new Set<string>(PROVIDER_MESSAGE_KEYS);

/**
 * Project a message onto the provider-visible fields, dropping everything
 * else.
 *
 * Returns the SAME object when it carries no extra key, so the common case
 * allocates nothing (this runs per message on every LLM call).
 */
function toProviderMessage(m: Message): Message {
  const hasExtra = Object.keys(m).some((k) => !PROVIDER_MESSAGE_KEY_SET.has(k));
  if (!hasExtra) return m;
  const out: Record<string, unknown> = {};
  for (const key of PROVIDER_MESSAGE_KEYS) {
    const value = (m as unknown as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as Message;
}
