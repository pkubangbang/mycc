/**
 * mock-harness.ts — Centralized mock setup for agent-loop state tests.
 *
 * THE PURPOSE: eliminate scattered vi.mock() blocks from test files.
 * Every test file that uses MockHarness should have ZERO vi.mock() calls.
 * All mock setup is centralized in MockHarness.install().
 *
 * ## Symbol → Response Mapping (verified against source code)
 *
 * | Symbol | LLM Response        | Path                                        |
 * |--------|---------------------|---------------------------------------------|
 * | T      | tool_calls (bash)   | HOOK→TOOL→COLLECT (normal tool round)       |
 * | H      | tool_calls (ckpt)   | HOOK→COLLECT (checkpoint/recap/blocked/etc) |
 * | W      | text-only           | HOOK→STOP→COLLECT (awaitTeam question/time) |
 * | E      | throw Error         | LLM→PROMPT (ESC/empty-exhausted/error-decl) |
 * | X      | text-only           | HOOK→PROMPT (recap ESC / catch error)       |
 * | P      | tool_calls (bash)   | HOOK→TOOL→PROMPT (ESC per-tool)             |
 * | S      | text-only "final"   | HOOK→STOP→PROMPT (all-done/no-teammates)    |
 * | CE     | (no LLM call)       | COLLECT→PROMPT (hint ESC / catch error)     |
 *
 * ## Hoisting Note
 *
 * vi.mock() calls are hoisted by vitest to the top of the file. They cannot
 * reference `this` or closure variables that don't exist at hoist time. We
 * solve this with a **module-level registry** (`_registry`) that the mock
 * factories read from. MockHarness.install() populates `_registry` before
 * triggering the (already-hoisted) vi.mock factories.
 *
 * Usage in test files:
 *   ```ts
 *   import { MockHarness, type PathDescriptor } from '../mock-harness.js';
 *
 *   const harness = new MockHarness({ symbols: ['T', 'S'] });
 *   harness.install();
 *
 *   // Import modules under test AFTER install
 *   const { handleLlm } = await import('../../../loop/states/llm.js');
 *   ```
 */
import { vi } from 'vitest';
import {
  createMockChatResponse,
  createMockToolCall,
} from './esc-test-helpers.js';

// ============================================================================
// Public Types
// ============================================================================

/** A bridge or exit symbol from the topological alphabet. */
export type Symbol = 'T' | 'H' | 'W' | 'E' | 'X' | 'P' | 'S' | 'CE';

/** Describes a path by its symbol sequence. */
export interface PathDescriptor {
  /** e.g. ['T', 'S'] for a 2-LLM-call path: tool bridge then stop exit */
  symbols: Symbol[];
  /** Initial user query (stored on TurnVars.lastUserQuery) */
  userQuery?: string;
  /** Outputs for T/P bridges (defaults to 'ok'). Indexed per tool round. */
  toolResults?: string[];
}

// ============================================================================
// Module-Level Registry (read by hoisted vi.mock factories)
// ============================================================================

/**
 * Internal registry that the hoisted vi.mock factories reference.
 * Populated by MockHarness.install() before any mock factory executes.
 *
 * Why module-level? vi.mock() is hoisted above all imports and assignments.
 * The factory function passed to vi.mock runs at hoist time and cannot close
 * over class instance state. A module-level singleton is the standard vitest
 * pattern for sharing state into hoisted mocks.
 */
interface HarnessRegistry {
  /** Queue of symbols to consume (LLM responses are generated per symbol). */
  symbolQueue: Symbol[];
  /** Queue of tool results for T/P tool execution. */
  toolResultQueue: string[];
  /** Index of the next tool result to return. */
  toolResultIndex: number;
  /** Whether install() has been called. */
  installed: boolean;
}

const _registry: HarnessRegistry = {
  symbolQueue: [],
  toolResultQueue: [],
  toolResultIndex: 0,
  installed: false,
};

// ============================================================================
// Mock Harness Class
// ============================================================================

export class MockHarness {
  private desc: PathDescriptor;

  constructor(desc: PathDescriptor) {
    this.desc = desc;
  }

  /**
   * Set up ALL vi.mock blocks in ONE place.
   *
   * This replaces 10+ scattered vi.mock() calls in each test file.
   * After calling install(), import the modules under test (the mocks will
   * intercept).
   *
   * Mocks centralized here (paths relative to src/tests/loop/states/):
   *  - engine/chat-provider.js (retryChat, forkChat, MODEL)
   *  - loop/agent-io.js (neglected mode toggle)
   *  - loop/esc-wrap-up.js (startWrapUp, evaluateWrapUp, clearWrapUp)
   *  - loop/crossroad.js (handleCrossroad)
   *  - engine/chat-helpers.js (stopSpinner)
   *  - loop/agent-prompts.js (buildPlanModePrompt, buildNormalModePrompt, isInPlanMode)
   *  - context/shared/loader.js (getToolsForScope, execute)
   *  - loop/triologue.js (Triologue stub class)
   *  - loop/state-machine.js (AgentState enum + presentResult)
   */
  install(): void {
    // Populate the module-level registry so hoisted mock factories can read it
    _registry.symbolQueue = [...this.desc.symbols];
    _registry.toolResultQueue = this.desc.toolResults ?? [];
    _registry.toolResultIndex = 0;
    _registry.installed = true;

    // --- chat-provider: retryChat driven by symbol queue, forkChat stubbed ---
    vi.mock('../../../engine/chat-provider.js', () => ({
      retryChat: vi.fn(async () => MockHarness.generateLlmResponse()),
      forkChat: vi.fn(async () => 'fork-result'),
      MODEL: 'test-model',
    }));

    // --- agent-io: neglected mode closure (toggle via setNeglectedMode) ---
    vi.mock('../../../loop/agent-io.js', () => {
      let neglected = false;
      return {
        agentIO: {
          isNeglectedMode: vi.fn(() => neglected),
          setNeglectedMode: vi.fn((v: boolean) => {
            neglected = v;
          }),
          isAuto: vi.fn(() => false),
          setAuto: vi.fn(),
          log: vi.fn(),
          flushOutput: vi.fn(),
          verbose: vi.fn(),
          brief: vi.fn(),
        },
      };
    });

    // --- esc-wrap-up ---
    vi.mock('../../../loop/esc-wrap-up.js', () => ({
      startWrapUp: vi.fn(),
      evaluateWrapUp: vi.fn(),
      clearWrapUp: vi.fn(),
    }));

    // --- crossroad ---
    vi.mock('../../../loop/crossroad.js', () => ({
      handleCrossroad: vi.fn(async () => null),
    }));

    // --- chat-helpers ---
    vi.mock('../../../engine/chat-helpers.js', () => ({
      stopSpinner: vi.fn(),
    }));

    // --- agent-prompts ---
    vi.mock('../../../loop/agent-prompts.js', () => ({
      buildPlanModePrompt: vi.fn(() => 'plan-prompt'),
      buildNormalModePrompt: vi.fn(() => 'normal-prompt'),
      isInPlanMode: vi.fn(() => false),
    }));

    // --- loader: getToolsForScope returns a tool list, execute driven by queue ---
    vi.mock('../../../context/shared/loader.js', () => ({
      loader: {
        getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]),
        execute: vi.fn(async () => MockHarness.generateToolResult()),
      },
    }));

    // --- triologue: stub class with all methods used by state handlers ---
    vi.mock('../../../loop/triologue.js', () => {
      class TriologueStub {
        setSystemPrompt = vi.fn();
        getMessagesRaw = vi.fn(() => []);
        getLastRole = vi.fn(() => null);
        agent = vi.fn();
        tool = vi.fn();
        getMessages = vi.fn(() => []);
        needsCompact = vi.fn(() => false);
        compact = vi.fn(async () => {});
        note = vi.fn();
        skipPendingTools = vi.fn();
        getTokenCount = vi.fn(() => 0);
        getTokenThreshold = vi.fn(() => 8000);
        findCheckpointById = vi.fn(() => null);
        findAllCheckpoints = vi.fn(() => []);
        recapMessages = vi.fn();
        generateHintRound = vi.fn(async () => 'hint');
      }
      return { Triologue: TriologueStub };
    });

    // --- state-machine: AgentState enum + presentResult (for stop.ts) ---
    vi.mock('../../../loop/state-machine.js', () => ({
      AgentState: {
        PROMPT: 'prompt',
        SLASH: 'slash',
        COLLECT: 'collect',
        LLM: 'llm',
        HOOK: 'hook',
        TOOL: 'tool',
        STOP: 'stop',
        WAIT: 'wait',
      },
      presentResult: vi.fn(),
      AgentStateMachine: vi.fn(),
    }));
  }

  // ==========================================================================
  // Symbol-Driven Response Generation
  // ==========================================================================

  /**
   * Consume the next symbol from the registry queue and generate the
   * corresponding LLM response.
   *
   * Called by the mocked retryChat() factory.
   *
   * Symbol → Response:
   *  - T: tool_calls (bash) — HOOK returns TOOL, TOOL returns COLLECT
   *  - H: tool_calls (checkpoint) — HOOK returns COLLECT (meta-tool path)
   *  - W: text-only — HOOK returns STOP, STOP awaitTeam returns COLLECT
   *  - E: throw Error — simulates ESC/empty-exhausted/error-declined (LLM→PROMPT)
   *  - X: text-only — HOOK catch error fires, HOOK→PROMPT
   *  - P: tool_calls (bash) — TOOL ESC fires during execution (TOOL→PROMPT)
   *  - S: text-only "final answer" — HOOK→STOP→PROMPT (all-done)
   *  - CE: (no LLM call needed — COLLECT exits directly to PROMPT)
   */
  static generateLlmResponse(): unknown {
    const sym = _registry.symbolQueue.shift();
    if (sym === undefined) {
      // No more symbols — return a harmless text response
      return createMockChatResponse({ content: 'ok' });
    }

    switch (sym) {
      case 'T':
        // Normal tool round: LLM produces bash tool calls
        // HOOK → TOOL → COLLECT
        return createMockChatResponse({
          toolCalls: [createMockToolCall('bash', { command: 'echo test' })],
        });

      case 'H':
        // Hook-blocked / checkpoint / recap / crossroad / compact path:
        // LLM produces a checkpoint meta-tool call, which HOOK intercepts
        // and returns COLLECT (meta-tool handler returns COLLECT).
        return createMockChatResponse({
          toolCalls: [createMockToolCall('checkpoint', { description: 'test' })],
        });

      case 'W':
        // Text-only response (no tools) → HOOK returns STOP
        // STOP awaitTeam returns question/timeout/mail → COLLECT
        return createMockChatResponse({ content: 'Waiting for team input.' });

      case 'E':
        // ESC during LLM / empty retries exhausted / transient error declined
        // llm.ts catches the error or ESC cleanup returns null → PROMPT
        throw new Error('Simulated ESC / transient error (symbol E)');

      case 'X':
        // HOOK catch error fires (e.g. recap ESC) → HOOK returns PROMPT
        // LLM succeeds with text-only; the error is triggered downstream in HOOK
        return createMockChatResponse({ content: 'text response' });

      case 'P':
        // TOOL ESC fires during execution (skipPendingTools) → TOOL returns PROMPT
        // LLM produces tool calls; ESC is simulated during tool execution
        return createMockChatResponse({
          toolCalls: [createMockToolCall('bash', { command: 'echo test' })],
        });

      case 'S':
        // Text-only "final answer" → HOOK returns STOP → STOP all-done → PROMPT
        return createMockChatResponse({ content: 'Final answer: task complete.' });

      case 'CE':
        // COLLECT exits directly to PROMPT (no LLM call needed).
        // If this is reached, it means the LLM was called despite CE being
        // a zero-LLM exit. Return a minimal response as a safety net.
        return createMockChatResponse({ content: '' });

      default:
        return createMockChatResponse({ content: 'ok' });
    }
  }

  /**
   * Generate the next tool result from the registry queue.
   * Called by the mocked loader.execute().
   * Defaults to 'ok' if no toolResults were provided.
   */
  static generateToolResult(): string {
    const result =
      _registry.toolResultQueue[_registry.toolResultIndex] ?? 'ok';
    _registry.toolResultIndex++;
    return result;
  }

  // ==========================================================================
  // Assertion Helpers
  // ==========================================================================

  /**
   * Assert that all scripted LLM responses have been consumed.
   * Throws if the symbol queue is not empty (i.e. some symbols were never
   * consumed by retryChat).
   */
  assertExhausted(): void {
    if (_registry.symbolQueue.length > 0) {
      throw new Error(
        `MockHarness: ${_registry.symbolQueue.length} unconsumed symbol(s) ` +
          `remaining: [${_registry.symbolQueue.join(', ')}]. ` +
          `Expected all symbols to be consumed by retryChat calls.`,
      );
    }
  }

  /**
   * Reset the registry (useful in beforeEach to clear state between tests).
   */
  reset(): void {
    _registry.symbolQueue = [...this.desc.symbols];
    _registry.toolResultQueue = this.desc.toolResults ?? [];
    _registry.toolResultIndex = 0;
  }
}