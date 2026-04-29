# Session Storage (In-Memory)

> **Note**: This document describes the current in-memory storage architecture. The previous SQLite-based `state.db` has been removed.

## Overview

The system uses **in-memory storage** for session-scoped data via `src/context/memory-store.ts`:

- **Issue Management**: Tasks with blocking relationships (session-scoped)
- **Teammate Management**: Team member status (session-scoped)
- **Worktree Management**: Git worktree tracking (persisted in `.mycc/worktrees.json`)

**Key Point**: All session data (issues, teammates) is **volatile** - lost when the process exits. Only worktrees persist across sessions via JSON file.

## Architecture

### Session-Scoped Data (In-Memory)

Issues and teammates are stored in memory using `Map` structures:

```typescript
// src/context/memory-store.ts
const issues: Map<number, Issue> = new Map();
const blockages: Map<string, { blocker: number; blocked: number }> = new Map();
const teammates: Map<string, Teammate> = new Map();
```

**Benefits:**
- Simplicity - no database setup or migrations
- Performance - instant in-memory access
- Session isolation - clean state between sessions

**Limitations:**
- Data lost on process exit (by design)
- Not suitable for persistent task tracking

### Persisted Data

Only worktrees persist across sessions via `.mycc/worktrees.json`:

```json
{
  "teammate-name": {
    "name": "teammate-name",
    "path": "/path/to/worktree",
    "branch": "feature-branch",
    "createdAt": "2024-01-15T10:30:00.000Z"
  }
}
```

## Data Structures

### issues 表

存储持久化的任务（Issue）。

```sql
CREATE TABLE issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  status TEXT DEFAULT 'pending',
  owner TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  comments TEXT DEFAULT '[]'
)
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 主键，自动递增 |
| `title` | TEXT | 任务标题 |
| `content` | TEXT | 任务详细描述 |
| `status` | TEXT | 状态：`pending`, `in_progress`, `completed`, `failed`, `abandoned` |
| `owner` | TEXT | 认领者名称，NULL 表示未认领 |
| `created_at` | DATETIME | 创建时间 |
| `comments` | TEXT | 评论 JSON 数组 |

#### 索引

```sql
CREATE INDEX idx_issues_status ON issues(status);
CREATE INDEX idx_issues_owner ON issues(owner);
```

#### comments 字段格式

`comments` 字段存储 JSON 数组：

```json
[
  {
    "poster": "system",
    "content": "Created issue \"修复登录bug\"",
    "timestamp": "2024-01-15T10:30:00.000Z"
  },
  {
    "poster": "alice",
    "content": "开始处理",
    "timestamp": "2024-01-15T10:35:00.000Z"
  }
]
```

### issue_blockages 表

存储任务之间的阻塞关系。

```sql
CREATE TABLE issue_blockages (
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  FOREIGN KEY (blocker_id) REFERENCES issues(id),
  FOREIGN KEY (blocked_id) REFERENCES issues(id)
)
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `blocker_id` | INTEGER | 阻塞任务的 ID |
| `blocked_id` | INTEGER | 被阻塞任务的 ID |

#### 示例

如果 Issue #1 阻塞了 Issue #2，则：
- `blocker_id = 1`
- `blocked_id = 2`

这表示 Issue #2 必须等待 Issue #1 完成后才能开始。

#### 索引

```sql
CREATE INDEX idx_issue_blockages_blocker ON issue_blockages(blocker_id);
CREATE INDEX idx_issue_blockages_blocked ON issue_blockages(blocked_id);
```

### teammates 表

存储团队成员信息。

```sql
CREATE TABLE teammates (
  name TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  status TEXT DEFAULT 'idle',
  prompt TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | TEXT | 主键，成员名称 |
| `role` | TEXT | 成员角色（如 "developer", "architect"） |
| `status` | TEXT | 状态：`working`, `idle`, `shutdown` |
| `prompt` | TEXT | 初始提示词 |
| `created_at` | DATETIME | 创建时间 |

#### 状态说明

| 状态 | 说明 |
|------|------|
| `working` | 正在执行任务 |
| `idle` | 空闲，等待新任务 |
| `shutdown` | 进程已终止 |

### worktrees 表

存储 Git worktree 信息。

```sql
CREATE TABLE worktrees (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | TEXT | 主键，worktree 名称 |
| `path` | TEXT | 文件系统路径 |
| `branch` | TEXT | Git 分支名称 |
| `created_at` | DATETIME | 创建时间 |

## IPC Data Access

Child processes access data through IPC to the parent process:

```typescript
// Child process code
const issue = await ipc.sendRequest('db_issue_get', { id: 1 });
```

Parent process IPC handlers execute operations:

```typescript
// Parent process IPC handler
{
  messageType: 'db_issue_get',
  module: 'issue',
  handler: async (_sender, payload, ctx, sendResponse) => {
    const { id } = payload as { id: number };
    const issue = await ctx.issue.getIssue(id);
    sendResponse('db_result', true, issue);
  },
}
```

## Related Files

| File | Description |
|------|-------------|
| `src/context/memory-store.ts` | In-memory storage implementation |
| `src/context/parent/issue.ts` | Issue module (parent process) |
| `src/context/child/issue.ts` | Issue IPC client (child process) |
| `src/context/parent/team.ts` | Teammate management (parent process) |
| `src/context/child/team.ts` | Team IPC client (child process) |
| `src/context/shared/bg.ts` | Background tasks (shared) |
| `src/context/worktree-store.ts` | Worktree persistence (JSON file) |