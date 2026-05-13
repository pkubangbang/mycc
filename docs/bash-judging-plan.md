# Bash Judging Plan: Intent Language and Mode Safety

## Overview

Improve the bash tool behavior to ensure no unintended changes are made in plan mode. The solution uses a structured intent language and a 5-step judging process.

## Intent Language Specification

```
VERB OBJECT TO PURPOSE
```

**Note:** OBJECT is NOT wrapped in brackets - only VERB is.

### VERB (Action Category)

| Verb | Meaning | Plan Mode | Examples |
|------|---------|-----------|----------|
| `READ` | Observe without changing | ✅ Allow | `cat`, `ls`, `grep`, `git status` |
| `WRITE` | Create new content | ❌ Block | Create new file, write output |
| `EDIT` | Modify existing content | ❌ Block | Edit existing file |
| `DELETE` | Remove content | ❌ Block | `rm file`, `git clean` |
| `BUILD` | Compile/build artifacts | ❌ Block | `npm run build`, `make` |
| `TEST` | Run tests | ✅ Allow | `npm test`, `pytest` |
| `INSTALL` | Add dependencies | ❌ Block | `npm install`, `pip install` |
| `RUN` | Unknown/generic | ⚠️ Judge | Fallback for ambiguous cases |

### OBJECT (Target Domain)

| Object | Meaning |
|--------|---------|
| `SOURCE` | Source code files (.ts, .js, .py, etc.) |
| `CONFIG` | Configuration files (.env, package.json, tsconfig.json) |
| `DEPENDENCY` | External packages (node_modules/, venv/) |
| `ARTIFACT` | Build outputs (dist/, build/, *.o) |
| `SYSTEM` | System operations (processes, network, environment) |
| `DATA` | Data files, databases, logs (*.json, *.db, *.log) |
| `TEMP` | Temporary/ephemeral files (/tmp/*, .cache/) |

### PURPOSE (Required)

A brief explanation of why this action is needed. Forces explicit reasoning.

### Examples

```
[READ] SOURCE path=package.json TO check available scripts
[READ] CONFIG TO understand the codebase structure before planning
[WRITE] SOURCE path=src/utils.ts TO create utility functions
[EDIT] SOURCE path=src/index.ts TO add new feature implementation
[DELETE] ARTIFACT path=dist/ TO clean build outputs
[BUILD] ARTIFACT TO compile TypeScript to JavaScript
[TEST] SOURCE TO verify the implementation works correctly
[INSTALL] DEPENDENCY name=express TO add web framework
[RUN] SYSTEM command=ps aux TO check running processes
```

## 5-Step Bash Judging Logic

```
┌─────────────────────────────────────────────────────────────┐
│                    BASH JUDGING FLOW                         │
└─────────────────────────────────────────────────────────────┘

Input: command, intent, mode, isChildProcess

┌─────────────────────────────────────────────────────────────┐
│ Step 1: DANGEROUS COMMAND CHECK (Pattern Matching)          │
│ - rm -rf /, sudo rm, mkfs, dd if=, git commit, etc.         │
│ → BLOCK immediately (no LLM, no IPC)                       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼ Not dangerous
┌─────────────────────────────────────────────────────────────┐
│ Step 2: INTENT GRAMMAR CHECK                                │
│ - Parse intent: VERB OBJECT ... TO PURPOSE           │
│ - Validate VERB is known                                    │
│ - Validate OBJECT is known                                  │
│ - Validate PURPOSE exists                                   │
│ → INVALID: Return error with hint for LLM to retry         │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼ Valid grammar
┌─────────────────────────────────────────────────────────────┐
│ Step 3: MODE + VERB CHECK (Local Decision)                  │
│ - If NORMAL mode → ALLOW                                    │
│ - If PLAN mode:                                             │
│   - VERB ∈ {READ, TEST} → ALLOW (read-only)                 │
│   - VERB ∈ {WRITE, EDIT, DELETE, BUILD, INSTALL} → BLOCK    │
│   - VERB = RUN → GOTO Step 4                               │
│ → No IPC needed for this step                               │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼ VERB = RUN (ambiguous)
┌─────────────────────────────────────────────────────────────┐
│ Step 4: LLM JUDGING (Parent Process Only)                   │
│ - If isChildProcess → BLOCK (cannot use LLM judge)         │
│ - Otherwise, ask LLM: "Is this command a mutation?"         │
│ - LLM response: READ/WRITE/UNCERTAIN                        │
│ → WRITE: BLOCK, READ: ALLOW, UNCERTAIN: GOTO Step 5        │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼ UNCERTAIN
┌─────────────────────────────────────────────────────────────┐
│ Step 5: USER PROMPT (Parent Process Only)                   │
│ - If isChildProcess → BLOCK (should have been caught)       │
│ - Otherwise, use core.question() to prompt user            │
│ - User can press ESC to skip (returns empty → block)       │
│ → User decides: ALLOW or BLOCK                              │
└─────────────────────────────────────────────────────────────┘
```

## Code Structure

```
src/context/grant/
├── index.ts                    # Barrel export
├── types.ts                    # Type interfaces (no enums)
├── intent-parser.ts            # Parse and validate intent
├── dangerous-commands.ts       # Step 1: Pattern-based blocking
├── bash-judge.ts              # Steps 2-5 orchestration
└── grant-evaluator.ts         # Main evaluator (integrates with Core)
```

## Implementation Details

### Types (`types.ts`)

```typescript
export interface ParsedIntent {
  verb: string;           // e.g., 'READ', 'WRITE', 'RUN'
  object: string;         // e.g., 'SOURCE', 'CONFIG'
  params: Record<string, string>;  // key=value pairs
  purpose: string;        // The TO clause
  raw: string;            // Original intent string
}

export interface IntentValidation {
  valid: boolean;
  error?: string;         // Human-readable error for LLM to fix
  hint?: string;           // Suggested correction
}

export interface BashJudgeResult {
  decision: 'allow' | 'block' | 'ask_user';
  reason?: string;
}

export interface DangerousCommand {
  pattern: RegExp;
  reason: string;
  category: 'destructive' | 'irreversible' | 'system';
}
```

### Intent Parser (`intent-parser.ts`)

- Parse intent using regex: `/^\[([A-Z]+)\]\s+\[([A-Z]+)\](?:\s+([a-z_]+=[^\s]+))*\s+TO\s+(.+)$/i`
- Validate verb against known list: `['READ', 'WRITE', 'EDIT', 'DELETE', 'BUILD', 'TEST', 'INSTALL', 'RUN']`
- Validate object against known list: `['SOURCE', 'CONFIG', 'DEPENDENCY', 'ARTIFACT', 'SYSTEM', 'DATA', 'TEMP']`
- Return structured error with hint on failure

### Dangerous Commands (`dangerous-commands.ts`)

Pattern-based blocking for:
- `rm -rf /`, `sudo rm` - Destructive deletion
- `mkfs`, `dd if=` - Irreversible operations
- `git commit`, `git push --force` - System operations
- `npm publish`, `pip upload` - Publishing

### Bash Judge (`bash-judge.ts`)

Implements the 5-step process:
1. Check dangerous commands (pattern matching)
2. Parse and validate intent grammar
3. Check mode + verb combination
4. LLM analysis for RUN verb (parent only, with ESC awareness)
5. User prompt for uncertain cases (parent only)

**Step 4: LLM Judge**
- Uses `retryMultipleChoice()` from `ollama.ts` for structured LLM responses
- Validates response matches exactly one of: READ, WRITE, UNCERTAIN
- On invalid response, retries with hint (max 2 retries)
- Wrapped in `escAware()` for ESC handling during LLM call
- If ESC pressed, returns `uncertain` to fall through to user prompt

### Grant Evaluator (`grant-evaluator.ts`)

Integrates with Core:
- For bash: delegates to `judgeBash()`
- For files: checks mode and worktree ownership

## Error Handling

### Intent Grammar Errors

When intent is invalid, return structured error:
```
Invalid intent format: Unknown verb: "LOOK"
Hint: Use one of: READ, WRITE, EDIT, DELETE, BUILD, TEST, INSTALL, RUN
Example: [READ] SOURCE TO check dependencies
```

### ESC Handling During User Prompt

- `core.question()` uses `agentIO.ask()` which is ESC-aware
- If user presses ESC, `ask()` returns empty string
- Empty response is treated as "no" (block the command)

### LLM Judge Failures

- If LLM call fails, be conservative: return `uncertain`
- Fall through to Step 5 (ask user)

## Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `src/context/grant/types.ts` | Create | Type interfaces |
| `src/context/grant/intent-parser.ts` | Create | Parse and validate intent |
| `src/context/grant/dangerous-commands.ts` | Create | Pattern-based blocking |
| `src/context/grant/bash-judge.ts` | Create | 5-step judging logic |
| `src/context/grant/grant-evaluator.ts` | Create | Main evaluator |
| `src/context/grant/index.ts` | Create | Barrel export |
| `src/ollama.ts` | Modify | Add retryMultipleChoice function |
| `src/tools/bash.ts` | Modify | Add requestGrant call |
| `src/types.ts` | Modify | Update requestGrant signature |
| `src/context/parent/core.ts` | Modify | Implement requestGrant for bash |
| `src/context/child/core.ts` | Modify | Pass intent in requestGrant IPC |
| `src/context/parent-context.ts` | Modify | Pass intent in IPC handler |
| `src/loop/agent-prompts.ts` | Modify | Add intent language section |
| `src/tests/context/grant.test.ts` | Modify | Add comprehensive tests |
| `src/tests/tools/bash.test.ts` | Modify | Update tests for grant system |

## Testing Strategy

1. **Intent Parsing Tests**
   - Valid intents with various formats
   - Invalid intents (unknown verb, missing purpose)
   - Edge cases (extra whitespace, lowercase)

2. **Dangerous Command Tests**
   - Each pattern in the list
   - Variations (flags, paths)

3. **Verb Classification Tests**
   - Read-only verbs (READ, TEST)
   - Mutation verbs (WRITE, EDIT, DELETE, BUILD, INSTALL)
   - Unknown verb (RUN)

4. **Mode Tests**
   - Plan mode blocks mutation verbs
   - Normal mode allows all verbs
   - Child process restrictions

5. **LLM Judge Tests**
   - Mocked LLM responses
   - Timeout/failure handling

6. **User Prompt Tests**
   - Accept/reject responses
   - ESC handling (empty response)

## Extensibility

- Add new verbs: Update `VALID_VERBS` in `intent-parser.ts`
- Add new objects: Update `VALID_OBJECTS` in `intent-parser.ts`
- Add dangerous patterns: Update `DANGEROUS_COMMANDS` array
- Add new grant types: Extend `GrantTool` type