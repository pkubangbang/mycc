# Plan: Thoroughly Test ESC-Neglection Features from Within the Loop

## Goal

Test all 7 ESC-neglection branches across state handlers + the wrap-up commit/rollback lifecycle — exercising real handler logic (not fake handlers) while mocking only the LLM streaming seam (`retryChat`) and IO-level modules.

## Architecture Summary (What We're Testing)

```
ESC pressed
  → agentIO.setNeglectedMode(true) + fires onNeglectedCallbacks
  → Core.escAware races operation vs ESC cleanup
  → State handler short-circuits to PROMPT
  → Background wrap-up LLM runs via startWrapUp()
  → Next prompt.ts entry: evaluateWrapUp() → commit (keep) or rollback (truncate)
```

### The 7 Neglected-Mode Branches in State Handlers

| # | Handler | File | Branch | Trigger | Expected Return |
|---|---------|------|--------|---------|-----------------|
| 1 | `handleLlm` | `states/llm.ts:57-63` | Pre-check | `isNeglectedMode()` true before `escAware` | `startWrapUp()` + PROMPT |
| 2 | `handleLlm` | `states/llm.ts:65-96` | Mid-call | ESC during `retryChat` → cleanup returns null | PROMPT (response discarded) |
| 3 | `handleLlm` | `states/llm.ts:119-124` | Mid-crossroad | ESC during `handleCrossroad` → `isNeglectedMode()` true | PROMPT |
| 4 | `handleTool` | `states/tool.ts:45-55` | Pre-tool | `isNeglectedMode()` true before each tool | `skipPendingTools()` + PROMPT |
| 5 | `handleStop` | `states/stop.ts:22-33` | Post-LLM | `isNeglectedMode()` true at STOP entry | Clear flag, `flushOutput()`, `presentResult()`, PROMPT |
| 6 | `handleCollect` | `states/collect.ts:83-92` | Hint-abort | ESC during hint gen → escAware returns `'aborted'` | PROMPT |
| 7 | `handleHook` | `states/hook.ts:268-275` | Recap-cancel | ESC during recap LLM → `isNeglectedMode()` true | PROMPT (or COLLECT if flag clear) |

### Wrap-Up Lifecycle (3 outcomes in prompt.ts)

| Scenario | Condition | Action |
|----------|-----------|--------|
| Commit | Wrap-up completed AND >3s since completion | `commitWrapUp()` — keep wrap-up messages |
| Rollback (grace) | Wrap-up completed AND <3s since completion | `rollbackWrapUp()` — truncate wrap-up messages |
| Rollback (incomplete) | Wrap-up not completed when user submits | `rollbackWrapUp()` — truncate wrap-up messages |

---

## Key Interfaces (for constructing test fixtures)

### ProcessToolCallsResult (from `hook/hook-executor.ts:68`)
```typescript
interface ProcessToolCallsResult {
  calls: AugmentedToolCall[];         // Modified array (blocked calls kept, injections added)
  blockedCalls: Map<string, string>;  // toolCall.id → blocking message
  deferredMessages: Array<{ hookName: string; message: string }>;
  compactRequested: boolean;
}
```

### AugmentedToolCall (from `hook/hook-executor.ts:16`)
```typescript
interface AugmentedToolCall extends ToolCall {
  metadata?: {
    filePath?: string;
    newLoc?: number;
    existingLoc?: number;
    isDestructive?: boolean;
    [key: string]: unknown;
  };
}
```

### PassData (from `loop/state-machine.ts:77`)
```typescript
interface PassData {
  abortController: AbortController | null;
  rawToolCalls: ToolCall[];
  assistantContent: string;
  assistantReasoningContent?: string;
  augmentedCalls: AugmentedToolCall[];
  hookResult: ProcessToolCallsResult | null;
  crossroadContinuation?: string;
}
```

### MachineEnv (from `loop/state-machine.ts:43`)
```typescript
interface MachineEnv {
  triologue: Triologue;
  ctx: AgentContext;
  scope: ToolScope;
  conditions: ConditionRegistry;
  sequence: Sequence;
  hookExecutor: HookExecutor;
  inputProvider: InputProvider;
  sessionFilePath: string;
  pendingSlashQuery: string | null;
  crossroadOccurred: boolean;
  requestEmbeddingTracker: RequestEmbeddingTracker;
  nextWtNudge: number;
}
```

---

## Testing Strategy: Three Layers

### Layer A — Handler Isolation (7 test files, one per branch)

Each test file targets a single handler with all external deps mocked. Uses `createMockContext()` from `src/tests/test-utils/mock-context.ts`.

**ESC simulation pattern** (from `esc-aware.test.ts`):
```typescript
// To simulate "ESC already pressed before handler runs":
agentIO.setNeglectedMode(true);

// To simulate "ESC pressed during operation":
agentIO.setNeglectedMode(true);
const callbacks = (agentIO as any).onNeglectedCallbacks;
for (const cb of callbacks) cb();
```

### Layer B — Full-Loop Integration (1 test file)

Wire all real handlers into `AgentStateMachine`, mock only `retryChat` + `agentIO` + `session I/O`. Simulate ESC at specific points during loop execution and verify the full PROMPT→...→PROMPT cycle.

### Layer C — Wrap-Up Lifecycle (1 test file)

Test `startWrapUp` + `evaluateWrapUp` + `commitWrapUp`/`rollbackWrapUp` with controlled timing using `vi.useFakeTimers()`.

---

## File-by-File Plan

### Test Infrastructure (shared mock utilities)

**New file**: `src/tests/loop/esc-test-helpers.ts`

```typescript
/**
 * Shared test helpers for ESC-neglection loop tests.
 * Provides factories for MachineEnv, PassData, TurnVars, and mock ChatResponse.
 */
import { vi } from 'vitest';
import { createMockContext, type MockContextOptions } from '../test-utils/mock-context.js';
import type { MachineEnv, TurnVars, PassData } from '../../../loop/state-machine.js';
import type { AgentContext, ToolScope, ToolCall } from '../../../types.js';
import type { Triologue } from '../../../loop/triologue.js';
import type { ConditionRegistry } from '../../../hook/conditions.js';
import type { Sequence } from '../../../hook/sequence.js';
import type { HookExecutor } from '../../../hook/hook-executor.js';
import type { InputProvider } from '../../../loop/input-provider.js';
import type { RequestEmbeddingTracker } from '../../../loop/request-embedding.js';

/** Create a fresh TurnVars with default values */
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

/** Create a fresh PassData with default values */
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

/** Create a mock ChatResponse (the return shape of retryChat) */
export function createMockChatResponse(options: {
  content?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
}): { message: { role: 'assistant'; content: string; tool_calls?: ToolCall[]; reasoning_content?: string }; done: boolean; done_reason: string; eval_count: number } {
  return {
    message: {
      role: 'assistant' as const,
      content: options.content ?? '',
      ...(options.toolCalls && options.toolCalls.length > 0 ? { tool_calls: options.toolCalls } : {}),
      ...(options.reasoningContent ? { reasoning_content: options.reasoningContent } : {}),
    },
    done: true,
    done_reason: 'stop',
    eval_count: 100,
  };
}

/** Create a mock AugmentedToolCall */
export function createMockToolCall(
  name: string,
  args: Record<string, unknown> = {},
  id?: string,
): import('../../../hook/hook-executor.js').AugmentedToolCall {
  return {
    id: id ?? `call-${Math.random().toString(36).slice(2, 10)}`,
    function: { name, arguments: args },
  };
}

/** Create a mock ProcessToolCallsResult */
export function createMockHookResult(options: {
  calls?: import('../../../hook/hook-executor.js').AugmentedToolCall[];
  blockedCalls?: Map<string, string>;
  deferredMessages?: Array<{ hookName: string; message: string }>;
  compactRequested?: boolean;
} = {}): import('../../../hook/hook-executor.js').ProcessToolCallsResult {
  return {
    calls: options.calls ?? [],
    blockedCalls: options.blockedCalls ?? new Map(),
    deferredMessages: options.deferredMessages ?? [],
    compactRequested: options.compactRequested ?? false,
  };
}

/** Create a fully-wired MachineEnv with mocked dependencies */
export function createMockMachineEnv(options: {
  triologue: Triologue;
  ctxOptions?: MockContextOptions;
  scope?: ToolScope;
  conditions?: Partial<ConditionRegistry>;
  sequence?: Partial<Sequence>;
  hookExecutor?: Partial<HookExecutor>;
  inputProvider?: Partial<InputProvider>;
  requestEmbeddingTracker?: Partial<RequestEmbeddingTracker>;
  sessionFilePath?: string;
}): MachineEnv {
  const ctx = createMockContext(options.ctxOptions);
  // escAware must be a function that can run the operation or return cleanup
  // By default, just runs the operation (no ESC simulation)
  ctx.core.escAware = vi.fn(async (fn: any) => fn(new AbortController())) as any;

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
```

---

### Layer A Tests (handler isolation — 7 files)

All files go in `src/tests/loop/states/`.

---

#### A1: `src/tests/loop/states/llm-esc-precheck.test.ts`

**Branch**: `handleLlm` — `isNeglectedMode()` true before `escAware` (llm.ts:57-63)

**Code path under test**:
```typescript
// llm.ts:57-63
if (agentIO.isNeglectedMode()) {
  ctx.core.verbose('llm', 'ESC pressed before LLM call - starting wrap-up');
  stopSpinner();
  startWrapUp(triologue, tools);
  agentIO.setNeglectedMode(false);
  return AgentState.PROMPT;
}
```

**Full mock setup**:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Triologue } from '../../loop/triologue.js';

// Mock all external dependencies — agentIO.isNeglectedMode() returns true
vi.mock('../../engine/ollama.js', () => ({
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    isNeglectedMode: vi.fn(() => true),   // ← ESC already pressed
    setNeglectedMode: vi.fn(),
  },
}));
vi.mock('../esc-wrap-up.js', () => ({ startWrapUp: vi.fn() }));
vi.mock('../crossroad.js', () => ({ handleCrossroad: vi.fn() }));
vi.mock('../../engine/chat-helpers.js', () => ({ stopSpinner: vi.fn() }));
vi.mock('../agent-prompts.js', () => ({
  buildPlanModePrompt: vi.fn(() => 'plan-prompt'),
  buildNormalModePrompt: vi.fn(() => 'normal-prompt'),
  isInPlanMode: vi.fn(() => false),
}));
vi.mock('../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]) },
}));

// Import after mocks
import { handleLlm } from '../../loop/states/llm.js';
import { AgentState } from '../../loop/state-machine.js';
import { agentIO } from '../../loop/agent-io.js';
import { startWrapUp } from '../esc-wrap-up.js';
import { stopSpinner } from '../../engine/chat-helpers.js';
import { retryChat } from '../../engine/ollama.js';
import { createTurnVars, createPassData, createMockMachineEnv } from '../esc-test-helpers.js';
```

**Test cases** (3 tests):

**Test 1**: `should call startWrapUp with triologue and tools, then return PROMPT`
```typescript
it('should call startWrapUp with triologue and tools, then return PROMPT', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData();

  const result = await handleLlm(env, turn, pass);

  expect(result).toBe(AgentState.PROMPT);
  expect(startWrapUp).toHaveBeenCalledTimes(1);
  // startWrapUp receives (triologue, tools) — tools from loader.getToolsForScope
  expect(startWrapUp).toHaveBeenCalledWith(triologue, expect.any(Array));
});
```

**Test 2**: `should clear neglected mode after starting wrap-up`
```typescript
it('should clear neglected mode after starting wrap-up', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData();

  await handleLlm(env, turn, pass);

  expect(agentIO.setNeglectedMode).toHaveBeenCalledWith(false);
});
```

**Test 3**: `should not call retryChat when already in neglected mode`
```typescript
it('should not call retryChat when already in neglected mode', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData();

  await handleLlm(env, turn, pass);

  expect(retryChat).not.toHaveBeenCalled();
  // Also verify stopSpinner was called (spinner must be stopped before returning to PROMPT)
  expect(stopSpinner).toHaveBeenCalled();
});
```

**Edge case**: `should not enter crossroad block (tools would be empty array due to isNeglectedMode check at line 55)`
```typescript
it('should pass empty tools array since isNeglectedMode returns true at line 55', async () => {
  // Note: llm.ts:55 does `const tools = agentIO.isNeglectedMode() ? [] : loader.getToolsForScope(scope)`
  // So when isNeglectedMode is true, tools=[] — startWrapUp receives empty array
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData();

  await handleLlm(env, turn, pass);

  // startWrapUp called with empty tools (not the loader result)
  expect(startWrapUp).toHaveBeenCalledWith(triologue, []);
});
```

---

#### A2: `src/tests/loop/states/llm-esc-midcall.test.ts`

**Branch**: `handleLlm` — ESC during `retryChat` (llm.ts:65-96)

**Code path under test**:
```typescript
// llm.ts:65-96
const response = await ctx.core.escAware(
  async (abortController) => {
    pass.abortController = abortController;
    return await retryChat({ model: MODEL, messages: ..., tools, think: ... }, { signal, neglected });
  },
  () => {
    startWrapUp(triologue, tools);  // ESC cleanup starts wrap-up
    return null;                      // returns null → response is null
  }
);
if (!response) {
  stopSpinner();
  agentIO.setNeglectedMode(false);
  return AgentState.PROMPT;
}
```

**Mock setup**: `isNeglectedMode()` returns `false` initially. `ctx.core.escAware` is mocked to call cleanup (returning null) instead of running the operation:
```typescript
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    isNeglectedMode: vi.fn(() => false),  // NOT in neglected mode initially
    setNeglectedMode: vi.fn(),
  },
}));
// ... same other mocks as A1 ...
```

**Test cases** (4 tests):

**Test 1**: `should return PROMPT and discard response when ESC fires during LLM call`
```typescript
it('should return PROMPT and discard response when ESC fires during LLM call', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  // Mock escAware to simulate ESC: call cleanup instead of running operation
  env.ctx.core.escAware = vi.fn(async (_operation, cleanup) => {
    return cleanup(new AbortController()); // cleanup returns null
  }) as any;

  const turn = createTurnVars();
  const pass = createPassData();

  const result = await handleLlm(env, turn, pass);

  expect(result).toBe(AgentState.PROMPT);
  // PassData should NOT be populated with LLM response
  expect(pass.rawToolCalls).toEqual([]);
  expect(pass.assistantContent).toBe('');
  expect(pass.abortController).toBeNull(); // released after ESC
});
```

**Test 2**: `should call startWrapUp during ESC cleanup`
```typescript
it('should call startWrapUp during ESC cleanup', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  env.ctx.core.escAware = vi.fn(async (_operation, cleanup) => {
    return cleanup(new AbortController());
  }) as any;

  const turn = createTurnVars();
  const pass = createPassData();

  await handleLlm(env, turn, pass);

  // The cleanup function calls startWrapUp(triologue, tools)
  expect(startWrapUp).toHaveBeenCalledTimes(1);
  expect(startWrapUp).toHaveBeenCalledWith(triologue, expect.any(Array));
});
```

**Test 3**: `should clear neglected mode after ESC cleanup`
```typescript
it('should clear neglected mode and stop spinner after ESC cleanup', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  env.ctx.core.escAware = vi.fn(async (_operation, cleanup) => {
    return cleanup(new AbortController());
  }) as any;

  const turn = createTurnVars();
  const pass = createPassData();

  await handleLlm(env, turn, pass);

  expect(agentIO.setNeglectedMode).toHaveBeenCalledWith(false);
  expect(stopSpinner).toHaveBeenCalled();
});
```

**Test 4**: `should pass correct think flag (true when not in neglected mode and not plan mode)`
```typescript
it('should pass think=false in retryChat request when not in neglected or plan mode', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  // This time escAware runs the operation normally (no ESC)
  env.ctx.core.escAware = vi.fn(async (operation) => {
    return await operation(new AbortController());
  }) as any;

  const turn = createTurnVars();
  const pass = createPassData();

  // Mock retryChat to return a valid response
  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({ content: 'hello' }));

  await handleLlm(env, turn, pass);

  // Verify retryChat was called with think: false (not neglected, not plan mode)
  const callArgs = vi.mocked(retryChat).mock.calls[0][0];
  expect(callArgs.think).toBe(false);
});
```

**Edge case**: `should not enter crossroad block when tools is empty (ESC mid-call with empty tools)`
```typescript
it('should not execute crossroad block when tools array is empty', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  // Mock loader to return empty tools
  vi.mocked(loader.getToolsForScope).mockReturnValueOnce([]);

  env.ctx.core.escAware = vi.fn(async (operation) => {
    return await operation(new AbortController());
  }) as any;

  const turn = createTurnVars();
  const pass = createPassData();
  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({ content: 'response' }));

  await handleLlm(env, turn, pass);

  // crossroad block is gated on tools.length > 0 — should not be entered
  // Verify handleCrossroad was not called
  expect(handleCrossroad).not.toHaveBeenCalled();
  // env.crossroadOccurred should be reset to false (else branch at line 150)
  expect(env.crossroadOccurred).toBe(false);
});
```

---

#### A3: `src/tests/loop/states/llm-esc-crossroad.test.ts`

**Branch**: `handleLlm` — ESC during `handleCrossroad` (llm.ts:108-124)

**Code path under test**:
```typescript
// llm.ts:108-124
if (tools.length > 0) {
  const crossroadResult = await ctx.core.escAware(
    async (abortController) => {
      return await handleCrossroad(...);
    },
    () => null,  // ESC cleanup returns null (transparent skip)
  );
  // ESC pressed during crossroad processing - return to PROMPT immediately
  if (agentIO.isNeglectedMode()) {
    stopSpinner();
    return AgentState.PROMPT;
  }
  // ... normal crossroad result handling
}
```

**Key insight**: After ESC, `agentIO.isNeglectedMode()` is checked (line 119). If true → return PROMPT. The `escAware` cleanup returns null (not the crossroad result), so `crossroadResult` is null, but the `isNeglectedMode()` check fires FIRST.

**Mock setup**: First `escAware` (LLM call) returns valid response. Second `escAware` (crossroad) triggers ESC — cleanup returns null AND `agentIO.isNeglectedMode()` returns true on the subsequent check.

```typescript
vi.mock('../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
    },
  };
});
vi.mock('../crossroad.js', () => ({ handleCrossroad: vi.fn(async () => null) }));
// ... same other mocks ...
```

**Test cases** (3 tests):

**Test 1**: `should return PROMPT when ESC fires during crossroad processing`
```typescript
it('should return PROMPT when ESC fires during crossroad processing', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData();

  // Mock escAware: 1st call (LLM) runs normally, 2nd call (crossroad) triggers ESC
  let escAwareCallCount = 0;
  env.ctx.core.escAware = vi.fn(async (operation, cleanup) => {
    escAwareCallCount++;
    if (escAwareCallCount === 1) {
      return await operation(new AbortController()); // LLM call succeeds
    }
    // 2nd call: crossroad ESC
    const result = cleanup(new AbortController()); // returns null
    // Simulate that ESC set neglected mode
    agentIO.setNeglectedMode(true);
    return result;
  }) as any;

  vi.mocked(retryChat).mockResolvedValueOnce(
    createMockChatResponse({ content: 'However, let me think...', toolCalls: [] })
  );

  const result = await handleLlm(env, turn, pass);

  expect(result).toBe(AgentState.PROMPT);
});
```

**Test 2**: `should store LLM response data on pass before crossroad ESC`
```typescript
it('should store LLM response data on pass before crossroad ESC', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData();

  let escAwareCallCount = 0;
  env.ctx.core.escAware = vi.fn(async (operation, cleanup) => {
    escAwareCallCount++;
    if (escAwareCallCount === 1) return await operation(new AbortController());
    const result = cleanup(new AbortController());
    agentIO.setNeglectedMode(true);
    return result;
  }) as any;

  vi.mocked(retryChat).mockResolvedValueOnce(
    createMockChatResponse({ content: 'Let me read the file.', toolCalls: [
      { id: 'c1', function: { name: 'read_file', arguments: { path: '/test.ts' } } }
    ]})
  );

  await handleLlm(env, turn, pass);

  // LLM response data was stored on pass BEFORE crossroad ESC
  expect(pass.assistantContent).toBe('Let me read the file.');
  expect(pass.rawToolCalls).toHaveLength(1);
  expect(pass.rawToolCalls[0].function.name).toBe('read_file');
  // crossroadContinuation should NOT be set (ESC interrupted before crossroad result processed)
  expect(pass.crossroadContinuation).toBeUndefined();
});
```

**Test 3**: `should stop spinner before returning to PROMPT on crossroad ESC`
```typescript
it('should stop spinner before returning to PROMPT on crossroad ESC', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData();

  let escAwareCallCount = 0;
  env.ctx.core.escAware = vi.fn(async (operation, cleanup) => {
    escAwareCallCount++;
    if (escAwareCallCount === 1) return await operation(new AbortController());
    const result = cleanup(new AbortController());
    agentIO.setNeglectedMode(true);
    return result;
  }) as any;

  vi.mocked(retryChat).mockResolvedValueOnce(
    createMockChatResponse({ content: 'Wait...' })
  );

  await handleLlm(env, turn, pass);

  expect(stopSpinner).toHaveBeenCalled();
});
```

---

#### A4: `src/tests/loop/states/tool-esc.test.ts`

**Branch**: `handleTool` — `isNeglectedMode()` before each tool (tool.ts:45-55)

**Code path under test**:
```typescript
// tool.ts:45-55
for (const toolCall of hookResult.calls) {
  if (agentIO.isNeglectedMode()) {
    agentIO.setNeglectedMode(false);
    triologue.skipPendingTools(
      'Tool use interrupted - user pressed ESC.',
      'Tool use skipped due to ESC interruption.',
    );
    return AgentState.PROMPT;
  }
  // ... execute tool ...
}
```

**Mock setup**:
```typescript
vi.mock('../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      verbose: vi.fn(),
    },
  };
});
vi.mock('../../context/shared/loader.js', () => ({
  loader: { execute: vi.fn(async () => 'tool result') },
}));
vi.mock('../../config.js', () => ({ isVerbose: vi.fn(() => false) }));

import { handleTool } from '../../loop/states/tool.js';
import { AgentState } from '../../loop/state-machine.js';
import { agentIO } from '../../loop/agent-io.js';
import { loader } from '../../context/shared/loader.js';
import { createMockToolCall, createMockHookResult, createTurnVars, createPassData, createMockMachineEnv } from '../esc-test-helpers.js';
import { Triologue } from '../../loop/triologue.js';
```

**Test cases** (5 tests):

**Test 1**: `should skip all tools and return PROMPT when ESC pressed before first tool`
```typescript
it('should skip all tools and return PROMPT when ESC pressed before first tool', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData({
    hookResult: createMockHookResult({
      calls: [
        createMockToolCall('read_file', { path: '/a.ts' }),
        createMockToolCall('edit_file', { path: '/a.ts', old_text: 'x', new_text: 'y' }),
      ],
    }),
  });

  // ESC already pressed
  agentIO.setNeglectedMode(true);

  const result = await handleTool(env, turn, pass);

  expect(result).toBe(AgentState.PROMPT);
  expect(loader.execute).not.toHaveBeenCalled();
  // skipPendingTools called with specific messages
  expect(triologue.skipPendingTools).toHaveBeenCalledWith(
    'Tool use interrupted - user pressed ESC.',
    'Tool use skipped due to ESC interruption.',
  );
  // Neglected mode cleared
  expect(agentIO.isNeglectedMode()).toBe(false);
});
```
*Note*: `triologue.skipPendingTools` is a method on Triologue — need to spy on it. Use `vi.spyOn(triologue, 'skipPendingTools')`.

**Test 2**: `should skip remaining tools when ESC pressed mid-execution (after first tool)`
```typescript
it('should skip remaining tools when ESC pressed mid-execution (after first tool)', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData({
    hookResult: createMockHookResult({
      calls: [
        createMockToolCall('read_file', { path: '/a.ts' }, 'call-1'),
        createMockToolCall('edit_file', { path: '/a.ts' }, 'call-2'),
      ],
    }),
  });

  // First tool executes normally, then ESC is pressed
  let executeCallCount = 0;
  vi.mocked(loader.execute).mockImplementation(async () => {
    executeCallCount++;
    if (executeCallCount >= 1) {
      agentIO.setNeglectedMode(true); // ESC after first tool completes
    }
    return 'file content';
  });

  const result = await handleTool(env, turn, pass);

  expect(result).toBe(AgentState.PROMPT);
  expect(loader.execute).toHaveBeenCalledTimes(1); // only first tool executed
  // The escAware wrapper returns 'Tool interrupted by user.' on ESC,
  // but the first tool already completed via the operation path.
  // Actually: escAware wraps each tool. For the 2nd tool, isNeglectedMode()
  // check at loop top fires BEFORE escAware, so skipPendingTools is called.
});
```
*Note*: The ESC check is at the TOP of the for-loop (before escAware wraps the tool). So if ESC happens after tool 1 completes, the next iteration's `isNeglectedMode()` check fires before tool 2 is attempted. `loader.execute` is called only once.

**Test 3**: `should not skip tools when neglectedMode is false throughout`
```typescript
it('should not skip tools when neglectedMode is false throughout', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData({
    hookResult: createMockHookResult({
      calls: [
        createMockToolCall('read_file', { path: '/a.ts' }, 'call-1'),
        createMockToolCall('edit_file', { path: '/a.ts' }, 'call-2'),
      ],
    }),
  });

  const result = await handleTool(env, turn, pass);

  expect(result).toBe(AgentState.COLLECT);
  expect(loader.execute).toHaveBeenCalledTimes(2);
});
```

**Test 4**: `should clear neglected mode before returning to PROMPT`
```typescript
it('should clear neglected mode before returning to PROMPT', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData({
    hookResult: createMockHookResult({
      calls: [createMockToolCall('read_file', { path: '/a.ts' })],
    }),
  });

  agentIO.setNeglectedMode(true);

  await handleTool(env, turn, pass);

  // setNeglectedMode(false) is called at line 47, before skipPendingTools
  expect(agentIO.isNeglectedMode()).toBe(false);
});
```

**Test 5**: `should not skip hook-blocked calls (they continue even in neglected mode — but ESC check is before them)`
```typescript
it('should check ESC before processing each tool, including blocked calls', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const blockedCalls = new Map([['call-blocked', 'Blocked by hook']]);
  const pass = createPassData({
    hookResult: createMockHookResult({
      calls: [
        createMockToolCall('read_file', { path: '/a.ts' }, 'call-1'),
        createMockToolCall('edit_file', { path: '/b.ts' }, 'call-blocked'),
      ],
      blockedCalls,
    }),
  });

  // ESC after first tool
  let executeCallCount = 0;
  vi.mocked(loader.execute).mockImplementation(async () => {
    executeCallCount++;
    agentIO.setNeglectedMode(true);
    return 'content';
  });

  const result = await handleTool(env, turn, pass);

  // First tool executed, then ESC → skipPendingTools (blocked call-2 never reached)
  expect(result).toBe(AgentState.PROMPT);
  expect(loader.execute).toHaveBeenCalledTimes(1);
});
```

---

#### A5: `src/tests/loop/states/stop-esc.test.ts`

**Branch**: `handleStop` — `isNeglectedMode()` true at STOP entry (stop.ts:22-33)

**Code path under test**:
```typescript
// stop.ts:22-33
if (agentIO.isNeglectedMode()) {
  agentIO.setNeglectedMode(false); // Clear FIRST for isInteractionMode()
  const teammates = ctx.team.listTeammates();
  if (teammates.some((t) => t.status === 'working')) {
    agentIO.log(chalk.yellow('teammates still working (use /team to check status)'));
  }
  agentIO.flushOutput();
  presentResult(triologue);
  return AgentState.PROMPT;
}
```

**Mock setup**: Need to mock `presentResult` from `state-machine.js` (which `stop.ts` imports). But since `AgentState` is also from the same module, we need to use `vi.mock` with `vi.importActual`:
```typescript
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    isNeglectedMode: vi.fn(() => true),
    setNeglectedMode: vi.fn(),
    flushOutput: vi.fn(),
    log: vi.fn(),
  },
}));
// Mock state-machine.js but preserve AgentState enum
vi.mock('../../loop/state-machine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../loop/state-machine.js')>();
  return {
    ...actual,
    presentResult: vi.fn(),
  };
});

import { handleStop } from '../../loop/states/stop.js';
import { AgentState, presentResult } from '../../loop/state-machine.js';
import { agentIO } from '../../loop/agent-io.js';
import { createMockContext } from '../test-utils/mock-context.js';
import type { MachineEnv, TurnVars, PassData } from '../../loop/state-machine.js';
import { Triologue } from '../../loop/triologue.js';
```

**Test cases** (4 tests):

**Test 1**: `should clear neglected mode FIRST, then flush, present, and return PROMPT`
```typescript
it('should clear neglected mode FIRST, then flush, present, and return PROMPT', async () => {
  const triologue = new Triologue();
  const ctx = createMockContext();
  const env = { triologue, ctx, /* ... minimal env ... */ } as any;
  const turn = createTurnVars();
  const pass = createPassData();

  const result = await handleStop(env, turn, pass);

  expect(result).toBe(AgentState.PROMPT);
  // setNeglectedMode(false) called before flushOutput
  const setCallOrder = vi.mocked(agentIO.setNeglectedMode).mock.invocationCallOrder[0];
  const flushCallOrder = vi.mocked(agentIO.flushOutput).mock.invocationCallOrder[0];
  expect(setCallOrder).toBeLessThan(flushCallOrder);
});
```

**Test 2**: `should call presentResult with triologue`
```typescript
it('should call presentResult with triologue', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  const turn = createTurnVars();
  const pass = createPassData();

  await handleStop(env, turn, pass);

  expect(presentResult).toHaveBeenCalledWith(triologue);
});
```

**Test 3**: `should warn about working teammates when ESC at STOP`
```typescript
it('should warn about working teammates when ESC at STOP', async () => {
  const triologue = new Triologue();
  const ctx = createMockContext({
    team: {
      listTeammates: vi.fn(() => [
        { name: 'worker1', status: 'working' },
        { name: 'worker2', status: 'idle' },
      ]),
    } as any,
  });
  const env = createMockMachineEnv({ triologue, ctxOptions: { team: { listTeammates: vi.fn(() => [
    { name: 'worker1', status: 'working' },
  ]) } as any } });

  const turn = createTurnVars();
  const pass = createPassData();

  await handleStop(env, turn, pass);

  expect(agentIO.log).toHaveBeenCalledWith(
    expect.stringContaining('teammates still working')
  );
});
```

**Test 4**: `should NOT warn about teammates when none are working`
```typescript
it('should NOT warn about teammates when none are working', async () => {
  const triologue = new Triologue();
  const env = createMockMachineEnv({
    triologue,
    ctxOptions: {
      team: { listTeammates: vi.fn(() => [{ name: 'worker1', status: 'idle' }]) } as any,
    },
  });
  const turn = createTurnVars();
  const pass = createPassData();

  await handleStop(env, turn, pass);

  expect(agentIO.log).not.toHaveBeenCalledWith(
    expect.stringContaining('teammates still working')
  );
});
```

---

#### A6: `src/tests/loop/states/collect-esc-hint.test.ts`

**Branch**: `handleCollect` — ESC during hint generation (collect.ts:83-92)

**Code path under test**:
```typescript
// collect.ts:71-92
if (confusionIndex >= CONFUSION_THRESHOLD && messageCount >= MIN_MESSAGES_FOR_HINT) {
  ctx.core.brief('info', 'loop', 'Generating hint...');
  const pendingSkills = env.conditions.getPending();
  const breakdown = generateBreakdown(confusionIndex, env.sequence.getEvents());

  const result = await ctx.core.escAware(
    async (abortController) => {
      return await triologue.generateHintRound(abortController, confusionIndex, breakdown, pendingSkills);
    },
    () => {
      startWrapUp(triologue, loader.getToolsForScope(env.scope));
      return 'aborted' as const;
    }
  );

  if (result === 'aborted') {
    agentIO.setNeglectedMode(false);
    return AgentState.PROMPT;
  }
  ctx.core.resetConfusionIndex();
}
```

**Setup**: To trigger hint generation, need:
- `ctx.core.getConfusionIndex()` ≥ 10 (CONFUSION_THRESHOLD)
- `triologue.getMessagesRaw().length` ≥ 6 (MIN_MESSAGES_FOR_HINT)

**Mock setup**:
```typescript
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { isNeglectedMode: vi.fn(() => false), setNeglectedMode: vi.fn(), verbose: vi.fn() },
}));
vi.mock('../esc-wrap-up.js', () => ({ startWrapUp: vi.fn() }));
vi.mock('../../config.js', () => ({ isVerbose: vi.fn(() => false) }));
vi.mock('../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => []) },
}));
vi.mock('../../context/worktree-store.js', () => ({ loadWorktrees: vi.fn(() => []) }));
vi.mock('../../utils/skill-dedup.js', () => ({ getSkillTriologueStatus: vi.fn(() => 'loaded') }));

import { handleCollect } from '../../loop/states/collect.js';
import { AgentState } from '../../loop/state-machine.js';
import { agentIO } from '../../loop/agent-io.js';
import { startWrapUp } from '../esc-wrap-up.js';
import { Triologue } from '../../loop/triologue.js';
import { createTurnVars, createPassData, createMockMachineEnv } from '../esc-test-helpers.js';
```

**Test cases** (4 tests):

**Test 1**: `should return PROMPT when ESC fires during hint generation`
```typescript
it('should return PROMPT when ESC fires during hint generation', async () => {
  const triologue = new Triologue();
  // Add 6+ messages to trigger hint threshold
  for (let i = 0; i < 6; i++) {
    triologue.user(`msg ${i}`);
    triologue.agent(`resp ${i}`);
  }

  const env = createMockMachineEnv({
    triologue,
    ctxOptions: {
      core: { getConfusionIndex: vi.fn(() => 12) } as any,  // ≥10 threshold
    },
  });
  // Mock escAware to simulate ESC during hint generation
  env.ctx.core.escAware = vi.fn(async (_operation, cleanup) => {
    return cleanup(new AbortController()); // returns 'aborted'
  }) as any;

  const turn = createTurnVars();
  const pass = createPassData();

  const result = await handleCollect(env, turn, pass);

  expect(result).toBe(AgentState.PROMPT);
});
```

**Test 2**: `should clear neglected mode after hint ESC`
```typescript
it('should clear neglected mode after hint ESC', async () => {
  // ... same setup as Test 1 ...
  await handleCollect(env, turn, pass);
  expect(agentIO.setNeglectedMode).toHaveBeenCalledWith(false);
});
```

**Test 3**: `should call startWrapUp during hint ESC cleanup`
```typescript
it('should call startWrapUp during hint ESC cleanup', async () => {
  // ... same setup as Test 1 ...
  await handleCollect(env, turn, pass);
  expect(startWrapUp).toHaveBeenCalledWith(triologue, expect.any(Array));
});
```

**Test 4**: `should NOT trigger hint generation when confusionIndex < threshold`
```typescript
it('should return LLM (not PROMPT) when confusionIndex is below threshold', async () => {
  const triologue = new Triologue();
  for (let i = 0; i < 6; i++) {
    triologue.user(`msg ${i}`);
    triologue.agent(`resp ${i}`);
  }

  const env = createMockMachineEnv({
    triologue,
    ctxOptions: {
      core: { getConfusionIndex: vi.fn(() => 5) } as any,  // <10 threshold
    },
  });
  // escAware should NOT be called for hint generation
  env.ctx.core.escAware = vi.fn(async (operation) => operation(new AbortController())) as any;

  const turn = createTurnVars();
  const pass = createPassData();

  const result = await handleCollect(env, turn, pass);

  expect(result).toBe(AgentState.LLM);
  // escAware should not have been called (no hint generation)
  expect(env.ctx.core.escAware).not.toHaveBeenCalled();
});
```

**Edge case**: `should NOT trigger hint generation when message count < 6`
```typescript
it('should NOT trigger hint generation when message count < 6', async () => {
  const triologue = new Triologue();
  triologue.user('hello');
  triologue.agent('hi');
  // Only 2 messages (< 6 threshold)

  const env = createMockMachineEnv({
    triologue,
    ctxOptions: {
      core: { getConfusionIndex: vi.fn(() => 15) } as any,  // ≥10 but messages < 6
    },
  });

  const result = await handleCollect(env, turn, pass);

  expect(result).toBe(AgentState.LLM);
  expect(env.ctx.core.escAware).not.toHaveBeenCalled();
});
```

---

#### A7: `src/tests/loop/states/hook-esc-recap.test.ts`

**Branch**: `handleHook` — ESC during recap LLM call (hook.ts:268-275)

**Code path under test**:
```typescript
// hook.ts:245-275 (inside handleRecapCall)
const summary = await handleRecap(fullMessages, allTools, checkpoint.description, escAware, comment, lastQueryForRecap, checkpointResult);

// Check for ESC cancellation
if (summary.startsWith('[RECAP] Cancelled:')) {
  triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
  triologue.tool('recap', summary, call.id);
  ctx.core.brief('warn', 'recap', summary);
  // ESC pressed during recap - return to PROMPT immediately
  if (agentIO.isNeglectedMode()) {
    agentIO.setNeglectedMode(false);
    return AgentState.PROMPT;
  }
  turn.isFirstRound = false;
  return AgentState.COLLECT;
}
```

**Mock setup**: Mock `handleRecap` from `../checkpoint-recap.js` to return `'[RECAP] Cancelled: ESC pressed'`. Mock `augmentToolCalls` to pass through. Mock `hookExecutor.processToolCalls` to return a result with a recap call.

```typescript
vi.mock('../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      log: vi.fn(),
    },
  };
});
vi.mock('../checkpoint-recap.js', () => ({
  validateCheckpointIsolation: vi.fn(() => ({ valid: true })),
  validateRecapIsolation: vi.fn(() => ({ valid: true })),
  handleCheckpoint: vi.fn(),
  handleRecap: vi.fn(async () => '[RECAP] Cancelled: ESC pressed during recap'),
}));
vi.mock('../../hook/hook-preprocessor.js', () => ({
  augmentToolCalls: vi.fn((calls) => calls), // pass through
}));
vi.mock('../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => []) },
}));

import { handleHook } from '../../loop/states/hook.js';
import { AgentState } from '../../loop/state-machine.js';
import { agentIO } from '../../loop/agent-io.js';
import { handleRecap } from '../checkpoint-recap.js';
import { createMockToolCall, createMockHookResult, createTurnVars, createPassData, createMockMachineEnv } from '../esc-test-helpers.js';
import { Triologue } from '../../loop/triologue.js';
```

**Test cases** (3 tests):

**Test 1**: `should return PROMPT when ESC fires during recap and neglectedMode is true`
```typescript
it('should return PROMPT when ESC fires during recap and neglectedMode is true', async () => {
  const triologue = new Triologue();
  // Set up triologue with a checkpoint so recap can find it
  // (handleRecapCall calls triologue.findCheckpointById)
  // ... need to mock triologue.findCheckpointById to return a checkpoint

  const recapCall = createMockToolCall('recap', { checkpoint_id: 'abc12345' }, 'call-recap');
  const env = createMockMachineEnv({
    triologue,
    hookExecutor: {
      processToolCalls: vi.fn(async () => createMockHookResult({
        calls: [recapCall],
      })),
    },
  });

  // Mock triologue.findCheckpointById to return a fake checkpoint
  vi.spyOn(triologue, 'findCheckpointById').mockReturnValue({
    id: 'abc12345',
    description: 'test checkpoint',
    index: 0,
  } as any);
  vi.spyOn(triologue, 'getTokenCount').mockReturnValue(1000);
  vi.spyOn(triologue, 'getMessages').mockReturnValue([]);

  // ESC is active
  agentIO.setNeglectedMode(true);

  const turn = createTurnVars({ lastUserQuery: 'test query' });
  const pass = createPassData({
    rawToolCalls: [recapCall],
    assistantContent: 'Let me summarize.',
  });

  const result = await handleHook(env, turn, pass);

  expect(result).toBe(AgentState.PROMPT);
  expect(agentIO.isNeglectedMode()).toBe(false); // cleared
});
```

**Test 2**: `should return COLLECT when recap is cancelled but neglectedMode is false`
```typescript
it('should return COLLECT when recap is cancelled but neglectedMode is false', async () => {
  // Same setup but neglectedMode stays false
  // handleRecap still returns '[RECAP] Cancelled: ...'
  // Since isNeglectedMode() is false, the if-block doesn't fire
  // Falls through to turn.isFirstRound = false; return AgentState.COLLECT;

  // ... same setup but do NOT setNeglectedMode(true) ...
  const result = await handleHook(env, turn, pass);
  expect(result).toBe(AgentState.COLLECT);
});
```

**Test 3**: `should register agent message and recap tool result before returning`
```typescript
it('should register agent message and recap tool result before returning on ESC', async () => {
  // ... setup with ESC ...
  const agentSpy = vi.spyOn(triologue, 'agent');
  const toolSpy = vi.spyOn(triologue, 'tool');

  await handleHook(env, turn, pass);

  // triologue.agent called with assistantContent + rawToolCalls
  expect(agentSpy).toHaveBeenCalledWith('Let me summarize.', expect.any(Array), undefined);
  // triologue.tool called with recap + cancelled message
  expect(toolSpy).toHaveBeenCalledWith('recap', expect.stringContaining('[RECAP] Cancelled:'), 'call-recap');
});
```

---

### Layer B — Full-Loop Integration (1 file)

#### `src/tests/loop/esc-full-loop.test.ts`

Wire all real handlers into `AgentStateMachine`. Mock only:
- `retryChat` (from `../../engine/ollama.js`)
- `agentIO` (use real `agentIO.initMain()` so `escAware` works; manually trigger ESC via `setNeglectedMode` + `onNeglectedCallbacks`)
- `session I/O` (`../../session/index.js`)
- `handleCrossroad` (mock to return null = no crossroad)
- `loader.execute` (mock to return controlled tool results)
- `loader.getToolsForScope` (mock to return empty array or controlled tools)
- `keyword-extractor` (mock to return empty keywords)
- `multiline-input` (mock to return submit with content)
- `agent-prompts` (mock to return empty string system prompts)
- `esc-wrap-up` (mock `startWrapUp` to avoid real LLM calls, but allow `evaluateWrapUp`/`clearWrapUp` to work)

**Mock setup**:
```typescript
vi.mock('../../engine/ollama.js', () => ({
  retryChat: vi.fn(),
  MODEL: 'test-model',
  retryMultipleChoice: vi.fn(),
  webSearch: vi.fn(),
  webFetch: vi.fn(),
  imgDescribe: vi.fn(),
  structuredChat: vi.fn(),
  healthCheck: vi.fn(),
  getEmbedding: vi.fn(),
}));
vi.mock('../../loop/agent-io.js', () => {
  // Use a controllable flag
  let neglected = false;
  const callbacks = new Set<() => void>();
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      // Support onNeglectedCallbacks registration (used by escAware)
      onNeglectedCallbacks: callbacks,
      // Other methods
      initMain: vi.fn(),
      isInteractionMode: vi.fn(() => neglected),
      log: vi.fn(),
      verbose: vi.fn(),
      brief: vi.fn(),
      flushOutput: vi.fn(),
    },
  };
});
vi.mock('../../session/index.js', () => ({
  readSession: vi.fn(() => null),
  writeSession: vi.fn(),
}));
vi.mock('../crossroad.js', () => ({ handleCrossroad: vi.fn(async () => null) }));
vi.mock('../keyword-extractor.js', () => ({ extractKeywords: vi.fn(async () => []) }));
vi.mock('../agent-prompts.js', () => ({
  buildPlanModePrompt: vi.fn(() => ''),
  buildNormalModePrompt: vi.fn(() => ''),
  isInPlanMode: vi.fn(() => false),
}));
vi.mock('../../utils/multiline-input.js', () => ({
  openMultilineEditor: vi.fn(async (text: string) => ({ action: 'submit', content: text })),
}));

// Import real handlers + state machine + triologue
import { AgentStateMachine, AgentState } from '../../loop/state-machine.js';
import { handlePrompt } from '../../loop/states/prompt.js';
import { handleCollect } from '../../loop/states/collect.js';
import { handleLlm } from '../../loop/states/llm.js';
import { handleHook } from '../../loop/states/hook.js';
import { handleTool } from '../../loop/states/tool.js';
import { handleStop } from '../../loop/states/stop.js';
import { Triologue } from '../../loop/triologue.js';
import { retryChat } from '../../engine/ollama.js';
import { agentIO } from '../../loop/agent-io.js';
```

**Test cases** (5 tests):

**Test 1**: `ESC before LLM call → wrap-up → prompt → commit`
```typescript
it('ESC before LLM call → wrap-up started → machine returns to PROMPT', async () => {
  const triologue = new Triologue();
  const ctx = createMockContext({ workdir: '/tmp/test' });
  // escAware must actually run the operation (use real-ish behavior)
  ctx.core.escAware = vi.fn(async (fn: any) => fn(new AbortController())) as any;

  const handlers: Record<AgentState, StateHandler> = {
    [AgentState.PROMPT]: handlePrompt,
    [AgentState.SLASH]: vi.fn(),
    [AgentState.COLLECT]: handleCollect,
    [AgentState.LLM]: handleLlm,
    [AgentState.HOOK]: handleHook,
    [AgentState.TOOL]: handleTool,
    [AgentState.STOP]: handleStop,
  };

  // Input: user types "read file"
  let inputCallCount = 0;
  const inputProvider = {
    getInput: vi.fn(async () => {
      inputCallCount++;
      if (inputCallCount === 1) return 'read file';
      return null; // exit after first turn
    }),
    setMode: vi.fn(),
    promptRetry: vi.fn(async () => false),
  };

  // LLM: return text + tool call (first call), then text-only (second call)
  let llmCallCount = 0;
  vi.mocked(retryChat).mockImplementation(async () => {
    llmCallCount++;
    if (llmCallCount === 1) {
      return createMockChatResponse({
        content: 'Reading the file.',
        toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: { path: '/test.ts' } } }],
      });
    }
    // Before 2nd LLM call, simulate ESC
    agentIO.setNeglectedMode(true);
    return createMockChatResponse({ content: 'should not reach here' });
  });

  // Mock loader to return controlled results
  vi.mocked(loader.execute).mockResolvedValue('file content');

  const machine = new AgentStateMachine(
    triologue, ctx, 'main', conditions, sequence, hookExecutor,
    inputProvider, '/tmp/session.json', handlers, requestEmbeddingTracker,
  );

  await machine.run();

  // ESC should have been triggered during 2nd COLLECT (before LLM call)
  // Machine should have returned to PROMPT
  // Triologue should have: user("read file"), agent(tool_call), tool(result), then wrap-up
  const msgs = triologue.getMessagesRaw();
  expect(msgs.some(m => m.role === 'user')).toBe(true);
  expect(msgs.some(m => m.role === 'tool')).toBe(true);
});
```

**Test 2**: `ESC during tool execution → skip remaining → PROMPT`
```typescript
it('ESC during tool execution → skip remaining tools → PROMPT', async () => {
  // retryChat returns 2 tool calls (read_file, edit_file)
  // loader.execute: first tool returns content, then ESC is set
  // Verify: only 1 tool result in triologue, skipPendingTools called

  // ... wire machine with real handlers ...

  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({
    content: 'Let me work.',
    toolCalls: [
      { id: 'c1', function: { name: 'read_file', arguments: { path: '/a.ts' } } },
      { id: 'c2', function: { name: 'edit_file', arguments: { path: '/a.ts', old_text: 'x', new_text: 'y' } } },
    ],
  }));

  let executeCount = 0;
  vi.mocked(loader.execute).mockImplementation(async () => {
    executeCount++;
    if (executeCount >= 1) agentIO.setNeglectedMode(true);
    return 'content';
  });

  // hookExecutor returns the calls as-is (no blocking)
  vi.mocked(hookExecutor.processToolCalls).mockResolvedValue(createMockHookResult({
    calls: [
      createMockToolCall('read_file', { path: '/a.ts' }, 'c1'),
      createMockToolCall('edit_file', { path: '/a.ts' }, 'c2'),
    ],
  }));

  await machine.run();

  // Only first tool executed
  expect(loader.execute).toHaveBeenCalledTimes(1);
  // skipPendingTools called (verify via triologue state)
  const msgs = triologue.getMessagesRaw();
  // Only 1 tool result message should exist
  const toolMsgs = msgs.filter(m => m.role === 'tool');
  expect(toolMsgs.length).toBe(1);
});
```

**Test 3**: `ESC during LLM call (never-resolving promise) → response discarded → PROMPT`
```typescript
it('ESC during LLM call → response discarded → PROMPT', async () => {
  // retryChat returns a never-resolving promise
  let resolveLlm: () => void;
  vi.mocked(retryChat).mockImplementation(async () => {
    return new Promise((resolve) => { resolveLlm = () => resolve(createMockChatResponse({ content: '' })); });
  });

  // Simulate ESC during LLM call (after retryChat is invoked)
  // Use setTimeout to trigger ESC while LLM is "in progress"
  setTimeout(() => {
    agentIO.setNeglectedMode(true);
    const callbacks = (agentIO as any).onNeglectedCallbacks;
    for (const cb of callbacks) cb();
  }, 50);

  await machine.run();

  // No assistant message should be added (response was discarded)
  const msgs = triologue.getMessagesRaw();
  const assistantMsgs = msgs.filter(m => m.role === 'assistant');
  // The only assistant message might be from wrap-up, but the LLM response itself was discarded
  // Verify no tool_calls in any assistant message
  expect(assistantMsgs.every(m => !m.tool_calls || m.tool_calls.length === 0)).toBe(true);
});
```

**Test 4**: `ESC at STOP → flush + present + PROMPT`
```typescript
it('ESC at STOP → flush output, present result, return PROMPT', async () => {
  // retryChat returns text-only (no tool calls) → HOOK → STOP
  // isNeglectedMode() returns true at STOP entry

  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({
    content: 'Here is the answer.',
  }));

  // Set ESC before STOP handler runs (simulating ESC during HOOK or just before STOP)
  // Actually: need ESC to be true when STOP handler checks isNeglectedMode()
  // This means ESC was pressed during the LLM response display, but the response
  // was already stored. The handler goes HOOK (no tools) → STOP.
  // At STOP entry, isNeglectedMode() is true.

  // To trigger this: set neglected mode after HOOK completes but before STOP
  // This is tricky — use a hookExecutor that sets neglected mode
  vi.mocked(hookExecutor.processToolCalls).mockImplementation(async (calls) => {
    agentIO.setNeglectedMode(true);
    return createMockHookResult({ calls: [] }); // no calls → STOP
  });

  await machine.run();

  expect(agentIO.flushOutput).toHaveBeenCalled();
});
```

**Test 5**: `full loop without ESC: normal turn completes to STOP → PROMPT`
```typescript
it('normal turn without ESC: PROMPT → COLLECT → LLM → HOOK → TOOL → COLLECT → LLM → HOOK → STOP → PROMPT', async () => {
  // This is a baseline test to verify the mock wiring works without ESC
  let llmCallCount = 0;
  vi.mocked(retryChat).mockImplementation(async () => {
    llmCallCount++;
    if (llmCallCount === 1) {
      return createMockChatResponse({
        content: 'Reading file.',
        toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: { path: '/test.ts' } } }],
      });
    }
    return createMockChatResponse({ content: 'Done.' });
  });

  vi.mocked(loader.execute).mockResolvedValue('content');

  let inputCallCount = 0;
  inputProvider.getInput = vi.fn(async () => {
    inputCallCount++;
    if (inputCallCount === 1) return 'read /test.ts';
    return null; // exit
  });

  await machine.run();

  // Two LLM calls (one with tool, one text-only)
  expect(llmCallCount).toBe(2);
  // Machine exited normally (null from 2nd PROMPT)
});
```

---

### Layer C — Wrap-Up Lifecycle (1 file)

#### `src/tests/loop/esc-wrap-up-lifecycle.test.ts`

Test `startWrapUp` + `evaluateWrapUp` + `commitWrapUp`/`rollbackWrapUp` with controlled timing.

**Mock setup**:
```typescript
vi.mock('../../engine/ollama.js', () => ({
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));
vi.mock('../../config.js', () => ({ getApiProvider: vi.fn(() => 'ollama') }));
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { brief: vi.fn(), verbose: vi.fn(), log: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startWrapUp,
  evaluateWrapUp,
  clearWrapUp,
  getWrapUpState,
  hasPendingWrapUp,
  markWrapUpShown,
} from '../../loop/esc-wrap-up.js';
import { retryChat } from '../../engine/ollama.js';
import { Triologue } from '../../loop/triologue.js';
```

**Test cases** (8 tests):

**Test 1**: `should commit wrap-up when user submits >3s after wrap-up completion`
```typescript
it('should commit wrap-up when user submits >3s after completion', async () => {
  vi.useFakeTimers();
  const triologue = new Triologue();
  vi.spyOn(triologue, 'beginWrapUp');
  vi.spyOn(triologue, 'finishWrapUp');

  // Mock retryChat to resolve with wrap-up content
  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({ content: 'Wrap-up text' }) as any);

  startWrapUp(triologue, []);

  // Wait for the wrap-up promise to resolve
  await vi.advanceTimersByTimeAsync(10);

  // Advance past 3s grace period
  vi.advanceTimersByTime(3001);

  const decision = evaluateWrapUp();
  expect(decision).toBe('commit');

  vi.useRealTimers();
});
```

**Test 2**: `should rollback wrap-up when user submits <3s after completion`
```typescript
it('should rollback wrap-up when user submits <3s after completion', async () => {
  vi.useFakeTimers();
  const triologue = new Triologue();

  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({ content: 'Wrap-up text' }) as any);

  startWrapUp(triologue, []);
  await vi.advanceTimersByTimeAsync(10);

  // Only 1s since completion (< 3s grace)
  vi.advanceTimersByTime(1000);

  const decision = evaluateWrapUp();
  expect(decision).toBe('rollback');

  vi.useRealTimers();
});
```

**Test 3**: `should rollback when wrap-up not completed (user submits during LLM)`
```typescript
it('should rollback when wrap-up not completed (LLM still running)', async () => {
  vi.useFakeTimers();
  const triologue = new Triologue();

  // retryChat never resolves — pending promise
  let resolveLlm: () => void;
  vi.mocked(retryChat).mockImplementation(async () => {
    return new Promise((resolve) => { resolveLlm = () => resolve(createMockChatResponse({ content: '' }) as any); });
  });

  startWrapUp(triologue, []);

  // Don't advance timers enough to resolve
  vi.advanceTimersByTime(100);

  const decision = evaluateWrapUp();
  expect(decision).toBe('rollback'); // completedAt is null

  vi.useRealTimers();
});
```

**Test 4**: `should rollback when wrap-up content is empty (LLM failure)`
```typescript
it('should rollback when wrap-up content is empty (LLM failure)', async () => {
  vi.useFakeTimers();
  const triologue = new Triologue();

  // retryChat rejects — catch block sets content = ''
  vi.mocked(retryChat).mockRejectedValueOnce(new Error('LLM error'));

  startWrapUp(triologue, []);
  await vi.advanceTimersByTimeAsync(10);

  const decision = evaluateWrapUp();
  // content is '' → evaluateWrapUp returns 'rollback'
  expect(decision).toBe('rollback');

  vi.useRealTimers();
});
```

**Test 5**: `should rollback when wrap-up already shown`
```typescript
it('should rollback when wrap-up already shown', async () => {
  vi.useFakeTimers();
  const triologue = new Triologue();

  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({ content: 'Wrap-up text' }) as any);

  startWrapUp(triologue, []);
  await vi.advanceTimersByTimeAsync(10);

  markWrapUpShown();

  const decision = evaluateWrapUp();
  expect(decision).toBe('rollback');

  vi.useRealTimers();
});
```

**Test 6**: `startWrapUp should call triologue.beginWrapUp immediately (synchronously)`
```typescript
it('should call triologue.beginWrapUp synchronously before LLM promise', async () => {
  vi.useFakeTimers();
  const triologue = new Triologue();
  const beginSpy = vi.spyOn(triologue, 'beginWrapUp');

  // retryChat returns a pending promise
  vi.mocked(retryChat).mockImplementation(async () => {
    return new Promise(() => {}); // never resolves
  });

  startWrapUp(triologue, []);

  // beginWrapUp should have been called synchronously (before any await)
  expect(beginSpy).toHaveBeenCalledTimes(1);

  vi.useRealTimers();
});
```

**Test 7**: `clearWrapUp should reset all state`
```typescript
it('clearWrapUp should reset all state', async () => {
  vi.useFakeTimers();
  const triologue = new Triologue();
  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({ content: 'x' }) as any);

  startWrapUp(triologue, []);
  await vi.advanceTimersByTimeAsync(10);

  clearWrapUp();

  const state = getWrapUpState();
  expect(state.promise).toBeNull();
  expect(state.content).toBeNull();
  expect(state.completedAt).toBeNull();
  expect(state.shown).toBe(false);
  expect(state.triologue).toBeNull();

  vi.useRealTimers();
});
```

**Test 8**: `startWrapUp should replace previous wrap-up state if called twice`
```typescript
it('should replace previous wrap-up state when startWrapUp called again', async () => {
  vi.useFakeTimers();
  const triologue = new Triologue();

  // First wrap-up
  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({ content: 'first' }) as any);
  startWrapUp(triologue, []);
  const firstPromise = getWrapUpState().promise;
  await vi.advanceTimersByTimeAsync(10);

  // Second wrap-up (replaces first)
  vi.mocked(retryChat).mockResolvedValueOnce(createMockChatResponse({ content: 'second' }) as any);
  startWrapUp(triologue, []);
  const secondState = getWrapUpState();

  // The content should be from the second wrap-up, not the first
  // (first wrap-up's .then() checks wrapUpState.promise !== promise and bails)
  expect(secondState.promise).not.toBe(firstPromise);

  // Wait for second to complete
  await vi.advanceTimersByTimeAsync(10);
  expect(getWrapUpState().content).toBe('second');

  vi.useRealTimers();
});
```

---

## Summary: Files to Create

| File | Layer | Tests | Description |
|------|-------|-------|-------------|
| `src/tests/loop/esc-test-helpers.ts` | Infra | — | Shared mock utilities for ESC loop tests |
| `src/tests/loop/states/llm-esc-precheck.test.ts` | A | 4 | handleLlm: neglected mode before escAware |
| `src/tests/loop/states/llm-esc-midcall.test.ts` | A | 5 | handleLlm: ESC during retryChat |
| `src/tests/loop/states/llm-esc-crossroad.test.ts` | A | 3 | handleLlm: ESC during crossroad |
| `src/tests/loop/states/tool-esc.test.ts` | A | 5 | handleTool: ESC before/mid tool |
| `src/tests/loop/states/stop-esc.test.ts` | A | 4 | handleStop: neglected mode at entry |
| `src/tests/loop/states/collect-esc-hint.test.ts` | A | 5 | handleCollect: ESC during hint gen |
| `src/tests/loop/states/hook-esc-recap.test.ts` | A | 3 | handleHook: ESC during recap |
| `src/tests/loop/esc-full-loop.test.ts` | B | 5 | Full-loop integration with real handlers |
| `src/tests/loop/esc-wrap-up-lifecycle.test.ts` | C | 8 | Wrap-up commit/rollback timing |

**Total**: 10 new files, ~42 test cases.

## Execution Order

1. `esc-test-helpers.ts` (shared infra — no tests)
2. Layer A files (A1–A7) — can be done in parallel
3. Layer C (`esc-wrap-up-lifecycle.test.ts`) — independent of A/B
4. Layer B (`esc-full-loop.test.ts`) — depends on patterns validated in A

## Key Design Decisions

- **Mock `agentIO` with internal flag**: Most Layer A tests use a mock `agentIO` with a mutable `neglected` flag that can be toggled mid-test. This allows simulating "ESC already pressed" (flag starts true) or "ESC during operation" (flag set to true at a specific point).
- **Mock `retryChat` at `ollama.js` level**: Mocking `../../engine/ollama.js` ensures both `chat-provider.ts` re-exports and `forkChat` internal calls hit the stub (same-module binding, proven in `compact-undefined-role.test.ts`).
- **Mock `startWrapUp` in handler tests**: To avoid testing wrap-up lifecycle in handler isolation tests. Wrap-up lifecycle is tested separately in Layer C.
- **Fake timers for wrap-up timing**: Layer C uses `vi.useFakeTimers()` to deterministically test the 3s grace period without real delays.
- **Spy on Triologue methods**: For verifying `skipPendingTools`, `agent`, `tool`, `beginWrapUp`, `finishWrapUp`, `commitWrapUp`, `rollbackWrapUp` calls, use `vi.spyOn(triologue, 'methodName')`.
- **Mock `state-machine.js` with `importOriginal`**: For `stop-esc.test.ts`, need to mock `presentResult` while preserving the `AgentState` enum. Use `vi.mock(..., async (importOriginal) => { const actual = await importOriginal(); return { ...actual, presentResult: vi.fn() }; })`.
- **File size limit**: Each test file stays under 300 lines per `TESTING_STANDARDS.md`. If a file exceeds this, split by branch (e.g., `llm-esc-precheck.test.ts` and `llm-esc-midcall.test.ts` are already separate).
- **`escAware` mocking strategy**: Two patterns:
  - **"ESC before handler"**: Set `isNeglectedMode()` to return `true` — handler checks before calling `escAware`.
  - **"ESC during operation"**: Mock `ctx.core.escAware` to call the cleanup function instead of the operation. This simulates the race condition where ESC wins.