/**
 * esc-test-helpers.ts - Shared test utilities for ESC-neglection loop tests.
 *
 * Provides factories for TurnVars, PassData, mock ChatResponse, mock ToolCall,
 * mock HookResult, and a fully-wired MachineEnv with mocked dependencies.
 *
 * NOTE: This file does NOT import Triologue — test files import it themselves
 * after setting up vi.mock() for agent-io.js and ollama.js (required to construct
 * a real Triologue). See compact-undefined-role.test.ts for the mock pattern.
 */
import { vi } from 'vitest';
import { createMockContext, type MockContextOptions } from '../test-utils/mock-context.js';
import type { MachineEnv, TurnVars, PassData } from '../../../loop/state-machine.js';
import type { ToolCall, ToolScope } from '../../../types.js';
import type { ConditionRegistry } from '../../../hook/conditions.js';
import type { Sequence } from '../../../hook/sequence.js';
import type { HookExecutor, AugmentedToolCall, ProcessToolCallsResult } from '../../../hook/hook-executor.js';
import type { InputProvider } from '../../../loop/input-provider.js';
import type { RequestEmbeddingTracker } from '../../../loop/request-embedding.js';
import type { Triologue } from '../../../loop/triologue.js';

// ============================================================================
// Data factories
// ============================================================================

/** Create a fresh TurnVars with default values. */
export function createTurnVars(overrides: Partial<TurnVars> = {}): TurnVars {
  return {
    isFirstRound: true,
    nextTodoNudge: 3,
    lastTodoState: '',
    nextBriefNudge: 5,
    lastUserQuery: '',
    extractedKeywords: [],
    ...overrides,
  };
}

/** Create a fresh PassData with default values. */
export function createPassData(overrides: Partial<PassData> = {}): PassData {
  return {
    abortController: null,
    rawToolCalls: [],
    assistantContent: '',
    augmentedCalls: [],
    hookResult: null,
    ...overrides,
  };
}

/**
 * Create a mock ChatResponse — the return shape of retryChat.
 * Matches the Ollama ChatResponse structure used by llm.ts.
 */
export function createMockChatResponse(options: {
  content?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
}): {
  message: {
    role: 'assistant';
    content: string;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
  };
  done: boolean;
  done_reason: string;
  eval_count: number;
  model: string;
  created_at: string;
} {
  return {
    message: {
      role: 'assistant' as const,
      content: options.content ?? '',
      ...(options.toolCalls && options.toolCalls.length > 0
        ? { tool_calls: options.toolCalls }
        : {}),
      ...(options.reasoningContent ? { reasoning_content: options.reasoningContent } : {}),
    },
    done: true,
    done_reason: 'stop',
    eval_count: 100,
    model: 'test-model',
    created_at: new Date().toISOString(),
  };
}

/** Create a mock ToolCall (with id, required by mycc's extended ToolCall type). */
export function createMockToolCall(
  name: string,
  args: Record<string, unknown> = {},
  id?: string,
): ToolCall {
  return {
    id: id ?? `call-${Math.random().toString(36).slice(2, 10)}`,
    function: { name, arguments: args },
  } as ToolCall;
}

/** Create a mock AugmentedToolCall (with optional metadata). */
export function createMockAugmentedToolCall(
  name: string,
  args: Record<string, unknown> = {},
  id?: string,
  metadata?: AugmentedToolCall['metadata'],
): AugmentedToolCall {
  return {
    ...createMockToolCall(name, args, id),
    ...(metadata ? { metadata } : {}),
  };
}

/** Create a mock ProcessToolCallsResult. */
export function createMockHookResult(options: {
  calls?: AugmentedToolCall[];
  blockedCalls?: Map<string, string>;
  deferredMessages?: Array<{ hookName: string; message: string }>;
  compactRequested?: boolean;
} = {}): ProcessToolCallsResult {
  return {
    calls: options.calls ?? [],
    blockedCalls: options.blockedCalls ?? new Map(),
    deferredMessages: options.deferredMessages ?? [],
    compactRequested: options.compactRequested ?? false,
  };
}

// ============================================================================
// MachineEnv factory
// ============================================================================

/** Options for createMockMachineEnv. */
export interface MockMachineEnvOptions {
  triologue: Triologue;
  ctxOptions?: MockContextOptions;
  scope?: ToolScope;
  conditions?: Partial<ConditionRegistry>;
  sequence?: Partial<Sequence>;
  hookExecutor?: Partial<HookExecutor>;
  inputProvider?: Partial<InputProvider>;
  requestEmbeddingTracker?: Partial<RequestEmbeddingTracker>;
  sessionFilePath?: string;
}

/**
 * Create a fully-wired MachineEnv with mocked dependencies.
 *
 * By default, `ctx.core.escAware` runs the operation (no ESC simulation).
 * Tests override `ctx.core.escAware` to simulate ESC during operation:
 *   env.ctx.core.escAware = vi.fn(async (_op, cleanup) => cleanup(new AbortController())) as any;
 */
export function createMockMachineEnv(options: MockMachineEnvOptions): MachineEnv {
  const ctx = createMockContext(options.ctxOptions);
  // Default escAware: run the operation, pass a real AbortController (no ESC)
  ctx.core.escAware = vi.fn(async (fn: (ac: AbortController) => Promise<unknown>) =>
    fn(new AbortController()),
  ) as never;

  return {
    triologue: options.triologue,
    ctx,
    scope: options.scope ?? ('main' as ToolScope),
    conditions: {
      getPending: vi.fn(() => []),
      load: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
      findByTrigger: vi.fn(() => []),
      matches: vi.fn(() => []),
      save: vi.fn(),
      markPending: vi.fn(),
      needsCompilation: vi.fn(() => false),
      markInjected: vi.fn(),
      hasInjected: vi.fn(() => false),
      clearInjected: vi.fn(),
      ...options.conditions,
    } as unknown as ConditionRegistry,
    sequence: {
      add: vi.fn(),
      getEvents: vi.fn(() => []),
      clear: vi.fn(),
      has: vi.fn(() => false),
      hasAny: vi.fn(() => false),
      lastIndexOf: vi.fn(() => -1),
      last: vi.fn(),
      lastError: vi.fn(),
      count: vi.fn(() => 0),
      since: vi.fn(() => []),
      sinceEdit: vi.fn(() => []),
      evaluate: vi.fn(() => false),
      isPlanMode: vi.fn(() => false),
      hasSkillInConversation: vi.fn(() => false),
      totalCount: vi.fn(() => 0),
      markPromptBoundary: vi.fn(),
      ...options.sequence,
    } as unknown as Sequence,
    hookExecutor: {
      processToolCalls: vi.fn(async () => createMockHookResult()),
      ...options.hookExecutor,
    } as unknown as HookExecutor,
    inputProvider: {
      getInput: vi.fn(),
      setMode: vi.fn(),
      promptRetry: vi.fn(async () => false),
      ...options.inputProvider,
    } as unknown as InputProvider,
    sessionFilePath: options.sessionFilePath ?? '/tmp/test-session.json',
    pendingSlashQuery: null,
    crossroadOccurred: false,
    requestEmbeddingTracker: {
      addEntry: vi.fn(async () => {}),
      getMaxSimilarity: vi.fn(() => 0),
      similarityToDelta: vi.fn(() => 0),
      getDuplicationReport: vi.fn(() => ''),
      clear: vi.fn(),
      ...options.requestEmbeddingTracker,
    } as unknown as RequestEmbeddingTracker,
    nextWtNudge: 0,
  };
}