/**
 * Tests for tp-auto-fixer.ts - Auto-recovery for triologue parity violations
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attemptAutoFix } from '../../loop/tp-auto-fixer.js';
import type { Triologue } from '../../loop/triologue.js';
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
}));

function createMockTriologue(): Triologue {
  // Create a minimal mock that satisfies the Triologue interface
  const injectedMessages: Message[] = [];
  const pendingToolCalls = new Map<string, ToolCall>();
  const pendingToolCallOrder: string[] = [];

  return {
    _injectBypass: vi.fn((msg: Message) => {
      injectedMessages.push(msg);
    }),
    _getPendingToolCallOrder: vi.fn(() => [...pendingToolCallOrder]),
    _getPendingToolCall: vi.fn((id: string) => pendingToolCalls.get(id) || undefined),
    _clearPendingToolCalls: vi.fn(() => {
      pendingToolCalls.clear();
      pendingToolCallOrder.length = 0;
    }),
    getMessagesRaw: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    getLastRole: vi.fn(() => null),
    getLastUserQuery: vi.fn(() => ''),
    getTokenCount: vi.fn(() => 0),
    getTokenThreshold: vi.fn(() => 50000),
    needsCompact: vi.fn(() => false),
    hasActiveWrapUp: vi.fn(() => false),
    findAllCheckpoints: vi.fn(() => []),
    findOpenCheckpoint: vi.fn(() => null),
    findCheckpointById: vi.fn(() => null),
    getMessagesFrom: vi.fn(() => []),
    getWiki: vi.fn(() => undefined),
    getMessagesRaw: vi.fn(() => []),
  } as unknown as Triologue;
}

describe('attemptAutoFix', () => {
  let triologue: Triologue;

  beforeEach(() => {
    triologue = createMockTriologue();
    vi.clearAllMocks();
  });

  describe('debug mode', () => {
    it('should return debug_throw for all violation types when debugging TP', () => {
      mockDebuggingTp.current = true;

      const types = ['user_after_tool', 'note_after_tool', 'tool_no_assistant', 'duplicate_assistant', 'agent_after_system', 'invalid_sequence'] as const;
      for (const type of types) {
        const result = attemptAutoFix(triologue, type, 'assistant');
        expect(result).toBe('debug_throw');
      }
    });
  });

  describe('provider-supported transitions', () => {
    it('should return allowed for user_after_tool with ollama provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'ollama';
      const result = attemptAutoFix(triologue, 'user_after_tool', 'tool');
      expect(result).toBe('allowed');
    });

    it('should return allowed for note_after_tool with ollama provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'ollama';
      const result = attemptAutoFix(triologue, 'note_after_tool', 'tool');
      expect(result).toBe('allowed');
    });

    it('should return allowed for user_after_tool with deepseek provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'deepseek';
      const result = attemptAutoFix(triologue, 'user_after_tool', 'tool');
      expect(result).toBe('allowed');
    });

    it('should return allowed for note_after_tool with deepseek provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'deepseek';
      const result = attemptAutoFix(triologue, 'note_after_tool', 'tool');
      expect(result).toBe('allowed');
    });

    it('should NOT return allowed for tool_no_assistant even with ollama', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'ollama';
      const result = attemptAutoFix(triologue, 'tool_no_assistant', 'user');
      expect(result).toBe('recovered');
    });
  });

  describe('recovery for user_after_tool', () => {
    it('should inject empty assistant bridge for non-ollama provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'other';
      const result = attemptAutoFix(triologue, 'user_after_tool', 'tool');
      expect(result).toBe('recovered');
      expect(triologue._injectBypass).toHaveBeenCalledWith({
        role: 'assistant',
        content: '',
      });
    });
  });

  describe('recovery for note_after_tool', () => {
    it('should inject empty assistant bridge for non-ollama provider', () => {
      mockDebuggingTp.current = false;
      mockApiProvider.current = 'other';
      const result = attemptAutoFix(triologue, 'note_after_tool', 'tool');
      expect(result).toBe('recovered');
      expect(triologue._injectBypass).toHaveBeenCalledWith({
        role: 'assistant',
        content: '',
      });
    });
  });

  describe('recovery for tool_no_assistant', () => {
    it('should inject synthetic assistant with tool_calls', () => {
      const result = attemptAutoFix(triologue, 'tool_no_assistant', 'user');
      expect(result).toBe('recovered');
      expect(triologue._injectBypass).toHaveBeenCalled();
      const call = vi.mocked(triologue._injectBypass).mock.calls[0][0];
      expect(call.role).toBe('assistant');
      expect(call.content).toBe('');
      expect(call.tool_calls).toBeDefined();
      expect(call.tool_calls!.length).toBe(1);
      expect(call.tool_calls![0].function.name).toBe('');
    });
  });

  describe('recovery for duplicate_assistant', () => {
    it('should inject tool results for pending calls and clear them', () => {
      // Set up pending tool calls
      const triologueWithPending = {
        _injectBypass: vi.fn(),
        _getPendingToolCallOrder: vi.fn(() => ['call_1', 'call_2']),
        _getPendingToolCall: vi.fn((id: string) => {
          if (id === 'call_1') return { id: 'call_1', function: { name: 'bash', arguments: {} } } as ToolCall;
          if (id === 'call_2') return { id: 'call_2', function: { name: 'edit_file', arguments: {} } } as ToolCall;
          return undefined;
        }),
        _clearPendingToolCalls: vi.fn(),
      } as unknown as Triologue;

      const result = attemptAutoFix(triologueWithPending, 'duplicate_assistant', 'assistant');
      expect(result).toBe('recovered');
      expect(triologueWithPending._injectBypass).toHaveBeenCalledTimes(2);
      expect(triologueWithPending._clearPendingToolCalls).toHaveBeenCalled();
    });

    it('should handle empty pending calls gracefully', () => {
      const triologueEmpty = {
        _injectBypass: vi.fn(),
        _getPendingToolCallOrder: vi.fn(() => []),
        _getPendingToolCall: vi.fn(() => undefined),
        _clearPendingToolCalls: vi.fn(),
      } as unknown as Triologue;

      const result = attemptAutoFix(triologueEmpty, 'duplicate_assistant', 'assistant');
      expect(result).toBe('recovered');
      expect(triologueEmpty._injectBypass).not.toHaveBeenCalled();
      expect(triologueEmpty._clearPendingToolCalls).toHaveBeenCalled();
    });
  });

  describe('recovery for agent_after_system', () => {
    it('should inject bridge user message', () => {
      const result = attemptAutoFix(triologue, 'agent_after_system', 'system');
      expect(result).toBe('recovered');
      expect(triologue._injectBypass).toHaveBeenCalledWith({
        role: 'user',
        content: '[TP_RECOVERY] Continue.',
      });
    });
  });

  describe('recovery for invalid_sequence', () => {
    it('should inject neutral empty assistant message', () => {
      const result = attemptAutoFix(triologue, 'invalid_sequence', null);
      expect(result).toBe('recovered');
      expect(triologue._injectBypass).toHaveBeenCalledWith({
        role: 'assistant',
        content: '',
      });
    });
  });
});
