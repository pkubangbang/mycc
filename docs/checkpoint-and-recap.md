# Checkpoint and Recap Design

> Context management through explicit subtask boundaries

## Overview

The `checkpoint` + `recap` pattern provides a subagent-like context management mechanism without spawning child processes. It allows agents to mark the start of a subtask and later compress the subtask's messages into a concise summary.

## ⚠️ Architecture: Meta-Tools

**Key Decision**: Checkpoint and recap are implemented as **meta-tools**, NOT regular tools.

### Why Meta-Tools?

Regular tools receive `AgentContext`, which contains modules like `core`, `todo`, `mail`, etc. The triologue (message history manager) is **NOT** part of AgentContext because:

1. **Separation of concerns**: Triologue belongs to the agent loop (state machine), not to the tool context
2. **Lifecycle mismatch**: Tools are short-lived execution units; triologue spans the entire conversation
3. **Access pattern**: Only the state machine should manage message history directly

### Implementation Pattern

**Tool Definitions** (`src/tools/checkpoint.ts`, `src/tools/recap.ts`):
- Define the tool interface (name, description, parameters) for LLM visibility
- Handler returns empty string (placeholder)
- Document that execution happens at state machine level

**State Machine Handling** (`src/loop/states/hook.ts` for lead, `src/context/teammate-worker.ts` for child):
- Detect checkpoint/recap tool calls before regular tool execution
- Execute the real logic using `env.triologue`
- Return result directly without calling regular tool handler

**Isolation Validation**:
- Both checkpoint and recap must be called ALONE (no other tools in same turn)
- Validated in `hook.ts` via `validateCheckpointIsolation` and `validateRecapIsolation`
- Enforced before tool execution

## Motivation

### The Problem

As agents work, their message history grows. Long conversations consume tokens and can degrade LLM performance. The existing `autoCompact` triggers automatically on token thresholds, but agents have no manual control over context management.

Subagents solve this by giving each subtask a fresh context, but implementing subagents requires:
- Child process management
- IPC communication
- Complex state coordination

### The Solution

`checkpoint` + `recap` provides similar benefits with simpler implementation:

1. Agent explicitly marks subtask start with `checkpoint`
2. Agent performs subtask (reads files, runs commands, etc.)
3. Agent calls `recap` to compress subtask messages into summary
4. Context stays clean, no child process needed

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Checkpoint message format | User role: `[CHECKPOINT {id}: {description}]` | Fits naturally into conversation flow |
| Single checkpoint enforcement | Fail fast with error | One open checkpoint at a time |
| Checkpoint ID format | 8-char random hash | Easy to reference, collision unlikely |
| Checkpoint isolation | Must be only tool call in turn | Clear boundary, enforced before tool execution |
| Track open checkpoint | Scan messages (in-memory) | Simple, cheap O(n) scan |
| Recap with wrong ID | Error + list available checkpoints | Helpful error message |
| Recap replacement | Replace checkpoint and everything after | Clean history |
| Recap summary format | User + assistant pair (NO tool message) | Matches autoCompact pattern, cleaner history |
| Recap isolation | Must be only tool call in turn | Same as checkpoint, enforced before execution |
| Todo for checkpoint | Regular todo with checkpoint info in note | Uses existing infrastructure |
| Recap without checkpoint | Error: "No checkpoint found." | Ruthless, clear contract |
| Todo nudge for checkpoint | Include in standard todo nudge | Simple integration |
| Teammate support | Supported | Both lead and child can use checkpoint/recap |

## Message Structure

### Checkpoint Flow

When `checkpoint` is called:
1. LLM outputs assistant message with `checkpoint` tool call
2. State machine adds: `triologue.agent(content, toolCalls)`
3. State machine adds: `triologue.tool('checkpoint', result, id)`
4. State machine adds: `addCheckpointMarker(triologue, id, description)`

**Result**: `[assistant(tool_calls), tool(result), user(checkpoint_marker)]`

### Recap Flow

When `recap` is called:
1. LLM outputs assistant message with `recap` tool call
2. State machine calls `handleRecap()` which:
   - Finds checkpoint by ID
   - Summarizes messages from checkpoint to end
   - Replaces with: `triologue.recapMessages(index, userMessage, assistantMessage)`
3. State machine adds continuation prompt

**Result**: `[user(summary), assistant(acknowledgment)]`

**Key difference**: Recap does NOT add the tool call/result to history. It directly replaces the checkpoint and all subsequent messages with a clean summary pair.

## Tools

### Checkpoint Tool

**Purpose**: Mark the start of a subtask before exploration begins.

**Parameters**:
```typescript
interface CheckpointParams {
  description: string;  // What the subtask will accomplish
}
```

**Behavior**:
1. Scan messages for existing open checkpoint
   - If found: fail with error "Checkpoint already exists."
2. Validate: checkpoint must be ONLY tool call in this turn
   - If other tools present: fail with error "Checkpoint must be called alone."
3. Generate 8-character random ID (e.g., `k7x9m2pq`)
4. Add checkpoint message to history:
   ```
   { role: 'user', content: '[CHECKPOINT k7x9m2pq: find authentication code]' }
   ```
5. Add todo entry:
   ```
   { name: "Checkpoint: find authentication code", note: "ID: k7x9m2pq", done: false }
   ```
6. Return success message: `"Checkpoint created: k7x9m2pq"`

**Example**:
```
Agent: I'll search for the authentication code. Let me create a checkpoint first.
Tool: checkpoint({ description: "find authentication code" })
Result: "Checkpoint created: k7x9m2pq"
[Agent then explores files, reads code, etc.]
```

### Recap Tool

**Purpose**: Compress subtask messages into a summary and close the checkpoint.

**Parameters**:
```typescript
interface RecapParams {
  checkpoint_id: string;  // ID of the checkpoint to close
}
```

**Behavior**:
1. Find checkpoint by ID in message history
   - If not found: fail with error including available checkpoints
   - Format: `"Checkpoint {id} not found. Available: [abc123: find auth code]"`
2. Extract messages from checkpoint (inclusive) to end of history
3. Call LLM to summarize with focus = checkpoint description
4. Replace message range with summary pair:
   ```
   { role: 'user', content: '[RECAP] Completed checkpoint "find authentication code":\n- Found auth in src/auth/\n- Login uses JWT\n- Session stored in Redis' }
   { role: 'assistant', content: 'Understood. I have the checkpoint summary. Continuing.' }
   ```
5. Mark corresponding todo as done
6. Return summary to LLM

**Example**:
```
Agent: I've found the authentication code. Let me recap to clean up context.
Tool: recap({ checkpoint_id: "k7x9m2pq" })
Result: "[RECAP] Completed checkpoint 'find authentication code':
- Authentication logic in src/auth/login.ts
- Uses JWT tokens with 24h expiry
- Session stored in Redis with prefix 'sess:'"
```

## Validation: Checkpoint Isolation

Checkpoint must be called alone in a single assistant turn. This is enforced at the agent loop level, before tool execution.

**Validation Logic** (in agent loop, before executing tools):
```typescript
// Before executing any tools:
if (toolCalls.some(tc => tc.function.name === 'checkpoint') && toolCalls.length > 1) {
  // Return error message to LLM
  return {
    role: 'tool',
    tool_name: 'checkpoint',
    content: "Checkpoint must be called alone. Other tools cannot be used in the same turn."
  };
}
```

**Why this matters**:
- Creates a clean boundary marker in history
- No ambiguity about where subtask "starts"
- The checkpoint message clearly means: "Everything after this is the subtask"

## Finding Open Checkpoint

To check if a checkpoint exists, scan message history:

```typescript
function findOpenCheckpoint(messages: Message[]): { id: string; description: string } | null {
  for (const msg of messages) {
    if (msg.role === 'user') {
      const match = msg.content.match(/^\[CHECKPOINT ([a-z0-9]{8}): (.+)\]$/);
      if (match) {
        return { id: match[1], description: match[2] };
      }
    }
  }
  return null;
}
```

To find all checkpoints (for error messages):
```typescript
function findAllCheckpoints(messages: Message[]): Array<{ id: string; description: string }> {
  const checkpoints = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const match = msg.content.match(/^\[CHECKPOINT ([a-z0-9]{8}): (.+)\]$/);
      if (match) {
        checkpoints.push({ id: match[1], description: match[2] });
      }
    }
  }
  return checkpoints;
}
```

## Todo Integration

When checkpoint is created, add a todo entry:

```typescript
todo_write({
  items: [{
    name: `Checkpoint: ${description}`,
    note: `ID: ${id}`,
    done: false
  }]
});
```

When recap is called, mark the todo as done:

```typescript
todo_write({
  items: [{
    name: `Checkpoint: ${description}`,
    done: true
  }]
});
```

### Todo Nudge

The standard todo nudge includes checkpoint information:

```
[TODO NUDGE] Open items:
- [ ] Checkpoint: find authentication code (ID: k7x9m2pq)
- [ ] Implement login
- [ ] Add tests
```

## Summary Generation

When recap is called, the LLM generates a summary focused on the checkpoint description:

**Prompt to LLM**:
```
Summarize the following conversation segment. Focus on: "{checkpoint_description}"

Include:
1. What was discovered/accomplished
2. Key files and locations
3. Important decisions or findings
4. Any pending items

Conversation:
{messages from checkpoint to end}
```

**Summary Format**:
```
[RECAP] Completed checkpoint "{description}":
- {finding 1}
- {finding 2}
- {finding 3}
...
```

## Comparison with Subagents

| Aspect | Subagents | Checkpoint + Recap |
|--------|-----------|-------------------|
| Task scope | Explicit in prompt | Explicit in description |
| Context boundary | Fresh empty context | Checkpoint marks start |
| Result | Returns summary | Recap produces summary |
| LLM motivation | "Need clean context" | "Made commitment, todo reminds" |
| Implementation | Child process, IPC | Simple message markers |
| Parallelism | Yes | No |
| Token overhead | None in parent | Summary in history |

## Usage Patterns

### Pattern 1: Exploration

```
User: Find where authentication happens in this codebase.

Agent: I'll create a checkpoint before exploring.
→ checkpoint({ description: "find authentication code" })
→ "Checkpoint created: abc12345"

Agent: Now let me explore the codebase...
→ [reads multiple files]
→ [searches for patterns]
→ [examines auth logic]

Agent: Found it! Let me recap to clean context.
→ recap({ checkpoint_id: "abc12345" })
→ "Summary: Auth is in src/auth/, uses JWT..."

Agent: Authentication is in src/auth/login.ts, using JWT tokens.
```

### Pattern 2: Investigation + Fix

```
User: There's a bug in the login flow.

Agent: I'll checkpoint before investigating.
→ checkpoint({ description: "investigate login bug" })

Agent: [explores login code, finds issue]
→ [reads related files]
→ [identifies root cause]

Agent: Found the bug! Let me recap and fix it.
→ recap({ checkpoint_id: "xyz789abc" })

Agent: The bug is in session handling. Fixing now...
→ [applies fix]
```

### Pattern 3: Multi-step Task

```
Agent: I need to refactor the API layer. Creating checkpoint.
→ checkpoint({ description: "refactor API layer" })

Agent: [analyzes current structure]
→ [plans refactoring]
→ [implements changes]

Agent: Refactoring complete. Recapping.
→ recap({ checkpoint_id: "def456ghi" })

Agent: API layer refactored. All tests pass.
```

## Edge Cases

### Multiple Checkpoints (Attempted)

```
Agent: checkpoint({ description: "task A" })
→ "Checkpoint created: abc12345"

Agent: [does work]

Agent: checkpoint({ description: "task B" })
→ "Checkpoint already exists: abc12345 'task A'. Call recap first."
```

### Recap with Wrong ID

```
Agent: recap({ checkpoint_id: "wrong123" })
→ "Checkpoint wrong123 not found. Available: [abc12345: task A]"
```

### Recap Without Checkpoint

```
Agent: recap({ checkpoint_id: "any12345" })
→ "No checkpoint found."
```

### Checkpoint with Other Tools

```
Agent: [calls checkpoint AND read_file in same turn]
→ Tool execution blocked
→ "Checkpoint must be called alone. Other tools cannot be used in the same turn."
```

## Implementation Files

| File | Purpose |
|------|---------|
| `src/tools/checkpoint.ts` | Checkpoint tool implementation |
| `src/tools/recap.ts` | Recap tool implementation |
| `src/loop/triologue.ts` | Helper: findCheckpointById(), findAllCheckpoints() |
| `src/loop/states/act.ts` | Validation: checkpoint isolation before tool execution |
| System prompt | Add checkpoint tool visibility |

## System Prompt Addition

The checkpoint tool should be prominently mentioned in the system prompt:

```markdown
## Context Management

Use `checkpoint` before starting a focused subtask (exploration, investigation, refactoring) to mark a clean boundary. After completing the subtask, use `recap` with the checkpoint ID to compress the exploration into a summary. This keeps your context clean and focused.

Example:
1. checkpoint({ description: "find authentication logic" })
2. [explore files, read code, investigate]
3. recap({ checkpoint_id: "abc12345" })
4. Continue with clean context and summary of findings
```

## Future Considerations

- **Checkpoint removal**: Allow explicit removal of abandoned checkpoints without recap
- **Checkpoint listing**: Tool to list all checkpoints in history
- **Auto-checkpoint**: Optionally auto-create checkpoints for certain patterns
- **Nested checkpoints**: Consider supporting hierarchical checkpoints (future)