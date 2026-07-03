# ESC Single-Press Return-to-Prompt Audit & Fix Plan

## Requirement
A single ESC keypress should return the user to the prompt immediately, regardless of what state the agent is in.

## Investigation Results

### ESC Flow Overview
1. **Coordinator** (`src/index.ts`): Raw mode intercepts ESC via `isEscape()` → sends `{ type: 'neglection' }` IPC to Lead
2. **AgentIO** (`src/loop/agent-io.ts`): Receives neglection IPC → sets `neglectedModeFlag = true` → aborts LLM via `AbortController` → fires `onNeglectedCallbacks`
3. **escAware** (`src/context/parent/core.ts`): Races operation vs ESC callback → returns cleanup result immediately on ESC
4. **State handlers**: Check `isNeglectedMode()` and return `AgentState.PROMPT`

### All ESC Entry Points (6 total)

| # | Location | State | Current Behavior | Compliant? |
|---|----------|-------|-------------------|------------|
| 1 | `llm.ts` LLM call | LLM | escAware → startWrapUp → return PROMPT | ⚠️ neglectedMode not cleared |
| 2 | `llm.ts` crossroad | LLM | escAware → returns null → falls through to HOOK | ❌ NO (goes to HOOK, not PROMPT) |
| 3 | `tool.ts` tool execution | TOOL | Check isNeglectedMode → skipPendingTools → return PROMPT | ✅ YES |
| 4 | `collect.ts` hint generation | COLLECT | escAware → startWrapUp → return PROMPT | ⚠️ neglectedMode not cleared |
| 5 | `hook.ts` recap generation | HOOK | escAware → returns cancelled string → return COLLECT | ❌ NO (goes to COLLECT, not PROMPT) |
| 6 | `agent-io.ts` ask()/question() | PROMPT | ESC ignored if activeLineEditor exists | ❌ NO (ESC completely ignored) |

---

## Fixes

### Fix 1: ESC during crossroad → return PROMPT
**File**: `src/loop/states/llm.ts`
After the crossroad `escAware` block (after `const crossroadResult = await ctx.core.escAware(...)`), BEFORE the `if (crossroadResult)` check, add:
```typescript
if (agentIO.isNeglectedMode()) {
  stopSpinner();
  return AgentState.PROMPT;
}
```

### Fix 2: ESC during recap → return PROMPT
**File**: `src/loop/states/hook.ts`
In `handleRecapCall`, inside the `if (summary.startsWith('[RECAP] Cancelled:'))` block, before `turn.isFirstRound = false; return AgentState.COLLECT;`, add:
```typescript
if (agentIO.isNeglectedMode()) {
  agentIO.setNeglectedMode(false);
  return AgentState.PROMPT;
}
```

### Fix 3: ESC during ask() — add `onEsc` / `onEnter` options ✅ COMPLETE
**File**: `src/loop/agent-io.ts`

#### Rationale
ESC during `ask()` should not blindly return `''` because empty string may be interpreted as a "default" choice by callers. Instead, `ask()` gains optional `onEsc` and `onEnter` options that let each caller specify what ESC or empty-Enter should resolve to. If neither is provided, ESC is ignored (preserving current behavior for the main prompt where ESC = no-op).

#### Actual implementation (consolidated AskOptions pattern)
Per user instruction, all params except `query` are consolidated into a single `AskOptions` options object:

```typescript
interface AskOptions {
  useAsPrompt?: boolean;
  initialContent?: string;
  onEsc?: string;
  onEnter?: string;
}

async ask(query: string, options?: AskOptions): Promise<string>
```

- `onEsc`: When ESC pressed, resolve with this value. If not provided, ESC is ignored (current behavior — preserves main prompt no-op).
- `onEnter`: When Enter pressed with empty content, resolve with this value. If not provided, returns `''` (current behavior).

#### Implementation
1. **Add `AskOptions` interface** with `useAsPrompt`, `initialContent`, `onEsc`, `onEnter` fields.
2. **Add private fields**: `askResolver`, `askOnEsc`, `askOnEnter`.
3. **In `ask()`**: Store resolver and onEsc/onEnter values at start of Promise.
4. **In `onDone` callback**: If value is empty string and `askOnEnter` is set, use that value instead. Clear all fields before calling `resolve()`.
5. **In neglection IPC handler**: If `activeLineEditor` exists and `askOnEsc` is set, close editor and resolve with onEsc value. If onEsc not set, ESC is ignored (main prompt no-op).
6. **Clear fields in `onDone` and `catch`**: Set all three fields to null before resolve/throw.

#### Caller updates (all complete)
Each caller of `ask()` that is NOT the main prompt passes `onEsc` (and `onEnter` where appropriate):

| Caller | File | onEsc | onEnter |
|--------|------|-------|---------|
| Main prompt | `input-provider.ts` | not set (ignore ESC) | not set |
| Retry prompt | `input-provider.ts` | `'n'` | `'y'` |
| Health check retry | `agent-repl.ts` | `'n'` | `'y'` |
| Retry (LLM fail) | `agent-repl.ts` | `'n'` | `'y'` |
| "Press Enter to continue" | `session/index.ts` | `''` | not set |
| "Press Enter to continue" | `slashes/load.ts` | `''` | not set |
| "Press Enter to submit" | `multiline-input.ts` | `'r'` (return) | not set |
| Save tmux session | `hand_over.ts` | not set | not set |

#### `question()` propagation (complete)
`core.question()` accepts and passes through options:
```typescript
async question(query: string, asker: string, options?: { onEsc?: string; onEnter?: string }): Promise<string>
```
- `src/context/parent/core.ts`: passes options to `agentIO.ask(query, { onEsc, onEnter })`
- `src/context/child/core.ts`: passes options through IPC `question` request
- `src/types.ts`: updated `CoreModule` interface
- `src/context/parent/team.ts`: `pendingQuestions` stores and forwards `options` from child IPC

#### Grant callers with `onEsc` (all complete)
- `git_commit.ts`: `{ onEsc: 'n' }` (ESC = deny commit)
- `plan_on.ts`: `{ onEsc: 'n' }` (ESC = strict plan mode)
- `plan_off.ts`: `{ onEsc: 'n' }` (ESC = stay in plan mode)
- `wt_enter.ts`: `{ onEsc: 'n' }` (ESC = cancel entry)
- `core.ts requestExternalPathAccess()`: `{ onEsc: '4' }` (ESC = deny, option 4)
- `question.ts` tool: `{ onEsc: '' }` (ESC = cancel question, empty response)

### Fix 4a: Clear neglectedMode in llm.ts before returning PROMPT
**File**: `src/loop/states/llm.ts`
1. ESC-before-LLM path: after `startWrapUp(triologue, tools)` and before `return AgentState.PROMPT;`, add `agentIO.setNeglectedMode(false);`
2. ESC-during-LLM path (null response): after `stopSpinner()` and before `return AgentState.PROMPT;`, add `agentIO.setNeglectedMode(false);`

### Fix 4b: Clear neglectedMode in collect.ts before returning PROMPT
**File**: `src/loop/states/collect.ts`
In the hint generation section, when `result === 'aborted'`, add `agentIO.setNeglectedMode(false);` before `return AgentState.PROMPT;`

---

## Files Changed (summary)

| File | Fixes |
|------|-------|
| `src/loop/agent-io.ts` | Fix 3 (ask() onEsc/onEnter) |
| `src/context/parent/core.ts` | Fix 3 (question() propagation) |
| `src/context/child/core.ts` | Fix 3 (question() IPC propagation) |
| `src/types.ts` | Fix 3 (CoreModule interface) |
| `src/context/parent/team.ts` | Fix 3 (child question IPC pass-through) |
| `src/loop/states/llm.ts` | Fix 1 (crossroad ESC) + Fix 4a |
| `src/loop/states/hook.ts` | Fix 2 (recap ESC) |
| `src/loop/states/collect.ts` | Fix 4b |
| `src/loop/input-provider.ts` | Fix 3 (retry prompts: onEsc/onEnter) |
| `src/loop/agent-repl.ts` | Fix 3 (retry prompts: onEsc/onEnter) |
| `src/session/index.ts` | Fix 3 (press Enter: onEsc) |
| `src/slashes/load.ts` | Fix 3 (press Enter: onEsc) |
| `src/utils/multiline-input.ts` | Fix 3 (press Enter: onEsc) |
| `src/tools/git_commit.ts` | Fix 3 (grant: onEsc) |
| `src/tools/plan_on.ts` | Fix 3 (grant: onEsc) |
| `src/tools/plan_off.ts` | Fix 3 (grant: onEsc) |
| `src/tools/wt_enter.ts` | Fix 3 (grant: onEsc) |
| `src/tools/question.ts` | Fix 3 (LLM question: onEsc) |

## Teammate Assignment
- **Teammate 1 (esc-state-fixes)**: Fix 1, 2, 4a, 4b — state handler changes (llm.ts, hook.ts, collect.ts)
- **Teammate 2 (esc-ask-fix)**: Fix 3 — ask() onEsc/onEnter + all caller updates (agent-io.ts, core.ts, types.ts, team.ts, input-provider.ts, agent-repl.ts, session/index.ts, load.ts, multiline-input.ts, git_commit.ts, plan_on.ts, plan_off.ts, wt_enter.ts, question.ts)