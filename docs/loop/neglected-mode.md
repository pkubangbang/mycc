# Neglected Mode

**Neglected Mode** (also called "neglection" in the codebase) is an interrupt mechanism that allows users to press **ESC** at any time to stop the agent's current operation and force it to wrap up quickly.

> **Note:** The agent loop has been refactored from `src/loop/agent-loop.ts` (removed) into a state machine (`src/loop/state-machine.ts`) with handlers in `src/loop/states/*.ts`. The Ollama client (`src/ollama.ts`, removed) was refactored into `src/engine/chat-provider.ts` + `src/engine/chat-helpers.ts`. Wrap-up is now managed by `src/loop/esc-wrap-up.ts` (`startWrapUp`, `evaluateWrapUp`, `commitWrapUp`/`rollbackWrapUp`). The sections below reflect the current codebase.

## Why It Exists

When an LLM agent is:
- Making a long LLM call
- Executing multiple tools in sequence
- Running long-running bash commands

Users need a way to interrupt and regain control without killing the entire session. Neglected mode provides a graceful interruption path.

## How It Works

### Architecture Flow

```
User presses ESC
       ↓
Coordinator (index.ts) intercepts key
       ↓
Sends { type: 'neglection' } IPC to Lead
       ↓
agent-io.ts sets neglectedModeFlag
       ↓
If LLM call in progress: abort it
If tool executing: skip remaining tools
       ↓
Inject wrap-up message
       ↓
LLM responds (no tools available in neglected mode)
       ↓
Clear neglected mode flag
```

### Key Components

#### 1. Coordinator (`src/index.ts`)

The Coordinator runs in raw mode and intercepts ESC key presses:

```typescript
// ESC - send neglection IPC
if (isEscape(key)) {
  lead?.send({ type: 'neglection' });
}
```

The Coordinator forwards the neglection signal to the Lead process via IPC message.

#### 2. AgentIO (`src/loop/agent-io.ts`)

AgentIO manages the neglected state as a singleton:

```typescript
private neglectedModeFlag = false;
private onNeglectedCallbacks: Set<() => void> = new Set();

isNeglectedMode(): boolean {
  return this.neglectedModeFlag;
}

setNeglectedMode(value: boolean): void {
  this.neglectedModeFlag = value;
}
```

Key features:
- **Flag tracking**: `neglectedModeFlag` indicates if ESC was pressed this round
- **Callback system**: `onNeglected()` registers callbacks for ESC events (stored in a `Set`)
- **IPC handler**: Receives `{ type: 'neglection' }` messages from Coordinator
- **Trigger method**: `triggerNeglection()` encapsulates the standard ESC logic (set flag, abort LLM, fire callbacks) — used by both Coordinator IPC and ServeHub WS interrupt

When neglection is triggered (via `triggerNeglection()`):
```typescript
triggerNeglection(): void {
  if (this.isNeglectedMode()) return;  // avoid duplicate processing
  this.setNeglectedMode(true);
  const controller = this.getLlmAbortController();
  if (controller) {
    controller.abort();
  }
  for (const cb of this.onNeglectedCallbacks) {
    try {
      const maybePromise = cb();
      if (maybePromise && typeof (maybePromise as { catch?: unknown }).catch === 'function') {
        (maybePromise as Promise<unknown>).catch(() => {});
      }
    } catch { /* swallow sync errors */ }
  }
  this.onNeglectedCallbacks.clear();
}
```

#### 3. State Machine Handlers (`src/loop/states/*.ts`)

The state machine handles neglected mode at key points across state handlers:

**a) LLM state (`states/llm.ts`) - empty tools array + pre-check:**
```typescript
// In neglected mode, provide no tools so LLM can only respond with text
const tools = agentIO.isNeglectedMode() ? [] : loader.getToolsForScope(scope);

// Pre-check: if ESC was already pressed before the LLM call
if (agentIO.isNeglectedMode()) {
  stopSpinner();
  startWrapUp(triologue, tools);
  agentIO.setNeglectedMode(false);
  return AgentState.PROMPT;
}
```

**b) LLM state - ESC during LLM call:**
```typescript
const response = await ctx.core.escAware(
  async (abortController) => {
    return await retryChat({ model: MODEL, messages, tools, ... }, { signal: abortController.signal, ... });
  },
  () => {
    startWrapUp(triologue, tools);  // ESC cleanup starts wrap-up
    return null;                      // returns null → response is null
  }
);
if (!response) {
  stopSpinner();
  agentIO.setNeglectedMode(false);
  return AgentState.PROMPT;
}
```

**c) TOOL state (`states/tool.ts`) - skip remaining tools:**
```typescript
for (const toolCall of hookResult.calls) {
  if (agentIO.isNeglectedMode()) {
    agentIO.setNeglectedMode(false);
    triologue.skipPendingTools(
      'Tool use interrupted - user pressed ESC.',
      'Tool use skipped due to ESC interruption.'
    );
    return AgentState.PROMPT;
  }
  // ... execute tool via escAware
}
```

**d) STOP state (`states/stop.ts`) - wrap-up completion:**
```typescript
if (agentIO.isNeglectedMode()) {
  agentIO.setNeglectedMode(false); // Clear FIRST
  if (autoState.getAuto()) {
    autoState.setAuto(false); // ESC exits auto mode too
  }
  const teammates = ctx.team.listTeammates();
  if (teammates.some((t) => t.status === 'working')) {
    agentIO.log(chalk.yellow('teammates still working (use /team to check status)'));
  }
  agentIO.flushOutput();
  presentResult(triologue);
  return AgentState.PROMPT;
}
```

#### 4. Chat Engine (`src/engine/chat-helpers.ts`)

The chat engine passes a `neglected` flag in the retry config, which can be used to adjust spinner behavior during neglected mode. The spinner is managed via `startSpinner()` / `stopSpinner()` from `src/engine/chat-helpers.ts`.

#### 5. Triologue (`src/loop/triologue.ts`)

The Triologue class provides a method to skip pending tool calls:

```typescript
skipPendingTools(firstMessage: string, subsequentMessage?: string): void {
  let isFirst = true;
  for (const id of this.pendingToolCallOrder) {
    const tc = this.pendingToolCalls.get(id);
    if (tc) {
      const msg = isFirst ? firstMessage : (subsequentMessage || firstMessage);
      this.addMessage({
        role: 'tool',
        tool_name: tc.function.name,
        content: msg,
        tool_call_id: id,
      });
      isFirst = false;
    }
  }
  this.pendingToolCalls.clear();
  this.pendingToolCallOrder = [];
}
```

## Behavior Details

### During LLM Call

| Event | Action |
|-------|--------|
| ESC pressed | AbortController.abort() called |
| LLM response | Discarded |
| User message | `"LLM call interrupted. Please wrap up and ask user for next steps."` |
| Tools available | Empty array (text-only response) |

### During Tool Execution

| Event | Action |
|-------|--------|
| Current tool | Completes normally |
| Remaining tools | Skipped with placeholder results |
| User message | `"The user pressed ESC to interrupt. Please wrap up and wait for next instruction."` |
| Tools available | Empty array (text-only response) |

### During Bash Command (exec)

The `exec()` method in `agent-io.ts` delegates to `runExec()` in `src/loop/agent-exec.ts`, which registers a neglection callback:

```typescript
// Register callback for ESC (neglected) - skip subprocess wait
this.onNeglected(() => {
  if (!completed) {
    completed = true;
    clearTimeout(timer);
    // Return premature output, let subprocess continue in background
    resolve({
      stdout: stdoutBuffer.getString(),
      stderr: stderrBuffer.getString(),
      interrupted: true,
      exitCode: -1, // Unknown - subprocess still running
      timedOut: false,
    });
  }
});
```

| Event | Action |
|-------|--------|
| ESC pressed | Skip waiting for subprocess |
| Output | Return whatever collected so far |
| Subprocess | Continues in background |
| `interrupted` flag | Set to `true` in result |

### After Wrap-up

| Condition | Action |
|-----------|--------|
| LLM responds without tool calls | Wrap-up complete |
| Neglected mode flag | Cleared |
| Agent state | Returns to normal operation |

## IPC Message Types

```typescript
// From Coordinator to Lead
type CoordinatorToLeadMessage =
  | { type: 'neglection' }          // ESC pressed
  | { type: 'key'; key: KeyInfo }   // Single key event
  | { type: 'key-batch'; keys: KeyInfo[] }  // Batch key events (paste)
  | { type: 'resize'; columns: number }     // Terminal resize
  | { type: 'condition_reload' }    // skill_compile updated conditions.json
  | { type: 'serve_shutdown' };     // Coordinator asked to shut down serve
```

## Usage Example

```
User: run `sleep 30`
Tool: bash with timeout 35
Error: timeout must be an integer between 1 and 60, got: 65

User: [presses ESC]
[ESC] LLM call interrupted

LLM: I encountered a timeout constraint - the bash tool has a maximum timeout 
     of 60 seconds. Would you like me to:
     1. Run it as a background task with `bg_create`?
     2. Run a shorter sleep duration?
     3. Do something else?

User: I'm testing the neglected mode. Do you know that?

LLM: No, I'm not aware of a "neglected mode" feature. I see from the docs 
     there's a `docs/confusion-index.md` file that might be related...
```

## Summary Table

| Aspect | Behavior |
|--------|----------|
| **Trigger** | ESC key press |
| **LLM Call** | Aborted, response discarded, wrap-up requested |
| **Tool Execution** | Current completes, remaining skipped |
| **Bash Command** | Returns premature output, subprocess continues |
| **LLM Tools** | Empty array (text-only response) |
| **Recovery** | Automatic after wrap-up response (no tool calls) |
| **User Message** | Wrap-up instruction injected automatically |
| **Spinner Text** | "Wrapping up..." instead of "Thinking" |

## Design Rationale

1. **Graceful interruption**: Unlike Ctrl+C which kills the process, ESC allows the agent to wrap up cleanly and provide a response.

2. **No tools in wrap-up**: By providing an empty tools array, the LLM is forced to respond with text only, ensuring a quick conclusion.

3. **Callback system**: The `onNeglected()` callback pattern allows different subsystems (like `exec`) to react to ESC press without tight coupling.

4. **Flag-based state**: A simple boolean flag makes it easy to check neglected mode throughout the codebase.

5. **Automatic recovery**: The flag clears automatically after wrap-up, requiring no manual intervention.