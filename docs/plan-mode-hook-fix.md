# Plan Mode Hook Fix - Implementation Plan

## Problem Statement

The `lint-typecheck-after-edit` hook triggers during plan mode (false positive) because hook conditions cannot check if the agent is in plan mode.

**Root Cause:**
- `Core` stores `modeState: 'plan' | 'normal'` but it's not exposed in the `CoreModule` interface
- `Sequence` (used by hook conditions) has no access to mode information
- The hook condition `seq.hasAny(['edit_file', 'write_file']) && !seq.hasCommand('bash#lint') && !seq.hasCommand('bash#typecheck')` cannot check plan mode

**Why It Happens:**
1. HOOK state evaluates conditions BEFORE tools execute
2. Tool calls like `edit_file` are present in the hook evaluation context
3. Even though tools are blocked by plan mode (via `requestGrant`), the hook sees the tool call and triggers
4. This causes unnecessary lint/typecheck injection during planning

## Solution Overview

Add a `seq.isPlanMode()` predicate to the hook condition system so conditions can check if the agent is in plan mode.

## Implementation Plan

### 1. Expose Mode in CoreModule Interface
**File:** `src/types.ts`

Add `getMode()` method to the `CoreModule` interface:

```typescript
export interface CoreModule {
  // ... existing methods ...
  
  /**
   * Get current agent mode ('plan' or 'normal')
   * Used by hooks to prevent false positives during planning
   */
  getMode(): 'plan' | 'normal';
}
```

**Rationale:** This makes mode accessible to all modules that depend on the interface.

### 2. Add Mode Tracking to Sequence
**File:** `src/hook/sequence.ts`

Add a mode getter to the Sequence class:

```typescript
export class Sequence {
  private events: SequenceEvent[] = [];
  private triologue?: Triologue;
  private getMode: () => 'plan' | 'normal';

  constructor(triologue?: Triologue, getMode?: () => 'plan' | 'normal') {
    this.triologue = triologue;
    this.getMode = getMode || (() => 'normal'); // Default to normal mode
  }

  // ... existing methods ...

  /**
   * Check if agent is in plan mode
   * Used by hooks to prevent triggering during planning
   */
  isPlanMode(): boolean {
    return this.getMode() === 'plan';
  }

  /**
   * Evaluate a condition expression against the sequence
   * Add isPlanMode to the evaluation context
   */
  evaluate(expression: string): boolean {
    const ctx: EvalContext = {
      has: (tool: string) => this.has(tool),
      hasAny: (tools: string[]) => this.hasAny(tools),
      hasCommand: (pattern: string) => this.hasCommand(pattern),
      last: (tool?: string) => this.last(tool),
      lastError: () => this.lastError(),
      count: (tool?: string) => this.count(tool),
      since: (tool: string) => this.since(tool),
      sinceEdit: () => this.sinceEdit(),
      isPlanMode: () => this.isPlanMode(),  // NEW
    };

    return evaluateExpression(expression, ctx);
  }
}
```

### 3. Update Sequence Instantiation
**File:** `src/loop/agent-repl.ts`

Pass the mode getter when creating the Sequence:

```typescript
// Around line 200-203
const core = ctx.core as Core;
const sequence = new Sequence(triologue, () => core.getMode());
```

**Note:** Need to cast `ctx.core` to `Core` to access `getMode()` since it's now in the interface.

### 4. Update EvalContext Interface
**File:** `src/hook/evaluator.ts`

Add `isPlanMode` to the EvalContext interface:

```typescript
export interface EvalContext {
  has: (tool: string) => boolean;
  hasAny: (tools: string[]) => boolean;
  hasCommand: (pattern: string) => boolean;
  last: (tool?: string) => unknown;
  lastError: () => unknown;
  count: (tool?: string) => number;
  since: (tool: string) => unknown[];
  sinceEdit: () => unknown[];
  isPlanMode: () => boolean;  // NEW
}
```

### 5. Update Evaluator Preprocessing
**File:** `src/hook/evaluator.ts`

Update the `evaluateExpression` function to handle `seq.isPlanMode()`:

```typescript
export function evaluateExpression(expression: string, ctx: EvalContext): boolean {
  try {
    // Preprocess: replace seq.X with X
    const jsExpr = expression
      .replace(/seq\.has\(/g, 'has(')
      .replace(/seq\.hasAny\(/g, 'hasAny(')
      .replace(/seq\.hasCommand\(/g, 'hasCommand(')
      .replace(/seq\.last\(/g, 'last(')
      .replace(/seq\.lastError\(/g, 'lastError(')
      .replace(/seq\.count\(/g, 'count(')
      .replace(/seq\.since\(/g, 'since(')
      .replace(/seq\.sinceEdit\(/g, 'sinceEdit(')
      .replace(/seq\.isPlanMode\(/g, 'isPlanMode(');  // NEW

    // ... rest of function
  }
}
```

### 6. Update the Hook Skill
**File:** `skills/lint-typecheck-after-edit.md`

Update the compiled condition to exclude plan mode:

```markdown
When: before LLM finishes reply (no tool calls pending), if edit_file or write_file was used this session and lint/typecheck was not run and NOT in plan mode
```

**Compiled condition:**
```
seq.hasAny(['edit_file', 'write_file']) && !seq.hasCommand('bash#lint') && !seq.hasCommand('bash#typecheck') && !seq.isPlanMode()
```

### 7. Recompile the Skill
**Tool call:** `skill_compile(name="lint-typecheck-after-edit")`

After making the code changes, recompile the skill to update the compiled condition in the condition registry.

### 8. Update Tests
**File:** `src/tests/sequence.test.ts`

Add tests for the new `isPlanMode()` functionality:

```typescript
describe('seq.isPlanMode()', () => {
  it('should return false when mode getter not provided', () => {
    const seq = new Sequence();
    expect(seq.isPlanMode()).toBe(false);
  });

  it('should return true when mode getter returns plan', () => {
    const seq = new Sequence(undefined, () => 'plan');
    expect(seq.isPlanMode()).toBe(true);
  });

  it('should return false when mode getter returns normal', () => {
    const seq = new Sequence(undefined, () => 'normal');
    expect(seq.isPlanMode()).toBe(false);
  });
});

describe('Sequence.evaluate() with isPlanMode', () => {
  it('should evaluate seq.isPlanMode() expression', () => {
    const seq = new Sequence(undefined, () => 'plan');
    expect(seq.evaluate('seq.isPlanMode()')).toBe(true);
  });

  it('should use isPlanMode in complex conditions', () => {
    const seq = new Sequence(undefined, () => 'plan');
    seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });
    
    // Should NOT trigger in plan mode
    expect(seq.evaluate('seq.has("edit_file") && !seq.isPlanMode()')).toBe(false);
  });

  it('should allow hook in normal mode', () => {
    const seq = new Sequence(undefined, () => 'normal');
    seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });
    
    // Should trigger in normal mode
    expect(seq.evaluate('seq.has("edit_file") && !seq.isPlanMode()')).toBe(true);
  });
});
```

## Implementation Order

1. **src/types.ts** - Add `getMode()` to CoreModule interface (no breaking changes)
2. **src/hook/evaluator.ts** - Add `isPlanMode` to EvalContext interface
3. **src/hook/sequence.ts** - Add mode getter and `isPlanMode()` method
4. **src/loop/agent-repl.ts** - Pass mode getter to Sequence constructor
5. **src/tests/sequence.test.ts** - Add tests for isPlanMode
6. **skills/lint-typecheck-after-edit.md** - Update the skill description/when clause
7. **skill_compile** - Recompile the skill to update the compiled condition

## Testing Strategy

1. **Unit tests:** Test Sequence.isPlanMode() with different mode getters
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