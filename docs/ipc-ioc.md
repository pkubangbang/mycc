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
  responseType: string,    // 响应类型，如 'db_result', 'wt_result'
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

不同的模块使用不同的响应类型：

| 响应类型 | 模块 | 说明 |
|---------|------|------|
| `db_result` | issue | 数据库操作结果 |
| `wt_result` | wt | 工作树操作结果 |
| `team_result` | team | 团队操作结果 |
| `question_result` | core | 用户问答结果 |
| `error` | 通用 | 错误响应 |

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

  // 检查处理器是否存在
  hasHandler(messageType: string): boolean;

  // 分发消息到处理器
  async dispatch(sender: string, msg: { type: string; [key: string]: unknown }): 
    Promise<void | IpcHandlerResult>;

  // 列出所有处理器（调试用）
  listHandlers(): { messageType: string; module: string }[];
}
```

### 错误处理

- 重复注册同一消息类型会抛出错误
- 处理器执行异常会返回 `{ success: false, error: '...' }`
- 未注册的消息类型返回 `undefined`（静默忽略）

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

```typescript
// src/context/index.ts

import { createMyModule, createMyModuleIpcHandlers } from './my-module.js';

export function createAgentContext(workDir?: string): AgentContext {
  // ... 创建模块 ...

  // 注册处理器
  for (const handler of createMyModuleIpcHandlers()) {
    team.registerHandler(handler);
  }

  return ctx;
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

### team 模块

| 消息类型 | 说明 | 响应 |
|---------|------|------|
| `status` | 更新队友状态 | 无 |
| `log` | 记录日志 | 无 |
| `error` | 记录错误 | 无 |

### issue 模块

| 消息类型 | 说明 | 响应 |
|---------|------|------|
| `db_issue_create` | 创建 Issue | `{ id: number }` |
| `db_issue_claim` | 认领 Issue | `{ claimed: boolean }` |
| `db_issue_close` | 关闭 Issue | 无 |
| `db_issue_comment` | 添加评论 | 无 |
| `db_block_add` | 添加阻塞关系 | 无 |
| `db_block_remove` | 移除阻塞关系 | 无 |

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
| `src/types.ts` | 类型定义 |
| `src/context/ipc-registry.ts` | 注册表实现 |
| `src/context/team.ts` | IPC 消息分发 |
| `src/context/issue.ts` | Issue 模块处理器示例 |
| `src/context/index.ts` | 处理器注册入口 |