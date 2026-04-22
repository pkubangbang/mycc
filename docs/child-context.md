# 子进程上下文（Child Context）

本文档描述子进程队友使用的上下文模块设计。

## 背景

`TeamManager` 使用 `child_process.fork()` 创建子进程队友。子进程需要访问与主进程相同的模块接口（`AgentContext`），但由于进程隔离，部分操作必须通过 IPC 转发到主进程执行。

### 挑战

1. **数据库访问**：SQLite 数据库文件只能由主进程访问，子进程的所有 DB 操作必须通过 IPC
2. **用户交互**：子进程没有终端访问权限，`question()` 必须通过 IPC 转发到主进程
3. **状态同步**：`core.brief()` 日志需要转发到主进程显示
4. **进程间通信**：子进程通过 `mail` 模块接收消息

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                           主进程（Lead）                              │
│                                                                     │
│  ┌───────────┐         ┌─────────────┐         ┌──────────────┐   │
│  │TeamManager│────────►│ IpcRegistry │────────►│ParentContext │   │
│  │           │         │             │         │              │   │
│  │ handleMsg │         │ dispatch()  │         │ core         │   │
│  │           │         │ handlers[]  │         │ issue        │   │
│  └─────┬─────┘         └─────────────┘         │ bg           │   │
│        ▲                                       │ wt           │   │
│        │ IPC                                   └──────────────┘   │
└────────│────────────────────────────────────────────────────────────┘
         │
         │
┌────────│───────────────────────────────────────────────────────────┐
│        │                    子进程（Teammate）                      │
│        │                                                            │
│  ┌─────┴─────┐         ┌─────────────┐         ┌──────────────┐   │
│  │ipc-helpers│         │ChildContext │         │ 本地模块      │   │
│  │           │◄────────│             │         │              │   │
│  │sendRequest│         │ core        │         │ todo         │   │
│  │sendStatus │         │ issue       │         │ mail         │   │
│  │sendLog    │         │ bg          │         │ skill        │   │
│  │sendError  │         │ wt          │         └──────────────┘   │
│  └───────────┘         │ team (ChildTeam)│                        │
│                        └─────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
```

**流程说明：**

1. 子进程调用 `ChildContext.issue.createIssue()` 
2. ChildIssue 通过 `ipc-helpers.sendRequest()` 发送 IPC 消息
3. 主进程 TeamManager 接收消息，调用 `IpcRegistry.dispatch()`
4. IpcRegistry 找到对应的 handler（如 `db_issue_create`）
5. Handler 调用 `ParentContext.issue.createIssue()`
6. 结果通过 IPC 返回给子进程

## 文件结构

重构后的目录结构：

```
src/context/
├── parent-context.ts       # ParentContext 类（主进程）
├── child-context.ts        # ChildContext 类（子进程）
├── ipc-registry.ts         # IPC 处理器注册（共享）
├── parent/                 # 主进程模块实现
│   ├── core.ts            # Core - 终端访问、web搜索、图片描述
│   ├── issue.ts           # IssueManager - SQLite 操作
│   ├── wt.ts              # WorktreeManager - Git worktree
│   ├── team.ts            # TeamManager - 子进程管理
│   └── wiki.ts            # WikiManager - 知识库
├── child/                  # 子进程模块实现（IPC 包装）
│   ├── core.ts            # ChildCore - IPC 转发
│   ├── issue.ts           # ChildIssue - IPC 转发
│   ├── wt.ts              # ChildWt - IPC 转发
│   ├── team.ts            # ChildTeam - 受限功能
│   ├── wiki.ts            # ChildWiki - IPC 转发
│   └── ipc-helpers.ts     # IPC 通信原语
├── shared/                 # 共享模块（两边都用）
│   ├── todo.ts           # Todo - 内存状态
│   ├── mail.ts            # MailBox - 文件邮箱
│   ├── bg.ts              # BackgroundTasks - 后台任务
│   └── loader.ts          # Loader - 工具/技能加载器
├── memory-store.ts        # 内存存储（状态持久化）
├── worktree-store.ts      # worktree 存储
└── teammate-worker.ts     # 子进程入口点
```

### 关键设计

- **ParentContext** 和 **ChildContext** 在目录结构上平行，都在 `src/context/` 根目录
- 主进程专用的实现在 `parent/` 目录
- 子进程专用的实现在 `child/` 目录
- 两边共用的实现在 `shared/` 目录

## 模块实现

### IPC Helpers（child/ipc-helpers.ts）

IPC 通信原语，用于子进程发送消息到主进程：

```typescript
// 发送通知（无需响应）
sendNotification(type: string, payload: Record<string, unknown>): void;

// 发送请求并等待响应
sendRequest<T>(type: string, args: Record<string, unknown>): Promise<T>;

// 便捷方法
sendStatus(status: TeammateStatus): void;  // 更新状态
```

### ChildCore（child/core.ts）

核心模块的子进程实现：

```typescript
class ChildCore implements CoreModule {
  getWorkDir(): string;              // 本地存储
  setWorkDir(dir: string): void;     // 本地存储
  brief(level, tool, message): void; // 通过 IPC 发送到主进程
  question(query): Promise<string>;   // 通过 IPC 发送到主进程
}
```

### ChildIssue（child/issue.ts）

Issue 模块的子进程实现，所有操作通过 IPC：

```typescript
class ChildIssue implements IssueModule {
  createIssue(title, content, blockedBy): Promise<number>;  // IPC
  getIssue(id): Promise<Issue | undefined>;                  // IPC
  listIssues(): Promise<Issue[]>;                            // IPC
  claimIssue(id, owner): Promise<boolean>;                   // IPC
  closeIssue(id, status, comment?): Promise<void>;           // IPC
  // ... 其他操作类似
}
```

### ChildTeam（child/team.ts）

Team 模块的子进程实现，功能受限：

```typescript
class ChildTeam implements TeamModule {
  // 允许的操作
  mailTo(name, title, content): void;       // 直接写邮箱文件
  broadcast(title, content): void;          // 发送邮件给 lead
  printTeam(): Promise<string>;              // IPC 获取状态
  
  // 禁止的操作 - 抛出 FORBIDDEN 错误
  createTeammate(): never;
  removeTeammate(): never;
  awaitTeammate(): never;
  dismissTeam(): never;
}
```

## 工作状态机

子进程队友实现了一个状态机来管理工作生命周期：

```
        spawn
          │
          ▼
    ┌─────────┐
    │  WORK   │◄─────────────┐
    │         │              │
    │ 执行工具 │              │ 有新任务
    │ LLM调用 │              │
    └────┬────┘              │
         │                   │
         │ 无工具调用         │
         ▼                   │
    ┌─────────┐              │
    │  IDLE   │──────────────┘
    │         │
    │ 轮询等待 │──────────────┐
    │ 自动认领 │              │
    └────┬────┘              │
         │                   │
         │ 超时/关闭         │ 有新邮件
         ▼                   │
    ┌──────────┐            │
    │ SHUTDOWN │            │
    │          │            │
    │ 进程退出  │◄───────────┘
    └──────────┘
```

### 状态说明

- **WORK**：活跃工作状态，LLM 持续执行工具调用
- **IDLE**：空闲状态，轮询检查新任务
- **SHUTDOWN**：终止状态，进程退出

### 状态转换

1. **spawn → WORK**：收到 spawn 消息后开始工作
2. **WORK → IDLE**：LLM 返回无工具调用
3. **IDLE → WORK**：收到新邮件或自动认领了任务
4. **IDLE → SHUTDOWN**：超时（60秒无任务）或收到关闭消息

## 自动认领功能

在 IDLE 状态时，子进程会自动扫描并认领未分配的任务：

```typescript
// 进入空闲状态
async function enterIdleState(messages: Message[]): Promise<'shutdown' | 'resume'> {
  sendStatus('idle');

  while (!shutdownRequested) {
    // 1. 检查关闭请求
    if (shutdownRequested) {
      sendStatus('shutdown');
      return 'shutdown';
    }

    // 2. 检查邮箱（文件邮箱）
    if (ctx.mail.hasNewMails()) {
      sendStatus('working');
      return 'resume';
    }

    // 3. 自动认领未认领的 Issue
    const issues = await ctx.issue.listIssues();
    const unclaimed = issues.filter(
      (issue) => issue.status === 'pending' && !issue.owner && issue.blockedBy.length === 0
    );

    if (unclaimed.length > 0) {
      const issue = unclaimed[0];
      const claimed = await ctx.issue.claimIssue(issue.id, teammateName);
      if (claimed) {
        // 认领成功，恢复工作状态
        messages.push({
          role: 'user',
          content: `<auto-claimed>Issue #${issue.id}: ${issue.title}\n${issue.content || ''}</auto-claimed>`,
        });
        sendStatus('working');
        return 'resume';
      }
    }

    // 4. 等待下次轮询
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}
```

### 认领条件

任务必须同时满足以下条件才会被自动认领：

- `status === 'pending'`：处于待处理状态
- `!owner`：未被分配
- `blockedBy.length === 0`：没有被其他任务阻塞

### 轮询间隔

默认轮询间隔为 5000ms（5秒）。

## 消息类型

### 主进程 → 子进程

| 消息类型 | 说明 | 格式 |
|---------|------|------|
| `spawn` | 初始化队友 | `{ type: 'spawn', name, role, prompt }` |
| `message` | 邮件消息 | `{ type: 'message', from, title, content }` |
| `shutdown` | 终止进程 | `{ type: 'shutdown' }` |
| `db_result` | IPC 响应 | `{ type: 'db_result', reqId, success, data?, error? }` |

### 子进程 → 主进程

| 消息类型 | 说明 | 格式 |
|---------|------|------|
| `status` | 状态更新 | `{ type: 'status', status }` |
| `log` | 日志消息 | `{ type: 'log', message }` |
| `error` | 错误消息 | `{ type: 'error', error }` |
| `question` | 用户提问 | `{ type: 'question', reqId, query }` |
| `db_issue_*` | Issue 操作 | `{ type: 'db_issue_create', reqId, ... }` |
| `wt_*` | 工作树操作 | `{ type: 'wt_create', reqId, name, branch }` |

## IPC 处理器注册

主进程在 `ParentContext.initializeIpcHandlers()` 中注册处理器：

```typescript
// src/context/parent-context.ts
export class ParentContext implements AgentContext {
  // ...
  
  initializeIpcHandlers(): void {
    const handlers: IpcHandlerRegistration[] = [
      // Issue handlers
      {
        messageType: 'db_issue_get',
        module: 'issue',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { id } = payload as { id: number };
          const issue = await ctx.issue.getIssue(id);
          sendResponse('db_result', true, issue);
        },
      },
      // ... more handlers
    ];

    for (const handler of handlers) {
      this.teamModule.registerHandler(handler);
    }
  }
}
```

## 创建上下文

### 主进程上下文

```typescript
// src/context/parent-context.ts
export class ParentContext implements AgentContext {
  constructor(sessionFilePath: string) {
    this.coreModule = new Core();
    this.skillModule = loader;
    this.todoModule = new Todo();
    this.mailModule = new MailBox('lead');
    this.issueModule = new IssueManager();
    this.bgModule = new BackgroundTasks(this.coreModule);
    this.wtModule = new WorktreeManager(this.coreModule);
    this.teamModule = new TeamManager(this, sessionFilePath);
    this.wikiModule = new WikiManager(this.coreModule);
  }
}
```

### 子进程上下文

```typescript
// src/context/child-context.ts
export class ChildContext implements AgentContext {
  constructor(name: string, workDir: string) {
    this.coreModule = new ChildCore(name, workDir);   // IPC 包装
    this.todoModule = new Todo();                      // 本地
    this.mailModule = new MailBox(name);               // 本地（独立邮箱）
    this.skillModule = silentLoader;                   // 本地（静默模式）
    this.issueModule = new ChildIssue();               // IPC 包装
    this.bgModule = new BackgroundTasks(this.coreModule);
    this.wtModule = new ChildWt(this.coreModule);       // IPC 包装
    this.teamModule = new ChildTeam(name);             // ChildTeam (受限功能)
    this.wikiModule = new ChildWiki();                 // IPC 包装
  }
}
```

## 系统提示

子进程使用特殊的系统提示，强调团队协作和用户通信：

```typescript
// src/loop/agent-prompts.ts
function buildSystemPrompt(ctx: AgentContext, identity?: { name: string; role: string }) {
  if (identity) {
    // 子进程系统提示
    return `You are ${identity.name}, a ${identity.role} teammate working autonomously.

## Your Role
You are a specialized agent working as part of a team.

## User Communication
- Use ctx.core.brief() to log status updates visible to the user
- Use ctx.core.question() to ask the user questions
- These are your ONLY ways to communicate with the user directly

## Team Collaboration
- You CANNOT spawn additional teammates
- Use mail_to to send messages to teammates
- Coordinate work through issues

## Workflow
1. Check for mail and new tasks
2. Work on assigned issues
3. Report progress via brief()
4. Ask questions via question() when blocked
`;
  }
  // 主进程系统提示...
}
```

## 与主进程上下文对比

| 模块 | 主进程 | 子进程 |
|------|--------|--------|
| `core` | 直接访问终端 | IPC 转发 `brief`, `question` |
| `todo` | 内存状态 | 相同（独立） |
| `mail` | 文件邮箱 | 文件邮箱（独立邮箱） |
| `skill` | 文件系统 | 相同 |
| `issue` | 直接 SQLite 访问 | IPC 转发所有操作 |
| `bg` | 直接管理子进程 | IPC 转发 |
| `wt` | 直接 Git 操作 | IPC 转发 |
| `team` | 管理队友 | ChildTeam (受限：仅 mailTo/broadcast/printTeam) |
| `wiki` | 直接 SQLite 访问 | IPC 转发所有操作 |

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/context/parent-context.ts` | ParentContext 类定义 |
| `src/context/child-context.ts` | ChildContext 类定义 |
| `src/context/ipc-registry.ts` | IPC 处理器注册 |
| `src/context/parent/core.ts` | Core 实现（主进程） |
| `src/context/parent/issue.ts` | IssueManager 实现 |
| `src/context/child/core.ts` | ChildCore 实现（IPC 包装） |
| `src/context/child/issue.ts` | ChildIssue 实现（IPC 包装） |
| `src/context/child/ipc-helpers.ts` | IPC 通信原语 |
| `src/context/shared/todo.ts` | Todo 模块（共享） |
| `src/context/shared/mail.ts` | MailBox 模块（共享） |
| `src/context/shared/loader.ts` | Loader 模块（共享） |
| `src/context/teammate-worker.ts` | 子进程入口点 |
| `src/loop/agent-prompts.ts` | 系统提示生成 |