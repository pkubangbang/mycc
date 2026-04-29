# Plan: Mode and Grant System for Child Processes

## Executive Summary

Implement a **mode system** (`plan` / `normal`) combined with a **grant-based permission system** for child processes. In `plan` mode, all code changes are prohibited. In `normal` mode, children must request grants for sensitive operations outside their owned worktree.

---

## Part 1: Mode System

### Design Principle: Implementation-Only Methods

**Key insight:** `getMode()`/`setMode()` are **NOT declared in `CoreModule` interface**. They exist only inside `Core` (The main process's context). Add a `requestGrant` method to the CoreModule, and let the modifying tools call it before performing code changes.

### CoreModule Interface

```typescript
// src/types.ts
export interface CoreModule {
  // ... existing methods ...

  /**
   * Request grant from parent (child process only)
   * Parent's Core returns { approved: true } immediately (trusted)
   */
  requestGrant(tool: 'write_file' | 'edit_file' | 'bash', args: {
    path?: string;
    command?: string;
  }): Promise<{ approved: boolean; reason?: string }>;
}
```

### Core Implementation (Parent)

```typescript
// src/context/parent/core.ts
export class Core implements CoreModule {
  private modeState: 'plan' | 'normal' = 'normal';

  // NOT in CoreModule interface - implementation-only
  getMode(): 'plan' | 'normal' {
    return this.modeState;
  }

  // NOT in CoreModule interface - implementation-only
  setMode(mode: 'plan' | 'normal'): void {
    this.modeState = mode;
  }

  async requestGrant(tool: 'write_file' | 'edit_file' | 'bash', args: {
    path?: string;
    command?: string;
  }): Promise<{ approved: boolean; reason?: string }> {
    // Parent is trusted but still respects mode
    if (this.modeState === 'plan') {
      return {
        approved: false,
        reason: 'Code changes are prohibited in plan mode. Use /mode normal to enable modifications.',
      };
    }
    return { approved: true };
  }
}
```

### ChildCore Implementation

```typescript
// src/context/child/core.ts
export class ChildCore implements CoreModule {
  /**
   * No mode state stored here.
   * Child has zero knowledge of mode - always sends IPC to parent.
   */

  // In CoreModule interface - sends IPC to parent for evaluation
  async requestGrant(tool: 'write_file' | 'edit_file' | 'bash', args: {
    path?: string;
    command?: string;
  }): Promise<{ approved: boolean; reason?: string }> {
    // Always ask parent via IPC - parent knows the mode
    const response = await ipc.sendRequest<{ approved: boolean; reason?: string }>(
      'grant_request',
      { tool, ...args },
      5000
    );
    return response;
  }
}
```

### Child Process Mode Knowledge

Child processes **have zero knowledge of mode**:
- No mode state stored in ChildCore
- `requestGrant()` always sends IPC to parent
- Parent evaluates the request against its mode and worktree ownership
- Child just tries things and gets blocked by parent - pure "blunt" mindset

### `/mode` Slash Command

A slash command for manual mode control in the parent process:

**Usage:**
- `/mode` → "Currently in PLAN mode." or "Currently in NORMAL mode."
- `/mode plan` → "Mode changed to PLAN."
- `/mode normal` → "Mode changed to NORMAL."

### key insight: child process does not have mode or hook

There is no need to "create a read-only" child. Child processes are free to explore and request changes, only prohibited when the mode requires it. This keeps the teammate workflow simple.

## Part 2: Grant System

### Grant Flow

Note: It's the child process's responsibility to handle the permission. 
- write/edit/bash command MUST request grant;
- other tool MAY NEED grant but not required.

```
Child Process                          Main Process
     │                                      │
     │  1. Tool called (write/edit/bash)    │
     │                                      │
     │  2. requestGrant() sends IPC          │
     │─────────────────────────────────────▶│
     │                                      │
     │     3. Check mode: plan → reject      │
     │                                      │
     │     4. Check owned worktree:          │
     │        - In owned wt → Auto-grant    │
     │        - Outside wt → Reject         │
     │                                      │
     │  5. grant_response(approved, reason) │
     │◀─────────────────────────────────────│
     │                                      │
     │  6. Execute or reject                │
```

### Grant Request (IPC)

Use union type for type safety.

```typescript
// Child → Main
type GrantRequest =
  | {
      type: 'grant_request';
      reqId: number;
      tool: 'write_file' | 'edit_file';
      path: string;
      contentLength?: number;
    }
  | {
      type: 'grant_request';
      reqId: number;
      tool: 'bash';
      command: string;
      intent?: string;
      isDestructive?: boolean;
    };

// Main → Child
interface GrantResponse {
  type: 'grant_result';
  reqId: number;
  approved: boolean;
  reason?: string;      // If rejected
}
```

### Grant Evaluator (Main Process)

The parent evaluates grant requests from children:

```typescript
// src/context/parent/grant.ts
import * as path from 'path';
import type { Core } from './core.js';

export async function evaluateGrant(
  sender: string,
  request: Extract<GrantRequest, { tool: 'write_file' | 'edit_file' }> | Extract<GrantRequest, { tool: 'bash' }>,
  core: Core
): Promise<{ approved: boolean; reason?: string }> {
  // 1. Check mode first
  if (core.getMode() === 'plan') {
    return {
      approved: false,
      reason: 'Code changes are prohibited in plan mode.',
    };
  }

  // 2. File operations
  if (request.tool === 'write_file' || request.tool === 'edit_file') {
    // Check if sender owns a worktree
    const worktrees = loadWorktrees();
    const ownedWt = worktrees.find(wt => wt.name === sender);

    if (ownedWt) {
      const resolved = path.resolve(core.getWorkDir(), request.path);
      if (resolved.startsWith(ownedWt.path)) {
        return { approved: true };  // Auto-grant for owned worktree
      }
    }

    return {
      approved: false,
      reason: `'${request.path}' is outside your worktree. Teammates can only modify files within their assigned worktree.`,
    };
  }

  // 3. Bash commands
  if (request.tool === 'bash') {
    // Block dangerous commands
    const dangerous = ['rm -rf /', 'sudo rm', 'mkfs', 'dd if='];
    if (dangerous.some(d => request.command.includes(d))) {
      return { approved: false, reason: 'Dangerous command blocked' };
    }

    // Block git commit (must use git_commit tool)
    if (/\bgit\s+commit\b/.test(request.command)) {
      return { approved: false, reason: 'Use git_commit tool instead' };
    }

    // Auto-grant for owned worktree
    const worktrees = loadWorktrees();
    const ownedWt = worktrees.find(wt => wt.name === sender);
    if (ownedWt) {
      return { approved: true };
    }

    // Allow read-only commands for children without worktree
    const readOnly = /^git (status|log|diff|branch|show)/.test(request.command);
    if (readOnly) {
      return { approved: true };
    }

    return {
      approved: false,
      reason: `Cannot run '${request.command.slice(0, 50)}...' without an assigned worktree.`,
    };
  }

  return { approved: false, reason: `Unknown tool: ${(request as { tool: string }).tool}` };
}
```

## Tool Handler Pattern

Modifying tools (write/edit/bash) must call `requestGrant()` before performing changes:

```typescript
// Example: write.ts
handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
  const filePath = args.path as string;

  // Request grant - works for both parent and child
  const granted = await ctx.core.requestGrant('write_file', { path: filePath });
  if (!granted.approved) {
    return `Error: ${granted.reason}`;
  }

  // Execute the operation
  // ... existing logic ...
};
```

**Note:** No type coercion needed - `requestGrant()` is in `CoreModule` interface. Parent checks mode internally, child sends IPC to parent.

