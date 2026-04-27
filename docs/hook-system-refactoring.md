# Hook System Refactoring

## Overview

This document describes the refactored hook system that processes LLM tool calls with metadata augmentation and array-level manipulation.

## Problem Statement

The original hook implementation had several issues:

1. **One-by-one iteration**: Hooks processed each tool call individually in a loop with `i = -1` restart pattern
2. **Scattered logic**: Hook processing was inline in agent-loop.ts (two separate locations)
3. **No metadata access**: Hooks could only evaluate against sequence history, not the current call's arguments
4. **Implicit delta manipulation**: Array mutation and loop restarts were hard to follow

## Architecture

### Data Flow

```
LLM response → ToolCall[]
           → augmentToolCalls() (add metadata)
           → processToolCalls() (array-level hook processing)
           → Execute resulting calls
```

### Augmentation Step (agent-loop.ts)

Before hooks process tool calls, each call is augmented with metadata:

```typescript
interface AugmentedToolCall extends ToolCall {
  metadata?: {
    filePath?: string;
    isTestFile?: boolean;
    newLoc?: number;
    existingLoc?: number;
    isDestructive?: boolean;
    [key: string]: unknown;
  };
}
```

**Metadata computed:**
- `filePath`: Target file path (for write_file, edit_file)
- `isTestFile`: Whether the file is a test file (.test. or .spec. in name)
- `newLoc`: Lines of code in the new content
- `existingLoc`: Lines of code in existing file
- `isDestructive`: Whether bash command is destructive (rm -rf, git push --force, etc.)

### Hook Processing (HookExecutor.processToolCalls)

```typescript
interface ProcessToolCallsResult {
  calls: AugmentedToolCall[];       // Modified array
  blockedCalls: Map<string, string>; // toolCall.id → rejection message
  deferredMessages: string[];        // Messages to inject after execution
}
```

**Processing steps:**
1. For each call, find matching hooks via `checkHooks(toolName)`
2. Group hooks by priority: blockers (0) → replacers (1) → injectors (2) → messages (3)
3. Evaluate conditions with both `seq.*` (history) and `call.metadata.*` (current)
4. Execute actions in priority order, first wins within each group

### Hook Actions

| Action | Effect | Priority |
|--------|--------|----------|
| `block` | Keep call in array, return rejection message when executed | 0 |
| `replace` | Replace call with modified version | 1 |
| `inject_before` | Insert call before target | 2 |
| `inject_after` | Insert call after target | 2 |
| `message` | Collect message for deferred injection | 3 |

**Important**: Blocked calls are NOT removed from the array. They stay visible so the LLM sees what was attempted and learns from the rejection.

## Condition Syntax

Conditions can reference both sequence history and current call metadata:

```yaml
# Sequence functions
seq.has('edit_file')
seq.hasAny(['edit_file', 'write_file'])
seq.hasCommand('bash#lint')
seq.last().args.command
seq.count('bash') > 3

# Call metadata (NEW)
call.metadata.isTestFile
call.metadata.newLoc > 300
call.metadata.isDestructive
call.args.command.includes('main')
```

## Example: Test File LOC Limit

**Skill definition** (`.mycc/skills/test-file-loc-limit.md`):
```yaml
---
name: test-file-loc-limit
description: Block test files that exceed 300 lines of code
when: before write_file to test files, if newLoc > 300
---

Test files should be focused and concise. Large test files are harder to maintain.
```

**Compiled condition** (`.mycc/conditions.json`):
```json
{
  "test-file-loc-limit": {
    "trigger": "write_file",
    "condition": "call.metadata.isTestFile && call.metadata.newLoc > 300",
    "action": { "type": "block" }
  }
}
```

**Flow:**
1. LLM calls `write_file` with a 350-line test file
2. `augmentToolCalls()` computes: `metadata.isTestFile = true`, `metadata.newLoc = 350`
3. `processToolCalls()` evaluates condition → `true`
4. Hook blocks, adds call to `blockedCalls` with rejection message
5. Agent-loop executes: sees blocked call, returns rejection message
6. LLM sees blocked call + rejection, learns not to write large test files

## Key Files

| File | Purpose |
|------|---------|
| `src/context/shared/hooks.ts` | `HookExecutor` class with `processToolCalls()` |
| `src/context/shared/conditions.ts` | Condition compilation with `call.metadata.*` support |
| `src/context/shared/condition-validator.ts` | Expression validation for `call.*` syntax |
| `src/loop/agent-loop.ts` | `augmentToolCalls()` and caller logic |

## Safety

The condition validator ensures only safe expressions are allowed:

- Only `seq.X()` and `call.metadata.X` / `call.args.X` access
- Dangerous identifiers blocked: `eval`, `Function`, `require`, `process`, `fs`, etc.
- Dangerous property access blocked: `constructor`, `__proto__`, etc.
- String methods allowed: `includes`, `indexOf`, `startsWith`, etc.

## Benefits

1. **Array-level processing**: Eliminates `i = -1` restart pattern
2. **Metadata access**: Hooks can inspect current call's arguments
3. **Clean abstraction**: `processToolCalls(array) → { array, blocked, messages }`
4. **Unified handling**: Stop hooks and pre-tool hooks use the same method
5. **Visible rejections**: Blocked calls stay visible for LLM learning
6. **Testable**: Hook processing isolated in `HookExecutor`