# Plan: Revise turn.*/session.* semantics + add totalTurns()

## Problem

The `turn.*` and `session.*` hook condition scopes share a `Sequence.clear()`
method that zeroes BOTH on compaction. This is wrong:

- **`turn.*`** should mean "events since the last turn boundary" — a turn spans
  from a user query (or autonomous event) through all tool calls and LLM stages
  to STOP. If compaction fires mid-turn, pre-compact tool calls are still part
  of that turn. So `turn.*` should **survive compaction**.
- **`session.*`** should mean "the current livelog" — compaction replaces the
  livelog with a summary, so `session.*` should be **cleared by compaction**.
  This is the current behavior and is correct.

Additionally, in **daemon/auto mode**, PROMPT short-circuits to AWAIT
(`prompt.ts` line 165: `if (autoState.getAuto()) return AgentState.AWAIT`)
BEFORE reaching `markPromptBoundary()`. So `turn.*` accumulates forever
without clearing — a bug. Moving the boundary to STOP (reached in all modes)
fixes this.

Finally, there is no compaction-immune counter for "has substantial work
happened this session." `session.count()` is compaction-fragile, so the
`learn-from-past` hook's guard (`session.count() > 5`) silently fails after
compaction. We add `totalTurns()` for this.

## Semantic model (AFTER)

| Scope | Unit | Cleared by | Survives compaction? |
|-------|------|------------|---------------------|
| `turn.*` | events since last turn boundary | `markPromptBoundary()` at STOP→PROMPT | **YES** |
| `session.*` | events in current livelog | `compactReset()` (compaction) | NO |
| `totalTurns()` | number of completed turns (STOP→PROMPT cycles) | `fullClear()` only (`/clear`, Ctrl+L) | **YES** |

### What counts as a "turn"

A turn ends when STOP returns PROMPT (the agent produced its final response and
control returns to the user / next query). STOP→COLLECT (teammate mail,
steering, timeout) is a **continuation**, not a turn end — the agent keeps
working on the same task.

### `totalTurns()` at hook-evaluation time

Stop-trigger hooks run in the HOOK state, BEFORE STOP. So `totalTurns()`
reflects *previously completed* turns, not the current one. Use
`totalTurns() >= 5` to fire after 5 completed turns (on the 6th turn's hook
evaluation).

## Changes

### Section 1 — `src/hook/sequence.ts` (core)

**`markPromptBoundary()` — stays events-only (NO totalTurns increment):**

```typescript
markPromptBoundary(): void {
  this.events = [];
}
```

**New field + methods:**

```typescript
private totalTurns: number = 0;

incrementTotalTurns(): void {
  this.totalTurns++;
}

getTotalTurns(): number {
  return this.totalTurns;
}
```

**Split `clear()` into `compactReset()` + `fullClear()`:**

```typescript
/**
 * Clear session-level data ONLY (called on compaction).
 * Turn-level events[] is preserved — a turn spans across compaction.
 * totalTurns is preserved — compaction is not a turn boundary.
 */
compactReset(): void {
  this.totalEventsCount = 0;
  this.toolCallTally.clear();
  this.sessionPatternLog = [];
  this.sessionResultsLog = [];
  // turn.events[] NOT cleared — turn survives compaction
  // totalTurns NOT reset — compaction is not a turn boundary
}

/**
 * Full clear — reset everything including turn events and totalTurns.
 * Called by /clear, double-Ctrl+L, and session start.
 */
fullClear(): void {
  this.events = [];
  this.compactReset();
  this.totalTurns = 0;
}
```

Keep `clear()` temporarily as an alias for `fullClear()` (backward compat
during migration). Remove after all callers migrated.

**Update class docblock:**

```
Three scope levels:
1. turn.*   — events since last turn boundary. Survives compaction.
              Cleared by markPromptBoundary() at STOP→PROMPT.
2. session.* — events in current livelog. Cleared by compactReset()
              (co-called with triologue.compact()). Does NOT clear turn.*.
3. totalTurns() — number of completed turns (STOP→PROMPT cycles).
              Survives compaction. Cleared only by fullClear().
```

### Section 2 — `src/loop/states/stop.ts` (boundary relocation)

**Before each `return AgentState.PROMPT`** (5 sites), add:

```typescript
env.sequence.markPromptBoundary();
env.hookExecutor.resetTurn();
env.sequence.incrementTotalTurns();
return AgentState.PROMPT;
```

The 5 PROMPT return sites in stop.ts (a single `markTurnBoundary()` helper
wraps all three calls and is invoked before each):

| Site | Context |
|------|---------|
| neglected + lastRole='assistant' | HOOK→STOP text-only response path |
| neglected + mid-execution ESC | startWrapUp (letter-box summary) path |
| `awaitTeammates` switch default | reason 'esc' or 'all done' |
| catch block | error recovery → PROMPT |

(The `awaitTeammates` switch handles 'esc'/'all done'/'default' in one branch,
so the table lists 4 logical sites but 5 physical `return AgentState.PROMPT`
statements — the catch block is the 5th.)

**NOT added before `return AgentState.COLLECT`** (lines 118, 126) — STOP→COLLECT
is a continuation. Turn events, hook dedup, and totalTurns all persist.

### Section 3 — `src/loop/states/prompt.ts` (NO CHANGE)

Lines 277 and 436 already call `env.sequence.markPromptBoundary()` +
`env.hookExecutor.resetTurn()`. These stay as-is — they serve as fallbacks
for paths that bypass STOP (e.g. LLM error → direct PROMPT at llm.ts:329/378).
In normal flow they're no-ops (STOP already cleared). No `incrementTotalTurns()`
here — that's at STOP only.

### Section 4 — Call-site migration

**Compaction sites → `compactReset()`:**

| File | Line | Context |
|------|------|---------|
| `src/loop/states/llm.ts` | 76 | auto-compact at LLM stage |
| `src/loop/states/collect.ts` | 498 | hint-round signalled compaction |
| `src/loop/states/hook.ts` | 391 | deferred compact (hook-triggered) |
| `src/slashes/compact.ts` | 36 | `/compact` slash command |

**Full-wipe sites → `fullClear()`:**

| File | Line | Context |
|------|------|---------|
| `src/slashes/clear.ts` | 16 | `/clear` slash command |
| `src/loop/agent-repl.ts` | 202 | double-Ctrl+L callback |

**Compaction-site `resetTurn()` calls** (llm.ts:82, collect.ts:499, hook.ts,
slash/compact.ts:40) stay as-is — they re-arm hooks after mid-turn compaction.
Idempotent with STOP's `resetTurn()` (both clear a Set). No conflict.

### Section 5 — `src/hook/evaluator.ts`

Add `totalTurns: () => number` to `EvalContext` interface.

Handle `totalTurns` as a direct function call in `evaluateNode` (like
`isPlanMode`):

```typescript
if (callee.type === 'Identifier') {
  const idName = (callee as jsep.Identifier).name;
  if (idName === 'totalTurns') {
    // direct function call — return ctx.totalTurns()
  }
}
```

No change to `ALLOWED_ROOTS` — `totalTurns` is a bare function call, not a
member expression. The validator already allows direct function calls in
EvalContext.

### Section 6 — `src/hook/condition-validator.ts`

Add `totalTurns: () => number` to:
- `TestableSequence` interface
- `MockSequence` class (returns 0 by default)
- `smokeTestExpression`'s `emptyMock`
- `testExpression`'s ctx builder

Add `totalTurns` to the `CallExpression` + `callee.type === 'Identifier'`
branch in `visitNode` (same branch that allows `isPlanMode`).

### Section 7 — `src/hook/conditions.ts` (compile prompt)

Update scoping descriptions:

```
TURN-SCOPED (current turn since last turn boundary — NOT cleared by compaction, cleared at STOP→PROMPT):
SESSION-SCOPED (current livelog since session start or last compact — cleared by compaction):
LIFETIME (never reset by compaction, only by /clear):
- totalTurns(): Number of completed turns since session start. Use for "has
  substantial work happened" guards that must survive compaction. E.g.
  totalTurns() >= 5 means 5+ turns have completed. Note: at hook-evaluation
  time (HOOK state), totalTurns() reflects previously completed turns, not
  the current one.
```

### Section 8 — Tests

**`src/tests/hook/compact-reset-session-state.test.ts`:**
- Update `seq.clear()` → `seq.compactReset()`.
- Add assertion: `turn.count` is NOT reset by `compactReset()` (new behavior).
- Add assertion: `totalTurns` is NOT reset by `compactReset()`.

**New `src/tests/hook/turn-boundary-at-stop.test.ts`:**

```
Scenario 1: Normal turn — query → 3 tool calls → STOP → PROMPT
  Assert: turn.count() == 0 (cleared at STOP→PROMPT)
  Assert: totalTurns() == 1 (incremented at STOP→PROMPT)

Scenario 2: STOP→COLLECT (teammate mail) — query → 3 tool calls → STOP → COLLECT → 2 tool calls → STOP → PROMPT
  Assert after first STOP→COLLECT: turn.count() == 3 (NOT cleared)
  Assert after final STOP→PROMPT: turn.count() == 0, totalTurns() == 1

Scenario 3: Compaction mid-turn — query → 3 tool calls → compaction → 2 tool calls → STOP → PROMPT
  Assert: turn.count() == 0 (cleared at STOP), totalTurns() == 1
  Assert: session.count() == 2 (only post-compact, cleared by compactReset)

Scenario 4: Daemon mode — AWAIT → COLLECT → 2 tool calls → STOP → PROMPT → AWAIT
  Assert: turn.count() == 0 (cleared at STOP→PROMPT), totalTurns() == 1
  (This is the bug fix — previously turn.* never cleared in daemon mode)

Scenario 5: fullClear() resets totalTurns
  Assert: after fullClear(), totalTurns() == 0
```

**`src/tests/loop/states/prompt-autofly.test.ts`:**
- Line 392 test asserting `markPromptBoundary` called at PROMPT — still valid
  (PROMPT still calls it as fallback). No change.

**Existing tests with `seq.clear()`:**
- Update to `seq.compactReset()` or `seq.fullClear()` as appropriate.

**`src/tests/hook/condition-executor.test.ts`:**
- Update mock sequences to include `totalTurns: () => 0`.
- Update any `clear()` calls to the appropriate new method.

### Section 9 — Recompile `learn-from-past` skill

Change trigger condition from:

```
session.count() > 5
```

to:

```
totalTurns() >= 5
```

(Using `>=` because `totalTurns()` at hook-evaluation time reflects completed
turns; `>= 5` fires after 5 completed turns, on the 6th turn's hook
evaluation.)

Recompile via `skill_compile(name="learn-from-past")`.

## Interaction analysis

### `compact-on-intent-trap` hook

Condition: `turn.countResult('bash', 'Error: [Intent]', 20) >= 3 && session.count() > 20`

- `turn.countResult` now survives compaction — intent errors from before
  compaction still count. GOOD.
- `session.count() > 20` still resets on compaction — fine; the trap is about
  a tight burst.

### `plan-quality` hook

Condition: `isPlanMode() && session.count('skill_load#plan-quality') == 0`

- After compaction, `session.count` resets to 0, so the hook re-fires.
  Intended (documented in existing test). No change.

### `hand-over-ethics` hook

Condition: `session.count('skill_load#hand-over-ethics') == 0`

- Same as plan-quality: re-fires after compaction. Intended. No change.

## Edge cases (all verified)

| Edge case | Flow | turn.* clears? | totalTurns increments? | OK? |
|-----------|------|---------------|----------------------|-----|
| Normal turn | query→...→STOP→PROMPT | STOP→PROMPT ✓ | STOP→PROMPT ✓ | Yes |
| Daemon cycle | AWAIT→...→STOP→PROMPT→AWAIT | STOP→PROMPT ✓ | STOP→PROMPT ✓ | Yes (fixes the bug) |
| STOP→COLLECT (teammate mail) | STOP→COLLECT→LLM→...→STOP→PROMPT | At final STOP→PROMPT ✓ | At final STOP→PROMPT ✓ | Yes — continuation |
| LLM error → PROMPT | LLM→PROMPT (bypasses STOP) | PROMPT fallback ✓ | NO (next STOP) | Yes — temp stale events. In daemon/auto mode the PROMPT fallback is unreachable: `prompt.ts` short-circuits `PROMPT→AWAIT` at the top when `autoState.getAuto()` is on, before reaching the fallback `markPromptBoundary()`/`resetTurn()` calls — so no double-increment can occur. The next STOP→PROMPT increments exactly once. |
| Compaction mid-turn | LLM→compactReset→...→STOP→PROMPT | At STOP→PROMPT ✓ | At STOP→PROMPT ✓ | Yes — turn.* survives compaction |
| Stop-trigger hooks | HOOK evaluates → STOP | Already evaluated before STOP | N/A | Yes — clearing at STOP is safe |
| Bang/slash commands | PROMPT→PROMPT/SLASH | No (no turn happened) | No | Yes — correct to skip |

## Execution order

1. `sequence.ts` — add `totalTurns` field, `incrementTotalTurns()`,
   `getTotalTurns()`, split `clear()` into `compactReset()` + `fullClear()`.
   Keep `markPromptBoundary()` as events-only. Keep `clear()` as temp alias
   for `fullClear()`.
2. `stop.ts` — add `markPromptBoundary()` + `resetTurn()` +
   `incrementTotalTurns()` before each `return AgentState.PROMPT` (5 sites,
   via a `markTurnBoundary()` helper).
3. Migrate compaction call-sites → `compactReset()`; full-wipe sites →
   `fullClear()`.
4. `evaluator.ts` — add `totalTurns` to `EvalContext` + evaluation logic.
5. `condition-validator.ts` — add `totalTurns` to interfaces + mocks.
6. `conditions.ts` — update compile prompt.
7. Update tests.
8. `pnpm test` to verify.
9. Remove `clear()` alias (all callers migrated).
10. Recompile `learn-from-past` with `totalTurns() >= 5`.