---
updated_at: 2026-05-03
changelog:
  - "2026-05-03: Updated database references - now uses in-memory storage (memory-store.ts)"
  - "2026-05-03: Removed SQLite database references, updated implementation section"
---

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

### Status Updates (`src/context/parent/team.ts`)

The `handleChildMessage` function handles status updates:
```typescript
if (status === 'working') {
  // Phase 1 complete: move subscribers to phase 2
} else if (status === 'idle' || status === 'shutdown' || status === 'holding') {
  // Phase 2 complete: resolve all waiting
}
```

### Question Handling (`src/context/child/core.ts`)

When asking a question:
```typescript
async question(query: string, asker: string, options?: { onEsc?: string; onEnter?: string }): Promise<AskResult> {
  sendStatus('holding');  // Transition to holding
  try {
    return await ipc.sendRequest<AskResult>('question', { query, asker, options }, 0);
  } finally {
    sendStatus('working');  // Resume working
  }
}
```

### awaitTeam Logic (`src/context/parent/team.ts`)
```typescript
async awaitTeam(_timeout?: number): Promise<{ result: string }> {
  // 1. If no teammates or all shutdown → "no teammates"
  // 2. If any holding → "got question" (immediate)
  // 3. If nobody working → "all done"
  // 4. Wait for each working teammate via awaitTeammate (respects ETA deadlines)
  // 5. After all resolve, check for holding → "got question", else → "all done"
}
```

### awaitTeammate Logic (`src/context/parent/team.ts`)
```typescript
async awaitTeammate(name: string, defaultTimeout: number = 300000): Promise<{ waited: boolean }> {
  const status = this.statuses.get(name);

  // Subscribe to phase 2 (working → non-working transition)
  // - holding → resolve immediately
  // - working → subscribe to phase 2
  // - idle/shutdown/undefined → subscribe to phase 1 (will move to phase 2 when working starts)

  // Dynamic timeout: uses teammate ETA deadline (from mail_to eta_update)
  // Polls every 1s; also resolves if lead has new mail or ESC pressed
  await Promise.race([promise, timeoutPromise]);
  return { waited: true };
}
```

## Storage

The status is stored in-memory via `memory-store.ts`:

```typescript
// src/context/memory-store.ts
const teammates: Map<string, Teammate> = new Map();

export function updateTeammateStatus(name: string, status: TeammateStatus): boolean {
  const teammate = teammates.get(name);
  if (!teammate) return false;
  teammate.status = status;
  return true;
}
```

**Note**: Teammate data is session-scoped and lost when the process exits. No database persistence.