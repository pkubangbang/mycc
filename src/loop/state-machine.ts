/**
 * state-machine.ts - Agent state machine types and runner
 *
 * Replaces the imperative while(true) in agent-loop.ts with
 * isolated state handlers connected by explicit transitions.
 *
 *        ┌────────────────────────────────────────┐
 *        │                                        │
 *   ┌─── PROMPT ◄────────────────────┐           │
 *   │    │   ▲                       │           │
 *   │    ▼   │                       │           │
 *   │  SLASH─┘                       │           │
 *   │                                │           │
 *   │    ▼                           │           │
 *   │  COLLECT ◄─────── TOOL ─────┐ │           │
 *   │    │              ▲         │ │           │
 *   │    ▼              │         │ │           │
 *   │  LLM ────► HOOK ──┘       STOP ──────────┘
 *   │                │              │
 *   │          has calls        no calls
 *   └── (pendingSlashQuery set by SLASH)
 */

import type { AgentContext, ToolScope } from '../types.js';
import type { ToolCall } from '../types.js';
import type { Triologue } from './triologue.js';
import type { ConditionRegistry } from '../hook/conditions.js';
import type { Sequence } from '../hook/sequence.js';
import type { HookExecutor, AugmentedToolCall, ProcessToolCallsResult } from '../hook/hook-executor.js';
import type { InputProvider } from './input-provider.js';
import { displayLetterBox } from '../utils/letter-box.js';

// ============================================================================
// States
// ============================================================================

export enum AgentState {
  PROMPT = 'prompt',
  SLASH = 'slash',
  COLLECT = 'collect',
  LLM = 'llm',
  HOOK = 'hook',
  TOOL = 'tool',
  STOP = 'stop',
}

// ============================================================================
// Data Tiers
// ============================================================================

/** Machine lifetime — constructed once, never reset. Mutable fields are request-scoped (set+clear atomically). */
export interface MachineEnv {
  triologue: Triologue;
  ctx: AgentContext;
  scope: ToolScope;
  conditions: ConditionRegistry;
  sequence: Sequence;
  hookExecutor: HookExecutor;
  inputProvider: InputProvider;
  /** Session file path for bookmark capture */
  sessionFilePath: string;
  /**
   * Set by SLASH handler when a command (e.g., /load) produces a query.
   * Consumed and cleared by PROMPT handler on next entry.
   */
  pendingSlashQuery: string | null;
}

/** Turn lifetime — fresh when entering PROMPT from STOP/startup, persists across COLLECT→LLM→HOOK iterations */
export interface TurnVars {
  isFirstRound: boolean;
  nextTodoNudge: number;
  lastTodoState: string;
}

/** Pass lifetime — fresh at every COLLECT entry, flows LLM→HOOK→{TOOL|STOP} */
export interface PassData {
  abortController: AbortController | null;
  rawToolCalls: ToolCall[];
  /** Text content from the LLM assistant message */
  assistantContent: string;
  augmentedCalls: AugmentedToolCall[];
  hookResult: ProcessToolCallsResult | null;
}

// ============================================================================
// Handler Type
// ============================================================================

/** Returns the next state, or null to signal machine exit */
export type HandlerResult = AgentState | null;

export type StateHandler = (
  env: MachineEnv,
  turn: TurnVars,
  pass: PassData,
) => Promise<HandlerResult>;

// ============================================================================
// Runner
// ============================================================================

export class AgentStateMachine {
  private env: MachineEnv;
  private handlers: Record<AgentState, StateHandler>;

  constructor(
    triologue: Triologue,
    ctx: AgentContext,
    scope: ToolScope,
    conditions: ConditionRegistry,
    sequence: Sequence,
    hookExecutor: HookExecutor,
    inputProvider: InputProvider,
    sessionFilePath: string,
    handlers: Record<AgentState, StateHandler>,
  ) {
    this.env = {
      triologue,
      ctx,
      scope,
      conditions,
      sequence,
      hookExecutor,
      inputProvider,
      sessionFilePath,
      pendingSlashQuery: null,
    };
    this.handlers = handlers;
  }

  /**
   * Run the state machine loop.
   *
   * Conversational turns: PROMPT → ... → STOP → PROMPT (reset TurnVars)
   * Pipeline passes:      COLLECT → LLM → HOOK → {TOOL → COLLECT | STOP}
   * Slash:                PROMPT → SLASH → PROMPT (no TurnVars reset)
   *
   * Returns when the PROMPT handler returns null (user exit).
   * Errors propagate to the caller.
   */
  async run(): Promise<void> {
    let turn: TurnVars = { isFirstRound: true, nextTodoNudge: 3, lastTodoState: '' };
    let pass: PassData = { abortController: null, rawToolCalls: [], assistantContent: '', augmentedCalls: [], hookResult: null };
    let state: AgentState = AgentState.PROMPT;
    let prevState: AgentState | null = null;

    while (true) {
      // ── Lifetime boundaries ──
      // PROMPT = new conversational turn — but only when coming from STOP or startup.
      // When coming from SLASH we preserve TurnVars (same turn, slash was a side trip).
      if (state === AgentState.PROMPT && prevState !== AgentState.SLASH) {
        turn = { isFirstRound: true, nextTodoNudge: 3, lastTodoState: '' };
      }
      // COLLECT = fresh pipeline pass — always reset.
      if (state === AgentState.COLLECT) {
        pass = { abortController: null, rawToolCalls: [], assistantContent: '', augmentedCalls: [], hookResult: null };
      }

      // ── Execute ──
      const handler: StateHandler = this.handlers[state];
      const result: HandlerResult = await handler(this.env, turn, pass);

      // null = exit signal (from PROMPT handler)
      if (result === null) return;

      prevState = state;
      state = result;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Display the final assistant response in a letter-style box */
export function presentResult(triologue: Triologue): void {
  const lastMsg = triologue.getMessagesRaw().at(-1);
  if (lastMsg?.content) {
    displayLetterBox(lastMsg.content);
  }
}
