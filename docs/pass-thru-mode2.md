# Pass-Through Mode v2

Design document for interactive subprocess support in the agent loop.

## Overview

Pass-through mode enables real-time interaction with long-running subprocess commands (e.g., `vim`, `htop`, `mysql`). When activated, the terminal I/O is routed directly between the user and the subprocess, bypassing the agent loop's normal processing.

## Architecture

```
┌─────────────┐     IPC      ┌─────────────┐     spawn    ┌─────────────┐
│ Coordinator │ ◄──────────► │    Lead     │ ◄──────────► │  Subprocess │
│  (index.ts) │             │ (agent-io)  │              │  (bash -c)  │
└─────────────┘             └─────────────┘              └─────────────┘
      │                           │                             │
      │                           │                             │
   Terminal                   Agent Loop                   Command
   (stdin/stdout)             (LLM tools)                 (interactive)
```

## Key Components

### 1. ReplayBuffer Class (`src/loop/agent-io.ts`)

A buffer class for collecting stdout/stderr bytes with dual output formats:

```typescript
class ReplayBuffer {
  write(data: Buffer | string): void;    // Write bytes into buffer
  getString(): string;                    // Get content as UTF-8 string
  getBase64(): string;                    // Get content as base64 (for IPC)
}
```

### 2. AgentIO State (`src/loop/agent-io.ts`)

```typescript
private attachMode = false;                    // Currently in attach mode
private attachedSubprocess: ChildProcess | null; // Reference to subprocess
```

### 3. Coordinator State (`src/index.ts`)

```typescript
let attachMode = false;      // Active attach mode
let pendingAttach = false;   // Waiting for attach_ack
let logBuffer: Buffer[] = []; // Buffered logs during attach
```

## IPC Message Flow

### Entering Attach Mode

```
User          Coordinator           Lead               Subprocess
 │                 │                   │                    │
 │  F12            │                   │                    │
 ├────────────────►│                   │                    │
 │                 │  {type:'attach'}  │                    │
 │                 ├──────────────────►│                    │
 │                 │  pendingAttach=T  │                    │
 │                 │                   │  attachMode=T      │
 │                 │  {type:'attach_ack'}                    │
 │                 │◄──────────────────┤                    │
 │                 │  attachMode=T     │                    │
 │                 │                   │                    │
```

### During Attach Mode

```
User          Coordinator           Lead               Subprocess
 │                 │                   │                    │
 │  stdin          │                   │                    │
 ├────────────────►│                   │                    │
 │                 │ {type:'raw_bytes'}│                    │
 │                 ├──────────────────►│                    │
 │                 │                   │  stdin.write()     │
 │                 │                   ├───────────────────►│
 │                 │                   │                    │
 │                 │                   │  stdout            │
 │                 │                   │◄───────────────────┤
 │                 │ {type:'raw_bytes'}│                    │
 │                 │◄──────────────────┤                    │
 │  stdout         │                   │                    │
 │◄────────────────┤                   │                    │
 │                 │                   │                    │
```

### Exiting Attach Mode

```
Subprocess     Lead                Coordinator         User
 │                 │                   │                    │
 │  exit           │                   │                    │
 ├────────────────►│                   │                    │
 │                 │ {type:'detach'}   │                    │
 │                 ├──────────────────►│                    │
 │                 │                   │  flush buffer      │
 │                 │                   │  attachMode=F      │
 │                 │                   ├───────────────────►│
 │                 │                   │                    │
```

## IPC Message Types

### Coordinator → Lead

| Type | Fields | Description |
|------|--------|-------------|
| `attach` | - | Request to enter attach mode |
| `raw_bytes` | `data: string` (base64) | Raw stdin bytes for subprocess |
| `neglection` | - | ESC pressed, interrupt current operation |
| `key` | `key: KeyInfo` | Key event for LineEditor |
| `resize` | `columns: number` | Terminal resize event |

### Lead → Coordinator

| Type | Fields | Description |
|------|--------|-------------|
| `attach_ack` | - | Confirm attach mode is ready |
| `detach` | - | Exit attach mode (subprocess ended) |
| `raw_bytes` | `data: string` (base64) | Subprocess stdout to display |
| `ready` | - | Lead process initialized |
| `exit` | - | Request graceful shutdown |

## Exec Method Changes

The `exec()` method in `AgentIO` now supports attach mode:

```typescript
async exec(options: ExecOptions): Promise<ExecResult> {
  // 1. Validate timeout (1-30 seconds)
  // 2. Create ReplayBuffer for stdout/stderr
  // 3. Spawn subprocess with bash -c
  
  // In attach mode:
  // - Enable stdin pipe
  // - Store subprocess reference
  // - Disable timeout kill (runs until exit)
  // - Send stdout via IPC raw_bytes
  
  // Normal mode:
  // - stdin: 'ignore'
  // - Buffer stdout/stderr locally
  // - Kill on timeout
}
```

### Timeout Behavior

| Mode | Timeout | Behavior |
|------|---------|----------|
| Normal | Enforced | Kill with SIGKILL after timeout |
| Attach | Disabled | Run until subprocess exits or user detaches |

## Key Detection

F12 key triggers attach mode:

```typescript
// src/utils/key-parser.ts
export function isF12(data: Buffer): boolean {
  return data.toString('hex') === '1b5b32347e';
  // Escape sequence: ESC [ 2 4 ~
}
```

## Usage Flow

1. Agent starts a command (e.g., `vim file.txt`)
2. User presses F12 to enter attach mode
3. Coordinator sends `attach` to Lead
4. Lead responds with `attach_ack`, enters attach mode
5. Coordinator starts buffering logs
6. User interacts with subprocess directly:
   - Keystrokes → Coordinator → `raw_bytes` → Lead → subprocess.stdin
   - subprocess.stdout → Lead → `raw_bytes` → Coordinator → terminal
7. Subprocess exits
8. Lead sends `detach` to Coordinator
9. Coordinator flushes buffered logs, exits attach mode
10. Agent resumes normal operation

## Implementation Files

- `src/index.ts` - Coordinator IPC handling, F12 detection, log buffering
- `src/loop/agent-io.ts` - ReplayBuffer class, exec method, attach mode state
- `src/utils/key-parser.ts` - F12 key detection