# Plan Mode Implementation Plan

## Overview

This document describes the implementation of **plan mode** - a session-scoped state that blocks code modification tools when active. This allows users to have the agent focus on planning and analysis without accidentally modifying code.

## Goals

1. Add a session-scoped mode state (`'plan'` | `'normal'`) stored in `ctx.core`
2. Create a tool (`mode_set`) to switch between modes
3. Create a hookish skill that blocks code modifications when in plan mode
4. Extend the condition language to support `session.getMode()`

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        User Interface Layer                          │
├─────────────────────────────────────────────────────────────────────┤
│  mode_set tool                                                       │
│  - User calls: mode_set(mode: 'plan' | 'normal')                    │
│  - Returns: "Mode set to 'plan'" or "Mode set to 'normal'"          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Core Module Layer                            │
├─────────────────────────────────────────────────────────────────────┤
│  CoreModule interface (types.ts)                                     │
│  - getMode(): 'plan' | 'normal'                                     │
│  - setMode(mode: 'plan' | 'normal'): void                           │
│                                                                      │
│  Core (parent/core.ts) - Main process                               │
│  - private mode: 'plan' | 'normal' = 'normal'                       │
│  - getMode() / setMode() implementation                              │
│                                                                      │
│  ChildCore (child/core.ts) - Child process                          │
│  - IPC calls to parent for getMode/setMode                           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Hook System Layer                             │
├─────────────────────────────────────────────────────────────────────┤
│  Condition evaluation (conditions.ts)                                │
│  - Extended to support session.getMode()                             │
│  - session object passed to condition evaluator                      │
│                                                                      │
│  plan-mode skill (.mycc/skills/plan-mode.md)                        │
│  - when: "block code changes when in plan mode"                      │
│  - trigger: '*'                                                      │
│  - condition: "session.getMode() === 'plan' && isCodeModification"  │
│  - action: { type: 'block', reason: '...' }                          │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

### Step 1: Update CoreModule Interface

**File**: `src/types.ts`

**Changes**:
```typescript
export interface CoreModule {
  getWorkDir(): string;
  setWorkDir(dir: string): void;
  getName(): string;
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string, detail?: string): void;
  verbose(tool: string, message: string, data?: unknown): void;
  question(query: string, asker: string): Promise<string>;
  webSearch(query: string): Promise<WebSearchResult[]>;
  webFetch(url: string): Promise<WebFetchResponse>;
  imgDescribe(image: string, prompt?: string): Promise<string>;
  
  // NEW: Session mode management
  getMode(): 'plan' | 'normal';
  setMode(mode: 'plan' | 'normal'): void;
}
```

### Step 2: Implement Mode in Core (Parent Process)

**File**: `src/context/parent/core.ts`

**Changes**:
```typescript
export class Core implements CoreModule {
  private workDir: string;
  private mode: 'plan' | 'normal' = 'normal';  // NEW

  // ... existing methods ...

  /**
   * Get current session mode
   * @returns 'plan' or 'normal'
   */
  getMode(): 'plan' | 'normal' {
    return this.mode;
  }

  /**
   * Set session mode
   * @param mode - 'plan' or 'normal'
   */
  setMode(mode: 'plan' | 'normal'): void {
    this.mode = mode;
    this.brief('info', 'mode', `Mode changed to '${mode}'`);
  }
}
```

### Step 3: Implement Mode in ChildCore (Child Process)

**File**: `src/context/child/core.ts`

**Changes**:
```typescript
export class ChildCore implements CoreModule {
  private workDir: string;
  private name: string;

  // ... existing methods ...

  /**
   * Get current session mode via IPC
   */
  getMode(): 'plan' | 'normal' {
    // Synchronous IPC request to parent
    const response = ipc.sendRequestSync<{ mode: 'plan' | 'normal' }>('core_mode_get', {});
    return response.mode;
  }

  /**
   * Set session mode via IPC
   */
  setMode(mode: 'plan' | 'normal'): void {
    ipc.sendRequestSync('core_mode_set', { mode });
  }
}
```

### Step 4: Add IPC Handlers in ParentContext

**File**: `src/context/parent-context.ts`

**Changes**: Add handlers to `initializeIpcHandlers()`:

```typescript
// Mode handlers
{
  messageType: 'core_mode_get',
  module: 'core',
  handler: async (_sender, _payload, ctx, sendResponse) => {
    const mode = ctx.core.getMode();
    sendResponse('core_mode_result', true, { mode });
  },
},
{
  messageType: 'core_mode_set',
  module: 'core',
  handler: async (_sender, payload, ctx, sendResponse) => {
    const { mode } = payload as { mode: 'plan' | 'normal' };
    ctx.core.setMode(mode);
    sendResponse('core_mode_result', true);
  },
},
```

### Step 5: Add Sync IPC Support (if needed)

**File**: `src/context/child/ipc-helpers.ts`

If synchronous IPC doesn't exist, add it:

```typescript
/**
 * Synchronous IPC request (for getMode which must return immediately)
 */
export function sendRequestSync<T>(type: string, payload: Record<string, unknown>): T {
  // For mode, we can cache it locally since it rarely changes
  // Or implement true sync IPC
}
```

**Alternative**: Cache mode in ChildCore to avoid sync IPC:

```typescript
export class ChildCore implements CoreModule {
  private mode: 'plan' | 'normal' = 'normal';  // Cached locally
  
  getMode(): 'plan' | 'normal' {
    return this.mode;
  }
  
  setMode(mode: 'plan' | 'normal'): void {
    this.mode = mode;
    ipc.sendRequest('core_mode_set', { mode });  // Async notify parent
  }
}
```

### Step 6: Create mode_set Tool

**File**: `.mycc/tools/mode_set.ts`

```typescript
/**
 * mode_set.ts - Switch between plan mode and normal mode
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../../types.js';

export const modeSetTool: ToolDefinition = {
  name: 'mode_set',
  description: `Switch between plan mode and normal mode.

In PLAN MODE:
- Code modifications are blocked (edit_file, write_file, git_commit)
- Team spawning is blocked (tm_create)
- Use for planning, analysis, and architecture decisions

In NORMAL MODE:
- All tools are available
- Default mode for implementation work

Use this tool to control whether the session allows code changes.`,
  input_schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['plan', 'normal'],
        description: 'The mode to switch to',
      },
    },
    required: ['mode'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const mode = args.mode as 'plan' | 'normal';

    if (mode !== 'plan' && mode !== 'normal') {
      ctx.core.brief('error', 'mode_set', `Invalid mode: ${mode}`);
      return `Error: mode must be 'plan' or 'normal', got '${mode}'`;
    }

    const previousMode = ctx.core.getMode();
    ctx.core.setMode(mode);

    ctx.core.brief('info', 'mode_set', `Mode changed from '${previousMode}' to '${mode}'`);

    if (mode === 'plan') {
      return `Mode set to 'plan'. Code modifications are now BLOCKED.\n\nYou can:\n- Read files (read_file)\n- Run non-destructive commands (bash)\n- Create issues (issue_create)\n- Plan and document\n\nYou cannot:\n- Edit files (edit_file, write_file)\n- Commit changes (git_commit)\n- Spawn teammates (tm_create)\n\nUse mode_set({ mode: 'normal' }) to enable code changes.`;
    } else {
      return `Mode set to 'normal'. All tools are now available.\n\nYou can:\n- Modify code (edit_file, write_file)\n- Commit changes (git_commit)\n- Spawn teammates (tm_create)\n\nUse mode_set({ mode: 'plan' }) to block code changes during planning.`;
    }
  },
};
```

### Step 7: Register Tool in .mycc/tools/index.ts

**File**: `.mycc/tools/index.ts`

```typescript
import { modeSetTool } from './mode_set.js';

export const myccTools = [
  // ... existing tools
  new modeSetTool(),  // or however tools are registered
];
```

### Step 8: Extend Condition Evaluation

**File**: `src/hook/conditions.ts`

**Changes**: Add session parameter to condition evaluation:

```typescript
/**
 * Evaluate a condition expression against sequence, call metadata, and session.
 */
private evaluateCondition(
  condition: string,
  call: AugmentedToolCall,
  session: { getMode: () => string }  // NEW
): boolean {
  try {
    const seq = this.sequence;
    const callContext = {
      metadata: call.metadata || {},
      args: call.function.arguments,
    };

    // Create session context for condition evaluation
    const sessionContext = {
      getMode: () => session.getMode(),
    };

    // Transform condition
    const expr = condition
      .replace(/call\.metadata\./g, 'callContext.metadata.')
      .replace(/call\.args\./g, 'callContext.args.')
      .replace(/call\.args\b/g, 'callContext.args')
      .replace(/session\.getMode\(\)/g, 'sessionContext.getMode()');

    // Evaluate
    const fn = new Function('seq', 'callContext', 'sessionContext', `return ${expr}`);
    return fn(seq, callContext, sessionContext);
  } catch {
    return false;
  }
}
```

### Step 9: Extend ConditionValidator

**File**: `src/hook/condition-validator.ts`

**Changes**: Add `session` to allowed roots:

```typescript
// Allowed root identifiers (besides seq)
const ALLOWED_ROOTS = ['seq', 'call', 'session'];  // Added 'session'
```

**Changes**: Update testExpression:

```typescript
export function testExpression(
  expression: string,
  sequence: TestableSequence,
  callContext?: { metadata?: Record<string, unknown>; args?: Record<string, unknown> },
  sessionContext?: { getMode: () => string }  // NEW
): TestResult {
  // ... existing code ...

  const session = sessionContext || {
    getMode: () => 'normal',
  };

  const fn = new Function(
    'has', 'hasAny', 'hasCommand', 'last', 'lastError', 'count', 'since', 'sinceEdit', 'call', 'session',
    `"use strict"; return (${jsExpr});`
  );

  const result = fn(
    seqCtx.has, seqCtx.hasAny, seqCtx.hasCommand, seqCtx.last, seqCtx.lastError,
    seqCtx.count, seqCtx.since, seqCtx.sinceEdit, call, session
  );

  return { passed: true, evaluatedValue: Boolean(result) };
}
```

### Step 10: Create plan-mode Hook Skill

**File**: `.mycc/skills/plan-mode.md`

```markdown
---
name: plan-mode
description: >
  Block code modifications when in plan mode.
  
  When the session is in 'plan' mode, this hook blocks:
  - edit_file, write_file (file modifications)
  - git_commit (version control changes)
  - tm_create (team spawning)
  
  Allows all other tools for planning and analysis.
  
keywords: [plan, mode, block, code, changes, implementation]
when: block all code modifications when session is in plan mode
---

# Plan Mode Hook

You are in **PLAN MODE**. Code modifications are blocked.

## Allowed Tools

✅ **Planning & Analysis**:
- `read_file` - Read existing code
- `bash` - Run non-destructive commands (grep, find, ls)
- `issue_create`, `issue_claim`, `issue_close` - Task management
- `todo_write` - Track todos
- `wiki_get`, `wiki_prepare`, `wiki_put` - Knowledge management

✅ **Research**:
- `web_search`, `web_fetch` - Search documentation
- `skill_load` - Load specialized knowledge
- `question` - Ask user clarifying questions

✅ **Communication**:
- `brief` - Update user on progress
- `mail_to`, `broadcast` - Team communication

## Blocked Tools

❌ **Code Modifications**:
- `edit_file` - Blocked
- `write_file` - Blocked
- `git_commit` - Blocked

❌ **Team Spawning**:
- `tm_create` - Blocked (plan phase doesn't spawn workers)

## Switching Modes

To enable code modifications:
```
mode_set({ mode: 'normal' })
```

To return to planning:
```
mode_set({ mode: 'plan' })
```
```

### Step 11: Add Slash Command /mode

**File**: `src/slashes/mode.ts`

```typescript
/**
 * /mode command - View or change session mode
 *
 * Usage:
 *   /mode         - Show current mode
 *   /mode plan    - Switch to plan mode (blocks code changes)
 *   /mode normal  - Switch to normal mode (allows code changes)
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

export const modeCommand: SlashCommand = {
  name: 'mode',
  description: 'View or change session mode (plan/normal)',
  handler: (context) => {
    const args = context.args;
    const ctx = context.ctx;

    // No argument - show current mode
    if (args.length === 0) {
      const currentMode = ctx.core.getMode();
      console.log(chalk.cyan('\n=== Session Mode ===\n'));
      console.log(`Current mode: ${chalk.yellow(currentMode)}`);
      console.log();
      if (currentMode === 'plan') {
        console.log(chalk.yellow('Plan mode is active.'));
        console.log(chalk.gray('Code modifications are BLOCKED:'));
        console.log(chalk.gray('  - edit_file, write_file'));
        console.log(chalk.gray('  - git_commit'));
        console.log(chalk.gray('  - tm_create'));
        console.log();
        console.log(chalk.green('Use /mode normal to enable code changes.'));
      } else {
        console.log(chalk.green('Normal mode is active.'));
        console.log(chalk.gray('All tools are available.'));
        console.log();
        console.log(chalk.yellow('Use /mode plan to block code changes during planning.'));
      }
      console.log();
      return;
    }

    // Parse mode argument
    const mode = args[0].toLowerCase();

    if (mode !== 'plan' && mode !== 'normal') {
      console.log(chalk.red(`Invalid mode: ${mode}`));
      console.log(chalk.gray('Valid modes: plan, normal'));
      console.log();
      console.log(chalk.gray('  /mode plan   - Block code changes'));
      console.log(chalk.gray('  /mode normal - Allow code changes'));
      return;
    }

    const previousMode = ctx.core.getMode();
    ctx.core.setMode(mode as 'plan' | 'normal');

    console.log(chalk.cyan('\n=== Mode Changed ===\n'));
    console.log(`Previous: ${chalk.gray(previousMode)}`);
    console.log(`Current:  ${chalk.yellow(mode)}`);
    console.log();

    if (mode === 'plan') {
      console.log(chalk.yellow('Plan mode is now active.'));
      console.log(chalk.gray('Code modifications are BLOCKED.'));
      console.log();
      console.log(chalk.gray('Use /mode normal or mode_set({ mode: "normal" }) to enable code changes.'));
    } else {
      console.log(chalk.green('Normal mode is now active.'));
      console.log(chalk.gray('All tools are available.'));
      console.log();
      console.log(chalk.gray('Use /mode plan or mode_set({ mode: "plan" }) to block code changes.'));
    }
    console.log();
  },
};
```

### Step 12: Register Slash Command

**File**: `src/slashes/index.ts`

Add import and registration:

```typescript
import { modeCommand } from './mode.js';

// ... existing registrations ...
slashRegistry.register(modeCommand);
```

### Step 13: Add Explicit Blocking Log

**File**: `src/hook/hook-executor.ts`

Update the `block` method to log explicitly when blocking due to plan mode:

```typescript
/**
 * Block the trigger tool
 */
private async block(
  skillName: string,
  action: { type: 'block'; reason?: string },
  skillContent: string
): Promise<HookResult> {
  const reason = action.reason || skillContent.slice(0, 200);

  // Explicit log for plan mode blocking
  if (skillName === 'plan-mode') {
    ctx.core.brief('warn', 'plan-mode', 
      '🚫 Tool blocked - Plan mode is active', 
      'Use mode_set({ mode: "normal" }) or /mode normal to enable code changes'
    );
  } else {
    ctx.core.brief('warn', 'hook', `[${skillName}] Blocked tool execution`, reason.slice(0, 100));
  }

  return {
    action: 'blocked',
    message: `[Hook: ${skillName}] Blocked: ${reason}`,
  };
}
```

Update the `block` method signature to accept `ctx`:

```typescript
private async block(
  skillName: string,
  action: { type: 'block'; reason?: string },
  ctx: AgentContext,  // ADD ctx parameter
  skillContent: string
): Promise<HookResult> {
  // ... implementation
}
```

And update all call sites in `execute()` method:

```typescript
case 'block':
  return this.block(skillName, action, ctx, skillContent);  // Pass ctx
```

### Step 11: Compile the Hook Skill

After creating the skill file, compile it:

```typescript
// Use skill_compile tool
skill_compile(name="plan-mode")
```

Expected compiled condition (`conditions.json`):
```json
{
  "plan-mode": {
    "trigger": "*",
    "when": "block all code modifications when session is in plan mode",
    "condition": "session.getMode() === 'plan' && ['edit_file', 'write_file', 'git_commit', 'tm_create'].includes(call.tool)",
    "action": {
      "type": "block",
      "reason": "Plan mode is active. Code modifications are blocked. Use mode_set({ mode: 'normal' }) or /mode normal to enable code changes."
    },
    "version": 1
  }
}
```

### Step 12: Update Hook Executor

**File**: `src/hook/hook-executor.ts`

**Changes**: Pass session to condition evaluation:

```typescript
async processToolCalls(
  calls: AugmentedToolCall[],
  ctx: AgentContext,
  getSkill: (name: string) => { content?: string } | undefined
): Promise<ProcessToolCallsResult> {
  // ... existing code ...

  // Pass ctx.core as session context
  const sessionContext = {
    getMode: () => ctx.core.getMode(),
  };

  for (const call of calls) {
    const processResult = await this.processSingleCall(call, ctx, getSkill, sessionContext);
    // ...
  }
}

private async processSingleCall(
  call: AugmentedToolCall,
  ctx: AgentContext,
  getSkill: (name: string) => { content?: string } | undefined,
  sessionContext: { getMode: () => string }  // NEW
): Promise<CallProcessResult> {
  // ... existing code ...
  
  if (!this.evaluateCondition(cond.condition, call, sessionContext)) {
    continue;
  }
  
  // ...
}
```

## Testing Plan

### Unit Tests

1. **Core Module Tests**:
   - Test `getMode()` returns `'normal'` by default
   - Test `setMode('plan')` changes mode
   - Test `setMode('normal')` changes back

2. **IPC Tests** (for child process):
   - Test `ChildCore.getMode()` returns cached value
   - Test `ChildCore.setMode()` updates parent

3. **Condition Tests**:
   - Test `session.getMode() === 'plan'` evaluates correctly
   - Test combined condition with call.tool check

### Integration Tests

1. **Mode Switching**:
   ```
   mode_set({ mode: 'plan' })  → "Mode set to 'plan'"
   ctx.core.getMode()           → 'plan'
   mode_set({ mode: 'normal' }) → "Mode set to 'normal'"
   ctx.core.getMode()           → 'normal'
   ```

2. **Hook Blocking**:
   ```
   # In plan mode
   mode_set({ mode: 'plan' })
   edit_file({ ... })           → Blocked with message
   
   # In normal mode
   mode_set({ mode: 'normal' })
   edit_file({ ... })           → Allowed
   ```

3. **Skill Compilation**:
   ```
   skill_compile({ name: 'plan-mode' })
   → Creates condition with session.getMode()
   ```

## Files Changed

| File | Changes |
|------|---------|
| `src/types.ts` | Add `getMode()`/`setMode()` to `CoreModule` |
| `src/context/parent/core.ts` | Implement mode property |
| `src/context/child/core.ts` | Implement mode with IPC or cache |
| `src/context/parent-context.ts` | Add IPC handlers for mode |
| `src/context/child/ipc-helpers.ts` | (Optional) Add sync IPC |
| `.mycc/tools/mode_set.ts` | New tool for mode switching |
| `.mycc/tools/index.ts` | Register mode_set tool |
| `src/slashes/mode.ts` | **NEW** Slash command `/mode` |
| `src/slashes/index.ts` | Register mode slash command |
| `src/hook/conditions.ts` | Add session to condition evaluation |
| `src/hook/condition-validator.ts` | Allow `session` in expressions |
| `src/hook/hook-executor.ts` | Pass session context to evaluator, **add explicit blocking log** |
| `.mycc/skills/plan-mode.md` | Hook skill definition |
| `src/hook/sequence.ts` | (No changes needed) |

## Summary

This implementation adds:

1. **Session-scoped mode state** in `CoreModule`
2. **Tool for switching modes** (`mode_set`)
3. **Hook skill** that blocks code modifications in plan mode
4. **Extended condition language** to support `session.getMode()`

The design is minimal, focused, and follows existing patterns in the codebase.