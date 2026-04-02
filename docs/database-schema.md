# Database Schema

本文档描述 SQLite 数据库的表结构和设计。

## 概述

系统使用 SQLite 作为持久化存储，支持：
- **Issue 管理**：持久化的任务和阻塞关系
- **队友管理**：团队成员状态
- **工作树管理**：Git worktree 跟踪

数据库文件位于 `.mycc/state.db`。

## WAL 模式

数据库使用 Write-Ahead Logging (WAL) 模式以提高并发性能：

```typescript
db.pragma('journal_mode = WAL');
```

WAL 模式的优势：
- **并发读取**：多个进程可以同时读取数据库
- **单写入者**：只有一个进程可以写入，适合子进程通过 IPC 访问主进程的设计
- **性能提升**：写入操作不需要阻塞读取操作

## 表结构

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

## 数据访问模式

### 主进程直接访问

主进程通过 `getDb()` 获取数据库连接：

```typescript
import { getDb } from './db.js';

const db = getDb();
const stmt = db.prepare('SELECT * FROM issues WHERE status = ?');
const issues = stmt.all('pending');
```

### 子进程通过 IPC 访问

子进程不能直接访问数据库，必须通过 IPC 发送请求：

```typescript
// 子进程代码
const issue = await ipc.sendRequest('db_issue_get', { id: 1 });
```

主进程的 IPC 处理器执行数据库操作：

```typescript
// 主进程 IPC 处理器
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

## 事务支持

SQLite 支持事务，可用于原子操作：

```typescript
import { getDb } from './db.js';

const db = getDb();

const claimTx = db.transaction(() => {
  // 检查状态
  const stmt = db.prepare('SELECT status FROM issues WHERE id = ?');
  const row = stmt.get(id);
  
  if (!row || row.status !== 'pending') {
    return false;
  }
  
  // 原子更新
  const updateStmt = db.prepare('UPDATE issues SET status = ?, owner = ? WHERE id = ?');
  updateStmt.run('in_progress', owner, id);
  
  return true;
});

const success = claimTx();
```

## 并发安全

### 单写入者模式

设计上保证只有主进程写入数据库：
- 子进程通过 IPC 发送请求
- 主进程序列化处理 IPC 请求
- 避免写入冲突

### 读取并发

多个子进程可以同时读取（通过 IPC），WAL 模式优化了读取性能。

## 数据迁移

系统启动时自动创建表和索引：

```typescript
function initSchema(db: Database.Database): void {
  // 创建表
  db.exec(`CREATE TABLE IF NOT EXISTS issues (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS issue_blockages (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS teammates (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS worktrees (...)`);

  // 创建索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_owner ON issues(owner)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issue_blockages_blocker ON issue_blockages(blocker_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issue_blockages_blocked ON issue_blockages(blocked_id)`);
}
```

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/context/db.ts` | 数据库初始化和连接管理 |
| `src/context/issue.ts` | Issue 模块实现 |
| `src/context/team.ts` | Teammate 状态管理 |
| `src/context/wt.ts` | Worktree 管理 |
| `src/context/child-context/issue.ts` | 子进程 Issue IPC 客户端 |