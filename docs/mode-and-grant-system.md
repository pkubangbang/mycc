# Plan: Mode and Grant System for Child Processes

> **状态：已实施。** 模式系统和授权系统均已落地。保留为历史记录。
> **关键偏差：**
> - 授权评估器位于 `src/context/grant/grant-evaluator.ts`（非计划中的 `src/context/parent/grant.ts`），整个授权系统在 `src/context/grant/` 目录下（含 `bash-judge.ts`、`dangerous-commands.ts`、`intent-parser.ts`、`types.ts`、`index.ts`）。
> - Bash 授权使用 `judgeBash` 5 步判定流程（`bash-judge.ts`），非计划中的简单危险命令列表。支持 Intent Lang 解析、`dangerous=i_know`/`batch=i_know` 参数、`ask_user` 交互确认。
> - 计划模式（plan mode）不是一刀切拒绝：支持 `getAllowedFile()`（`plan_on` 指定的文件）和 plan-mode-writable 目录（如 `.mycc/longtext`、`.mycc/imgcache`）。
> - 无 worktree 的子进程在 normal 模式下可写入项目根目录（fallback），非计划中的直接拒绝。
> - `GrantRequest` 类型包含 `intent` 字段（bash 必需），见 `src/context/grant/types.ts`。
> - `requestGrant` 的 `args` 参数包含 `intent` 字段，见 `ChildCore.requestGrant` 和 `ParentContext.initializeIpcHandlers` 的 `grant_request` handler。

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
    intent?: string;
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

授权评估器位于 `src/context/grant/grant-evaluator.ts`，导出 `evaluateGrant` 函数。实际实现比计划更复杂：

```typescript
// src/context/grant/grant-evaluator.ts
export async function evaluateGrant(
  sender: string,
  request: GrantRequest,
  core: Core
): Promise<{ approved: boolean; reason?: string }> {
  const mode = core.getMode();
  const isChildProcess = sender !== 'lead';

  // 1. Bash 工具：使用 judgeBash 5 步判定流程（非简单危险命令列表）
  if (request.tool === 'bash') {
    const result = await judgeBash(
      request.command,
      request.intent || '',
      mode,
      isChildProcess,
      (query, asker, options) => core.question(query, asker, options).then(r => r.answer),
      core.escAware.bind(core)
    );
    return { approved: result.decision === 'allow', reason: result.reason };
  }

  // 2. 文件操作（write_file, edit_file）
  if (mode === 'plan') {
    // 计划模式不是一刀切拒绝：
    // a) 检查 getAllowedFile()（plan_on 指定的文件）
    // b) 检查 plan-mode-writable 目录（.mycc/longtext, .mycc/imgcache 等）
    // c) 其余拒绝
    ...
  }

  // 3. Normal 模式文件操作：检查 worktree 所有权（子进程）
  if (isChildProcess) {
    const worktrees = await listWorktrees(core.getWorkDir());
    const ownedWt = worktrees.find(wt => wt.name === sender);
    if (ownedWt) {
      // 在 owned worktree 内 → 自动授权
    }
    // 无 owned worktree → 允许写入项目根目录（fallback）
    if (resolved.startsWith(core.getWorkDir())) {
      return { approved: true };
    }
    // 项目根目录外 → 拒绝
  }

  // 4. Normal 模式 lead（父进程）：允许
  return { approved: true };
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

