# Ctrl+L Double-Press to Clear Chat History

> **Status:** Implemented

## Feature

When the user presses Ctrl+L twice within 3 seconds at the prompt, the conversation history is cleared (same effect as `/clear` slash command, plus additional state resets).

## Behavior

- **Ctrl+L once**: Clears the terminal screen and shows a whisper line: "Press Ctrl+L again to clear history" (auto-clears after 3s).
- **Ctrl+L twice within 3s**: Clears the terminal screen, clears all conversation state (triologue, sequence, wrap-up, todos, issues), and shows "Conversation cleared. Starting fresh." as a whisper line.

## Implementation

### Where the logic lives

The double-press detection is in **`AgentIO.handleKeyEvent()`** (`src/loop/agent-io.ts`), NOT in `LineEditor`. This is the key architectural decision: `AgentIO` already intercepts all key events forwarded via IPC from the Coordinator, so it can track timing state across presses without modifying `LineEditor`.

`LineEditor` (`src/utils/line-editor.ts`) provides two primitive methods used by the feature:
- `clearScreen()` — writes `\x1b[2J\x1b[H`, resets `screenStartRow`, re-renders.
- `setWhisper(text, duration?)` — shows a hint line below the prompt; auto-clears after `duration` ms if provided.

### AgentIO fields and constants

```typescript
// In AgentIO class (src/loop/agent-io.ts)
private static readonly CTRL_L_DOUBLE_PRESS_MS = 3000;  // 3 seconds for double press
private lastCtrlLTime: number | null = null;
private onDoubleCtrlLCallback: (() => void) | null = null;
private whisperTimeout: ReturnType<typeof setTimeout> | null = null;
```

### handleKeyEvent() — Ctrl+L interception

When a Ctrl+L key event arrives via IPC, `handleKeyEvent()` intercepts it BEFORE forwarding to `LineEditor.handleKey()`:

1. **First press**: Records `lastCtrlLTime = now`, calls `activeLineEditor.clearScreen()`, shows whisper "Press Ctrl+L again to clear history" with a 3s auto-clear. Sets a `whisperTimeout` to reset `lastCtrlLTime` after 3s.
2. **Second press within 3s** (and callback is set): Calls `clearCtrlLState()` (resets `lastCtrlLTime`, clears `whisperTimeout`), calls `activeLineEditor.clearScreen()`, invokes `onDoubleCtrlLCallback()`, then sets whisper to "Conversation cleared. Starting fresh."
3. **Non-Ctrl+L keys**: Forwarded to `activeLineEditor.handleKey(key)` as normal.

`clearCtrlLState()` is a private helper that resets `lastCtrlLTime` to null and clears the whisper timeout + whisper line.

### Callback registration — agent-repl.ts

The callback is set in `agent-repl.ts` (the main entry point), NOT in `prompt.ts`. This is because `agent-repl.ts` has access to all the objects that need clearing (triologue, sequence, ctx.todo, ctx.issue) at startup time:

```typescript
// In agent-repl.ts main()
agentIO.setDoubleCtrlLCallback(() => {
  triologue.clear();
  sequence.clear();
  clearWrapUp();
  ctx.todo.clear();
  ctx.issue.clearAll();
});
```

This clears more state than the original `/clear` slash command: in addition to triologue and wrap-up, it also clears the hook sequence and all todos/issues.

### setDoubleCtrlLCallback()

```typescript
// In AgentIO class
setDoubleCtrlLCallback(callback: (() => void) | null): void {
  this.onDoubleCtrlLCallback = callback;
}
```

### Data flow

```
User presses Ctrl+L
  → Terminal (raw mode)
  → Coordinator receives bytes
  → parseKeys() creates KeyInfo: { name: 'l', ctrl: true, ... }
  → Coordinator sends IPC: { type: 'key', key }
  → Lead process receives IPC
  → AgentIO.handleKeyEvent()
  → Intercepts Ctrl+L:
      First press:  clearScreen() + whisper "Press Ctrl+L again..."
      Second press: clearScreen() + onDoubleCtrlLCallback() + whisper "Conversation cleared."
  → (Other keys forwarded to LineEditor.handleKey())
```

### Edge cases

1. **Ctrl+L during LLM call**: `LineEditor` is not active (only active during `ask()`). `handleKeyEvent()` returns early when `activeLineEditor` is null, so double-press detection only works during the PROMPT state.

2. **Teammate processes**: Teammates don't use `LineEditor` (no direct user input). Ctrl+L handling only affects the Lead process.

3. **Callback errors**: Wrapped in try-catch in `handleKeyEvent()` to prevent crashing the key handler.

4. **Whisper auto-clear**: After the first Ctrl+L, if the user doesn't press again within 3s, the whisper line auto-clears and `lastCtrlLTime` resets to null — the next Ctrl+L is treated as a fresh first press.

## Test coverage

Tests are in `src/tests/agent-io/ctrl-l.test.ts`, covering:
- Single Ctrl+L clears screen and shows whisper
- Double Ctrl+L within 3s triggers callback
- Double Ctrl+L after 3s timeout does NOT trigger callback
- `setDoubleCtrlLCallback(null)` disables the feature
- Callback errors are caught