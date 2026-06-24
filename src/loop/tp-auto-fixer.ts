/**
 * tp-auto-fixer.ts - Auto-recovery for triologue parity violations
 *
 * When --debug-tp is NOT set, TP violations are automatically recovered by
 * inserting bridge messages to fix the role sequence. A warning is shown
 * on the terminal so the user is aware of the recovery.
 *
 * When --debug-tp IS set, the old throw+stacktrace behavior is preserved
 * for debugging the root cause.
 *
 * For certain providers (Ollama, DeepSeek), tool → user and tool → note
 * transitions are valid — no bridge is needed. Provider support is checked
 * directly via getApiProvider().
 */

import { isDebuggingTp, getApiProvider } from '../config.js';
import { agentIO } from './agent-io.js';
import type { Triologue } from './triologue.js';
import type { Message, ToolCall } from '../types.js';

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
 * @param triologue - The Triologue instance to fix
 * @param violation - The type of violation detected
 * @param lastRole - The last role before the violation (for context in warning)
 * @returns 'allowed' if transition is valid for provider, 'recovered' if fix applied, 'debug_throw' if caller should throw
 */
export function attemptAutoFix(
  triologue: Triologue,
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
      triologue._injectBypass({
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
      // will be updated by updateLastPendingToolCall() when the real tool() is called.
      const syntheticCall: ToolCall = {
        id: syntheticId,
        function: {
          name: '',
          arguments: {},
        },
      };
      triologue._injectBypass({
        role: 'assistant',
        content: '',
        tool_calls: [syntheticCall],
      } as Message);
      break;
    }

    case 'duplicate_assistant':
      // Inject tool results for all pending calls BEFORE clearing, so the first
      // assistant message's tool_calls each have a corresponding tool result.
      // DeepSeek strictly requires this — every tool_call_id must have a tool
      // response before the next assistant message. Ollama tolerates the omission,
      // but injecting results is semantically correct for all providers.
      for (const id of triologue._getPendingToolCallOrder()) {
        const tc = triologue._getPendingToolCall(id);
        if (tc) {
          triologue._injectBypass({
            role: 'tool',
            tool_name: tc.function.name,
            content: '[TP_RECOVERY] Tool call skipped due to consecutive assistant messages.',
            tool_call_id: id,
          });
        }
      }
      triologue._clearPendingToolCalls();
      break;

    case 'agent_after_system':
      // Bridge: system → user → assistant
      // Use a TP tag prefix (like [WRAP_UP], [MAIL]) to make it recognizable
      // as an internal system action, not user input.
      triologue._injectBypass({
        role: 'user',
        content: '[TP_RECOVERY] Continue.',
      });
      break;

    case 'invalid_sequence':
      // Generic: bridge with a neutral empty assistant message
      triologue._injectBypass({
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
