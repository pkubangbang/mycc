---
updated_at: 2026-05-03
changelog:
  - "2026-05-03: Updated to reflect SQLite removal - now uses in-memory storage"
  - "Original SQLite schema archived for historical reference"
---

# Database Schema (Historical Reference)

> **⚠️ IMPORTANT**: SQLite has been removed from the project as of v0.7.0. This document is kept for historical reference. The current implementation uses in-memory storage.

## Current Implementation (v0.7.0+)

系统现在使用 **内存存储** 而非 SQLite：

### Session-Scoped Data (In-Memory)

**File**: `src/context/memory-store.ts`

数据存储在内存中，进程退出后丢失：
- **Issue 管理**：`Map<number, Issue>`
- **阻塞关系**：`Map<string, { blocker, blocked }>`
- **队友管理**：`Map<string, Teammate>`

### Project-Level Data (JSON Files)

**File**: `src/context/worktree-store.ts`

工作树信息持久化到 JSON：
- **工作树管理**：`.mycc/worktrees.json`

## Migration Details

See `docs/migrate-remove-sqlite.md` for the complete migration plan that was executed in April 2026.

---

## Historical SQLite Schema (Pre-v0.7.0)

以下为已废弃的 SQLite 表结构，仅作历史参考：

### 原有设计概述

系统曾使用 SQLite 作为持久化存储，支持：
- **Issue 管理**：持久化的任务和阻塞关系
- **队友管理**：团队成员状态
- **工作树管理**：Git worktree 跟踪

数据库文件位于 `.mycc/state.db`。

### WAL 模式

数据库曾使用 Write-Ahead Logging (WAL) 模式以提高并发性能：

```typescript
db.pragma('journal_mode = WAL');
```

WAL 模式的优势：
- **并发读取**：多个进程可以同时读取数据库
- **单写入者**：只有一个进程可以写入，适合子进程通过 IPC 访问主进程的设计
- **性能提升**：写入操作不需要阻塞读取操作

### 原有表结构

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

### 原有数据访问模式

#### 主进程直接访问（已废弃）

主进程曾通过 `getDb()` 获取数据库连接：

```typescript
import { getDb } from './db.js';

const db = getDb();
const stmt = db.prepare('SELECT * FROM issues WHERE status = ?');
const issues = stmt.all('pending');
```

**当前方式**：直接调用 memory-store 函数：

```typescript
import * as MemoryStore from './memory-store.js';

const issues = MemoryStore.listIssues();
```

#### 子进程通过 IPC 访问（已废弃）

子进程曾不能直接访问数据库，必须通过 IPC 发送请求。

**当前方式**：子进程仍通过 IPC，但 IPC 处理器调用 memory-store：

```typescript
// 子进程代码（不变）
const issue = await ipc.sendRequest('db_issue_get', { id: 1 });

// 主进程 IPC 处理器（已更新）
{
  messageType: 'db_issue_get',
  module: 'issue',
  handler: async (_sender, payload, ctx, sendResponse) => {
    const { id } = payload as { id: number };
    const issue = MemoryStore.getIssue(id);  // 改用 memory-store
    sendResponse('db_result', true, issue);
  },
}
```

### 原有事务支持（已废弃）

SQLite 曾支持事务用于原子操作。**当前实现**：JavaScript 单线程模型天然保证原子性，无需事务。

### 原有并发安全（已废弃）

#### 单写入者模式

设计曾保证只有主进程写入数据库。**当前实现**：主进程独占内存，无需并发控制。

#### 读取并发

多个子进程曾可同时读取（通过 IPC）。**当前实现**：相同，但数据来自内存而非 WAL。

---

## 当前相关文件

| 文件 | 说明 |
|------|------|
| `src/context/memory-store.ts` | 内存存储实现（Issue、Blockage、Teammate） |
| `src/context/worktree-store.ts` | JSON 文件存储（Worktree） |
| `src/context/issue.ts` | Issue 模块实现（使用 memory-store） |
| `src/context/team.ts` | Teammate 状态管理（使用 memory-store） |
| `src/context/child/` | 子进程 IPC 客户端 |

---

## 历史表结构参考