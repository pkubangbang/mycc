# Neglected Mode

**Neglected Mode** (also called "neglection" in the codebase) is an interrupt mechanism that allows users to press **ESC** at any time to stop the agent's current operation and force it to wrap up quickly.

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
private onNeglectedCallbacks: Array<() => void> = [];

isNeglectedMode(): boolean {
  return this.neglectedModeFlag;
}

setNeglectedMode(value: boolean): void {
  this.neglectedModeFlag = value;
}
```

Key features:
- **Flag tracking**: `neglectedModeFlag` indicates if ESC was pressed this round
- **Callback system**: `onNeglected()` registers callbacks for ESC events
- **IPC handler**: Receives `{ type: 'neglection' }` messages from Coordinator

When neglection is triggered:
```typescript
if (msg.type === 'neglection') {
  if (!this.isNeglectedMode()) {
    this.setNeglectedMode(true);
    const controller = this.getLlmAbortController();
    if (controller) {
      controller.abort();
      console.log('\n[ESC] Interrupting LLM call...');
    } else {
      console.log('\n[ESC] Interrupt requested - will skip remaining work');
    }
    // Notify all neglected listeners
    for (const cb of this.onNeglectedCallbacks) {
      cb();
    }
    this.onNeglectedCallbacks = [];
  }
}
```

#### 3. Agent Loop (`src/loop/agent-loop.ts`)

The agent loop handles neglected mode at three key points:

**a) Before LLM call - empty tools array:**
```typescript
// In neglected mode, provide no tools so LLM can only respond with text
const tools = agentIO.isNeglectedMode() ? [] : loader.getToolsForScope(scope);
```

**b) After LLM call - check for abort:**
```typescript
// Check if ESC was pressed DURING this LLM call
if (abortController.signal.aborted) {
  console.log(chalk.yellow('[ESC] LLM response discarded due to interruption'));
  triologue.user('LLM call interrupted. Please wrap up and ask user for next steps.');
  continue;
}
```

**c) During tool execution - skip remaining tools:**
```typescript
for (const toolCall of assistantMessage.tool_calls) {
  if (agentIO.isNeglectedMode()) {
    console.log(chalk.yellow('\n[ESC] Tool execution interrupted - skipping remaining tools'));
    triologue.skipPendingTools(
      'Tool use interrupted - user pressed ESC.',
      'Tool use skipped due to ESC interruption.'
    );
    triologue.user('The user pressed ESC to interrupt. Please wrap up and wait for next instruction.');
    break;
  }
  // ... execute tool
}
```

**d) After wrap-up - clear flag:**
```typescript
// No tool calls = wrap-up complete
if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
  if (agentIO.isNeglectedMode()) {
    agentIO.setNeglectedMode(false);
  }
  // ... handle team await
}
```

#### 4. Ollama Client (`src/ollama.ts`)

The Ollama client shows a different spinner during neglected mode:

```typescript
const NEGLECTED_SPINNER_TEXT = 'Wrapping up...';

const neglected = config?.neglected ?? false;
startSpinner(neglected ? NEGLECTED_SPINNER_TEXT : 'Thinking');
```

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

The `exec()` function in `agent-io.ts` registers a neglection callback:

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
  | { type: 'neglection' }      // ESC pressed
  | { type: 'key'; key: KeyInfo }
  | { type: 'resize'; columns: number };
```

## Usage Example

```
User: run `sleep 30`
Tool: bash with timeout 35
Error: timeout must be an integer between 1 and 30, got: 35

User: [presses ESC]
[ESC] LLM call interrupted

LLM: I encountered a timeout constraint - the bash tool has a maximum timeout 
     of 30 seconds. Would you like me to:
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