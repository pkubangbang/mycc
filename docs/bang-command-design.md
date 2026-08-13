# Bang Command & hand_over Tool Design

> **Note**: This tool was originally planned as `tmux` but shipped as `hand_over`. The tool name, parameters, and implementation differ from the original plan. This document describes the actual implementation.

## Overview

The `hand_over` tool (`src/tools/hand_over.ts`) opens an external terminal popup for interactive command execution. The bang command (`!<command>`) is a UI shortcut that calls this tool.

## Two Terminals

| Terminal | Description | Role |
|----------|-------------|------|
| `mycc` | Main agent terminal | Prompts user, captures result |
| `popup` | External tmux terminal | User works interactively |

## Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ MYCC TERMINAL                                                    │
├─────────────────────────────────────────────────────────────────┤
│ agent >> !pnpm build                                            │
│                                                                 │
│ [popup opens in cwd, command typed into pane via send-keys]     │
│                                                                 │
│ Popup opened.                                                   │
│ Save tmux session? [y/N]                                        │
│                                                                 │
│ [user presses Enter (n) or y]                                   │
│                                                                 │
│ ─────────────────────────────────────                           │
│ User ran: pnpm build                                            │
│ Status: session closed (output captured below)                  │
│ Session name: mycc-1703123456                                   │
│ Next action: the session is closed; read the captured output... │
│ Output: ...                                                     │
│                                                                 │
│ agent >> _                                                      │
└─────────────────────────────────────────────────────────────────┘

For persistent sessions (npm run dev, ssh):

│ Save tmux session? [y/N] y                                      │
│                                                                 │
│ ─────────────────────────────────────                           │
│ User ran: npm run dev                                           │
│ Status: session still open (kept)                                │
│ Session name: mycc-1703123456                                   │
│ Next action: continue this interactive session with bash —      │
│   tmux send-keys -t mycc-1703123456 '<command>' Enter           │
│   tmux capture-pane -t mycc-1703123456 -p                       │
```

## Tool Composition

The `hand_over` tool is a **workflow lock** combining:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. todo: track session name (createTodo)                        │
│  2. bash(spawn): tmux new-session -d -s <name> -c <cwd> <shell> │
│  3. bash(spawn): tmux send-keys -t <name> " <command>" Enter    │
│  4. spawn: <terminal> -- tmux attach -t <name>                  │
│           ↓ (popup opens, detached)                              │
│  5. question: "Save tmux session? [y/N]"                        │
│           ↓ (user confirms)                                      │
│  6. bash: tmux capture-pane -t <name> -p -S -3000 -E -1        │
│  7. LLM: summarize if > 100 lines                               │
│  8. bash: kill-session (if not kept)                             │
│           ↓                                                      │
│  9. Return result string with status + next-action guidance     │
└─────────────────────────────────────────────────────────────────┘
```

**Why track session in todo:**
- Agent can remember active session across turns
- User can reference session name later
- Handles disconnect/reconnect scenarios

## Tool Definition

```typescript
// src/tools/hand_over.ts

export const handOverTool: ToolDefinition = {
  name: 'hand_over',
  description: `Opens a popup terminal and BLOCKS until the user finishes interacting, then captures and returns the terminal output. Use this when the task REQUIRES a human at the terminal — e.g. entering a password (sudo, SSH passphrase, 2FA), an interactive TUI (vim, htop, less), an SSH session, or anything that reads from a TTY.`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The single foreground command to hand to the user (e.g. sudo apt install X, ssh user@host, vim notes.txt). Do NOT prefix with tmux.',
      },
      intent: {
        type: 'string',
        description: 'REQUIRED: Explain why this command is needed (use intent language). OBJECT must be USER and VERB must be RUN.',
      },
    },
    required: ['command', 'intent'],
  },
  scope: ['main'],
  handler: (ctx, args) => handleHandOver(ctx, args),
};
```

**Key differences from the original `tmux` plan:**
- Tool name is `hand_over`, not `tmux`
- Parameters are `command` + `intent` (not `command` + `reason`)
- Intent must use `RUN USER` verb/object (validated by `parseIntent`)
- Command is sent to pane via `tmux send-keys` (spawn arg array), not passed as session shell-command
- Session is created with the detected shell (`getShellInfo().shell_cmd`)
- tmux nesting self-check: rejects any command starting with `tmux`
- Auto mode rejection: hand_over is disabled in auto mode
- User feedback path: if user types something other than y/n, it's returned as feedback

## Bang Command UI

The bang command (`!`) is a UI shortcut that calls the `hand_over` tool directly.

### Bang Detection

When user input starts with `!`, the command is extracted and `hand_over` is invoked with `command` set to the text after `!` and an appropriate intent.

## Use Cases

| Use Case | Command | Example |
|----------|---------|---------|
| Run local command | `!pnpm build` | Build with prompts |
| SSH session | `!ssh user@host` | Remote work |
| Interactive edit | `!vim file.txt` | Edit file |
| Open shell | `!` | Free-form work |

## Session Lifecycle

By default, sessions are **killed** after capture to prevent accumulation. But for long-running commands, user can choose to keep:

| User Input | Session State | Use Case |
|------------|---------------|----------|
| `n` (default) | Killed | `pnpm build`, `git push` |
| `y` | Kept | `npm run dev`, `ssh host` |

**Kept sessions are tracked in todo** via `ctx.todo.createTodo()`:
```
hand_over: [sessionName: mycc-1703123456]
```

**User can reattach manually:**
```
tmux attach -t mycc-1703123456
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| User types feedback (not y/n) | Session kept, feedback returned to LLM |
| No tmux installed | Show platform-specific install instructions |
| No terminal launcher | Error, suggest bash tool |
| Long output (>100 lines) | Summarized via LLM |
| Command starts with `tmux` | Rejected (would nest tmux inside hand_over's session) |
| Auto mode | Rejected up front (hand_over needs interactive terminal) |
| Intent validation fails | Socratic hint (names wrong dimension, withholds correct token) |

## Key Source Files

| File | Purpose |
|------|---------|
| `src/tools/hand_over.ts` | `hand_over` tool implementation |
| `src/utils/shell-detect.ts` | Shell detection (`getShellInfo()`) |
| `src/context/grant/intent-parser.ts` | Intent validation (`parseIntent`) |
| `src/engine/chat-provider.ts` | LLM summarization (`retryChat`, `MODEL`) |