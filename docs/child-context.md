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
│  │TeamManager│────────►│ IpcRegistry │────────►│AgentContext │   │
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
│  └───────────┘         │ team = null │                            │
│                        └─────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
```

**流程说明：**

1. 子进程调用 `ChildContext.issue.createIssue()` 
2. ChildIssue 通过 `ipc-helpers.sendRequest()` 发送 IPC 消息
3. 主进程 TeamManager 接收消息，调用 `IpcRegistry.dispatch()`
4. IpcRegistry 找到对应的 handler（如 `db_issue_create`）
5. Handler 调用 `AgentContext.issue.createIssue()`
6. 结果通过 IPC 返回给子进程

## 模块实现

### 文件结构

```
src/context/child-context/
├── ipc-helpers.ts    # IPC 通信原语
├── ipc-registry.ts   # IPC 处理器注册（共享）
├── core.ts           # ChildCore 实现
├── issue.ts          # ChildIssue 实现
├── bg.ts             # ChildBg 实现
├── wt.ts             # ChildWt 实现
└── index.ts          # createChildContext 工厂
```

### IPC Helpers（ipc-helpers.ts）

IPC 通信原语，用于子进程发送消息到主进程：

```typescript
// 发送通知（无需响应）
sendNotification(type: string, payload: Record<string, unknown>): void;

// 发送请求并等待响应
sendRequest<T>(type: string, args: Record<string, unknown>): Promise<T>;

// 处理主进程响应
handleDbResult(msg: { reqId: number; success: boolean; data?: unknown; error?: string }): void;

// 便捷方法
sendStatus(status: TeammateStatus): void;  // 更新状态
sendLog(message: string): void;             // 记录日志
sendError(error: string): void;             // 记录错误
```

### ChildCore（core.ts）

核心模块的子进程实现：

```typescript
class ChildCore implements CoreModule {
  getWorkDir(): string;              // 本地存储
  setWorkDir(dir: string): void;     // 本地存储
  brief(level, tool, message): void; // 通过 IPC 发送到主进程
  question(query): Promise<string>;  // 通过 IPC 发送到主进程
  setQuestionFn(): void;             // 无操作（子进程不直接问用户）
}
```

### ChildIssue（issue.ts）

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

### ChildBg & ChildWt

后台任务和工作树模块的子进程实现：

```typescript
class ChildBg implements BgModule {
  runCommand(cmd): Promise<number>;       // IPC
  printBgTasks(): Promise<string>;        // IPC
  hasRunningBgTasks(): Promise<boolean>;  // IPC
  killTask(pid): Promise<void>;           // IPC
}

class ChildWt implements WtModule {
  createWorkTree(name, branch): Promise<string>;  // IPC
  enterWorkTree(name): Promise<void>;              // IPC（同时更新本地 workDir）
  // ... 其他操作类似
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
| `bg_*` | 后台任务操作 | `{ type: 'bg_run', reqId, cmd }` |
| `wt_*` | 工作树操作 | `{ type: 'wt_create', reqId, name, branch }` |

## IPC 处理器注册

主进程通过 `IpcRegistry` 注册处理器：

```typescript
// src/context/index.ts
export function createAgentContext(workDir?: string): AgentContext {
  // ... 创建模块 ...

  // 注册 IPC 处理器
  for (const handler of createIssueIpcHandlers()) {
    team.registerHandler(handler);
  }
  for (const handler of createBgIpcHandlers()) {
    team.registerHandler(handler);
  }
  for (const handler of createWtIpcHandlers()) {
    team.registerHandler(handler);
  }

  // question 处理器在 TeamManager 构造函数中注册
  return ctx;
}
```

### 处理器示例

```typescript
// Issue 读取处理器
{
  messageType: 'db_issue_get',
  module: 'issue',
  handler: (_sender, payload, ctx) => {
    const { id } = payload as { id: number };
    const issue = ctx.issue.getIssue(id);
    return { success: true, data: issue };
  },
}
```

## 创建子进程上下文

```typescript
// src/context/child-context/index.ts
export function createChildContext(name: string, workDir: string): AgentContext {
  const core = createChildCore(name, workDir);  // IPC 包装
  const todo = createTodo();                     // 本地
  const mail = createMail(name);                  // 本地（独立邮箱）
  const skill = createSkill();                    // 本地
  const issue = createChildIssue();               // IPC 包装
  const bg = createChildBg();                     // IPC 包装
  const wt = createChildWt();                     // IPC 包装

  skill.loadSkills();

  return { core, todo, mail, skill, issue, bg, wt, team: null };
}
```

## 系统提示

子进程使用特殊的系统提示，强调团队协作和用户通信：

```typescript
// src/loop/agent-utils.ts
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
| `team` | 管理队友 | `null`（无法创建子队友） |

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/context/child-context/ipc-helpers.ts` | IPC 通信原语 |
| `src/context/child-context/core.ts` | ChildCore 实现 |
| `src/context/child-context/issue.ts` | ChildIssue 实现 |
| `src/context/child-context/bg.ts` | ChildBg 实现 |
| `src/context/child-context/wt.ts` | ChildWt 实现 |
| `src/context/child-context/index.ts` | createChildContext 工厂 |
| `src/context/teammate-worker.ts` | 子进程入口点 |
| `src/loop/agent-utils.ts` | 共享工具和系统提示 |
| `docs/ipc-ioc.md` | IPC IoC 模式文档 |