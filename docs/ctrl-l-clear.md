# Ctrl+L Double-Press to Clear Chat History

## Feature Request

When the user presses Ctrl+L twice within 3 seconds at the prompt, clear the chat history (same effect as `/clear` slash command).

## Current Behavior

- **Ctrl+L once**: Clears the terminal screen (existing behavior in LineEditor)
- **Ctrl+L twice**: Currently just clears screen twice

## Proposed Behavior

- **Ctrl+L once**: Clears the terminal screen (unchanged)
- **Ctrl+L twice within 3s**: Clears the terminal screen AND clears chat history (same as `/clear`)

## Architecture Analysis

### Key Components

1. **Coordinator** (`src/index.ts`):
   - Handles raw stdin in TTY raw mode
   - Parses keys using `parseKeys()` from `key-parser.ts`
   - Forwards `KeyInfo` to Lead via IPC: `{ type: 'key', key }`

2. **AgentIO** (`src/loop/agent-io.ts`):
   - Receives key IPC messages
   - Forwards to active `LineEditor` via `handleKeyEvent()`
   - Manages `LineEditor` lifecycle

3. **LineEditor** (`src/utils/line-editor.ts`):
   - Handles key events in `handleKey()` method
   - Ctrl+L handling at line ~580:
     ```typescript
     if (key.ctrl && key.name === 'l') {
       this.stdout.write('\x1b[2J\x1b[H');
       this.screenStartRow = 0;
       this.render();
       return;
     }
     ```

4. **/clear command** (`src/slashes/clear.ts`):
   - Calls `triologue.clear()` and `clearWrapUp()`
   - Prints "Conversation cleared. Starting fresh."

### Data Flow for Ctrl+L

```
User presses Ctrl+L
  → Terminal (raw mode)
  → Coordinator receives bytes
  → parseKeys() creates KeyInfo: { name: 'l', ctrl: true, ... }
  → Coordinator sends IPC: { type: 'key', key }
  → Lead process receives IPC
  → AgentIO.handleKeyEvent() 
  → LineEditor.handleKey()
  → Clears screen: '\x1b[2J\x1b[H'
```

### Problem

The `LineEditor` has no access to:
- `Triologue` (conversation history)
- `/clear` slash command handler
- `clearWrapUp()` function

These are only available in the main Lead process context, not in the LineEditor.

## Solution Design

### Option 1: IPC Message to Coordinator (Complex)

Send IPC message from LineEditor to Coordinator requesting clear. This requires:
- LineEditor → AgentIO → Lead → Coordinator → Lead → /clear
- Too complex, adds latency

### Option 2: Callback in LineEditor (Clean)

Add an optional `onDoubleCtrlL` callback to LineEditor options. AgentIO can set this callback to trigger `/clear`.

**This is the recommended approach.**

### Option 3: New IPC Message Type (Medium)

Add a new IPC message type `'clear_conversation'` that the Coordinator sends to Lead, similar to `'neglection'`.

## Recommended Implementation (Option 2)

### Files to Modify

1. **`src/utils/line-editor.ts`**:
   - Add `lastCtrlLTime: number | null` field to track last Ctrl+L press
   - Add `onDoubleCtrlL?: () => void` to options
   - Modify Ctrl+L handler:
     - If < 3s since last Ctrl+L AND `onDoubleCtrlL` provided → call callback
     - Otherwise → clear screen and update timestamp

2. **`src/loop/agent-io.ts`**:
   - Pass `onDoubleCtrlL` callback to LineEditor in `ask()` method
   - Callback should trigger `/clear`-like behavior

3. **`src/slashes/clear.ts`**:
   - Extract clear logic into a reusable function that can be called from both slash command and callback

4. **`src/loop/states/prompt.ts`** or relevant state:
   - Need access to `Triologue` to call `clear()`

### Implementation Details

#### Step 1: Modify LineEditor

```typescript
interface LineEditorOptions {
  prompt: string;
  stdout: NodeJS.WriteStream;
  onDone: (value: string) => void;
  history?: string[];
  onDoubleCtrlL?: () => void;  // NEW: Optional callback for double Ctrl+L
}

// In class:
private lastCtrlLTime: number | null = null;
private static readonly CTRL_L_DOUBLE_PRESS_MS = 3000;

// In handleKey():
if (key.ctrl && key.name === 'l') {
  const now = Date.now();
  const timeSinceLast = this.lastCtrlLTime ? now - this.lastCtrlLTime : Infinity;
  
  if (timeSinceLast < LineEditor.CTRL_L_DOUBLE_PRESS_MS && this.onDoubleCtrlL) {
    // Double Ctrl+L within 3s - call callback
    this.lastCtrlLTime = null;
    this.onDoubleCtrlL();
    // Also clear screen
    this.stdout.write('\x1b[2J\x1b[H');
    this.screenStartRow = 0;
    this.render();
  } else {
    // Single Ctrl+L - just clear screen
    this.lastCtrlLTime = now;
    this.stdout.write('\x1b[2J\x1b[H');
    this.screenStartRow = 0;
    this.render();
  }
  return;
}
```

#### Step 2: AgentIO Integration

The challenge is that `AgentIO.ask()` creates the LineEditor, but doesn't have direct access to `Triologue`. The clear operation needs to:
1. Clear triologue
2. Clear wrap-up state  
3. Print confirmation message

We need to either:
- Pass a callback from the state machine (where Triologue is available)
- Or create an event that the state machine can listen to

**Recommended: Pass callback from AgentIO**

```typescript
// In agent-io.ts
class AgentIO {
  private onDoubleCtrlLCallback: (() => void) | null = null;

  setDoubleCtrlLCallback(callback: (() => void) | null): void {
    this.onDoubleCtrlLCallback = callback;
  }

  async ask(query: string, useAsPrompt: boolean = false): Promise<string> {
    // ...existing code...
    
    this.activeLineEditor = new LineEditor({
      prompt,
      stdout: process.stdout,
      onDone: (value: string) => { /* ... */ },
      history: this.lineHistory,
      onDoubleCtrlL: this.onDoubleCtrlLCallback || undefined,
    });
    
    // ...rest of code...
  }
}
```

#### Step 3: State Machine Integration

In the prompt state handler, set up the callback:

```typescript
// In prompt.ts or wherever PROMPT state is handled
agentIO.setDoubleCtrlLCallback(() => {
  triologue.clear();
  clearWrapUp();
  console.log(chalk.green('Conversation cleared. Starting fresh.'));
});
```

### Alternative: Simpler Approach Using AgentIO

Since `AgentIO` has access to the clear callback, and the callback is set from the state machine, we can keep it simple:

1. AgentIO stores a `clearConversation` callback
2. State machine sets this callback when it has Triologue
3. LineEditor calls the callback on double Ctrl+L
4. Callback clears triologue and prints message

### Edge Cases

1. **What if user presses Ctrl+L during LLM call?**
   - LineEditor is not active (only active during `ask()`)
   - Key events still flow through IPC but LineEditor doesn't process them
   - Double-press detection only works during prompt
   
2. **What about teammate processes?**
   - Teammates don't use LineEditor (they don't have direct user input)
   - Ctrl+L handling only affects Lead process
   
3. **What if callback throws?**
   - Wrap in try-catch to prevent crashing the LineEditor

## Summary

The implementation involves:
1. Adding `onDoubleCtrlL` callback to `LineEditorOptions`
2. Modifying `LineEditor.handleKey()` to detect double Ctrl+L
3. Adding `setDoubleCtrlLCallback()` to `AgentIO`
4. Setting up the callback in the prompt state handler
5. Callback clears triologue, clears wrap-up, prints confirmation

This approach keeps the concerns separated:
- LineEditor handles input detection
- AgentIO connects components
- State machine has access to Triologue for clearing