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
│      "trigger": "git_commit",                                 │
│      "when": "run pnpm lint...",                              │
│      "condition": "seq.hasAny(['edit_file', 'write_file'])   │
│                    && !seq.has('bash#lint')",                │
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
│  In agent-loop, before each tool call:                       │
│  1. Check conditions.matches(trigger, sequence)              │
│  2. If match, execute action (inject/block/message)           │
│  3. Mark skill as injected to prevent duplicates             │
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
    "trigger": "git_commit",
    "when": "run pnpm lint after you have done with the code changes",
    "condition": "seq.hasAny(['edit_file', 'write_file']) && !seq.sinceEdit().has('bash#lint')",
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
    "history": [
      {
        "version": 1,
        "condition": "seq.has('edit_file')",
        "action": { "type": "message" },
        "reason": "initial compilation"
      },
      {
        "version": 2,
        "condition": "seq.hasAny(['edit_file', 'write_file']) && !seq.has('bash#lint')",
        "action": { "type": "inject_before", ... },
        "reason": "user: didn't catch write_file, and should run lint, not just warn"
      }
    ]
  }
}
```

## Action Types

```typescript
type HookAction =
  | { type: 'inject_before'; tool: string; args: Record<string, unknown>; reason?: string }
  | { type: 'inject_after'; tool: string; args: Record<string, unknown>; reason?: string }
  | { type: 'block'; reason?: string }
  | { type: 'replace'; tool: string; args: Record<string, unknown>; reason?: string }
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

| Trigger | When it Fires | Example Use Case |
|---------|---------------|-------------------|
| `git_commit` | Before git_commit tool executes | Run lint before commit |
| `edit_file` / `write_file` | Before file edit/write | Check patterns |
| `bash` | Before any bash command | Block dangerous operations |
| `*` | Before any tool call | Search wiki on errors |
| `stop` | When LLM has no tool calls (about to stop) | Run tests before stopping |
| `issue_create` | Before creating issues | Verify facts |

## Condition Language

Simple expressions evaluated against the conversation sequence:

```typescript
// Available in condition expressions:
seq.has(toolName)                    // Tool exists in sequence
seq.hasAny([tool1, tool2])           // Any of these tools exist
seq.hasCommand(pattern)              // Bash command contains pattern
seq.last()                           // Last tool result
seq.lastError()                      // Last error result
seq.count(toolName)                  // Count of tool calls
seq.since(toolName)                  // Events after last occurrence
seq.sinceEdit()                      // Events after last file edit

// Examples:
"seq.hasAny(['edit_file', 'write_file']) && !seq.has('bash#lint')"
"seq.lastError() && !seq.has('wiki_get')"
"seq.last().result.length > 5000"
"seq.count('bash') > 10"  // Too many bash calls, suggest alternative
```

## Sequence Tracking

The sequence wraps the triologue to query conversation history:

```typescript
export class Sequence {
  constructor(private triologue: Triologue) {}
  
  has(toolName: string): boolean {
    return this.triologue.getMessagesRaw()
      .filter(m => m.role === 'tool')
      .some(m => m.tool_name === toolName);
  }
  
  hasAny(tools: string[]): boolean {
    return tools.some(t => this.has(t));
  }
  
  hasCommand(pattern: string): boolean {
    return this.triologue.getMessagesRaw()
      .filter(m => m.role === 'tool' && m.tool_name === 'bash')
      .some(m => m.content?.includes(pattern));
  }
  
  last(): { tool: string; result: string } | undefined {
    const messages = this.triologue.getMessagesRaw();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool') {
        return {
          tool: messages[i].tool_name!,
          result: messages[i].content || ''
        };
      }
    }
    return undefined;
  }
  
  lastError(): { tool: string; result: string } | undefined {
    const messages = this.triologue.getMessagesRaw();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool' && 
          messages[i].content?.toLowerCase().includes('error')) {
        return {
          tool: messages[i].tool_name!,
          result: messages[i].content || ''
        };
      }
    }
    return undefined;
  }
  
  count(toolName: string): number {
    return this.triologue.getMessagesRaw()
      .filter(m => m.role === 'tool' && m.tool_name === toolName)
      .length;
  }
  
  since(toolName: string): Sequence {
    // Return new sequence with events after last occurrence of toolName
    // ...
  }
}
```

## Duplicate Prevention

Skills can be injected via multiple paths:
1. Hook trigger (condition matches)
2. Skill embedding match (semantic search)
3. Explicit load (`skill_load`)

To prevent duplicate content in triologue, use markers:

```typescript
hasSkillInConversation(skillName: string): boolean {
  const hookMarker = `[Hook: ${skillName}]`;
  const skillMarker = `[Skill: ${skillName}]`;
  
  return this.triologue.getMessagesRaw().some(msg => 
    msg.content?.includes(hookMarker) || msg.content?.includes(skillMarker)
  );
}
```

When injecting:
```typescript
if (sequence.hasSkillInConversation(skillName)) {
  // Already present - reference only
  triologue.user(`[Hook: ${skillName}] (see earlier in conversation)`);
} else {
  // First injection - full content
  triologue.user(`[Hook: ${skillName}]\n\n${skill.content}`);
}
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
    const skillName = args.name as string;
    const feedback = args.feedback as string | undefined;
    
    const skill = ctx.skill.getSkill(skillName);
    if (!skill?.when) {
      return `Error: Skill '${skillName}' not found or has no 'when' field`;
    }
    
    const existing = await ctx.conditions.get(skillName);
    
    // Get available tools for trigger validation
    const availableTools = ctx.skill.listAllTools();
    
    // Compile with tools list and source file tracking
    const condition = await ctx.conditions.compile(
      skill.when,
      skillName,
      skill.content,
      existing,
      skill.sourceFile,  // Track source for orphan detection
      availableTools      // Validate trigger against known tools
    );
    
    return `Compiled '${skillName}' (v${condition.version}):\n` +
           `Trigger: ${condition.trigger}\n` +
           `Condition: ${condition.condition}\n` +
           `Action: ${JSON.stringify(condition.action)}`;
  }
};
```

### Compilation with Retry and Validation

The compilation process includes:

1. **Tool List for Context**: The LLM receives the complete list of available tools with descriptions, allowing it to choose appropriate triggers.

2. **Retry Logic**: Up to 3 retries with error feedback to the LLM for correction.

3. **Trigger Validation**: Validates that the trigger is:
   - `'stop'` (fires when LLM finishes, no tool calls)
   - `'*'` (fires on any tool call)
   - A known tool name from the tools list

4. **Source File Tracking**: Each compiled condition tracks its source skill file using the format `"{layer}:{path}"` (e.g., `"project:lint-check/SKILL.md"`).

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

```typescript
// In agent-loop.ts

const sequence = new Sequence(triologue);

for (let i = 0; i < toolCalls.length; i++) {
  const toolCall = toolCalls[i];
  
  // Check hooks BEFORE executing
  const matchedHooks = conditions.matches(toolCall.function.name, sequence);
  
  for (const hookName of matchedHooks) {
    const cond = conditions.get(hookName);
    if (!cond) continue;
    
    const result = await conditions.execute(
      hookName,
      cond.action,
      ctx,
      toolCalls.slice(i)
    );
    
    if (result.result === 'blocked') {
      triologue.tool(toolCall.function.name, cond.action.reason, toolCall.id);
      continue; // Skip this tool
    }
    
    if (result.result === 'injected') {
      i = -1; // Restart loop to process injected call
      break;
    }
  }
  
  // Execute tool
  const output = await loader.execute(toolCall.function.name, ctx, args);
  triologue.tool(toolCall.function.name, output, toolCall.id);
}
```

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
  "trigger": "git_commit",
  "condition": "seq.hasAny(['edit_file', 'write_file']) && !seq.has('bash#lint')",
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
  "trigger": "*",
  "condition": "seq.lastError() && !seq.has('wiki_get')",
  "action": {
    "type": "inject_before",
    "tool": "wiki_get",
    "args": { "query": "${seq.lastError().result}", "domain": "pitfall" }
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
  "trigger": "issue_create",
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
  "trigger": "write_file",
  "condition": "!seq.has('bash#grep') && !seq.has('bash#rg') && !seq.has('read_file')",
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
  "trigger": "bash",
  "condition": "seq.last().args.command.includes('git push --force') && seq.last().args.command.includes('main')",
  "action": {
    "type": "block",
    "reason": "Force push to main branch is prohibited"
  }
}
```

## Evolution Through Feedback

The condition improves over time based on user feedback:

```
v1: "seq.has('edit_file')"
    → User: "Didn't catch write_file"
    
v2: "seq.hasAny(['edit_file', 'write_file'])"
    → User: "Just warned, didn't run lint"
    
v3: "seq.hasAny(['edit_file', 'write_file']) && !seq.has('bash#lint')"
    → User: "Should run before commit, not after edit"
    
v4: Trigger changed to "git_commit", action changed to "inject_before"
    → User: "Works now!"
```

Each version is persisted in `history` array for audit trail.

## File Structure

```
.mycc/
├── conditions.json      # Compiled conditions (lazy)
├── worktrees.json
├── .env
├── skills/
│   ├── lint-after-edit.md
│   ├── wiki-search.md
│   ├── verify-facts.md
│   └── check-patterns.md
└── tools/
```

## Implementation Phases

1. **Phase 1**: Core infrastructure
   - Add `when` field to Skill type
   - Create ConditionRegistry class
   - Create Sequence wrapper

2. **Phase 2**: Compilation
   - Implement `skill_compile` tool
   - LLM translates "when" → condition + action

3. **Phase 3**: Runtime execution
   - Integrate into agent-loop
   - Implement action execution
   - Add duplicate prevention

4. **Phase 4**: Refinement
   - Handle user feedback
   - Version history tracking
   - Condition evolution

---

## Comparison with Claude Code Hooks

Claude Code provides a similar hook system but with different trade-offs. Here's a comparison:

### Architecture Comparison

| Aspect | Claude Code Hooks | MyCC Hookish Skills |
|--------|-------------------|---------------------|
| **Definition Location** | JSON in settings file | `when` field in skill markdown |
| **Condition Language** | Matcher patterns (regex, exact) | LLM-translated natural language |
| **Action Type** | Shell commands, HTTP, prompts | Tool injection, blocking, messages |
| **State Tracking** | None (stateless) | Sequence history (seq.has, seq.last) |
| **Compilation** | Static JSON config | Lazy LLM compilation |
| **Evolution** | Manual editing | Version history with refinement |

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
  "trigger": "git_commit",
  "condition": "seq.hasAny(['edit_file', 'write_file']) && !seq.has('bash#lint')"
}
```
- Natural language condition
- LLM-translated to executable expression
- Full access to sequence history

#### 2. State Awareness

**Claude Code**: Stateless hooks. Cannot answer "did I already run lint?" without external state.

**MyCC**: Sequence-aware. `seq.has('bash#lint')` checks conversation history.

#### 3. Action Types

**Claude Code**: Actions are shell commands that output JSON to control behavior:
```json
// PreToolUse can return:
{
  "hookSpecificOutput": {
    "permissionDecision": "allow|deny|ask|defer",
    "updatedInput": { "command": "modified" }
  }
}
```

**MyCC**: Actions are tool calls that integrate directly:
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
    { "version": 1, "condition": "seq.has('edit_file')", "reason": "initial" },
    { "version": 2, "condition": "seq.hasAny(['edit_file', 'write_file'])", "reason": "user: didn't catch write_file" },
    { "version": 3, "condition": "seq.hasAny(['edit_file', 'write_file']) && !seq.has('bash#lint')", "reason": "user: should run lint" }
  ]
}
```

### What MyCC Can Learn from Claude Code

1. **Multiple Hook Events**: Claude Code has PreToolUse, PostToolUse, PermissionRequest, etc. MyCC could add similar lifecycle hooks.

2. **Structured JSON Output**: Claude Code hooks return JSON for control. MyCC should define similar response schema.

3. **Timeout Configuration**: Claude Code allows per-hook timeout. MyCC should add this.

4. **Matcher Patterns**: Claude Code's matcher syntax (`Edit|Write`, `Bash(npm test*)`) is useful. MyCC's `trigger` field could support similar patterns.

5. **HTTP Hooks**: Claude Code supports webhooks. MyCC could add `action.type: 'http'`.

### What MyCC Does Better

1. **Sequence History**: Can query past tool calls (`seq.has`, `seq.last`).

2. **Natural Language**: `when` field is more accessible than JSON config.

3. **Lazy Compilation**: Skills don't need pre-configuration, compile on demand.

4. **Evolution**: Built-in refinement mechanism with version history.

5. **Integration**: Actions integrate with MyCC's tool system directly.

### Timeout Handling

Hook actions that inject tool calls should have timeout limits to prevent runaway execution:

```json
{
  "lint-after-edit": {
    "trigger": "git_commit",
    "condition": "seq.hasAny(['edit_file', 'write_file']) && !seq.has('bash#lint')",
    "action": {
      "type": "inject_before",
      "tool": "bash",
      "args": { "command": "pnpm lint", "intent": "pre-commit lint check", "timeout": 60 },
      "timeout": 60
    }
  }
}
```

**Timeout behavior**:
- If injected tool call exceeds timeout, abort the hook action
- Log timeout event for debugging
- Continue with original tool execution (don't block commit on timeout)
- Timeout defaults to 60 seconds if not specified

**Implementation**:
```typescript
async function executeWithTimeout(
  action: HookAction,
  ctx: AgentContext,
  timeout: number
): Promise<{ result: string; timedOut: boolean }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);
  
  try {
    const result = await executeAction(action, ctx, controller.signal);
    clearTimeout(timeoutId);
    return { result, timedOut: false };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      ctx.core.brief('warn', 'hook', `Hook action timed out after ${timeout}s`);
      return { result: '', timedOut: true };
    }
    throw err;
  }
}
```