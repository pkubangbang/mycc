# Hookish Skill Design

A system for skills that actively trigger based on patterns in the conversation sequence.

## Overview

Traditional skills are passive - they only activate when explicitly loaded via `skill_load`. Hookish skills are active - they monitor the conversation and trigger when conditions match.

```
Passive Skill:  User asks → LLM loads skill → LLM uses knowledge
Hookish Skill:  Conversation pattern → Condition matches → Skill activates
```

## Architecture

### Three-Stage Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│  Stage 1: Skill Definition (User-authored)                  │
│  .mycc/skills/lint-after-edit.md                            │
│                                                             │
│  ---                                                         │
│  name: lint-after-edit                                       │
│  when: run pnpm lint after you have done with code changes   │
│  ---                                                         │
│  Run `pnpm lint` after editing files to ensure quality.      │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  Stage 2: Compilation (LLM-translated, lazy)                │
│  .mycc/conditions.json                                       │
│                                                             │
│  {                                                           │
│    "lint-after-edit": {                                      │
│      "trigger": ["git_commit"],                              │
│      "when": "run pnpm lint...",                              │
│      "condition": "seq.hasAny(['edit_file', 'write_file'])   │
│                    && !seq.hasCommand('bash#lint')",          │
│      "action": {                                              │
│        "type": "inject_before",                               │
│        "tool": "bash",                                        │
│        "args": { "command": "pnpm lint", ... }               │
│      },                                                       │
│      "version": 1                                             │
│    }                                                          │
│  }                                                            │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  Stage 3: Runtime Execution                                  │
│  Processed by HookExecutor.processToolCalls():               │
│  1. Augment tool calls with metadata (hook-preprocessor)     │
│  2. Check hooks grouped by priority (block > replace >       │
│     inject > message), evaluate conditions using jsep AST    │
│  3. Execute matched actions, mark injected for dedup         │
└─────────────────────────────────────────────────────────────┘
```

## Data Model

### Skill File (User-authored)

```yaml
# .mycc/skills/lint-after-edit.md
---
name: lint-after-edit
description: Run lint after code changes
when: run pnpm lint after you have done with the code changes
---

Run `pnpm lint` after editing files to ensure code quality.
If lint fails, fix errors before proceeding.
```

The `when` field is natural language - the LLM translates it to structured condition.

### Conditions Registry (LLM-maintained)

```json
// .mycc/conditions.json
{
  "lint-after-edit": {
    "trigger": ["git_commit", "stop"],
    "when": "run pnpm lint after you have done with the code changes",
    "condition": "hasAny(['edit_file', 'write_file']) && !hasCommand('bash#lint')",
    "action": {
      "type": "inject_before",
      "tool": "bash",
      "args": {
        "command": "pnpm lint",
        "intent": "pre-commit lint check (hook)",
        "timeout": 60
      }
    },
    "version": 2,
    "sourceFile": "project:lint-after-edit/SKILL.md",
    "history": [
      {
        "version": 1,
        "condition": "has('edit_file')",
        "action": { "type": "message" },
        "reason": "initial compilation"
      },
      {
        "version": 2,
        "condition": "hasAny(['edit_file', 'write_file']) && !hasCommand('bash#lint')",
        "action": { "type": "inject_before", "tool": "bash", "args": {"command": "pnpm lint", "intent": "pre-commit lint check (hook)", "timeout": 60} },
        "reason": "user: didn't catch write_file, and should run lint, not just warn"
      }
    ]
  }
}
```

## Action Types

```typescript
type HookAction =
  | { type: 'inject_before'; tool: string; args: Record<string, unknown>; timeout?: number }
  | { type: 'inject_after'; tool: string; args: Record<string, unknown>; timeout?: number }
  | { type: 'block'; reason?: string }
  | { type: 'replace'; tool: string; args: Record<string, unknown>; timeout?: number }
  | { type: 'message' }
```

| Action | Effect | Use Case |
|--------|--------|----------|
| `inject_before` | Insert tool call before trigger | Run lint before commit |
| `inject_after` | Insert tool call after trigger | Summarize after long output |
| `block` | Prevent trigger from executing | Block dangerous operations |
| `replace` | Replace trigger with different tool | Redirect to safer alternative |
| `message` | Inject text into conversation | Reminder/warning only |

## Trigger Types

The `trigger` field is an **array of strings**. Each element must be one of:

- `"*"` — fires on any tool call
- `"stop"` — fires when LLM has no tool calls (about to stop)
- A specific tool name (e.g., `"git_commit"`, `"bash"`, `"edit_file"`)

Multiple triggers can be combined in the same array: `["git_commit", "stop"]`.

| Trigger | When it Fires | Example Use Case |
|---------|---------------|-------------------|
| `["git_commit"]` | Before git_commit tool executes | Run lint before commit |
| `["edit_file"]` / `["write_file"]` | Before file edit/write | Check patterns |
| `["bash"]` | Before any bash command | Block dangerous operations |
| `["*"]` | Before any tool call | Search wiki on errors |
| `["stop"]` | When LLM has no tool calls (about to stop) | Run tests before stopping |
| `["issue_create"]` | Before creating issues | Verify facts |

## Condition Language

Hook conditions are JavaScript-like boolean expressions evaluated safely via **jsep AST parsing** (no `eval`, no `Function` constructor at runtime). Conditions have access to two namespaces:

### `seq` — Sequence history queries

| Function | Returns | Description |
|----------|---------|-------------|
| `seq.has(toolName)` | `boolean` | Check if a tool exists in the current turn's sequence |
| `seq.hasAny([t1, t2, ...])` | `boolean` | Check if any of the listed tools exist |
| `seq.hasCommand(pattern)` | `boolean` | Check if a bash command contains a pattern. Use `"tool#pattern"` syntax, e.g., `"bash#lint"` matches bash calls whose command contains "lint" |
| `seq.last(toolName?)` | `SequenceEvent\|undefined` | Get the last tool event (optionally filtered by tool name). Has `.tool`, `.args`, `.result` fields |
| `seq.lastError()` | `(SequenceEvent & {message})\|undefined` | Get the last event whose result contains "error" or "failed". Has an extra `.message` field |
| `seq.count(toolName?)` | `number` | Count tool occurrences since the last user query (current turn) |
| `seq.totalCount(toolName?)` | `number` | Count tool occurrences since session start (entire conversation) |
| `seq.since(toolName)` | `SequenceEvent[]` | Events that occurred after the last occurrence of `toolName` |
| `seq.sinceEdit()` | `SequenceEvent[]` | Events after the last `edit_file` or `write_file` |
| `seq.isPlanMode()` | `boolean` | Whether the agent is in plan mode |

### `call` — Current tool call metadata

| Access path | Type | Description |
|-------------|------|-------------|
| `call.metadata.filePath` | `string` | Target file path (for `write_file`/`edit_file`) |
| `call.metadata.newLoc` | `number` | Lines of code in the new content |
| `call.metadata.existingLoc` | `number` | Lines of code in existing file (0 if new) |
| `call.metadata.isDestructive` | `boolean` | Whether the bash command is destructive (rm -rf, git push --force, etc.) |
| `call.args.X` | varies | Direct access to the current tool's arguments (e.g., `call.args.command`) |

### Allowed Operations

- **Comparators**: `==`, `!=`, `>`, `<`, `>=`, `<=`, `===`, `!==`
- **Logical operators**: `&&`, `||`, `!`
- **Ternary**: `condition ? a : b`
- **Parentheses**: for grouping
- **Literals**: numbers, strings (`'` or `"`), `true`, `false`, `null`, `undefined`
- **Array literals**: `['a', 'b']`
- **Method calls on results**: `.includes()`, `.indexOf()`, `.startsWith()`, `.endsWith()`, `.length` (on strings and arrays)

### Safety Restrictions

- Only `seq` and `call` are valid root identifiers
- Direct function calls are forbidden (only method-call syntax is allowed)
- Dangerous identifiers (`eval`, `Function`, `require`, `process`, `fs`, `constructor`, `prototype`, etc.) are rejected at compilation time

### Examples

```js
// File changes exist and lint hasn't been run yet (current turn)
seq.hasAny(['edit_file', 'write_file']) && !seq.hasCommand('bash#lint')

// Last result was an error, and wiki hasn't been searched yet (current turn)
seq.lastError() && !seq.has('wiki_get')

// Too many bash calls in this turn (current turn)
seq.count('bash') > 10

// Too many bash calls across the entire session (session-wide)
seq.totalCount('bash') > 50

// Block when read_file has been called 20+ times in the session (session-wide)
seq.totalCount('read_file') > 20

// Block force push to main (uses call context)
call.args.command.includes('git push --force') && call.args.command.includes('main')

// Block test files over 300 lines (uses call metadata)
call.metadata.filePath.includes('/tests/') && call.metadata.newLoc > 300

// Block destructive operations on main branch
call.metadata.isDestructive && call.args.command.includes('main')

// Always fire (triggers on every matching trigger)
true

// Last result is very long (may need summarization)
seq.last().result.length > 5000
```

## Expression Evaluation (Internal)

Expressions are stored with `seq.X` syntax in `conditions.json`, but at evaluation time the `seq.` prefix is stripped and the bare function names are called against the `EvalContext`. The `evaluator.ts` module uses **jsep** to parse expressions into an AST, then walks the tree safely — no `Function` constructor is used at runtime for condition evaluation.

The evaluation context binds:
```
has, hasAny, hasCommand, last, lastError, count, since, sinceEdit, isPlanMode, call
```

## Sequence Tracking

The `Sequence` class tracks tool executions within the current turn (cleared at each prompt boundary via `markPromptBoundary()`). It maintains an internal events array (`SequenceEvent[]`) with `{ tool, args, result, timestamp }` entries.

```typescript
export interface SequenceEvent {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  timestamp: number;
}

export class Sequence {
  private events: SequenceEvent[] = [];
  private triologue?: Triologue;
  private getMode: () => 'plan' | 'normal';
  
  add(event: SequenceEvent): void
  markPromptBoundary(): void  // clears events at turn boundary
  clear(): void                // full reset
  
  has(toolName: string): boolean
  hasAny(tools: string[]): boolean
  hasCommand(pattern: string): boolean  // supports "bash#pattern" syntax
  last(toolName?: string): SequenceEvent | undefined
  lastError(): (SequenceEvent & { message: string }) | undefined  // checks for "error" or "failed"
  count(toolName?: string): number
  since(toolName: string): SequenceEvent[]
  sinceEdit(): SequenceEvent[]  // after last edit_file or write_file
  isPlanMode(): boolean
  hasSkillInConversation(skillName: string): boolean  // checks triologue markers
  evaluate(expression: string): boolean  // uses jsep AST evaluator
}
```

Key difference from earlier design: Sequence queries are against an **in-memory events array** scoped to the current turn — not against the full triologue history. This prevents hooks from re-firing based on events from prior user prompts.

## Duplicate Prevention

Skills can be injected via multiple paths:
1. Hook trigger (condition matches)
2. Skill embedding match (semantic search)
3. Explicit load (`skill_load`)

To prevent duplicate content, two mechanisms work together:

1. **In-memory set** (`ConditionRegistry.injected`): Tracks skills injected in the current session
2. **Triologue markers**: `[Hook: {skillName}]` and `[Skill: {skillName}]` markers in conversation, checked via `Sequence.hasSkillInConversation()`

When injecting:
```typescript
if (sequence.hasSkillInConversation(skillName) || conditions.hasInjected(skillName)) {
  // Already present - reference only
  return { action: 'proceed', message: `[Hook: ${skillName}] (content already in conversation)` };
}
// First injection - full content passed to agent
```

## Compilation (Lazy)

Skills with `when` field are not compiled eagerly. They're compiled on-demand via `skill_compile` tool:

```typescript
// src/tools/skill_compile.ts

export const skillCompileTool: ToolDefinition = {
  name: 'skill_compile',
  description: `Compile a skill's "when" condition into a structured hook.
  
Use this when:
- A skill has a "when" field but no compiled condition
- User asks to update/refine a hook condition
- You notice a hook isn't triggering correctly

This tool asks the LLM to translate natural language "when" into 
an executable condition and action.`,
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill name to compile'
      },
      feedback: {
        type: 'string',
        description: 'Optional user feedback for refining the condition'
      }
    },
    required: ['name']
  },
  scope: ['main', 'child'],
  handler: async (ctx, args) => {
    // Lazy-compile the "when" field into a structured condition
    // Stores result in .mycc/conditions.json with validation gates
  }
};
```

### Compilation with Retry and Validation

The compilation process includes:

1. **Tool List for Context**: The LLM receives the complete list of available tools with descriptions, allowing it to choose appropriate triggers.

2. **Retry Logic**: Up to 3 retries with error feedback to the LLM for correction.

3. **Schema Validation** (`condition-validator.ts`): Checks `trigger` is a non-empty array of strings, `when`/`condition` are strings, `action` has valid `type`, etc.

4. **Expression Validation**: Parses the expression with jsep and walks the AST to verify:
   - Only allowed `seq.X` functions are used (`has`, `hasAny`, `hasCommand`, `last`, `lastError`, `count`, `since`, `sinceEdit`, `isPlanMode`)
   - No dangerous identifiers (`eval`, `Function`, `require`, `process`, etc.)
   - No direct function calls (only method-call syntax)
   - Only `seq` and `call` as root objects

5. **Smoke Test**: Evaluates the expression against an empty mock sequence to verify it doesn't throw.

6. **Trigger Validation**: Validates that each trigger is `'stop'`, `'*'`, or a known tool name from the tools list.

7. **Atomic Persistence**: Writes to temp file then renames (prevents corruption).

8. **Source File Tracking**: Each compiled condition tracks its source skill file using the format `"{layer}:{path}"` (e.g., `"project:lint-check/SKILL.md"`).

### Source File Notation

Skills are stored in three locations with specific path notations:

| Location | Path Format | Example |
|----------|-------------|---------|
| User skills | `user:{filename}` | `user:my-skill.md` |
| Project skills | `project:{path}` | `project:code-review/SKILL.md` |
| Built-in skills | `built-in:{path}` | `built-in:git-workflow/SKILL.md` |

This notation enables:
- **Orphan detection**: Identifying conditions whose source skill files no longer exist
- **Cross-platform paths**: Consistent representation regardless of OS
- **Layer resolution**: Knowing which skills directory to check

See `src/utils/skill-path-resolver.ts` for implementation details.

## Agent Loop Integration

The hook system integrates via `HookExecutor.processToolCalls()`, which replaces the old imperative for-loop approach:

```typescript
// In agent-loop (TOOL state)

// 1. Preprocessor: augment tool calls with metadata
const augmented = augmentToolCalls(toolCalls);

// 2. HookExecutor processes the entire delta at once
const result = await hookExecutor.processToolCalls(
  augmented,
  ctx,
  (name) => loader.getSkill(name)
);

// 3. Handle blocked calls (return rejection to LLM)
for (const [callId, message] of result.blockedCalls) {
  triologue.tool(callId, `BLOCKED: ${message}`);
}

// 4. Inject deferred messages into triologue
for (const msg of result.deferredMessages) {
  triologue.user(msg);
}

// 5. Execute the (possibly modified) tool calls
toolCalls = result.calls;
```

### Hook Priority Order

When multiple hooks match a single tool call, they are evaluated in priority order:

| Priority | Action Type | Rationale |
|----------|-------------|-----------|
| 0 (first) | `block` | Safety first — block danger before anything else |
| 1 | `replace` | Modify the trigger before injection |
| 2 | `inject_before`, `inject_after` | Add tool calls around the trigger |
| 3 (last) | `message` | Weak action, only provides guidance |

Within blocker/replacer groups, the **first match wins** (short-circuits). Within injector/message groups, **all matches are processed**.

### `stop` Trigger Handling

The `stop` trigger (empty tool calls array) is handled specially:
- `block` actions on `stop` are treated as `message` (blocking a stop makes no sense semantically)
- `inject_before`/`inject_after` can add tool calls to prevent the agent from stopping
- `message` actions inject guidance into conversation

## Example Cases

### Case A: Lint before commit

```yaml
# .mycc/skills/lint-after-edit.md
---
name: lint-after-edit
when: run pnpm lint after you have done with the code changes
---

Run `pnpm lint` after editing files to ensure code quality.
```

Compiled:
```json
{
  "trigger": ["git_commit"],
  "condition": "hasAny(['edit_file', 'write_file']) && !hasCommand('bash#lint')",
  "action": {
    "type": "inject_before",
    "tool": "bash",
    "args": { "command": "pnpm lint", "intent": "pre-commit lint", "timeout": 60 }
  }
}
```

### Case B: Search wiki on errors

```yaml
# .mycc/skills/wiki-search.md
---
name: wiki-search
when: when you feel lack of knowledge, search the wiki under pitfall or example domain
---

Search the wiki before making assumptions.
Use `wiki_get(query, domain)` with domain='pitfall' or 'example'.
```

Compiled:
```json
{
  "trigger": ["*"],
  "condition": "lastError() && !has('wiki_get')",
  "action": {
    "type": "inject_before",
    "tool": "wiki_get",
    "args": { "query": "error", "domain": "pitfall" }
  }
}
```

### Case C: Verify facts when planning

```yaml
# .mycc/skills/verify-facts.md
---
name: verify-facts
when: when you make a plan, verify the facts by searching the internet
---

Before creating issues, verify key facts using web_search.
Don't assume library versions or API signatures.
```

Compiled:
```json
{
  "trigger": ["issue_create"],
  "condition": "true",
  "action": {
    "type": "message"
  }
}
```

### Case D: Check patterns before writing

```yaml
# .mycc/skills/check-patterns.md
---
name: check-patterns
when: before writing new code, check existing patterns in the codebase
---

Use `bash` with grep/ripgrep to find similar code patterns.
Check existing implementations before inventing new patterns.
```

Compiled:
```json
{
  "trigger": ["write_file"],
  "condition": "!hasCommand('bash#grep') && !hasCommand('bash#rg') && !has('read_file')",
  "action": {
    "type": "message"
  }
}
```

### Case E: Block dangerous operations

```yaml
# .mycc/skills/no-force-push.md
---
name: no-force-push
when: never force push to main branch
---

Force push to main branch is prohibited.
Use regular push or create a new branch.
```

Compiled:
```json
{
  "trigger": ["bash"],
  "condition": "call.args.command.includes('git push --force') && call.args.command.includes('main')",
  "action": {
    "type": "block",
    "reason": "Force push to main branch is prohibited"
  }
}
```

## Evolution Through Feedback

The condition improves over time based on user feedback via `skill_compile` with the `feedback` parameter:

```
v1: "has('edit_file')"
    → User: "Didn't catch write_file"
    
v2: "hasAny(['edit_file', 'write_file'])"
    → User: "Just warned, didn't run lint"
    
v3: "hasAny(['edit_file', 'write_file']) && !hasCommand('bash#lint')"
    → User: "Should run before commit, not after edit"
    
v4: Trigger changed to "git_commit", action changed to "inject_before"
    → User: "Works now!"
```

Each version is persisted in `history` array for audit trail.

## File Structure

```
.mycc/
├── conditions.json      # Compiled conditions (lazy, atomic writes)
├── worktrees.json
├── .env
├── skills/
│   ├── lint-after-edit.md
│   ├── wiki-search.md
│   ├── verify-facts.md
│   └── check-patterns.md
└── tools/
```

## Key Source Files

| File | Purpose |
|------|---------|
| `src/hook/conditions.ts` | `ConditionRegistry` — manages `.mycc/conditions.json`, compilation pipeline, trigger matching |
| `src/hook/condition-validator.ts` | Schema + expression validation, smoke testing, `compileCondition()` pipeline |
| `src/hook/evaluator.ts` | jsep-based AST expression evaluator (replaces `Function` constructor) |
| `src/hook/sequence.ts` | `Sequence` class — per-turn event tracking, condition query interface |
| `src/hook/hook-executor.ts` | `HookExecutor` — priority-based hook processing, action execution |
| `src/hook/hook-preprocessor.ts` | `augmentToolCalls()` — adds metadata to tool calls for `call.metadata.*` |
| `src/tools/skill_compile.ts` | `skill_compile` tool — triggers lazy compilation |

---

## Comparison with Claude Code Hooks

Claude Code provides a similar hook system but with different trade-offs. Here's a comparison:

### Architecture Comparison

| Aspect | Claude Code Hooks | MyCC Hookish Skills |
|--------|-------------------|---------------------|
| **Definition Location** | JSON in settings file | `when` field in skill markdown |
| **Condition Language** | Matcher patterns (regex, exact) | LLM-translated expressions with jsep AST evaluation |
| **Action Type** | Shell commands, HTTP, prompts | Tool injection, blocking, messages |
| **State Tracking** | None (stateless) | Per-turn sequence history (seq.has, seq.last) |
| **Compilation** | Static JSON config | Lazy LLM compilation with validation gates |
| **Evolution** | Manual editing | Version history with refinement feedback |

### Claude Code Hook Events

Claude Code provides 10+ hook events:

| Event | When | Can Block |
|-------|------|-----------|
| `PreToolUse` | Before tool execution | Yes |
| `PostToolUse` | After tool completes | Yes |
| `PermissionRequest` | Permission dialog shown | Yes |
| `UserPromptSubmit` | User submits prompt | Yes |
| `Stop` | Main agent finishes | Yes |
| `SubagentStop` | Subagent finishes | Yes |
| `Notification` | Notifications sent | No |
| `PreCompact` | Before compacting | No |
| `SessionStart` | Session begins | No |
| `SessionEnd` | Session ends | No |

MyCC's hookish skills are conceptually similar to `PreToolUse` with pattern matching, but with key differences:

### Key Differences

#### 1. Condition Expressiveness

**Claude Code**:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "command": "if [[ contains 'rm -rf' ]]; then exit 2; fi" }]
      }
    ]
  }
}
```
- Matcher is static (tool name regex)
- Logic is in shell script
- No access to conversation history

**MyCC Hookish Skills**:
```yaml
when: run pnpm lint after code changes before commit
```
```json
{
  "trigger": ["git_commit"],
  "condition": "hasAny(['edit_file', 'write_file']) && !hasCommand('bash#lint')"
}
```
- Natural language condition
- LLM-translated to executable expression
- Full access to sequence history via `seq.*` and call context via `call.*`

#### 2. State Awareness

**Claude Code**: Stateless hooks. Cannot answer "did I already run lint?" without external state.

**MyCC**: Sequence-aware within the current turn. `hasCommand('bash#lint')` checks conversation history. Events are cleared at each prompt boundary to prevent stale triggers.

#### 3. Action Types

**Claude Code**: Actions are shell commands that output JSON to control behavior:
```json
{
  "hookSpecificOutput": {
    "permissionDecision": "allow|deny|ask|defer",
    "updatedInput": { "command": "modified" }
  }
}
```

**MyCC**: Actions integrate directly with the tool system:
```json
{
  "action": {
    "type": "inject_before",
    "tool": "bash",
    "args": { "command": "pnpm lint" }
  }
}
```

#### 4. Evolution & Learning

**Claude Code**: Static configuration. User must manually edit JSON to refine behavior.

**MyCC**: Version history with refinement:
```json
{
  "history": [
    { "version": 1, "condition": "has('edit_file')", "reason": "initial" },
    { "version": 2, "condition": "hasAny(['edit_file', 'write_file'])", "reason": "user: didn't catch write_file" },
    { "version": 3, "condition": "hasAny(['edit_file', 'write_file']) && !hasCommand('bash#lint')", "reason": "user: should run lint" }
  ]
}
```

### What MyCC Can Learn from Claude Code

1. **Multiple Hook Events**: Claude Code has PreToolUse, PostToolUse, PermissionRequest, etc. MyCC could add similar lifecycle hooks.

2. **Structured JSON Output**: Claude Code hooks return JSON for control. MyCC could define similar response schema.

3. **Matcher Patterns**: Claude Code's matcher syntax (`Edit|Write`, `Bash(npm test*)`) is useful. MyCC's `trigger` field could support similar patterns.

4. **HTTP Hooks**: Claude Code supports webhooks. MyCC could add `action.type: 'http'`.

### What MyCC Does Better

1. **Sequence History**: Can query past tool calls in the current turn (`seq.has`, `seq.last`).

2. **Call Context**: Access to current tool's metadata and arguments (`call.metadata.*`, `call.args.*`).

3. **Natural Language**: `when` field is more accessible than JSON config.

4. **Lazy Compilation**: Skills don't need pre-configuration, compile on demand.

5. **Evolution**: Built-in refinement mechanism with version history.

6. **Safety**: jsep AST evaluation with comprehensive identifier/method validation at compile time.

7. **Integration**: Actions integrate with MyCC's tool system directly.
