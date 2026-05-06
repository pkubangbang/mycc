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
| `order` | Send task and block for results (mail_to + tm_await) |
| `hand_over` | Interactive terminal handover to user |
| `plan_on` | Switch to plan mode (block code changes) |
| `plan_off` | Exit plan mode |

### Teammate-Only Tools (scope: `['child']`)

| Tool | Purpose |
|------|---------|
| `question` | Ask user for clarification (routed through lead) |

### Shared Tools (scope: `['main', 'child']`)

Both lead and teammate agents can use these:

| Category | Tools |
|----------|-------|
| **Communication** | `mail_to`, `tm_print` |
| **File Operations** | `read_file`, `write_file`, `edit_file` |
| **Issue Management** | `issue_create`, `issue_close`, `issue_claim`, `issue_list`, `issue_comment`, `blockage_create`, `blockage_remove` |
| **Background Tasks** | `bg_create`, `bg_print`, `bg_remove`, `bg_await` |
| **Worktree** | `wt_create`, `wt_remove`, `wt_enter`, `wt_leave`, `wt_print` |
| **Information** | `time`, `bash`, `screen`, `read_picture`, `read_read` |
| **Knowledge** | `recall`, `skill_load`, `wiki_prepare`, `wiki_put`, `wiki_get`, `web_search`, `web_fetch` |
| **Status** | `todo_write`, `brief` |
| **Git** | `git_commit` |

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
│  │tm_create│  │broadcast│  │ order   │  │mail_to  │         │
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
| `order` | Lead → Teammate | Yes | Sequential workflows requiring results |

### Teammate Status Machine

```
  ┌─────────┐
  │ working │ ←──────────────────┐
  └────┬────┘                    │
       │ (task complete)         │ (new task via mail_to)
       ▼                         │
  ┌─────────┐                    │
  │  idle   │ ←──────────────┐   │
  └────┬────┘                │   │
       │ (shutdown request) │   │
       ▼                     │   │
  ┌─────────┐                │   │
  │ holding │ ───────────────┘   │
  └────┬────┘                    │
       │ (removed)              │
       ▼                         │
  ┌─────────┐                    │
  │shutdown │ ──────────────────┘
  └─────────┘
```

## Worktree Isolation

Teammates are restricted to their assigned worktree:

1. Lead creates worktree: `wt_create(name="feature", branch="feat-x")`
2. Lead spawns teammate with worktree assignment
3. Teammate's file operations are sandboxed to that worktree
4. Lead uses Grant system to validate all write requests from children

### Grant System

When a teammate requests to write a file:
1. Request sent via IPC to main process
2. Grant handler validates path is within assigned worktree
3. If valid, operation proceeds; otherwise, error returned

## Key Differences Summary

| Capability | Lead | Teammate |
|------------|------|----------|
| Spawn teammates | ✅ | ❌ |
| Remove teammates | ✅ | ❌ |
| Broadcast messages | ✅ | ❌ |
| Block for results (order) | ✅ | ❌ |
| Ask user (question) | ❌ | ✅ |
| Full project access | ✅ | ❌ (worktree only) |
| Direct tool access | ✅ | ❌ (IPC wrappers) |
| Use git_commit | ✅ | ✅ |
| File operations | ✅ | ✅ (sandboxed) |
| Use mail_to | ✅ | ✅ |
| Worktree operations | ✅ | ✅ |
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
- Use `order` when you need results before proceeding
- Use `tm_await` to wait for multiple teammates
- Teammates use `mail_to` to communicate with each other