# Lead vs Teammate Functionality Comparison

This document provides a comprehensive comparison of lead agent and teammate agent functionalities in the MyCC framework.

## Overview

| Aspect | Lead Agent | Teammate Agent |
|--------|------------|----------------|
| **Context Type** | `ParentContext` | `ChildContext` |
| **Process** | Main process | Spawned subprocess |
| **Access** | Direct module imports | IPC wrappers via message passing |
| **Isolation** | Full project access | Restricted to assigned worktree |

## Tool Scope Classification

### Lead-Only Tools (scope: `['main']`)

These tools are exclusively available to the lead agent:

| Tool | Purpose |
|------|---------|
| `tm_create` | Spawn new teammate agents |
| `tm_remove` | Terminate teammate processes |
| `tm_await` | Block until teammates finish |
| `broadcast` | Send message to all teammates at once |
| `hand_over` | Interactive terminal handover to user |
| `plan_on` | Switch to plan mode (block code changes) |
| `plan_off` | Exit plan mode |
| `checkpoint` | Create context checkpoint for exploration |
| `recap` | Summarize/abandon a checkpoint |
| `peers` | Peer discovery / cross-instance routing |
| `todo_pinning` | Pin todos and set reactivation conditions |

### Teammate-Only Tools (scope: `['child']`)

| Tool | Purpose |
|------|---------|
| `question` | Ask user for clarification (routed through lead) |

### Shared Tools (scope: `['main', 'child']`)

Both lead and teammate agents can use these:

| Category | Tools |
|----------|-------|
| **Communication** | `mail_to`, `tm_print`, `mycc_title` |
| **File Operations** | `read_file`, `write_file`, `edit_file`, `grep`, `bash`, `screen` |
| **Issue Management** | `issue_create`, `issue_close`, `issue_claim`, `issue_list`, `issue_publish`, `issue_comment`, `blockage_create`, `blockage_remove` |
| **Background Tasks** | `bg_create`, `bg_print`, `bg_remove`, `bg_await` |
| **Information** | `read_picture`, `read_read` |
| **Knowledge** | `recall`, `skill_load`, `skill_search`, `skill_compile`, `wiki_prepare`, `wiki_put`, `wiki_get`, `web_search`, `web_fetch` |
| **Status & Todos** | `todo_create`, `todo_update`, `brief` |
| **Git** | `git_commit` |

> **注**：不存在独立的 worktree 工具（无 `wt_create`/`wt_remove`/`wt_enter`/`wt_leave`/`wt_print`）。Worktree 通过 bash `git worktree` 命令操作，沙箱隔离由 spawn 的 `cwd` 参数 + 授权系统实现。

## Architecture Details

### Context Implementation

**ParentContext (Lead)**
- Direct access to all tool modules
- Full project directory access
- Manages teammate lifecycle
- Handles IPC server

**ChildContext (Teammate)**
- IPC wrappers that forward requests to main process
- Restricted to assigned worktree directory
- Cannot spawn other teammates
- Uses message passing for all operations

### Communication Patterns

```
┌─────────────────────────────────────────────────────────────┐
│                     Lead Agent (Main)                        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│  │tm_create│  │broadcast│  │tm_await │  │mail_to  │         │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘         │
└───────┼────────────┼────────────┼────────────┼───────────────┘
        │            │            │            │
        ▼            ▼            ▼            ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
   │Teammate1│  │Teammate2│  │Teammate3│  │TeammateN│
   └─────────┘  └─────────┘  └─────────┘  └─────────┘
        │            │            │            │
        └────────────┴────────────┴────────────┘
                     │
                     ▼ (teammate-to-teammate via mail_to)
```

### Mail Communication

| Method | Direction | Blocking | Use Case |
|--------|-----------|----------|----------|
| `mail_to` | Bidirectional | No | Async task assignment, notifications |
| `broadcast` | Lead → All | No | Announcements, coordinated actions |
| `tm_await` | Lead → Teammate(s) | Yes | Block until teammate(s) finish |

### Teammate Status Machine

状态类型：`TeammateStatus = 'working' | 'idle' | 'holding' | 'shutdown'`（见 `src/types.ts`）

```
  ┌─────────┐
  │ working │◄──────────────────┐
  └────┬────┘                   │
       │ (no tools + no todos)  │ (new mail / auto-claim)
       ▼                        │
  ┌─────────┐                   │
  │  idle   │───────────────────┘
  └────┬────┘
       │ (shutdown/disconnect/SIGTERM)
       ▼
  ┌─────────┐
  │shutdown │
  └─────────┘

  working ──(question())──► holding ──(answer received)──► working
```

- **working → idle**：LLM 返回无工具调用且无未完成 todo
- **idle → working**：收到新邮件或自动认领成功
- **working → holding**：调用 `question()` 等待用户回答
- **holding → working**：收到用户回答后恢复
- **idle/shutdown**：收到 shutdown 消息、进程断开、或终止信号

## Worktree Isolation

Teammates are restricted to their assigned worktree:

1. Lead creates worktree via bash: `git worktree add .worktrees/feature feat-x`
2. Lead spawns teammate with worktree assignment (`tm_create` `cwd` parameter)
3. Teammate's file operations are sandboxed to that worktree
4. Lead uses Grant system to validate all write requests from children

### Grant System

When a teammate requests to write a file:
1. Request sent via IPC (`grant_request`) to main process
2. Grant handler (`src/context/grant/grant-evaluator.ts`) validates path is within assigned worktree (queries `worktree-store.ts`)
3. If valid, operation proceeds; otherwise, error returned

## Key Differences Summary

| Capability | Lead | Teammate |
|------------|------|----------|
| Spawn teammates | ✅ | ❌ |
| Remove teammates | ✅ | ❌ |
| Broadcast messages | ✅ | ❌ |
| Block for results (tm_await) | ✅ | ❌ |
| Ask user (question) | ❌ | ✅ |
| Full project access | ✅ | ❌ (worktree only) |
| Direct tool access | ✅ | ❌ (IPC wrappers) |
| Use git_commit | ✅ | ✅ |
| File operations | ✅ | ✅ (sandboxed) |
| Use mail_to | ✅ | ✅ |
| Wiki operations | ✅ | ✅ |

## Best Practices

### When to Use Lead
- Task coordination and orchestration
- Creating/removing teammates
- Cross-worktree operations
- User interaction requiring terminal handover
- Making announcements to all teammates

### When to Use Teammates
- Parallel task execution
- Specialized roles (architect, reviewer, tester)
- Isolated feature development
- Tasks that can run independently
- Asking user for clarification (question tool)

### Communication Tips
- Use `broadcast` for team-wide announcements
- Use `mail_to` for async task assignment
- Use `tm_await` to wait for one or more teammates to finish
- Teammates use `mail_to` to communicate with each other