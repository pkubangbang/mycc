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
│        ▲                                       │ team         │   │
│        │ IPC                                   │ wiki         │   │
│        │                                       │ peer         │   │
│        │                                       └──────────────┘   │
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
│  │sendError  │         │ team        │         └──────────────┘   │
│  └───────────┘         │ wiki        │                            │
│                        │ peer (Noop) │                            │
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
│   ├── team.ts            # TeamManager - 子进程管理
│   └── wiki.ts            # WikiManager - 知识库
├── child/                  # 子进程模块实现（IPC 包装）
│   ├── core.ts            # ChildCore - IPC 转发
│   ├── issue.ts           # ChildIssue - IPC 转发
│   ├── team.ts            # ChildTeam - 受限功能
│   ├── wiki.ts            # ChildWiki - IPC 转发
│   └── ipc-helpers.ts     # IPC 通信原语
├── shared/                 # 共享模块（两边都用）
│   ├── base-core.ts       # BaseCore - workDir/mindmap 共享基类
│   ├── todo.ts            # Todo - 内存状态
│   ├── mail.ts            # MailBox - 文件邮箱
│   ├── bg.ts              # BackgroundTasks - 后台任务
│   ├── loader.ts          # Loader - 工具/技能加载器
│   ├── registry.ts        # ConditionRegistry - hook 条件注册表
│   └── format-issue.ts    # Issue 格式化工具
├── grant/                  # 授权系统（子进程通过 IPC 转发到主进程）
│   ├── bash-judge.ts      # Bash 命令授权判定
│   ├── dangerous-commands.ts # 危险命令拦截
│   ├── grant-evaluator.ts # 授权评估（含 worktree 所有权检查）
│   ├── intent-parser.ts   # Intent Lang 解析
│   ├── types.ts           # 授权类型定义
│   └── index.ts           # 导出 evaluateGrant
├── memory-store.ts        # 内存存储（状态持久化）
├── worktree-store.ts      # git worktree 查询（`git worktree list`，非持久化）
└── teammate-worker.ts     # 子进程入口点
```

> **注**：worktree 不作为独立模块（无 `WorktreeManager`/`ChildWt`）。worktree 查询由 `worktree-store.ts` 提供（`listWorktrees`/`findWorktreeByName`/`findWorktreeByPath`），授权系统在 `grant/grant-evaluator.ts` 中检查 worktree 所有权。子进程的 worktree 沙箱由 spawn 消息中的 `cwd` 字段 + 授权系统共同实现。

### 关键设计

- **ParentContext** 和 **ChildContext** 在目录结构上平行，都在 `src/context/` 根目录
- 主进程专用的实现在 `parent/` 目录
- 子进程专用的实现在 `child/` 目录
- 两边共用的实现在 `shared/` 目录

## 模块实现

### IPC Helpers（child/ipc-helpers.ts）

IPC 通信原语，用于子进程发送消息到主进程：

```typescript
// IpcClient 类
class IpcClient {
  // 发送通知（无需响应）
  sendNotification(type: string, payload: Record<string, unknown>): void;

  // 发送请求并等待响应（默认 30s 超时，timeoutMs=0 表示无超时）
  sendRequest<T>(type: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T>;

  // 处理来自主进程的响应消息
  handleMessage(msg): boolean;
}

// 全局实例
export const ipc: IpcClient;

// 便捷函数：发送状态通知
export function sendStatus(status: TeammateStatus): void;
```

### ChildCore（child/core.ts）

核心模块的子进程实现，继承 `BaseCore`（共享 workDir/mindmap 管理）：

```typescript
class ChildCore extends BaseCore implements CoreModule {
  getName(): string;
  brief(level, tool, message, detail?): void; // 通过 IPC 'log'/'error' 发送到主进程
  verbose(tool, message, data?): void;          // 仅 -v 模式，通过 IPC 'verbose' 发送
  question(query, asker, options?): Promise<AskResult>; // 通过 IPC 'question' 发送，等待用户回答
  imgDescribe(image, prompt?, signal?): Promise<string>;        // IPC 'core_img_describe'
  readPictureCached(imagePath, prompt?, cacheToken?, signal?): Promise<PictureResult>; // IPC 'core_read_picture_cached'
  requestGrant(tool, args): Promise<{ approved, reason? }>;     // IPC 'grant_request'
  requestExternalPathAccess(tool, requestedPath): Promise<{ approved, resolvedPath, reason? }>; // IPC 'external_path_access'
  getMode(): 'normal';   // 子进程始终为 normal 模式
  getAuto(): false;      // 子进程不使用 autonomous 模式
  escAware(operation, onCleanUp): Promise<T>;  // 子进程 ESC 处理尚未实现
}
```

### ChildIssue（child/issue.ts）

Issue 模块的子进程实现，所有操作通过 IPC：

```typescript
class ChildIssue implements IssueModule {
  createIssue(title, content, blockedBy): Promise<number>;  // IPC db_issue_create
  getIssue(id): Promise<Issue | undefined>;                  // IPC db_issue_get
  listIssues(): Promise<Issue[]>;                            // IPC db_issue_list
  printIssues(): Promise<string>;                            // 本地格式化 listIssues 结果
  printIssue(id): Promise<string>;                           // 本地格式化 getIssue 结果
  claimIssue(id, owner): Promise<boolean>;                   // IPC db_issue_claim
  publishIssue(id): Promise<boolean>;                        // IPC db_issue_publish
  closeIssue(id, status, comment?, poster?): Promise<void>; // IPC db_issue_close
  addComment(id, comment, poster?): Promise<void>;           // IPC db_issue_comment
  createBlockage(blocker, blocked): Promise<void>;           // IPC db_block_add
  removeBlockage(blocker, blocked): Promise<void>;           // IPC db_block_remove
  clearAll(): void;                                          // IPC db_issue_clear_all（fire-and-forget）
}
```

### ChildTeam（child/team.ts）

Team 模块的子进程实现，功能受限：

```typescript
class ChildTeam implements TeamModule {
  // 允许的操作
  mailTo(name, title, content, from?, eta?): void;  // 直接写邮箱文件；child→lead 且 eta>0 时发送 IPC 'eta_update'
  broadcast(title, content): void;                   // 发送广播请求邮件给 lead（lead 决定是否广播）
  createTeammate(name, role, prompt, cwd?): Promise<string>; // 发送创建请求邮件给 lead（lead 决定）
  printTeam(): Promise<string>;                      // IPC team_print 获取状态
  handlePendingQuestions(): Promise<void>;           // no-op（仅 lead 处理用户提问）

  // 禁止的操作 - 抛出 FORBIDDEN 错误
  getTeammate(): never;
  listTeammates(): never;
  awaitTeammate(): never;
  awaitTeam(): never;
  removeTeammate(): never;
  dismissTeam(): never;
}
```

> **注**：`createTeammate` 和 `broadcast` 不是直接执行，而是通过邮箱向 lead 发送建议邮件，由 lead 决定是否执行。`mailTo` 在子进程→lead 且 `eta > 0` 时额外发送 IPC `eta_update` 通知，让主进程的 TeamManager 跟踪截止时间。

## 工作状态机

子进程队友实现了一个状态机来管理工作生命周期。状态值类型为 `TeammateStatus = 'working' | 'idle' | 'holding' | 'shutdown'`（见 `src/types.ts`）。

```
        spawn
          │
          ▼
    ┌─────────┐◄─────────────┐
    │  WORK   │              │
    │         │              │ 有新任务/认领成功
    │ 执行工具 │              │
    │ LLM调用 │              │
    └────┬────┘              │
         │                   │
         │ 无工具调用         │
         ▼                   │
    ┌─────────┐              │
    │  IDLE   │──────────────┘
    │         │
    │ 轮询等待 │
    │ 自动认领 │
    └────┬────┘
         │ 收到 shutdown / 进程断开 / SIGTERM/SIGINT/SIGHUP
         ▼
    ┌──────────┐
    │ SHUTDOWN │
    │          │
    │ 进程退出  │
    └──────────┘

    ┌─────────┐  question() 等待用户回答  ┌─────────┐
    │  WORK   │─────────────────────────►│ HOLDING │
    └─────────┘                          └────┬────┘
                                              │ 收到回答
                                              ▼
                                         回到 WORK
```

### 状态说明

- **WORK**：活跃工作状态，LLM 持续执行工具调用
- **IDLE**：空闲状态，轮询检查新邮件和可认领的 Issue
- **HOLDING**：等待用户回答 `question()` 的中间状态，主进程的 `awaitTeammate`/`awaitTeam` 会立即返回以便 lead 处理提问
- **SHUTDOWN**：终止状态，进程退出

### 状态转换

1. **spawn → WORK**：收到 spawn 消息后开始工作
2. **WORK → IDLE**：LLM 返回无工具调用，且无未完成的 todo（若仍有 open todo 则仅注入提醒继续工作，不进入 idle）；或连续网络失败达到上限（`MAX_CONSECUTIVE_FAILURES = 3`）后进入 idle 恢复邮件轮询
3. **IDLE → WORK**：收到新邮件或自动认领了任务
4. **WORK → HOLDING**：调用 `question()` 等待用户回答
5. **HOLDING → WORK**：收到用户回答后恢复工作
6. **IDLE → SHUTDOWN**：收到 shutdown 消息、进程断开（`disconnect`）、或 `SIGTERM`/`SIGINT`/`SIGHUP` 信号

> **注**：IDLE 状态没有固定超时——轮询会持续进行直到收到关闭信号。主进程通过 `removeTeammate`/`dismissTeam` 发送 shutdown 消息或强制 `SIGTERM` 来终止子进程。

## 自动认领功能

在 IDLE 状态时，子进程会自动扫描并认领未分配的任务：

```typescript
// 进入空闲状态（src/context/teammate-worker.ts）
async function enterIdleState(triologue: Triologue): Promise<'shutdown' | 'resume'> {
  sendStatus('idle');

  while (!shutdownRequested) {
    // 1. 检查关闭请求
    if (shutdownRequested) {
      sendStatus('shutdown');
      return 'shutdown';
    }

    // 2. 检查邮箱（文件邮箱）
    if (ctx.mail.hasNewMails()) {
      return 'resume';
    }

    // 3. 自动认领未认领的 Issue
    const issues = await ctx.issue.listIssues();
    const unclaimed = issues.filter((issue) => {
      // 必须是 pending 且未被认领
      if (issue.status !== 'pending' || issue.owner) {
        return false;
      }
      // 如果被阻塞，检查所有阻塞者是否已完成
      if (issue.blockedBy.length > 0) {
        const allBlockersComplete = issue.blockedBy.every((blockerId) => {
          const blocker = issues.find((i) => i.id === blockerId);
          return blocker && blocker.status === 'completed';
        });
        return allBlockersComplete;
      }
      return true;
    });

    if (unclaimed.length > 0) {
      const issue = unclaimed[0];
      try {
        const claimed = await ctx.issue.claimIssue(issue.id, teammateName);
        if (claimed) {
          ctx.core.brief('info', 'auto_claim', `Issue #${issue.id}: ${issue.title}`);
          // 认领成功，恢复工作状态
          triologue.note('SYSTEM', `Issue #${issue.id}: ${issue.title}\n${issue.content || ''}`);
          return 'resume';
        }
      } catch (err) {
        // 认领失败，可能已被其他 worker 认领
        ctx.core.brief('info', 'auto_claim', `Failed to claim issue #${issue.id}: ${(err as Error).message}`);
      }
    }

    // 4. 等待下次轮询
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  sendStatus('shutdown');
  return 'shutdown';
}
```

### 认领条件

任务必须满足以下条件才会被自动认领：

- `status === 'pending'`：处于待处理状态（已发布，非 draft）
- `!owner`：未被分配
- 如果 `blockedBy.length > 0`：所有阻塞者必须 `status === 'completed'`（阻塞者全部完成后才可认领）
- 如果 `blockedBy.length === 0`：直接可认领

> **注**：Issue 创建时为 `draft` 状态，对自动认领不可见。需通过 `issue_publish`（draft → pending，开放自动认领）或 `issue_claim`（draft → in_progress，指定 teammate）来发布。

### 轮询间隔

默认轮询间隔为 5000ms（5秒），定义于 `teammate-worker.ts` 的 `POLL_INTERVAL` 常量。

## 消息类型

### 主进程 → 子进程

| 消息类型 | 说明 | 格式 |
|---------|------|------|
| `spawn` | 初始化队友 | `{ type: 'spawn', name, role, prompt, triologuePath, sessionId, cwd? }` |
| `message` | 邮件消息 | `{ type: 'message', from, title, content }` |
| `shutdown` | 终止进程（软关闭，子进程协作退出） | `{ type: 'shutdown' }` |
| `mode_change` | 模式变更通知 | `{ type: 'mode_change', mode: 'plan' \| 'normal' }` |
| `db_result` | Issue IPC 响应 | `{ type: 'db_result', reqId, success, data?, error? }` |
| `team_result` | Team IPC 响应 | `{ type: 'team_result', reqId, success, data?, error? }` |
| `wiki_result` | Wiki IPC 响应 | `{ type: 'wiki_result', reqId, success, data?, error? }` |
| `core_result` | Core IPC 响应 | `{ type: 'core_result', reqId, success, data?, error? }` |
| `grant_result` | 授权 IPC 响应 | `{ type: 'grant_result', reqId, success, data?, error? }` |
| `question_result` | 用户提问响应 | `{ type: 'question_result', reqId, success, data?, error? }` |

> **注**：所有 IPC 响应共享相同结构 `{ type, reqId, success, data?, error? }`，`type` 区分响应类别。响应类型集合定义于 `child/ipc-helpers.ts` 的 `RESPONSE_TYPES`。`message` 类型在代码中声明但当前未由主进程主动发送（邮件通过文件邮箱传递）。

### 子进程 → 主进程

**通知（无 reqId，无需响应）：**

| 消息类型 | 说明 | 格式 |
|---------|------|------|
| `status` | 状态更新 | `{ type: 'status', status }` |
| `teammate_ready` | spawn 完成，已就绪 | `{ type: 'teammate_ready', name }` |
| `eta_update` | 时间预算（绝对截止时间） | `{ type: 'eta_update', eta, sender }` |
| `log` | 日志消息 | `{ type: 'log', message, detail?, tool? }` |
| `error` | 错误消息 | `{ type: 'error', error, detail?, tool? }` |
| `verbose` | 详细日志（仅 -v 模式） | `{ type: 'verbose', tool, message, data? }` |
| `condition_replace` | skill_compile 后通知主进程重载 hook 条件 | `{ type: 'condition_replace', skillName }` |
| `db_issue_clear_all` | 清空所有 Issue（fire-and-forget） | `{ type: 'db_issue_clear_all' }` |

**请求（有 reqId，等待响应）：**

| 消息类型 | 说明 | 格式 |
|---------|------|------|
| `question` | 用户提问 | `{ type: 'question', reqId, query, asker, options? }` |
| `db_issue_get` | 获取 Issue | `{ type: 'db_issue_get', reqId, id }` |
| `db_issue_list` | 列出 Issue | `{ type: 'db_issue_list', reqId }` |
| `db_issue_create` | 创建 Issue | `{ type: 'db_issue_create', reqId, title, content, blockedBy? }` |
| `db_issue_claim` | 认领 Issue | `{ type: 'db_issue_claim', reqId, id, owner }` |
| `db_issue_publish` | 发布 Issue | `{ type: 'db_issue_publish', reqId, id }` |
| `db_issue_close` | 关闭 Issue | `{ type: 'db_issue_close', reqId, id, status, comment?, poster? }` |
| `db_issue_comment` | 添加评论 | `{ type: 'db_issue_comment', reqId, id, comment, poster? }` |
| `db_block_add` | 添加阻塞关系 | `{ type: 'db_block_add', reqId, blocker, blocked }` |
| `db_block_remove` | 移除阻塞关系 | `{ type: 'db_block_remove', reqId, blocker, blocked }` |
| `team_print` | 获取团队状态 | `{ type: 'team_print', reqId }` |
| `wiki_prepare` | Wiki 准备 | `{ type: 'wiki_prepare', reqId, document }` |
| `wiki_put` | Wiki 存储 | `{ type: 'wiki_put', reqId, hash, document }` |
| `wiki_get` | Wiki 查询 | `{ type: 'wiki_get', reqId, query, options? }` |
| `wiki_delete` | Wiki 删除 | `{ type: 'wiki_delete', reqId, hash }` |
| `core_img_describe` | 图片描述 | `{ type: 'core_img_describe', reqId, image, prompt?, aborted? }` |
| `core_read_picture_cached` | 图片缓存读取 | `{ type: 'core_read_picture_cached', reqId, imagePath, prompt?, cacheToken?, aborted? }` |
| `grant_request` | 授权请求 | `{ type: 'grant_request', reqId, tool, path?, command?, intent? }` |
| `external_path_access` | 外部路径访问请求 | `{ type: 'external_path_access', reqId, tool, requestedPath }` |

> 完整的 handler 注册列表见 `src/context/parent-context.ts` 的 `initializeIpcHandlers()`。

## IPC 处理器注册

主进程在 `ParentContext.initializeIpcHandlers()` 中注册处理器。Handler 覆盖 issue、team、wiki、core、grant 五类操作，每个 handler 声明 `messageType`、`module`、`handler` 三字段：

```typescript
// src/context/parent-context.ts
export class ParentContext implements AgentContext {
  // ...
  
  initializeIpcHandlers(): void {
    const handlers: IpcHandlerRegistration[] = [
      // Issue handlers (db_issue_get, db_issue_list, db_issue_create,
      //   db_issue_claim, db_issue_publish, db_issue_close,
      //   db_issue_comment, db_block_add, db_block_remove, db_issue_clear_all)
      {
        messageType: 'db_issue_get',
        module: 'issue',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { id } = payload as { id: number };
          const issue = await ctx.issue.getIssue(id);
          sendResponse('db_result', true, issue);
        },
      },
      // Team handlers (team_print)
      // Wiki handlers (wiki_prepare, wiki_put, wiki_get, wiki_delete,
      //   wiki_get_by_domain, wiki_batch_put, wiki_wal_get, wiki_wal_append,
      //   wiki_rebuild, wiki_domains_list, wiki_domain_get, wiki_domain_register)
      // Core handlers (core_img_describe, core_read_picture_cached)
      // Grant handlers (grant_request, external_path_access)
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
    this.teamModule = new TeamManager(this, sessionFilePath);
    this.wikiModule = new WikiManager(this.coreModule);
    // Peer discovery（跨实例路由）
    const peerSessionId = getSessionId(sessionFilePath);
    const peerWorkDir = process.cwd();
    const peerMailboxPath = path.resolve(getSessionDir(peerSessionId), 'unread-lead.jsonl');
    this.peerModule = new PeerManager(peerSessionId, peerWorkDir, peerMailboxPath);
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
    this.teamModule = new ChildTeam(name);             // ChildTeam (受限功能)
    this.wikiModule = new ChildWiki();                 // IPC 包装
    this.peerModule = new NoopPeerModule();            // 子进程不运行 peer discovery
  }
}
```

## 系统提示

子进程使用专门的系统提示，由 `buildTeammatePrompt(workDir, identity)` 生成，通过 `buildNormalModePrompt(workDir, identity)` 的 `identity` 分支触发（见 `src/loop/agent-prompts.ts`）。提示强调团队协作、时间预算协议和用户通信：

```typescript
// src/loop/agent-prompts.ts
function buildTeammatePrompt(workDir: string, identity: { name: string; role: string }): string {
  return `You are ${identity.name}, a specialized agent working as part of a team, created by the "lead".
Your role is ${identity.role}. You are working at ${workDir}.

You have 3 ways to communicate with others:
1. use "mail_to" tool to inform other teammates.
2. use "question" tool to interrupt and get input from the user.
3. use "brief" tool to send status updates.
...
### Time Budget Protocol
Your very first tool call MUST be a mail_to to "lead" with an eta (seconds from now) to set your time budget.
...
### Worktree Usage
Worktrees are managed via bash (git worktree commands). Use the worktree skill for guidance.
The lead creates worktrees and assigns them to teammates at spawn time via the \`cwd\` parameter of \`tm_create\`.
...
`;
}

export function buildNormalModePrompt(
  workDir: string,
  identity?: { name: string; role: string },
  hasTeam?: boolean
): string {
  if (identity) {
    return buildTeammatePrompt(workDir, identity);  // 子进程
  }
  return hasTeam ? buildTeamNormalPrompt(workDir) : buildSoloNormalPrompt(workDir);
}
```

> **注**：子进程提示包含 Knowledge Boundary、Intent Lang、Output Behavior 等共享段落（`buildCommonSections()`），但不包含 Pinned Todo 段落（该段落仅用于 lead）。`## Platform` 与 `## Calendar` 段落不再内联于系统提示——它们由 `prompt-populators.ts` 的 `buildPlatformCalendarMessages()` 以 projectContext populator 的方式注入（见 `src/loop/prompt-populators.ts`），在主进程与子进程中都于启动时注册并在 compact/clear 时重建。

## 与主进程上下文对比

| 模块 | 主进程 | 子进程 |
|------|--------|--------|
| `core` | 直接访问终端 | IPC 转发 `brief`, `question`, `imgDescribe`, `readPictureCached`, `requestGrant`, `requestExternalPathAccess` |
| `todo` | 内存状态 | 相同（独立） |
| `mail` | 文件邮箱 | 文件邮箱（独立邮箱） |
| `skill` | 文件系统 | 相同（静默模式 Loader） |
| `issue` | 直接 SQLite 访问 | IPC 转发所有操作 |
| `bg` | 直接管理子进程 | 相同（BackgroundTasks，基于 coreModule） |
| `team` | 管理队友（spawn/remove/await/broadcast） | ChildTeam（受限：mailTo/broadcast/createTeammate 经邮箱建议 lead，printTeam 经 IPC；禁止 getTeammate/listTeammates/awaitTeammate/awaitTeam/removeTeammate/dismissTeam） |
| `wiki` | 直接 SQLite 访问 | IPC 转发所有操作 |
| `peer` | PeerManager（跨实例路由） | NoopPeerModule（子进程不运行 peer discovery） |

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/context/parent-context.ts` | ParentContext 类定义 |
| `src/context/child-context.ts` | ChildContext 类定义 |
| `src/context/ipc-registry.ts` | IPC 处理器注册 |
| `src/context/parent/core.ts` | Core 实现（主进程） |
| `src/context/parent/issue.ts` | IssueManager 实现 |
| `src/context/parent/team.ts` | TeamManager 实现（子进程管理、IPC 消息处理） |
| `src/context/parent/wiki.ts` | WikiManager 实现 |
| `src/context/child/core.ts` | ChildCore 实现（IPC 包装，继承 BaseCore） |
| `src/context/child/issue.ts` | ChildIssue 实现（IPC 包装） |
| `src/context/child/team.ts` | ChildTeam 实现（受限功能） |
| `src/context/child/wiki.ts` | ChildWiki 实现（IPC 包装） |
| `src/context/child/ipc-helpers.ts` | IPC 通信原语（IpcClient） |
| `src/context/shared/base-core.ts` | BaseCore 共享基类（workDir/mindmap） |
| `src/context/shared/todo.ts` | Todo 模块（共享） |
| `src/context/shared/mail.ts` | MailBox 模块（共享） |
| `src/context/shared/loader.ts` | Loader 模块（共享） |
| `src/context/shared/registry.ts` | ConditionRegistry（hook 条件注册表） |
| `src/context/shared/format-issue.ts` | Issue 格式化工具 |
| `src/context/shared/bg.ts` | BackgroundTasks 模块（共享） |
| `src/context/grant/` | 授权系统（bash-judge、grant-evaluator、intent-parser 等） |
| `src/context/worktree-store.ts` | git worktree 查询（listWorktrees/findWorktreeByName/findWorktreeByPath） |
| `src/context/memory-store.ts` | 内存存储（teammate/issue 状态持久化） |
| `src/context/teammate-worker.ts` | 子进程入口点（状态机、自动认领、邮件轮询） |
| `src/peer/peer.ts` | PeerManager / NoopPeerModule |
| `src/loop/agent-prompts.ts` | 系统提示生成（buildTeammatePrompt） |