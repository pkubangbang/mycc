# Session Isolation Implementation

## Problem Statement

The SQLite database (`state.db`) was shared globally across all sessions. When multiple `mycc` processes started in the same project directory, they would corrupt each other's state:

1. **`clearSessionData()` wiped everything**: Called at startup, it deleted ALL rows from tables.
2. **No session context in queries**: All database operations were global, not session-scoped.
3. **Race conditions**: Two sessions could overwrite each other's data.

## Solution

Added `session_id` column to all state tables and filter all queries by session.

## Implementation Status

✅ **COMPLETED** - All changes have been implemented and tested.

### Changes Made

#### 1. Schema Migration (`src/context/db.ts`)
- Added `session_id` column to all tables: `issues`, `issue_blockages`, `teammates`, `worktrees`
- Created session-scoped indexes for efficient queries
- Migration runs automatically on first startup

```sql
-- Added columns
ALTER TABLE issues ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE issue_blockages ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE teammates ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE worktrees ADD COLUMN session_id TEXT NOT NULL DEFAULT '';

-- Added indexes
CREATE INDEX idx_issues_session ON issues(session_id);
CREATE INDEX idx_teammates_session ON teammates(session_id);
CREATE INDEX idx_worktrees_session ON worktrees(session_id);
CREATE INDEX idx_blockages_session ON issue_blockages(session_id);
```

#### 2. Session Context Functions (`src/context/db.ts`)
```typescript
// Set session context at startup
export function setSessionContext(sessionId: string): void;

// Get current session ID (throws if not set)
export function getSessionContext(): string;
```

#### 3. Updated Modules
All modules now filter queries by `session_id`:
- `IssueManager` (`src/context/issue.ts`)
- `TeamManager` (`src/context/team.ts`)
- `WorktreeManager` (`src/context/wt.ts`)

#### 4. Session-Scoped Cleanup (`src/context/db.ts`)
```typescript
export function clearSessionData(): void {
  // Only clears data for current session
  // Falls back to global clear if no session context (legacy)
}
```

#### 5. Session Initialization (`src/loop/agent-loop.ts`)
```typescript
async function initializeSession(): Promise<SessionInit> {
  // Get or create session
  const result = sessionArg ? await restoreSession(sessionArg) : createNewSession();
  
  // Set session context BEFORE any database operations
  setSessionContext(getSessionId(result.sessionFilePath));
  
  // Clear only for new sessions
  if (!sessionArg) clearSessionData();
  
  return result;
}
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Coordinator   │     │   Coordinator   │
│   (Session A)   │     │   (Session B)   │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│     Lead A      │     │     Lead B      │
│ session_id=aaa  │     │ session_id=bbb  │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     ▼
         ┌─────────────────────────────────────┐
         │         .mycc/state.db               │
         │  ┌─────────────────────────────────┐│
         │  │ issues                          ││
         │  │ ├── id=1, session_id='aaa'      ││
         │  │ └── id=2, session_id='bbb'      ││
         │  ├─────────────────────────────────┤│
         │  │ teammates                       ││
         │  │ ├── name='bot1', session_id='aaa'│
         │  │ └── name='bot2', session_id='bbb'│
         │  └─────────────────────────────────┘│
         └─────────────────────────────────────┘
```

## Testing

Run the isolation test:
```bash
npx tsx scripts/test-session-isolation.ts
```

This verifies:
- Schema migration adds `session_id` columns
- Data from different sessions is isolated
- Session-scoped clear only affects current session
- No data leak between sessions