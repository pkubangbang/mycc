# Design Doc: Non-Blocking Question Tool

## Problem Statement

The current `question` tool completely blocks the agent loop, preventing any other operations while waiting for user input. This causes significant issues:

1. **Teammate Communication Blocked**: After spawning a teammate, if the agent asks the user a question, it cannot communicate with the teammate until the user responds.
2. **No Progress During Wait**: No tools can execute, no mail can be sent/received, no background work can happen.
3. **Poor User Experience**: 36+ second gaps in the logs while waiting for input.

### Current Architecture

```
Agent Loop (sequential execution)
    |
    v
Tool Execution: question
    |
    v
ctx.core.question(query)  <-- BLOCKS HERE
    |
    v
Main: agentIO.question() -> readline
Child: IPC sendRequest() -> waits for parent
```

The blocking chain:
```
Worker: teammateLoop() -> LLM -> question tool -> ChildCore.question() -> IPC
  |
  v
Parent: handleChildMessage() -> core.question() -> agentIO.question() -> readline (BLOCKED)
```

## Design Goals

1. Allow the agent loop to continue while questions are pending
2. Enable mail collection and teammate communication during question wait
3. Maintain backward compatibility with existing question behavior
4. Support both main process and child process questions

## Proposed Solution: Pending Questions Queue

### Architecture Overview

```
Agent Loop (continuous)
    |
    +-- Check pending questions -> inject responses as user messages
    |
    +-- Collect mail -> inject as user messages
    |
    +-- LLM call -> tool execution
    |
    +-- If question tool: queue question, return "waiting" status
    |
    v
Next iteration
```

### Component Changes

#### 1. Core Module: Pending Questions Queue

**File: `src/context/core.ts`**

Add a pending questions system:

```typescript
interface PendingQuestion {
  id: string;
  query: string;
  asker: string;
  response?: string;
  timestamp: number;
}

// In Core class:
private pendingQuestions: Map<string, PendingQuestion> = new Map();
private questionCounter = 0;

// Non-blocking question - queues and returns ID
async askQuestion(query: string, asker?: string): Promise<string> {
  const id = `q${++this.questionCounter}`;
  this.pendingQuestions.set(id, {
    id,
    query,
    asker: asker || 'lead',
    timestamp: Date.now()
  });
  return id;
}

// Check if question has response
getQuestionResponse(id: string): string | undefined {
  return this.pendingQuestions.get(id)?.response;
}

// Resolve question (called by agentIO when user responds)
resolveQuestion(id: string, response: string): void {
  const q = this.pendingQuestions.get(id);
  if (q) q.response = response;
}

// Get all pending questions without responses
getPendingQuestions(): PendingQuestion[] {
  return Array.from(this.pendingQuestions.values()).filter(q => !q.response);
}
```

#### 2. Question Tool: Return Immediately

**File: `src/tools/question.ts`**

```typescript
handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
  const query = args.query as string;

  ctx.core.brief('info', 'question', `waiting for user input...`);

  // Queue the question and return immediately
  const questionId = await ctx.core.askQuestion(query);
  return `Question queued (ID: ${questionId}). Waiting for user response...`;
}
```

#### 3. Agent Loop: Check Pending Questions

**File: `src/loop/agent-loop.ts`**

Add question checking at the start of each iteration:

```typescript
while (true) {
  // 1. Check for resolved questions
  const resolvedQuestions = ctx.core.getResolvedQuestions();
  for (const q of resolvedQuestions) {
    messages.push({
      role: 'user',
      content: `[question resolved] ${q.query}\nUser response: ${q.response}`
    });
    ctx.core.clearQuestion(q.id);
  }

  // 2. Micro-compact old tool results
  microCompact(messages);

  // 3. Collect mails (existing)
  // ... rest of loop
}
```

#### 4. AgentIO: Resolve Questions

**File: `src/loop/agent-io.ts`**

When readline receives input, resolve the pending question:

```typescript
// Track current question
let currentQuestionId: string | null = null;

async function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      if (currentQuestionId) {
        ctx.core.resolveQuestion(currentQuestionId, answer);
        currentQuestionId = null;
      }
      resolve(answer);
    });
  });
}
```

### Alternative Designs Considered

#### Option B: Async Question Status Tool

Instead of modifying the agent loop, add a new tool:

```typescript
// question_ask.ts - queues question, returns ID
// question_check.ts - polls for response by ID
```

Pros: No agent loop changes
Cons: Requires LLM to poll, more complex for agent to manage

#### Option C: Restrict Question Scope

Remove question tool from child process scope:

```typescript
// In tool definition
scope: ['main']  // Only available to lead
```

Pros: Simple, teammates use mail_to for questions
Cons: Less flexible, teammates can't directly ask users

#### Option D: Event-Driven Question Handling

Use event emitters for question responses:

```typescript
ctx.core.on('questionResponse', (id, response) => {
  // Inject into message queue
});
```

Pros: Clean separation
Cons: More complex state management

## Implementation Plan

### Phase 1: Core Infrastructure
1. Add pending questions queue to `Core` module
2. Add question ID tracking to `AgentIO`
3. Add `resolveQuestion()` mechanism

### Phase 2: Tool Changes
1. Modify `question.ts` to return immediately
2. Update tool description to explain non-blocking behavior

### Phase 3: Agent Loop Integration
1. Add question response checking at loop start
2. Inject resolved questions as user messages
3. Handle multiple pending questions

### Phase 4: Child Process Support
1. Add IPC message types for question queue/response
2. Update child-context Core to use IPC for question operations
3. Test with teammates asking questions

## Backward Compatibility

- The question tool still works the same from user perspective
- LLM sees slightly different response ("Question queued" vs direct answer)
- Child processes can still ask questions through parent

## Testing Strategy

1. **Unit Tests**: Question queue/resolution in Core
2. **Integration Tests**: Agent loop with pending questions
3. **E2E Tests**:
   - Spawn teammate, ask question, verify mail still works
   - Multiple pending questions resolved in order
   - Child process questions through IPC

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| LLM confused by queued response | Clear tool description explaining behavior |
| Multiple questions pile up | Timeout old questions, show count in status |
| Child process questions more complex | IPC layer handles transparently |
| Message ordering issues | Use question IDs for correlation |

## Open Questions

1. Should there be a limit on pending questions?
2. Should old questions timeout automatically?
3. How to handle question cancellation?
4. Should priority questions be supported?

## References

- `src/context/core.ts` - Current question implementation
- `src/tools/question.ts` - Current question tool
- `src/loop/agent-loop.ts` - Agent loop iteration
- `src/loop/agent-io.ts` - readline interface
- `docs/test-prompts.md` - Test cases showing blocking behavior