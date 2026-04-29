# Agent Loop State Machine

## Motivation

The current agent loop (`src/loop/agent-loop.ts`) is a ~280-line imperative `while(true)` with ~7 interleaved steps. The user prompt lives outside the loop in `src/loop/agent-repl.ts`, which wraps it in its own two-level retry structure. This makes control flow hard to follow, test, and extend.

Refactoring into a state machine isolates each step into an independent handler connected by explicit transitions. The user prompt becomes a first-class state, enabling autonomous operation by swapping the input provider.

## The 6 States

```
                    TurnVars reset here
                         │
                    ┌────┴────┐
                    │  PROMPT │◄──────────────────────────────┐
                    └────┬────┘                               │
                         │                                    │
                    PassData reset here                       │
                         │                                    │
                    ┌────┴────┐      ┌──────┐    ┌──────┐    │
                    │ COLLECT │◄─────┤ TOOL │    │ STOP │────┘
                    └────┬────┘      └──┬───┘    └──┬───┘
                         │              ▲           ▲
                         ▼              │           │
                    ┌────────┐    ┌─────┴───────────┴──┐
                    │  LLM   │───>│        HOOK        │
                    └────────┘    └─────────┬──────────┘
                                            │
                                   has calls │  no calls
                                   ──────────┘  ────────┘
```

| State | Responsibility |
|-------|---------------|
| **prompt** | Get user input (or skip in autonomous mode). Handle `/slash`, `!bang`, multi-line, exit. Display letter box on turn completion. |
| **collect** | Pre-LLM pipeline: child questions, mail collection, hint round, todo nudging, role sequence validation. |
| **llm** | Build system prompt, call `retryChat` with internal retry loop, handle abort. |
| **hook** | Augment tool calls with metadata. Evaluate hook conditions. Inject, replace, or block tool calls. Branch to `tool` or `stop`. |
| **tool** | Execute tool calls sequentially. Handle ESC interruption, hook blocking, sequence tracking, ResultTooLargeError. |
| **stop** | Handle the no-tool-call case. Await teammates (if any). Branch: continue working or complete turn. |

## Data Tiers

Three tiers with distinct lifetimes:

| Tier | Reset on | Contains |
|------|----------|----------|
| `MachineEnv` | never | `triologue`, `ctx` (AgentContext), `scope`, `conditions`, `sequence`, `hookExecutor`, `inputProvider` |
| `TurnVars` | entering **prompt** | `isFirstRound`, `nextTodoNudge`, `lastTodoState` |
| `PassData` | entering **collect** | `abortController`, `rawToolCalls`, `augmentedCalls`, `hookResult` |

Handler signature:

```typescript
type StateHandler = (
  env: MachineEnv,
  turn: TurnVars,
  pass: PassData
) => Promise<AgentState>;
```

## Transition Table

| From | Condition | To |
|------|-----------|-----|
| prompt | got input | collect |
| prompt | user typed exit/quit | (machine returns) |
| collect | preflight done | llm |
| llm | response received | hook |
| llm | aborted during call | collect |
| llm | transient error + retry | llm (stay) |
| llm | transient error + user declines | (throw → main) |
| hook | has surviving tool calls | tool |
| hook | no calls (all blocked or LLM produced none) | stop |
| tool | all executed | collect |
| tool | ESC interrupt | collect |
| stop | got question / new mail / timeout | collect |
| stop | all done / no work | prompt |

## Error Handling

Three tiers:

**Tier 1: retryChat** (unchanged) — 3x backoff retry for transient errors. Abort short-circuits immediately.

**Tier 2: State handlers** — each handler owns its error domain:

- **llm**: `Request aborted` → inject wrap-up message → collect. Transient error → `inputProvider.promptRetry()` → retry or throw.
- **tool**: `ResultTooLargeError` → truncate output. ESC → skip remaining, collect. Other errors → throw.
- **collect**: teammate timeout → inject context → llm.

**Tier 3: agent-repl.ts main()** — catch-all for ShutdownError, readline closed, and fatal errors with `classifyError()` guidance.

### Retry Consolidation

The old REPL's retry loop (wrapping entire `agentLoop()`) merges into the **llm** state. When `retryChat` exhausts internal retries, the llm state calls `inputProvider.promptRetry()` inline instead of bubbling up to a separate loop. On retry, the llm call restarts immediately — no redundant preflight work.

## Input Provider Abstraction

```typescript
interface InputProvider {
  readonly name: string;
  getInput(): Promise<string | null>;  // null = skip prompt (autonomous)
  promptRetry(errorMessage: string): Promise<boolean>;
}
```

| Implementation | `getInput()` | `promptRetry()` |
|----------------|-------------|-----------------|
| `UserInputProvider` | `agentIO.ask()` | Shows "Retry? [Y/n]" |
| `AutonomousProvider` | returns `null` | returns `true` |
| `LLMDrivenProvider` (future) | LLM-generated task | returns `true` |

## File Layout

**New files:**
```
src/loop/state-machine.ts       — AgentState enum, MachineEnv/TurnVars/PassData, AgentStateMachine runner
src/loop/input-provider.ts      — InputProvider interface + UserInputProvider
src/loop/states/prompt.ts       — handlePrompt
src/loop/states/collect.ts      — handleCollect
src/loop/states/llm.ts          — handleLlm
src/loop/states/hook.ts         — handleHook
src/loop/states/tool.ts         — handleTool
src/loop/states/stop.ts         — handleStop
```

**Modified files:**
```
src/loop/agent-repl.ts          — Thin wrapper: init → AgentStateMachine → run → error display
src/loop/agent-loop.ts          — Backward-compat re-export via state machine
```

## Feature Mapping

| Current Location | Moves To |
|-----------------|----------|
| agent-repl.ts: ask() + slash/bang/exit | prompt state |
| agent-repl.ts: displayLetterBox | prompt state (after turn completion) |
| agent-repl.ts: retry loop | llm state (merged with retryChat retries) |
| agent-loop.ts: handlePendingQuestions | collect state |
| agent-loop.ts: collectMails | collect state |
| agent-loop.ts: hint round | collect state |
| agent-loop.ts: todo nudging | collect state |
| agent-loop.ts: buildSystemPrompt + retryChat | llm state |
| agent-loop.ts: augmentToolCalls + processToolCalls | hook state |
| agent-loop.ts: blocked call handling | hook state |
| agent-loop.ts: no-tool branching | hook state (→ tool or stop) |
| agent-loop.ts: tool execution loop | tool state |
| agent-loop.ts: deferred messages | tool state |
| agent-loop.ts: awaitTeam + timeout | stop state |
| agent-loop.ts: neglected wrap-up | stop state |

## Implementation Order

1. `state-machine.ts` — types, enum, context interfaces, runner class
2. `input-provider.ts` — interface + UserInputProvider
3. `stop.ts` — simplest handler, single decision point
4. `hook.ts` — augmentation + hook processing + branching
5. `tool.ts` — sequential tool execution
6. `collect.ts` — pre-LLM pipeline
7. `llm.ts` — system prompt + retryChat + retry + abort
8. `prompt.ts` — user input, slash/bang/exit, letter box
9. Modify `agent-repl.ts` — wire up machine
10. Modify `agent-loop.ts` — backward-compat wrapper
11. Tests
