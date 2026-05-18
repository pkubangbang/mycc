---
updated_at: 2026-05-03
status: COMPLETED
completion_date: 2026-04-29
changelog:
  - "2026-05-03: Marked migration as COMPLETED - all phases executed successfully"
  - "2026-04-29: SQLite removed, memory-store.ts and worktree-store.ts implemented"
  - "2026-04-29: All tests passing, documentation updated"
---

# Migration Plan: Remove SQLite Dependency

> **✅ MIGRATION COMPLETED** - This migration was successfully executed in April 2026.
>
> **Result**: SQLite has been removed. The project now uses:
> - `src/context/memory-store.ts` for session-scoped data (issues, blockages, teammates)
> - `src/context/worktree-store.ts` for project-level data (worktrees)

## Executive Summary

This document outlined the plan to remove SQLite (`better-sqlite3`) from the project and replace it with in-memory storage for session-scoped data and JSON file storage for project-level data.

**Status**: ✅ **COMPLETED** (April 2026)

## Current State Analysis

### SQLite Tables

| Table | Scope | Purpose | Migration Target |
|-------|-------|---------|-------------------|
| `issues` | Session-scoped | Task tracking | In-memory Map |
| `issue_blockages` | Session-scoped | Blocking relationships | In-memory Map |
| `teammates` | Session-scoped | Teammate state | In-memory Map (already partially exists in team.ts) |
| `worktrees` | **Project-level** | Git worktree tracking | JSON file (`.mycc/worktrees.json`) |

### Files Using SQLite

| File | Imports from db.ts | Usage |
|------|-------------------|-------|
| `src/context/issue.ts` | `getDb`, `getSessionContext` | CRUD for issues/blockages |
| `src/context/team.ts` | `getDb`, `getSessionContext`, `getMyccDir` | Teammate state sync |
| `src/context/wt.ts` | `getDb` | Worktree CRUD |
| `src/context/db.ts` | (source) | SQLite init, schema, helpers |
| `src/context/loader.ts` | `getToolsDir`, `getSkillsDir`, `getUserToolsDir`, `getUserSkillsDir`, `ensureDirs` | Directory helpers only |
| `src/context/mail.ts` | `getMailDir`, `ensureDirs` | Directory helpers only |
| `src/context/wiki.ts` | `getWikiLogsDir`, `getWikiDbDir`, `getWikiDomainsFile`, `ensureDirs` | Directory helpers only |
| `src/context/teammate-worker.ts` | `getMyccDir` | Directory helper only |
| `src/loop/agent-loop.ts` | `clearSessionData`, `getMyccDir`, `setSessionContext` | Session management |
| `src/loop/triologue.ts` | `getMyccDir`, `getLongtextDir`, `ensureDirs` | Directory helpers |
| `src/slashes/wiki.ts` | `getWikiLogsDir`, `getWikiDomainsFile`, `ensureDirs` | Directory helpers |
| `src/slashes/load.ts` | `getSessionContext` | Session context |
| `src/slashes/domain.ts` | `getWikiDomainsFile`, `ensureDirs` | Directory helpers |

### Directory Helpers in db.ts (Move to config.ts)

```typescript
// Directory helpers - NO database dependency, just path utilities
export function getMyccDir(): string
export function getMailDir(): string
export function getToolsDir(): string
export function getSkillsDir(): string
export function getSessionsDir(): string
export function getLongtextDir(): string
export function getUserToolsDir(): string
export function getUserSkillsDir(): string
export function getWikiDir(): string
export function getWikiLogsDir(): string
export function getWikiDbDir(): string
export function getWikiDomainsFile(): string
export function ensureDirs(): void
```

### Session Context in db.ts (Move to config.ts)

```typescript
let currentSessionId: string | null = null;
export function setSessionContext(sessionId: string): void
export function getSessionContext(): string
```

---

## Migration Phases

### Phase 1: Create Infrastructure (No Breaking Changes)

**Goal:** Create new modules without removing SQLite yet.

#### 1.1 Create `src/context/memory-store.ts`

```typescript
/**
 * memory-store.ts - In-memory storage for session-scoped data
 * 
 * This module provides volatile storage that exists only for the
 * duration of the session. Data is lost when the process exits.
 */

import type { Issue, Teammate, TeammateStatus } from '../types.js';

// In-memory stores (session-scoped)
let issues: Map<number, Issue> = new Map();
let blockages: Map<string, { blocker: number; blocked: number }> = new Map();
let teammates: Map<string, Teammate> = new Map();

// ID counter for issues
let nextIssueId = 1;

// Blockage key helper
function blockageKey(blocker: number, blocked: number): string {
  return `${blocker}:${blocked}`;
}

// Issue operations
export function createIssue(title: string, content: string, blockedBy: number[]): number {
  const id = nextIssueId++;
  const now = new Date();
  
  const issue: Issue = {
    id,
    title,
    content,
    status: 'pending',
    blockedBy: [],
    blocks: [],
    comments: [{
      poster: 'system',
      content: `Created issue "${title}"`,
      timestamp: now,
    }],
    createdAt: now,
  };
  
  issues.set(id, issue);
  
  // Create blockages
  for (const blockerId of blockedBy) {
    createBlockage(blockerId, id);
  }
  
  return id;
}

export function getIssue(id: number): Issue | undefined {
  return issues.get(id);
}

export function listIssues(): Issue[] {
  return Array.from(issues.values());
}

export function updateIssue(id: number, updates: Partial<Issue>): boolean {
  const issue = issues.get(id);
  if (!issue) return false;
  issues.set(id, { ...issue, ...updates });
  return true;
}

export function addIssueComment(id: number, comment: string, poster: string): boolean {
  const issue = issues.get(id);
  if (!issue) return false;
  issue.comments.push({ poster, content: comment, timestamp: new Date() });
  return true;
}

// Blockage operations
export function createBlockage(blocker: number, blocked: number): void {
  blockages.set(blockageKey(blocker, blocked), { blocker, blocked });
  
  // Update issue relationships
  const blockedIssue = issues.get(blocked);
  const blockerIssue = issues.get(blocker);
  if (blockedIssue && !blockedIssue.blockedBy.includes(blocker)) {
    blockedIssue.blockedBy.push(blocker);
  }
  if (blockerIssue && !blockerIssue.blocks.includes(blocked)) {
    blockerIssue.blocks.push(blocked);
  }
}

export function removeBlockage(blocker: number, blocked: number): void {
  blockages.delete(blockageKey(blocker, blocked));
  
  // Update issue relationships
  const blockedIssue = issues.get(blocked);
  const blockerIssue = issues.get(blocker);
  if (blockedIssue) {
    blockedIssue.blockedBy = blockedIssue.blockedBy.filter(id => id !== blocker);
  }
  if (blockerIssue) {
    blockerIssue.blocks = blockerIssue.blocks.filter(id => id !== blocked);
  }
}

// Teammate operations
export function createTeammate(name: string, role: string, prompt: string): void {
  teammates.set(name, {
    name,
    role,
    status: 'working',
    prompt,
    createdAt: new Date(),
  });
}

export function getTeammate(name: string): Teammate | undefined {
  return teammates.get(name);
}

export function listTeammates(): Teammate[] {
  return Array.from(teammates.values());
}

export function updateTeammateStatus(name: string, status: TeammateStatus): boolean {
  const teammate = teammates.get(name);
  if (!teammate) return false;
  teammate.status = status;
  return true;
}

export function removeTeammate(name: string): boolean {
  return teammates.delete(name);
}

// Clear all session data (for clearSessionData)
export function clearAll(): void {
  issues.clear();
  blockages.clear();
  teammates.clear();
  nextIssueId = 1;
}
```

#### 1.2 Create `src/context/worktree-store.ts`

```typescript
/**
 * worktree-store.ts - Persistent worktree storage using JSON
 * 
 * Worktrees are project-level resources that persist across sessions.
 * Uses .mycc/worktrees.json for persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkTree } from '../types.js';
import { getMyccDir } from './config.js';

const WORKTREES_FILE = 'worktrees.json';

function getWorktreesFile(): string {
  return path.join(getMyccDir(), WORKTREES_FILE);
}

function ensureFile(): void {
  const file = getWorktreesFile();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '[]', 'utf-8');
  }
}

export function loadWorktrees(): WorkTree[] {
  ensureFile();
  const file = getWorktreesFile();
  const content = fs.readFileSync(file, 'utf-8');
  const data = JSON.parse(content);
  return data.map((w: WorkTree) => ({
    ...w,
    createdAt: new Date(w.createdAt),
  }));
}

export function saveWorktrees(worktrees: WorkTree[]): void {
  ensureFile();
  const file = getWorktreesFile();
  fs.writeFileSync(file, JSON.stringify(worktrees, null, 2), 'utf-8');
}

export function addWorktree(worktree: WorkTree): void {
  const worktrees = loadWorktrees();
  const existing = worktrees.findIndex(w => w.name === worktree.name);
  if (existing >= 0) {
    worktrees[existing] = worktree;
  } else {
    worktrees.push(worktree);
  }
  saveWorktrees(worktrees);
}

export function removeWorktree(name: string): boolean {
  const worktrees = loadWorktrees();
  const index = worktrees.findIndex(w => w.name === name);
  if (index < 0) return false;
  worktrees.splice(index, 1);
  saveWorktrees(worktrees);
  return true;
}

export function getWorktree(name: string): WorkTree | undefined {
  const worktrees = loadWorktrees();
  return worktrees.find(w => w.name === name);
}
```

#### 1.3 Create `src/context/config.ts`

Move all directory helpers and session context from `db.ts`:

```typescript
/**
 * config.ts - Configuration, directory helpers, and session context
 * 
 * Centralized configuration management without database dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Constants
// ============================================================================

export const MYCC_DIR = '.mycc';

// ============================================================================
// Session Context
// ============================================================================

let currentSessionId: string | null = null;

export function setSessionContext(sessionId: string): void {
  currentSessionId = sessionId;
}

export function getSessionContext(): string {
  if (!currentSessionId) {
    throw new Error('Session context not initialized. Call setSessionContext() first.');
  }
  return currentSessionId;
}

// ============================================================================
// Directory Helpers
// ============================================================================

export function getMyccDir(): string {
  return path.resolve(MYCC_DIR);
}

export function getMailDir(): string {
  return path.join(MYCC_DIR, 'mail');
}

export function getToolsDir(): string {
  return path.join(MYCC_DIR, 'tools');
}

export function getSkillsDir(): string {
  return path.join(MYCC_DIR, 'skills');
}

export function getSessionsDir(): string {
  return path.join(MYCC_DIR, 'sessions');
}

export function getLongtextDir(): string {
  return path.join(MYCC_DIR, 'longtext');
}

export function getUserToolsDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'tools');
}

export function getUserSkillsDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'skills');
}

export function getWikiDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'wiki');
}

export function getWikiLogsDir(): string {
  return path.join(getWikiDir(), 'logs');
}

export function getWikiDbDir(): string {
  return path.join(getWikiDir(), 'db');
}

export function getWikiDomainsFile(): string {
  return path.join(getWikiDir(), 'domains.json');
}

// ============================================================================
// Directory Initialization
// ============================================================================

export function ensureDirs(): void {
  const dirs = [
    MYCC_DIR,
    getMailDir(),
    getToolsDir(),
    getSkillsDir(),
    getSessionsDir(),
    getLongtextDir(),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  
  // Wiki directories are in ~/.mycc-store, not project .mycc
  const wikiDirs = [getWikiDir(), getWikiLogsDir(), getWikiDbDir()];
  for (const dir of wikiDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ============================================================================
// Session Data Clear
// ============================================================================

/**
 * Clear session data for the current session only
 * Clears in-memory stores and mail files
 */
export function clearSessionData(): void {
  // Import dynamically to avoid circular dependency
  const { clearAll } = require('./memory-store.js');
  clearAll();
  
  // Clear mail files
  const mailDir = getMailDir();
  if (fs.existsSync(mailDir)) {
    const mailFiles = fs.readdirSync(mailDir).filter(f => f.endsWith('.jsonl'));
    for (const file of mailFiles) {
      fs.unlinkSync(path.join(mailDir, file));
    }
  }
}
```

---

### Phase 2: Update Modules to Use New Stores

#### 2.1 Update `src/context/issue.ts`

Replace SQLite with `memory-store`:

```typescript
import * as MemoryStore from './memory-store.js';

export class IssueManager implements IssueModule {
  async createIssue(title: string, content: string, blockedBy: number[] = []): Promise<number> {
    return MemoryStore.createIssue(title, content, blockedBy);
  }

  async getIssue(id: number): Promise<Issue | undefined> {
    return MemoryStore.getIssue(id);
  }

  async listIssues(): Promise<Issue[]> {
    return MemoryStore.listIssues();
  }

  async claimIssue(id: number, owner: string): Promise<boolean> {
    const issue = MemoryStore.getIssue(id);
    if (!issue || issue.status !== 'pending') return false;
    
    MemoryStore.updateIssue(id, { status: 'in_progress', owner });
    MemoryStore.addIssueComment(id, `Claimed by @${owner}`, 'system');
    return true;
  }

  async closeIssue(id: number, status: 'completed' | 'failed' | 'abandoned', comment?: string, poster?: string): Promise<void> {
    const issue = MemoryStore.getIssue(id);
    if (!issue) return;
    
    MemoryStore.updateIssue(id, { status });
    MemoryStore.addIssueComment(id, `Status changed to ${status}`, 'system');
    
    if (comment) {
      MemoryStore.addIssueComment(id, comment, poster || issue.owner || 'anonymous');
    }
    
    // Remove blockages where this issue is the blocker
    for (const blockedId of issue.blocks) {
      MemoryStore.removeBlockage(id, blockedId);
    }
  }

  async addComment(id: number, comment: string, poster?: string): Promise<void> {
    MemoryStore.addIssueComment(id, comment, poster || 'anonymous');
  }

  async createBlockage(blocker: number, blocked: number): Promise<void> {
    MemoryStore.createBlockage(blocker, blocked);
  }

  async removeBlockage(blocker: number, blocked: number): Promise<void> {
    MemoryStore.removeBlockage(blocker, blocked);
  }
  
  // ... printIssues, printIssue remain same (just call listIssues/getIssue)
}
```

#### 2.2 Update `src/context/team.ts`

Remove SQLite sync, keep existing in-memory Maps:

```typescript
// Remove these imports:
// import { getDb, getSessionContext } from './db.js';

// Add these imports:
import { getMyccDir } from './config.js';
import * as MemoryStore from './memory-store.js';

// Remove database operations:
// - this.updateDbStatus() calls
// - db.prepare() calls
// - stmt.run() calls

// In createTeammate():
// Remove: db.prepare(`INSERT OR REPLACE INTO teammates...`).run()
// Add: MemoryStore.createTeammate(name, role, prompt)

// In getTeammate():
// Use MemoryStore.getTeammate() + process map

// In listTeammates():
// Use MemoryStore.listTeammates()

// In removeTeammate():
// Remove: db.prepare(`DELETE FROM teammates...`).run()
// Add: MemoryStore.removeTeammate(name)

// In dismissTeam():
// Remove: db.prepare(`DELETE FROM teammates...`).run()
// Iterate and call MemoryStore.removeTeammate()
```

#### 2.3 Update `src/context/wt.ts`

Replace SQLite with JSON file storage:

```typescript
import * as WorktreeStore from './worktree-store.js';

export class WorktreeManager implements WtModule {
  async syncWorkTrees(): Promise<void> {
    // Get actual git worktrees
    const gitWorktrees = this.getGitWorktrees();
    const dbWorktrees = WorktreeStore.loadWorktrees();
    
    // Reconcile differences
    // ... sync logic using WorktreeStore.addWorktree/removeWorktree
  }

  async createWorkTree(name: string, branch: string): Promise<string> {
    // Check if exists
    if (WorktreeStore.getWorktree(name)) {
      return `Error: Worktree '${name}' already exists`;
    }
    
    // Create via git
    // ...
    
    // Save to JSON
    WorktreeStore.addWorktree({
      name,
      path: wtPath,
      branch,
      createdAt: new Date(),
    });
    
    return `Created worktree '${name}' at ${wtPath} on branch ${branch}`;
  }

  async printWorkTrees(): Promise<string> {
    const worktrees = WorktreeStore.loadWorktrees();
    // ... format output
  }

  async getWorkTreePath(name: string): Promise<string> {
    const wt = WorktreeStore.getWorktree(name);
    if (!wt) throw new Error(`Worktree '${name}' not found`);
    return wt.path;
  }

  async removeWorkTree(name: string): Promise<void> {
    // Remove via git
    // ...
    
    // Remove from JSON
    WorktreeStore.removeWorktree(name);
  }
}
```

#### 2.4 Update all imports

Update all files that import from `db.ts`:

```typescript
// Before:
import { getMailDir, ensureDirs } from '../context/db.js';

// After:
import { getMailDir, ensureDirs } from '../context/config.js';
```

Affected files:
- `src/context/loader.ts`
- `src/context/mail.ts`
- `src/context/wiki.ts`
- `src/context/teammate-worker.ts`
- `src/loop/agent-loop.ts`
- `src/loop/triologue.ts`
- `src/slashes/wiki.ts`
- `src/slashes/load.ts`
- `src/slashes/domain.ts`

---

### Phase 3: Remove SQLite

#### 3.1 Remove db.ts

```bash
rm src/context/db.ts
```

#### 3.2 Remove from package.json

```json
// Remove from dependencies:
"better-sqlite3": "^12.8.0",

// Remove from devDependencies:
"@types/better-sqlite3": "^7.6.13",
```

#### 3.3 Run pnpm install

```bash
pnpm install
```

---

### Phase 4: Testing & Cleanup

#### 4.1 Test all affected features

1. **Issue operations**: create, list, claim, close, comment, blockage
2. **Team operations**: create teammate, list, status updates, remove
3. **Worktree operations**: create, list, enter, leave, remove, sync
4. **Session operations**: clear session, restore session
5. **IPC operations**: child process access to issues/team/worktrees

#### 4.2 Update documentation

1. Remove `docs/database-schema.md` (archived)
2. Update `CLAUDE.md` to remove SQLite references
3. Update `README.md` if needed

---

## Migration Checklist

### Phase 1: Create Infrastructure
- [x] Create `src/context/memory-store.ts`
- [x] Create `src/context/worktree-store.ts`
- [x] Create `src/context/config.ts`
- [x] Add unit tests for new modules

### Phase 2: Update Modules
- [x] Update `src/context/issue.ts` to use MemoryStore
- [x] Update `src/context/team.ts` to use MemoryStore
- [x] Update `src/context/wt.ts` to use WorktreeStore
- [x] Update all imports from `db.ts` to `config.ts`
- [x] Update IPC handlers if needed

### Phase 3: Remove SQLite
- [x] Delete `src/context/db.ts`
- [x] Remove `better-sqlite3` from package.json
- [x] Remove `@types/better-sqlite3` from package.json
- [x] Run `pnpm install`

### Phase 4: Testing & Cleanup
- [x] Test issue operations
- [x] Test team operations
- [x] Test worktree operations
- [x] Test session operations
- [x] Test child process IPC
- [x] Update documentation

---

## Risk Assessment

### Low Risk
- **Issues/Blockages**: In-memory storage is sufficient, session-scoped
- **Teammates**: Already have in-memory state, DB is just backup
- **Directory helpers**: No logic change, just move to config.ts

### Medium Risk
- **Worktrees**: JSON file persistence is less robust than SQLite
  - Mitigation: Sync with `git worktree list` on startup
  - Mitigation: Atomic write pattern (write to temp, rename)

### Edge Cases
1. **Concurrent writes**: JSON file could have race conditions
   - Mitigation: Use synchronous writes, single-threaded Node.js
   
2. **Corrupted JSON**: Manual edits could break the file
   - Mitigation: Try/catch on load, fallback to empty array
   
3. **Session restore**: Old sessions reference SQLite data
   - Mitigation: Session restore works on triologue, not SQLite
   - Note: Issues/teammates won't restore (by design)

---

## Benefits

1. **Simpler dependencies**: Remove native compilation requirement
2. **Faster startup**: No database initialization
3. **Fewer files**: Remove `.mycc/state.db*` (3-4 files)
4. **Cleaner architecture**: Separate concerns (memory vs persistent)
5. **Easier testing**: Mock memory store instead of database