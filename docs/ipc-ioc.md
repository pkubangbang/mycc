# IPC 控制反转（IoC）模式

本文档描述了 `ctx.team` 模块中的 IPC 处理器注册机制。

## 背景

### 问题

`TeamManager` 使用 `child_process.fork()` 创建子进程队友，通过 Node.js IPC 通道进行通信。原始设计中，所有 IPC 消息处理都硬编码在 `handleChildMessage()` 方法中：

```typescript
private handleChildMessage(sender: string, msg: ChildMessage): void {
  switch (msg.type) {
    case 'status': // 更新状态
    case 'log':    // 记录日志
    case 'error':  // 记录错误
  }
}
```

这种设计存在以下问题：
1. **扩展困难**：添加新的消息类型需要修改 `team.ts`
2. **职责混乱**：其他模块（如 `issue`）无法处理与自己相关的 IPC 消息
3. **违反开闭原则**：每次添加处理器都需要修改核心代码

### 解决方案

采用 **控制反转（Inversion of Control）** 模式：
- `TeamManager` 作为 IPC 消息的**调度器**
- 各模块通过**注册处理器**来声明自己关心的消息类型
- 消息到达时，调度器将消息分发给已注册的处理器

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        主进程（Lead）                            │
│                                                                 │
│  ┌─────────────┐         ┌───────────────┐                      │
│  │ TeamManager │         │  IpcRegistry  │                      │
│  │             │         │               │                      │
│  │ handleChild │────────►│  dispatch()   │                      │
│  │  Message()  │         │               │                      │
│  └─────────────┘         └───────┬───────┘                      │
│                                  │                               │
│                    ┌─────────────┼─────────────┐                │
│                    ▼             ▼             ▼                │
│            ┌───────────┐  ┌───────────┐  ┌───────────┐          │
│            │  status   │  │   log     │  │ db_issue  │          │
│            │  handler  │  │  handler  │  │  handler  │          │
│            │ (team.ts) │  │ (team.ts) │  │(issue.ts) │          │
│            └───────────┘  └───────────┘  └───────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                                   ▲
                                   │ IPC
                                   │
┌─────────────────────────────────────────────────────────────────┐
│                       子进程（Teammate）                          │
│                                                                 │
│  process.send({ type: 'db_issue_create', reqId: 1, ... })       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 核心类型

### SendResponseCallback

响应回调函数，用于请求-响应模式：

```typescript
type SendResponseCallback = (
  responseType: string,    // 响应类型，如 'db_result', 'team_result', 'wiki_result', 'core_result', 'grant_result', 'question_result'
  success: boolean,        // 操作是否成功
  data?: unknown,          // 成功时返回的数据
  error?: string           // 失败时的错误信息
) => void;
```

### IpcMessageHandler

处理器函数类型（使用回调模式）：

```typescript
type IpcMessageHandler = (
  sender: string,                    // 发送消息的子进程名称
  payload: Record<string, unknown>,  // 消息内容（不含 type 字段）
  ctx: AgentContext,                 // 上下文，用于访问其他模块
  sendResponse: SendResponseCallback  // 响应回调函数
) => void | Promise<void>;
```

### IpcHandlerRegistration

处理器注册信息：

```typescript
interface IpcHandlerRegistration {
  messageType: string;        // 消息类型，如 'db_issue_create'
  handler: IpcMessageHandler; // 处理函数
  module: string;             // 模块名称，用于调试
}
```

## 消息模式

### 通知模式（Notification）

单向消息，不需要响应：

```typescript
// 子进程发送
process.send({ type: 'log', message: '工作完成' });

// 主进程处理
// 无返回值，仅记录日志
```

### 请求-响应模式（Request-Response）

需要响应的消息，必须携带 `reqId`：

```typescript
// 子进程发送
process.send({ 
  type: 'db_issue_create', 
  reqId: 1, 
  title: '修复bug', 
  content: '...' 
});

// 主进程处理并响应（使用回调）
sendResponse('db_result', true, { id: 42 });

// 或发送错误响应
sendResponse('error', false, undefined, '错误信息');
```

### 响应类型

不同的模块使用不同的响应类型（响应类型集合定义于 `child/ipc-helpers.ts` 的 `RESPONSE_TYPES`）：

| 响应类型 | 模块 | 说明 |
|---------|------|------|
| `db_result` | issue | 数据库操作结果 |
| `team_result` | team | 团队操作结果 |
| `wiki_result` | wiki | 知识库操作结果 |
| `core_result` | core | Core 操作结果（imgDescribe、readPictureCached） |
| `grant_result` | grant | 授权操作结果（grant_request、external_path_access） |
| `question_result` | core | 用户问答结果 |
| `error` | 通用 | 错误响应（dispatch 异常或未注册消息类型时使用） |

## IpcRegistry 类

`src/context/ipc-registry.ts` 提供处理器注册和消息分发功能：

### 主要方法

```typescript
class IpcRegistry {
  // 设置上下文（处理器需要访问模块）
  setContext(ctx: AgentContext): void;

  // 注册处理器
  register(registration: IpcHandlerRegistration): void;

  // 注销处理器
  unregister(messageType: string): void;

  // 分发消息到处理器
  async dispatch(
    sender: string,
    msg: { type: string; [key: string]: unknown },
    sendResponse: SendResponseCallback
  ): Promise<void>;
}
```

### 错误处理

- 重复注册同一消息类型会抛出错误（包含 existing 和 new 模块名）
- 处理器执行异常会调用 `sendResponse('error', false, undefined, errorMessage)`
- 未注册的消息类型会调用 `sendResponse('error', false, undefined, 'No handler registered for message type: ...')`（**不是**静默忽略）
- `dispatch` 前未设置 context 会抛出 `IPC registry context not initialized`

## TeamModule 接口扩展

`TeamModule` 新增两个方法：

```typescript
interface TeamModule {
  // ... 原有方法 ...

  // 注册 IPC 处理器
  registerHandler(registration: IpcHandlerRegistration): void;

  // 注销 IPC 处理器
  unregisterHandler(messageType: string): void;
}
```

## 如何添加新的处理器

### 1. 在模块中创建处理器工厂函数

```typescript
// src/context/my-module.ts

import type { IpcHandlerRegistration, AgentContext, SendResponseCallback } from '../types.js';

export function createMyModuleIpcHandlers(): IpcHandlerRegistration[] {
  return [
    {
      messageType: 'my_action',
      module: 'my-module',
      handler: (sender, payload, ctx, sendResponse) => {
        const { param } = payload as { param: string };
        // 通过 ctx 访问其他模块
        ctx.core.brief('info', sender, `执行: ${param}`);
        // 使用回调发送响应
        sendResponse('db_result', true, { result: 'ok' });
      },
    },
  ];
}
```

### 2. 在上下文初始化时注册

处理器在 `ParentContext.initializeIpcHandlers()` 中注册（见 `src/context/parent-context.ts`）：

```typescript
// src/context/parent-context.ts
export class ParentContext implements AgentContext {
  initializeIpcHandlers(): void {
    const handlers: IpcHandlerRegistration[] = [
      // ... 现有 handler
      {
        messageType: 'my_action',
        module: 'my-module',
        handler: async (sender, payload, ctx, sendResponse) => {
          const { param } = payload as { param: string };
          ctx.core.brief('info', sender, `执行: ${param}`);
          sendResponse('db_result', true, { result: 'ok' });
        },
      },
    ];

    for (const handler of handlers) {
      this.teamModule.registerHandler(handler);
    }
  }
}
```

### 3. 在子进程中发送消息

```typescript
// 子进程代码
process.send({
  type: 'my_action',
  reqId: requestId,  // 如果需要响应
  param: 'value',
});
```

## 内置处理器

### 直接处理（不在 IpcRegistry 中）

以下消息类型由 `TeamManager.handleChildMessage()` 直接处理，**不经过** IpcRegistry：

| 消息类型 | 说明 | 响应 |
|---------|------|------|
| `status` | 更新队友状态（working/idle/holding/shutdown） | 无 |
| `teammate_ready` | spawn 完成就绪通知 | 无 |
| `eta_update` | 时间预算通知（更新截止时间） | 无 |
| `log` | 记录日志（带 @sender/tool 标签路由到 teammate timeline） | 无 |
| `error` | 记录错误 | 无 |
| `verbose` | 详细日志（仅 -v 模式） | 无 |
| `condition_replace` | skill_compile 后通知重载 hook 条件 | 无 |
| `question` | 用户提问（加入 pendingQuestions 队列，稍后在 COLLECT 状态处理） | `question_result` |

### IpcRegistry 注册的处理器

以下消息类型通过 `IpcRegistry.dispatch()` 分发到注册的 handler：

**issue 模块**（响应类型 `db_result`）：

| 消息类型 | 说明 | 响应数据 |
|---------|------|------|
| `db_issue_get` | 获取 Issue | `Issue` |
| `db_issue_list` | 列出 Issue | `Issue[]` |
| `db_issue_create` | 创建 Issue | `{ id: number }` |
| `db_issue_claim` | 认领 Issue | `{ claimed: boolean }` |
| `db_issue_publish` | 发布 Issue | `{ published: boolean }` |
| `db_issue_close` | 关闭 Issue | 无 |
| `db_issue_comment` | 添加评论 | 无 |
| `db_block_add` | 添加阻塞关系 | 无 |
| `db_block_remove` | 移除阻塞关系 | 无 |
| `db_issue_clear_all` | 清空所有 Issue | 无 |

**team 模块**（响应类型 `team_result`）：

| 消息类型 | 说明 | 响应数据 |
|---------|------|------|
| `team_print` | 获取团队状态 | `{ message: string }` |

**wiki 模块**（响应类型 `wiki_result`）：

| 消息类型 | 说明 | 响应数据 |
|---------|------|------|
| `wiki_prepare` | Wiki 准备 | prepare 结果 |
| `wiki_put` | Wiki 存储 | put 结果 |
| `wiki_get` | Wiki 查询 | 查询结果 |
| `wiki_delete` | Wiki 删除 | 删除结果 |
| `wiki_get_by_domain` | 按域查询 | 结果列表 |
| `wiki_batch_put` | 批量存储 | 结果列表 |
| `wiki_wal_get` | 获取 WAL | WAL 条目 |
| `wiki_wal_append` | 追加 WAL | 无 |
| `wiki_rebuild` | 重建索引 | 重建结果 |
| `wiki_domains_list` | 列出域 | 域列表 |
| `wiki_domain_get` | 获取域 | 域信息 |
| `wiki_domain_register` | 注册域 | 无 |

**core 模块**（响应类型 `core_result`）：

| 消息类型 | 说明 | 响应数据 |
|---------|------|------|
| `core_img_describe` | 图片描述 | `{ description: string }` |
| `core_read_picture_cached` | 图片缓存读取 | `PictureResult` |

**grant 模块**（响应类型 `grant_result`）：

| 消息类型 | 说明 | 响应数据 |
|---------|------|------|
| `grant_request` | 授权请求 | `{ approved: boolean, reason?: string }` |
| `external_path_access` | 外部路径访问请求 | `{ approved: boolean, resolvedPath: string, reason?: string }` |

## 设计决策

### 为什么使用注册模式而不是继承？

1. **模块独立性**：各模块不需要继承 `TeamManager`
2. **松耦合**：模块可以在任何时候注册/注销处理器
3. **类型安全**：TypeScript 可以检查处理器类型

### 为什么处理器需要 AgentContext？

子进程无法直接访问 SQLite 数据库（进程隔离），所有数据库操作必须通过 IPC 发送到主进程执行。处理器通过 `ctx.issue`、`ctx.mail` 等访问模块，保持与主进程相同的 API。

### 为什么区分通知和请求-响应？

- **通知**：适用于状态更新、日志等不需要确认的场景，减少 IPC 往返
- **请求-响应**：适用于需要返回数据的操作（如创建 Issue 返回 ID）

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/types.ts` | 类型定义（IpcHandlerRegistration、SendResponseCallback 等） |
| `src/context/ipc-registry.ts` | IpcRegistry 注册表实现 |
| `src/context/parent/team.ts` | TeamManager — IPC 消息接收、直接处理通知、dispatch 到 IpcRegistry |
| `src/context/parent-context.ts` | ParentContext — `initializeIpcHandlers()` 注册所有 handler |
| `src/context/child/ipc-helpers.ts` | IpcClient — 子进程 IPC 通信原语、RESPONSE_TYPES 定义 |