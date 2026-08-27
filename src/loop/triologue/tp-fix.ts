/**
 * triologue/tp-fix.ts - TP-violation auto-recovery, INSIDE the triologue layer
 *
 * When --debug-tp is NOT set, TP violations are automatically recovered by
 * inserting bridge messages to fix the role sequence. A warning is shown
 * on the terminal so the user is aware of the recovery.
 *
 * When --debug-tp IS set, the old throw+stacktrace behavior is preserved
 * for debugging the root cause (TpAutoFixer.throwViolation handles it).
 *
 * For certain providers (Ollama, DeepSeek), tool → user and tool → note
 * transitions are valid — no bridge is needed. Provider support is checked
 * directly via getApiProvider().
 *
 * 2026-08: moved from loop/tp-auto-fixer.ts into the triologue layer so the
 * recovery logic can manipulate the facade's private state (store, ledger)
 * DIRECTLY — the five _-prefixed public methods and the TriologueInternals
 * interface are gone. attemptAutoFix now takes an explicit context object
 * with exactly the primitives recovery needs.
 *
 * The TpAutoFixer class wraps attemptAutoFix with the violation-throw path:
 * the facade calls tpFix.handle(kind, lastRole, msg) at each transition site
 * and the class owns both the recovery dispatch AND the debug-mode throw,
 * so the facade keeps no TP-recovery logic of its own.
 */

import { isDebuggingTp, getApiProvider } from '../../config.js';
import { agentIO } from '../agent-io.js';
import type { Message, ToolCall } from '../../types.js';

/**
 * All possible TP violation types that can be auto-recovered.
 */
export type TpViolationType =
  | 'user_after_tool'
  | 'note_after_tool'
  | 'tool_no_assistant'
  | 'duplicate_assistant'
  | 'agent_after_system'
  | 'invalid_sequence';

/**
 * Result of attempting auto-fix.
 * - 'allowed': violation is a valid transition for this provider, no fix needed
 * - 'recovered': fix was applied, caller should continue normally
 * - 'debug_throw': --debug-tp is set, caller should throw the violation
 */
export type AutoFixResult = 'allowed' | 'recovered' | 'debug_throw';

/**
 * The primitives TP recovery needs from the facade. The facade passes an
 * adapter over its private store/ledger/onMessage — no public internals
 * exposed, and no other consumer can reach these (the type is not exported
 * for external use; it lives in the triologue layer).
 */
export interface TpFixContext {
  /** Push a message bypassing TP validation (updates tokens + onMessage). */
  injectBypass(message: Message): void;
  /** Register tool calls to the pending ledger (post synthetic injection). */
  registerPending(toolCalls: ToolCall[]): void;
  /** Iterate pending tool calls in order (copy). */
  getPendingOrder(): string[];
  /** Look up a pending tool call by ID. */
  getPendingById(id: string): ToolCall | undefined;
  /** Clear all pending tool calls (post-recovery cleanup). */
  clearPending(): void;
}

/**
 * Check whether the current API provider supports tool → user transitions
 * natively, making the bridge unnecessary.
 */
function supportsToolToUser(): boolean {
  const provider = getApiProvider();
  return provider === 'ollama' || provider === 'deepseek';
}

/**
 * Attempt to auto-recover a TP violation by injecting bridge messages.
 *
 * @param ctx - Adapter over the facade's private state (see TpFixContext)
 * @param violation - The type of violation detected
 * @param lastRole - The last role before the violation (for context in warning)
 * @returns 'allowed' if transition is valid for provider, 'recovered' if fix applied, 'debug_throw' if caller should throw
 */
export function attemptAutoFix(
  ctx: TpFixContext,
  violation: TpViolationType,
  lastRole: string | null,
): AutoFixResult {
  // ── Debug mode: preserve old throw+stacktrace behavior ──
  if (isDebuggingTp()) {
    return 'debug_throw';
  }

  // ── Provider-supported transitions: no bridge needed ──
  if (supportsToolToUser() && (violation === 'user_after_tool' || violation === 'note_after_tool')) {
    agentIO.verbose('tp', `Allowing ${formatViolationLabel(violation)} for provider ${getApiProvider()}`);
    return 'allowed';
  }

  // ── Log recovery in verbose mode only ──
  const violationLabel = formatViolationLabel(violation);
  agentIO.verbose('tp', `Auto-recovering TP violation: ${violationLabel} (lastRole: ${lastRole})`);

  // ── Apply recovery ──
  switch (violation) {
    case 'user_after_tool':
    case 'note_after_tool':
      // Bridge: tool → assistant → user
      // Use empty content so the subsequent user message naturally follows.
      ctx.injectBypass({
        role: 'assistant',
        content: '',
      });
      break;

    case 'tool_no_assistant': {
      // Bridge: user/system/null → assistant(with synthetic tool_call) → tool
      // Generate a synthetic ID so the subsequent tool() call finds a pending call.
      // Empty content is fine — the tool result will follow immediately.
      const syntheticId = `tp_recovery_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // Build a ToolCall with a synthetic ID; function name is empty and
      // will be updated by the facade (ledger.updateLastName) when the real
      // tool() is called.
      const syntheticCall: ToolCall = {
        id: syntheticId,
        function: {
          name: '',
          arguments: {},
        },
      };
      ctx.injectBypass({
        role: 'assistant',
        content: '',
        tool_calls: [syntheticCall],
      } as Message);
      // Register the synthetic tool_call to the pending ledger so the
      // subsequent tool() call can resolve the tool_call_id and alignment
      // validation does not falsely report 'no_pending_calls'. injectBypass()
      // only pushes the message; it does not register pending calls (agent()
      // does that at its own call site, but recovery bypasses agent()).
      ctx.registerPending([syntheticCall]);
      break;
    }

    case 'duplicate_assistant':
      // Inject tool results for all pending calls BEFORE clearing, so the first
      // assistant message's tool_calls each have a corresponding tool result.
      // DeepSeek strictly requires this — every tool_call_id must have a tool
      // response before the next assistant message. Ollama tolerates the omission,
      // but injecting results is semantically correct for all providers.
      for (const id of ctx.getPendingOrder()) {
        const tc = ctx.getPendingById(id);
        if (tc) {
          ctx.injectBypass({
            role: 'tool',
            tool_name: tc.function.name,
            content: '[TP_RECOVERY] Tool call skipped due to consecutive assistant messages.',
            tool_call_id: id,
          });
        }
      }
      ctx.clearPending();
      break;

    case 'agent_after_system':
      // Bridge: system → user → assistant
      // Use a TP tag prefix (like [WRAP_UP], [MAIL]) to make it recognizable
      // as an internal system action, not user input.
      ctx.injectBypass({
        role: 'user',
        content: '[TP_RECOVERY] Continue.',
      });
      break;

    case 'invalid_sequence':
      // Generic: bridge with a neutral empty assistant message
      ctx.injectBypass({
        role: 'assistant',
        content: '',
      });
      break;
  }

  return 'recovered';
}

/**
 * Format a human-readable label for the violation type.
 */
function formatViolationLabel(violation: TpViolationType): string {
  const labels: Record<TpViolationType, string> = {
    user_after_tool: 'user() after tool()',
    note_after_tool: 'note() after tool()',
    tool_no_assistant: 'tool() without preceding assistant (no pending calls)',
    duplicate_assistant: 'agent() after assistant()',
    agent_after_system: 'agent() after system()',
    invalid_sequence: 'invalid role transition',
  };
  return labels[violation];
}

/**
 * Delegate owning TP-violation handling for the Triologue facade.
 *
 * Consolidates the two coupled halves that previously lived apart:
 * 1. the recovery dispatch (attemptAutoFix, below), and
 * 2. the violation-throw path (the facade's former throwTpViolation —
 *    --debug-tp stacktrace brief + throw).
 *
 * The facade instantiates one TpAutoFixer in a field initializer with
 * closures over its private store/ledger; each role-transition site calls
 * handle() and gets back the AutoFixResult:
 * - 'allowed'    → transition is valid for this provider; caller appends directly
 * - 'recovered'  → bridge injected; caller falls through as today
 * - (never returns 'debug_throw' — handle() throws instead)
 */
export class TpAutoFixer {
  private readonly ctx: TpFixContext;

  constructor(ctx: TpFixContext) {
    this.ctx = ctx;
  }

  /**
   * Handle a potential TP violation at a role-transition site.
   *
   * @param violation - The type of violation detected
   * @param lastRole - The last role before the violation (for context)
   * @param violationMessage - Human-readable message used when throwing
   *   in --debug-tp mode (e.g. 'cannot add user message after tool role')
   * @returns 'allowed' if transition is valid for provider, 'recovered' if fix applied.
   *   Throws in --debug-tp mode (never returns 'debug_throw').
   */
  handle(violation: TpViolationType, lastRole: string | null, violationMessage: string): Exclude<AutoFixResult, 'debug_throw'> {
    const result = attemptAutoFix(this.ctx, violation, lastRole);
    if (result === 'debug_throw') {
      this.throwViolation(violationMessage);
    }
    return result;
  }

  /**
   * Throw a TP violation error, with the call-site stack trace surfaced
   * via a brief when --debug-tp is enabled (absorbed from the facade's
   * throwTpViolation — attemptAutoFix's isDebuggingTp() gate already
   * decided this path, so no second check is needed here).
   */
  throwViolation(message: string): never {
    const stack = new Error().stack;
    agentIO.brief('error', 'tp', `${message}\nCall site:\n${stack}`);
    throw new Error(`TP violation: ${message}`);
  }
}