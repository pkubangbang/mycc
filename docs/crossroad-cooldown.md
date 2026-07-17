# Crossroad Cooldown Design Doc

> **Status:** Approved (2026-07-17)
> **Supersedes:** N/A — this is a bugfix for the crossroad stuck-loop, first identified during the pinned-todo-reactivation work.

## 1. Problem

When the LLM's response contains a "turning word" (e.g. `However`, `Wait`, `但`), the **crossroad** mechanism fires: it truncates the response at the turning word, generates an alternative continuation via `forkChat`, and discards the original tool calls (`rawToolCalls = []`). The continuation is merged into the next triologue agent message, nudging the LLM to commit to one direction and regenerate tool calls.

The bug: crossroad **re-fires on every LLM pass** with no cooldown. Because tool calls are always discarded, the LLM never executes any real work, and it keeps producing the same turning-word response. The triologue grows monotonically in length but the content loops — the hint round (confusion threshold 10) is the only escape valve, and it triggers too slowly (~6 consecutive fires) and does not break the loop even when it fires.

### Root Cause

In `src/loop/states/llm.ts`, `handleCrossroad()` is called unconditionally every pass when tools are available. The `MachineEnv.crossroadOccurred` boolean is set to `true` when crossroad fires and `false` when it doesn't — but nothing checks this flag to *skip* detection on the next pass. It only feeds a `+2` confusion bonus for consecutive fires.

## 2. Fix Overview

Repurpose the existing `crossroadOccurred` flag as a **one-pass cooldown gate**:

- When crossroad fires (pass N): set `crossroadOccurred = true` (arm cooldown).
- On the next pass (N+1): if `crossroadOccurred` is true, **skip** `handleCrossroad()` entirely, let the LLM's response pass through unchanged (tool calls preserved), and reset the flag to `false` (cooldown consumed).
- On pass N+2: detection runs normally again. If the LLM still produces turning words, crossroad re-fires.

This changes the loop from `detect → resolve → detect → resolve → ...` (never executes) to `detect → resolve → execute → re-check` (the intended flow).

## 3. Design Decisions

### 3.1 One-pass cooldown (not N-pass)

One pass is the minimum that breaks the infinite loop while preserving the "try once" semantic. After crossroad resolves the direction and injects a synthetic `brief("Resolved my direction...", 7)`, the LLM gets exactly one pass to act on that resolved direction. N-pass cooldown would let the LLM spin for N passes of potentially-wrong tool calls before re-evaluating — there is no use case where that is desirable.

One-pass is **not** made configurable. There is no reason a user would want "let the LLM spin for 3 passes before re-checking," and adding a knob adds surface area for no gain.

### 3.2 Confusion scoring on every fire (not just consecutive)

**BEFORE:** `+2` confusion only added when crossroad fired *and* `crossroadOccurred` was already true (consecutive fire).

**AFTER:** With cooldown, consecutive fires are impossible — `crossroadOccurred` is always `false` when detection runs. The old `if (env.crossroadOccurred) { increaseConfusionIndex(2); }` guard becomes dead code.

The fix changes the `+2` to fire on **every** crossroad fire (unconditional). This keeps the hint escape valve functional:

- Fire → `+2`, Cooldown → `+1` (plan-mode hook scoring), Fire → `+2`, Cooldown → `+1`, ...
- Threshold 10 reached in ~7 passes (3.5 fire+cooldown cycles).
- Each cycle includes a cooldown pass that might break the loop by letting tools execute — so the hint only fires when the LLM is *truly* stuck.

Without this change, a stuck loop would accumulate only `+1`/pass (plan-mode hook scoring on the cooldown pass), taking ~20 passes to reach the hint threshold — too slow.

### 3.3 Flag lifecycle resets

`crossroadOccurred` lives on `MachineEnv` (machine lifetime), so it survives across pass resets within a turn. But it must be cleared at three boundary points to avoid stale cooldown:

| Location | Why |
|----------|-----|
| `prompt.ts` (turn entry) | If a turn ends while cooldown is active (e.g. LLM produces no tool calls → STOP, or ESC), the flag must not bleed into the next user query. |
| `hook.ts` (compact path) | After compaction, the context is fresh — crossroad should be fully active. |
| `llm.ts` (no-tools / neglected mode) | Existing behavior — already resets to `false`. |

The PROMPT reset is added next to the existing `resetConfusionIndex()` calls (three call sites in `prompt.ts`: autonomous skip, bang command, and user query submission).

## 4. State Transition Trace

### Crossroad fires (pass N)

```
COLLECT → LLM
  [detection runs: turning word found]
  [truncate, set crossroadContinuation, rawToolCalls=[], +2 confusion, crossroadOccurred=true]
  → HOOK
    [pass.crossroadContinuation is set → crossroad branch]
    [merge continuation + synthetic brief → triologue.agent + triologue.tool('brief')]
    → COLLECT → LLM
```

### Cooldown pass (pass N+1)

```
COLLECT → LLM
  [crossroadOccurred=true → SKIP detection, reset to false]
  [pass.assistantContent = original LLM content (unchanged, turning words present but ignored)]
  [pass.rawToolCalls = original tool calls (PRESERVED)]
  [pass.crossroadContinuation = undefined]
  → HOOK
    [no crossroadContinuation → skip crossroad branch]
    [section 6: triologue.agent(content, toolCalls) + +1 confusion (plan mode)]
    [hookResult.calls.length > 0 → return TOOL]
  → TOOL
    [tools execute normally]
    → COLLECT → LLM
```

### Pass N+2 (cooldown consumed)

```
COLLECT → LLM
  [crossroadOccurred=false → detection runs normally]
  [if turning words persist → crossroad fires again]
  [if no turning words → normal pass, tools execute]
```

## 5. Files Changed

### 5.1 `src/loop/states/llm.ts` (primary)

Restructure the crossroad block (lines 133–156):

- Wrap `handleCrossroad()` call in an `else` clause.
- Add `if (env.crossroadOccurred) { env.crossroadOccurred = false; }` as the cooldown skip.
- Change `increaseConfusionIndex(2)` from conditional (only when `crossroadOccurred` was already true) to unconditional (on every crossroad fire).

### 5.2 `src/loop/states/prompt.ts` (turn boundary reset)

Add `env.crossroadOccurred = false;` alongside the existing `resetConfusionIndex()` calls at:
- Line 76 (autonomous skip path)
- Line 116 (bang command path)
- Line 143 (user query submission path)

### 5.3 `src/loop/states/hook.ts` (compact reset)

Add `env.crossroadOccurred = false;` alongside the existing `resetConfusionIndex()` at line 282 (compact path).

### 5.4 What does NOT change

- **`hook.ts` crossroad branch (lines 234–258):** Already handles `crossroadContinuation === undefined` by falling through to normal agent registration (section 6). During cooldown, tool calls execute normally via TOOL state.
- **`collect.ts`:** Confusion scoring and hint round work unchanged. Threshold (10) and min messages (6) remain the same.
- **`state-machine.ts`:** `crossroadOccurred` field definition and initialization are already correct.
- **`crossroad.ts`:** Detection logic (`handleCrossroad`, `detectTurningWord`) is untouched.

## 6. Edge Cases

| Case | Handling |
|------|----------|
| LLM pivots twice in a row | Pass 1: fire. Pass 2: cooldown (execute). Pass 3: fire again. One execution pass between pivots — acceptable. |
| Stale flag across turns | Reset at PROMPT entry (§5.2). |
| ESC during cooldown pass | Returns PROMPT; flag reset at next PROMPT entry (§5.2). |
| Compact during cooldown | Reset after compact (§5.3). |
| LLM uses "However" non-turningly | Crossroad skipped entirely during cooldown — no false positive on the cooldown pass. |

## 7. Testing

### 7.1 New test file: `src/tests/loop/states/llm-crossroad-cooldown.test.ts`

Following the mock pattern of `llm-esc-crossroad.test.ts`:

1. **Cooldown skips detection:** Pre-set `crossroadOccurred=true`, verify `handleCrossroad` NOT called, `rawToolCalls` preserved, result is `HOOK`, flag reset to `false`.
2. **Crossroad re-fires after cooldown:** 3-pass loop with same `env` — pass 1 fires, pass 2 skips, pass 3 fires again.
3. **+2 confusion always fires:** Verify `increaseConfusionIndex(2)` called on every crossroad fire (unconditional, not just consecutive).
4. **No tools / neglected mode:** `tools.length===0` resets flag (existing behavior preserved).
5. **Turn boundary reset:** Verify `crossroadOccurred` reset at PROMPT entry.

### 7.2 Existing test impact

No existing tests break:
- "should reset crossroadOccurred when handleCrossroad returns null" — still passes (no crossroad → reset).
- "should apply crossroad result" — still passes (first crossroad fires, `crossroadOccurred` was false).
- No existing test covers `crossroadOccurred=true` + `handleCrossroad returns non-null` (the old consecutive path), so no test needs updating — only new tests added.

### 7.3 Stuck-loop simulation

Mock `retryChat` to always return turning-word content; mock `handleCrossroad` to always return a result; call `handleLlm` in a loop with the same `env` (so `crossroadOccurred` persists across passes). **Before fix:** every pass fires crossroad, `rawToolCalls` always discarded. **After fix:** odd passes fire crossroad, even passes skip and preserve `rawToolCalls`.

## 8. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Cooldown delays hint escape valve | Low | `+2` on every fire (not just consecutive) keeps hint at ~7 passes. Each cycle includes an execution pass that may break the loop. |
| Stale flag across turns | Medium | Reset at PROMPT entry (§5.2). |
| Cooldown hides a genuine second indecision | Low | One-pass cooldown only — the LLM gets one execution pass, then crossroad re-evaluates. |
| Removing conditional `+2` weakens confusion signal | Low | `+2` is now unconditional — strictly stronger signal per fire. |

Overall risk: **Low**. The fix is ~15 lines across 3 files, reuses an existing env-scoped flag, and all downstream states already handle the no-crossroad path (that's the normal case for every pass where no turning word is detected).