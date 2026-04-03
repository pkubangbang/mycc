# Teammate Status State Machine

## Overview

Teammates (child process agents) have a status state machine that tracks their current state. This document describes the states, transitions, and semantics.

## Status Values

| Status | Meaning | Can Accept New Work? | Active LLM? | awaitTeam Returns? |
|--------|---------|---------------------|-------------|-------------------|
| `working` | Actively processing (executing tools, thinking) | No | Yes | No (wait) |
| `holding` | Blocked waiting for external input (e.g., user answer) | No | No | Yes (immediate) |
| `idle` | Waiting for new task (polling for mails/issues) | Yes | No | Yes (immediate) |
| `shutdown` | Process has exited | No | No | Yes (immediate) |

## State Diagram

```
                    ┌──────────────┐
                    │   spawned    │
                    └──────┬───────┘
                           │ spawn complete
                           ▼
                    ┌──────────────┐
         ┌──────────│   working    │◄──────────┐
         │          └──────────────┘           │
         │                    │                │
         │                    │ ask question   │ get answer
         │                    ▼                │
         │              ┌──────────────┐       │
         │              │   holding    │───────┘
         │              └──────────────┘
         │                    
         │ no tool calls     
         ▼                    
   ┌──────────────┐           
   │    idle      │◄──────┐   
   └──────────────┘       │   
         │    find work   │   
         └────────────────┘   
         │                    
         │ shutdown / SIGTERM
         ▼                    
   ┌──────────────┐
   │   shutdown   │
   └──────────────┘
```

## Transitions

### Spawn → Working
When a teammate is spawned, it immediately enters `working` status and processes its initial prompt.

### Working → Holding
When a teammate asks a question via `core.question()`, it transitions to `holding` status. This signals:
- The teammate is blocked and cannot proceed
- `awaitTeam` should return immediately (the lead can continue)
- The teammate should NOT be assigned new work

### Holding → Working
When the answer is received, the teammate transitions back to `working` status and continues processing.

### Working → Idle
When a teammate finishes its turn (no more tool calls), it enters the `idle` state:
- Checks for new mail
- Polls for auto-claimable issues
- Waits for new work

### Idle → Working
When a teammate finds new work (new mail or auto-claimed issue), it transitions back to `working`.

### Any → Shutdown
When the teammate process exits (gracefully or via signal), status becomes `shutdown`.

## Semantics

### Working
- The teammate is actively using LLM or executing tools
- Should NOT receive new tasks
- `awaitTeam` will wait until transition to idle/holding/shutdown

### Holding
- The teammate is blocked on external input (user answer, lead response)
- Should NOT receive new tasks
- `awaitTeam` returns immediately - lead can proceed
- No polling for issues (the teammate has unfinished work)

### Idle
- The teammate has no current task
- CAN receive new work via mail or auto-claim issues
- `awaitTeam` returns immediately - lead can proceed
- Polling loop checks for new work every 5 seconds

### Shutdown
- The teammate process has exited
- No further activity possible
- `awaitTeam` returns immediately

## Implementation

### Type Definition (`src/types.ts`)
```typescript
export type TeammateStatus = 'working' | 'idle' | 'holding' | 'shutdown';
```

### Status Updates (`src/context/team.ts`)
The `handleChildMessage` function handles status updates:
```typescript
if (status === 'working') {
  // Phase 1 complete: move subscribers to phase 2
} else if (status === 'idle' || status === 'shutdown' || status === 'holding') {
  // Phase 2 complete: resolve all waiting
}
```

### Question Handling (`src/context/child-context/core.ts`)
When asking a question:
```typescript
async question(query: string, asker: string): Promise<string> {
  sendStatus('holding');  // Transition to holding
  try {
    return await ipc.sendRequest(...);
  } finally {
    sendStatus('working');  // Resume working
  }
}
```

### awaitTeam Logic (`src/context/team.ts`)
```typescript
async awaitTeammate(name: string, timeout: number): Promise<{ waited: boolean }> {
  const status = this.statuses.get(name);
  
  // Already settled (not actively working)
  if (status === 'idle' || status === 'shutdown' || status === 'holding') {
    return { waited: false };
  }
  // ... wait for working → idle/holding/shutdown transition
}
```

## Database

The status is stored as a TEXT column in SQLite with no enum constraint:
```sql
CREATE TABLE teammates (
  name TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  status TEXT DEFAULT 'idle',
  prompt TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

New status values are automatically supported without migration.