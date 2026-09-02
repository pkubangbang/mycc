/**
 * Tests for triologue/tp-fix.ts - Auto-recovery for triologue parity violations
 *
 * 2026-08: tp-auto-fixer.ts was folded INTO the triologue layer as
 * triologue/tp-fix.ts. attemptAutoFix now takes a TpFixContext adapter
 * (injectBypass / registerPending / getPendingOrder / getPendingById /
 * clearPending) instead of the old Triologue facade with _-prefixed
 * methods. The mock builds that context directly — behavior assertions
 * are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attemptAutoFix } from '../../loop/triologue/tp-fix.js';
import type { TpFixContext } from '../../loop/triologue/tp-fix.js';
import type { Message, ToolCall } from '../../types.js';

// Use vi.hoisted for variables accessible in hoisted vi.mock factory
const { mockDebuggingTp, mockApiProvider } = vi.hoisted(() => ({
  mockDebuggingTp: { current: false },
  mockApiProvider: { current: 'ollama' },
}));

// Mock config module - must include all exports that transitive imports need
vi.mock('../../config.js', () => ({
  isDebuggingTp: () => mockDebuggingTp.current,
  getApiProvider: () => mockApiProvider.current,
  getMyccDir: () => '/tmp/.mycc',
  getLongtextDir: () => '/tmp/.mycc/longtext',
  ensureDirs: () => {},
  getTokenThreshold: () => 50000,
  isVerbose: () => false,
  getOllamaModel: () => 'test-model',
  getOllamaHost: () => 'http://localhost:11434',
  getOllamaApiKey: () => undefined,
  getDeepSeekHost: () => 'https://api.deepseek.com',
  getDeepSeekApiKey: () => undefined,
  getDeepSeekModel: () => 'deepseek-chat',
  isVisionEnabled: () => false,
  getVisionModel: () => '',
  getSessionArg: () => null,
  shouldSkipHealthCheck: () => true,
  shouldRunSetup: () => false,
  isDebuggingEval: () => false,
  isDebuggingPrompt: () => false,
  getSkillMatchThreshold: () => 0.5,
  validateEnv: () => ({ ok: true }),
  MYCC_DIR: '.mycc',
  setSessionContext: () => {},
  getSessionContext: () => '',
  getSessionDir: () => '/tmp/.mycc/sessions/test-session',
  getToolsDir: () => '/tmp/.mycc/tools',
  getSkillsDir: () => '/tmp/.mycc/skills',
  getSessionsDir: () => '/tmp/.mycc/sessions',
  getUserToolsDir: () => '/tmp/.mycc-store/tools',
  getUserSkillsDir: () => '/tmp/.mycc-store/skills',
  getWikiDir: () => '/tmp/.mycc-store/wiki',
  getWikiLogsDir: () => '/tmp/.mycc-store/wiki/logs',
  getWikiDbDir: () => '/tmp/.mycc-store/wiki/db',
  getWikiDomainsFile: () => '/tmp/.mycc-store/wiki/domains.json',
  ensureToolTypeImports: () => {},
  getRagProvider: () => 'nomic',
}));

// Mock agentIO (imported eagerly by tp-fix.ts)
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    brief: vi.fn(),
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createMockContext(): TpFixContext & {
  injectedMessages: Message[];
  pendingToolCalls: Map<string, ToolCall>;
  pendingToolCallOrder: string[];
} {
  const injectedMessages: Message[] = [];
  const pendingToolCalls = new Map<string, ToolCall>();
  const pendingToolCallOrder: string[] = [];

  return {
    injectedMessages,
    pendingToolCalls,
    pendingToolCallOrder,
    injectBypass: vi.fn((msg: Message) => {
      injectedMessages.push(msg);
    }),
    registerPending: vi.fn((toolCalls: ToolCall[]) => {
      for (const tc of toolCalls) {
        pendingToolCalls.set(tc.id, tc);
        pendingToolCallOrder.push(tc.id);
      }
    }),
    getPendingOrder: vi.fn(() => [...pendingToolCallOrder]),
    getPendingById: vi.fn((id: string) => pendingToolCalls.get(id) || undefined),
    clearPending: vi.fn(() => {
      pendingToolCalls.clear();
      pendingToolCallOrder.length = 0;
    }),
  };
}

describe('attemptAutoFix', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
    // Reset the controllable config state so tests don't leak into each other.
    mockDebuggingTp.current = false;
    mockApiProvider.current = 'ollama';
  });

  describe('debug mode', () => {
    it('should return debug_throw for all violation types when debugging TP', () => {
      mockDebuggingTp.current = true;

      const types = ['user_after_tool', 'note_after_tool', 'tool_no_assistant', 'duplicate_assistant', 'agent_after_system', 'invalid_sequence'] as const;
      for (const type of types) {
        const result = attemptAutoFix(ctx, type, 'assistant');
        expect(result).toBe('debug_throw');
      }
    });
  });

  describe('provider-supported transitions', () => {
    it('should return allowed for user_after_tool with ollama provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'ollama';
      const result = attemptAutoFix(ctx, 'user_after_tool', 'tool');
      expect(result).toBe('allowed');
    });

    it('should return allowed for note_after_tool with ollama provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'ollama';
      const result = attemptAutoFix(ctx, 'note_after_tool', 'tool');
      expect(result).toBe('allowed');
    });

    it('should return allowed for user_after_tool with deepseek provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'deepseek';
      const result = attemptAutoFix(ctx, 'user_after_tool', 'tool');
      expect(result).toBe('allowed');
    });

    it('should return allowed for note_after_tool with deepseek provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'deepseek';
      const result = attemptAutoFix(ctx, 'note_after_tool', 'tool');
      expect(result).toBe('allowed');
    });

    it('should NOT return allowed for tool_no_assistant even with ollama', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'ollama';
      const result = attemptAutoFix(ctx, 'tool_no_assistant', 'user');
      expect(result).toBe('recovered');
    });
  });

  describe('recovery for user_after_tool', () => {
    it('should inject empty assistant bridge for non-ollama provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'other';
      const result = attemptAutoFix(ctx, 'user_after_tool', 'tool');
      expect(result).toBe('recovered');
      expect(ctx.injectBypass).toHaveBeenCalledWith({
        role: 'assistant',
        content: '',
      });
    });
  });

  describe('recovery for note_after_tool', () => {
    it('should inject empty assistant bridge for non-ollama provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'other';
      const result = attemptAutoFix(ctx, 'note_after_tool', 'tool');
      expect(result).toBe('recovered');
      expect(ctx.injectBypass).toHaveBeenCalledWith({
        role: 'assistant',
        content: '',
      });
    });
  });

  describe('recovery for tool_no_assistant', () => {
    it('should inject synthetic assistant with tool_calls', () => {
      const result = attemptAutoFix(ctx, 'tool_no_assistant', 'user');
      expect(result).toBe('recovered');
      expect(ctx.injectBypass).toHaveBeenCalled();
      const call = vi.mocked(ctx.injectBypass).mock.calls[0][0];
      expect(call.role).toBe('assistant');
      expect(call.content).toBe('');
      expect(call.tool_calls).toBeDefined();
      expect(call.tool_calls!.length).toBe(1);
      expect(call.tool_calls![0].function.name).toBe('');
    });

    it('should register the synthetic tool_call to pending maps so tool() can resolve it', () => {
      const result = attemptAutoFix(ctx, 'tool_no_assistant', 'user');
      expect(result).toBe('recovered');
      // registerPending must be called with the synthetic tool_call so the
      // pending-ledger resolution finds the id and alignment validation
      // does not falsely report 'no_pending_calls'.
      expect(ctx.registerPending).toHaveBeenCalledTimes(1);
      const registered = vi.mocked(ctx.registerPending).mock.calls[0][0];
      expect(registered.length).toBe(1);
      // The registered call must be the same synthetic call that was injected.
      const injectedCall = vi.mocked(ctx.injectBypass).mock.calls[0][0];
      const injectedToolCall = injectedCall.tool_calls![0] as ToolCall;
      expect(registered[0].id).toBe(injectedToolCall.id);
    });
  });

  describe('recovery for duplicate_assistant', () => {
    it('should inject tool results for pending calls and clear them', () => {
      // Set up pending tool calls
      const ctxWithPending = createMockContext();
      ctxWithPending.pendingToolCallOrder.push('call_1', 'call_2');
      ctxWithPending.pendingToolCalls.set('call_1', { id: 'call_1', function: { name: 'bash', arguments: {} } } as ToolCall);
      ctxWithPending.pendingToolCalls.set('call_2', { id: 'call_2', function: { name: 'edit_file', arguments: {} } } as ToolCall);

      const result = attemptAutoFix(ctxWithPending, 'duplicate_assistant', 'assistant');
      expect(result).toBe('recovered');
      expect(ctxWithPending.injectBypass).toHaveBeenCalledTimes(2);
      expect(ctxWithPending.clearPending).toHaveBeenCalled();
      // The two injected messages are tool results for the pending calls.
      const injected = ctxWithPending.injectedMessages;
      expect(injected[0].role).toBe('tool');
      expect(injected[1].role).toBe('tool');
    });

    it('should handle empty pending calls gracefully', () => {
      const ctxEmpty = createMockContext();

      const result = attemptAutoFix(ctxEmpty, 'duplicate_assistant', 'assistant');
      expect(result).toBe('recovered');
      expect(ctxEmpty.injectBypass).not.toHaveBeenCalled();
      expect(ctxEmpty.clearPending).toHaveBeenCalled();
    });

    it('uses a placeholder tool_name when a pending tool_call has an empty function.name', () => {
      // Regression: a malformed provider tool_call may carry an empty
      // function.name. The duplicate_assistant branch used to inject a tool
      // result with tool_name: '' — empty tool_name can confuse downstream
      // tool routing/display, and clearPending() then drops the call
      // permanently (no later chance to recover the name). Now the branch
      // falls back to a recognizable placeholder so the injected result is
      // well-formed even when the provider omitted the name.
      const ctxBad = createMockContext();
      ctxBad.pendingToolCallOrder.push('call_bad');
      ctxBad.pendingToolCalls.set('call_bad', { id: 'call_bad', function: { name: '', arguments: {} } } as ToolCall);

      const result = attemptAutoFix(ctxBad, 'duplicate_assistant', 'assistant');
      expect(result).toBe('recovered');
      expect(ctxBad.injectBypass).toHaveBeenCalledTimes(1);
      const injected = ctxBad.injectedMessages[0];
      expect(injected.role).toBe('tool');
      expect(injected.tool_name).not.toBe('');
      expect(injected.tool_name).toBe('__tp_recovery_unknown_tool__');
      expect(injected.tool_call_id).toBe('call_bad');
    });
  });

  describe('recovery for agent_after_system', () => {
    it('should inject bridge user message', () => {
      const result = attemptAutoFix(ctx, 'agent_after_system', 'system');
      expect(result).toBe('recovered');
      expect(ctx.injectBypass).toHaveBeenCalledWith({
        role: 'user',
        content: '[TP_RECOVERY] Continue.',
      });
    });
  });

  describe('recovery for invalid_sequence', () => {
    it('should inject neutral empty assistant message', () => {
      const result = attemptAutoFix(ctx, 'invalid_sequence', null);
      expect(result).toBe('recovered');
      expect(ctx.injectBypass).toHaveBeenCalledWith({
        role: 'assistant',
        content: '',
      });
    });
  });
});