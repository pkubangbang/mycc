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
import type { RequestEmbeddingTracker } from './request-embedding.js';
import { displayLetterBox } from '../utils/letter-box.js';
import { loopEvents } from './loop-events.js';

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
  WAIT = 'wait',
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
  /** Tracks whether the previous LLM pass had a crossroad (for consecutive detection) */
  crossroadOccurred: boolean;
  /** Semantic duplication tracker for embedding-based confusion scoring */
  requestEmbeddingTracker: RequestEmbeddingTracker;
  /** Countdown to the next worktree cleanup nudge (0 = no worktrees present) */
  nextWtNudge: number;
}

/** Turn lifetime — fresh when entering PROMPT from STOP/startup, persists across COLLECT→LLM→HOOK iterations */
export interface TurnVars {
  isFirstRound: boolean;
  nextTodoNudge: number;
  lastTodoState: string;
  nextBriefNudge: number;
  /** User's last real query, stored for recap to preserve across compression */
  lastUserQuery: string;
  /** English keywords extracted from user query for skill discovery */
  extractedKeywords: string[];
}

/** Pass lifetime — fresh at every COLLECT entry, flows LLM→HOOK→{TOOL|STOP} */
export interface ChatData {
  abortController: AbortController | null;
  rawToolCalls: ToolCall[];
  /** Text content from the LLM assistant message */
  assistantContent: string;
  /** Reasoning content from thinking mode (must be echoed back for DeepSeek) */
  assistantReasoningContent?: string;
  augmentedCalls: AugmentedToolCall[];
  hookResult: ProcessToolCallsResult | null;
  /** If crossroad was triggered, the best continuation text (injected in hook.ts) */
  crossroadContinuation?: string;
  /** If crossroad was triggered, the path to the crossroad record JSON file
   *  (written to the session dir by llm.ts, injected into the brief tool result
   *  by hook.ts so the LLM knows where the full decision record lives). */
  crossroadFilePath?: string;
  /**
   * Set by HOOK when a hook requests compaction (e.g. compact-on-intent-trap).
   * Consumed and cleared by the LLM stage, which performs the compact there
   * (where tools are available for a cache-friendly forkChat) rather than
   * inside the HOOK state. Deferring avoids compacting mid-tool-execution
   * where the tool list is not in scope.
   */
  deferredCompact: boolean;
}

// ============================================================================
// Handler Type
// ============================================================================

/** Returns the next state, or null to signal machine exit */
export type HandlerResult = AgentState | null;

export type StateHandler = (
  env: MachineEnv,
  turn: TurnVars,
  chat: ChatData,
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
    requestEmbeddingTracker: RequestEmbeddingTracker,
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
      crossroadOccurred: false,
      requestEmbeddingTracker,
      nextWtNudge: 0,
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
    let turn: TurnVars = { isFirstRound: true, nextTodoNudge: 3, lastTodoState: '', nextBriefNudge: 5, lastUserQuery: '', extractedKeywords: [] };
    let chat: ChatData = { abortController: null, rawToolCalls: [], assistantContent: '', augmentedCalls: [], hookResult: null, deferredCompact: false };
    // Initial state is always PROMPT. PROMPT is the single decision point for
    // whether to run autonomously: it redirects to WAIT when auto mode is on
    // (e.g. started via --auto, which calls autoState.setAuto(true)) or when
    // the --debug-autofly autofly trigger fires. Starting at PROMPT (instead
    // of branching on getAuto() here) keeps the engagement policy in one
    // place and avoids duplicating the WAIT-vs-PROMPT choice at startup.
    let state: AgentState = AgentState.PROMPT;
    let prevState: AgentState | null = null;

    while (true) {
      // ── Lifetime boundaries ──
      // PROMPT = new conversational turn — but only when coming from STOP or startup.
      // When coming from SLASH we preserve TurnVars (same turn, slash was a side trip).
      // WAIT is also a turn boundary in auto mode: each autonomous cycle starts a
      // fresh turn (fresh nudges, lastUserQuery cleared). WAIT never follows SLASH.
      if ((state === AgentState.PROMPT || state === AgentState.WAIT) && prevState !== AgentState.SLASH) {
        turn = { isFirstRound: true, nextTodoNudge: 3, lastTodoState: '', nextBriefNudge: 5, lastUserQuery: '', extractedKeywords: [] };
      }
      // COLLECT = fresh pipeline pass — always reset. Preserve
      // `deferredCompact`: HOOK sets it (e.g. compact-on-intent-trap) and
      // returns COLLECT so the LLM stage can run the compact where the tool
      // list is in scope. Resetting it to false here wipes the request before
      // the LLM stage ever sees it, leaving the deferred-compact branch dead.
      if (state === AgentState.COLLECT) {
        chat = { abortController: null, rawToolCalls: [], assistantContent: '', augmentedCalls: [], hookResult: null, deferredCompact: chat.deferredCompact };
      }

      // ── Execute ──
      const handler: StateHandler = this.handlers[state];
      const result: HandlerResult = await handler(this.env, turn, chat);

      // null = exit signal (from PROMPT handler)
      if (result === null) return;

      // Observability: emit state transition (silent when no listeners)
      loopEvents.emit('state_transition', { from: state, to: result });

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