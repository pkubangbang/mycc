# Plan Mode Hook Fix - Implementation Status

> **Status**: Implemented. `seq.isPlanMode()` is available in the hook condition system. See `src/hook/sequence.ts`, `src/hook/condition-validator.ts`, and `src/hook/evaluator.ts`.

## Problem Statement

The `lint-typecheck-after-edit` hook triggers during plan mode (false positive) because hook conditions cannot check if the agent is in plan mode.

**Root Cause:**
- `Core` stores `modeState: 'plan' | 'normal'` but it's not exposed in the `CoreModule` interface
- `Sequence` (used by hook conditions) has no access to mode information
- The hook condition `seq.hasAny(['edit_file', 'write_file']) && seq.lastIndexOf('bash#lint') == -1 && seq.lastIndexOf('bash#typecheck') == -1` cannot check plan mode

**Why It Happens:**
1. HOOK state evaluates conditions BEFORE tools execute
2. Tool calls like `edit_file` are present in the hook evaluation context
3. Even though tools are blocked by plan mode (via `requestGrant`), the hook sees the tool call and triggers
4. This causes unnecessary lint/typecheck injection during planning

## Solution (Shipped)

Added a `seq.isPlanMode()` predicate to the hook condition system so conditions can check if the agent is in plan mode.

### What Was Implemented

1. **`src/types.ts`** — `getMode(): 'plan' | 'normal'` added to the `CoreModule` interface.

2. **`src/hook/sequence.ts`** — `Sequence` class has a `getMode` getter (defaults to `() => 'normal'`) and an `isPlanMode()` method. The `evaluate()` method includes `isPlanMode` in the evaluation context.

3. **`src/hook/evaluator.ts`** — `EvalContext` interface includes `isPlanMode: () => boolean`. The `evaluateExpression` function preprocesses `seq.isPlanMode(` → `isPlanMode(`.

4. **`src/hook/condition-validator.ts`** — `isPlanMode` added to the `ConditionContext` interface and `SEQ_FUNCTIONS` list. Validation, evaluation, and the no-op fallback all handle `isPlanMode`.

5. **`src/hook/conditions.ts`** — Documents `seq.isPlanMode()` in the condition function reference.

6. **`src/loop/agent-repl.ts`** — Passes the mode getter to the `Sequence` constructor.

7. **`skills/lint-typecheck-after-edit.md`** — The compiled condition includes `&& !seq.isPlanMode()`.

## Implementation Plan

### Implementation Details

The implementation differs slightly from the original plan in file organization. The plan called for changes in `src/hook/evaluator.ts` and `src/hook/sequence.ts`; the shipped code also updated `src/hook/condition-validator.ts` (which handles condition validation and the no-op fallback context). The `SEQ_FUNCTIONS` array in `condition-validator.ts` includes `'isPlanMode'`, ensuring the validator recognizes the function in conditions.

### Skill Condition

The `lint-typecheck-after-edit` skill's compiled condition includes `&& !seq.isPlanMode()` to prevent triggering during planning.

## Testing Strategy

1. **Unit tests:** Test `Sequence.isPlanMode()` with different mode getters
2. **Integration test:** Test that the hook doesn't trigger in plan mode
3. **Manual test:** 
   - Enter plan mode with `plan_on`
   - Attempt to edit a file (should fail)
   - Verify no lint/typecheck injection happens

## Benefits

1. **Fixes false positive:** Hook won't trigger during planning
2. **Extensible:** Other hooks can now use `seq.isPlanMode()` if needed
3. **Minimal changes:** Only exposes what's needed, doesn't refactor the whole system
4. **Type-safe:** Mode getter is typed and validated

## Alternative Approaches Considered

### Alternative 1: Check Mode in Tool Handlers
Add mode check in `edit_file` and `write_file` handlers before they're added to sequence.
- **Rejected:** Too late in the pipeline - hooks check conditions before tools execute.

### Alternative 2: Add Mode to AugmentedToolCall
Add mode metadata to each tool call in the hook system.
- **Rejected:** Mode is session-level, not call-level. Would duplicate data unnecessarily.

### Alternative 3: Block Hooks for Plan Mode in HookExecutor
Short-circuit all hooks when in plan mode.
- **Rejected:** Some hooks might still be useful in plan mode (e.g., logging, validation). Let each hook decide via its condition.

## Conclusion

This solution provides a clean, minimal way to bridge the gap between the Core's mode state and the Sequence's hook condition evaluation. By adding `seq.isPlanMode()`, we enable hooks to make intelligent decisions about whether to trigger based on the agent's operational mode.