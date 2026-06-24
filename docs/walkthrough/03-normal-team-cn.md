# 漫游指南：普通团队模式

> *一篇 mycc 团队模式的漫游指南——讲述领导代理如何生成队友代理、它们如何通信、以及如何并行完成工作。*

---

## 序幕：领导决定委派

用户输入了一个复杂的请求：

```
agent >> 重构项目：将数学工具函数提取到独立模块中，添加测试，并更新所有导入
```

领导代理（主 LLM 进程）思考了一下。这是三个任务：
1. 提取数学工具函数
2. 添加测试
3. 更新导入

这些任务是**独立的**——可以并行完成。领导决定生成队友。

---

## 第一幕：生成队友

领导调用 `tm_create`：

```typescript
tm_create({
  name: "extractor",
  role: "developer",
  prompt: "你是一名开发者。认领 issue #1 并提取数学工具函数..."
})

tm_create({
  name: "tester",
  role: "tester",
  prompt: "你是一名测试员。认领 issue #2 并编写测试..."
})

tm_create({
  name: "importer",
  role: "developer",
  prompt: "你是一名开发者。认领 issue #3 并更新导入..."
})
```

### 幕后发生了什么

`TeamManager.createTeammate()` 方法：

1. **生成子进程** 通过 `spawnTsx()`——一个运行 `npx tsx` 在队友工作脚本上的辅助函数
2. **设置 IPC** 通过 `child_process.fork()`——父子进程之间的消息传递
3. **创建邮箱**——一个基于文件的追加式 JSONL 文件，位于 `.mycc/mail/{name}.jsonl`
4. **在内存存储中注册队友**，状态为 `'working'`
5. **发送初始提示**作为邮箱中的第一条消息

每个队友运行自己的**自主代理循环**，带有：
- **ChildContext**：受限版本的 AgentContext，写操作通过 IPC 发送到父进程
- **silentLoader**：抑制非关键警告的 Loader 实例
- **子作用域工具**：工具子集（没有 `tm_create`、`tm_remove`、`tm_await`、`broadcast`、`order`、`hand_over`、`plan_on/off`）

---

## 第二幕：队友的自主循环

每个队友运行一个简化的 while-true 循环（不是领导的 6 状态机）。循环包含以下阶段：

```
┌─────────────────────────────────────────────────────────────┐
│                    队友循环                                  │
│                                                             │
│  1. 从基于文件的邮箱收集邮件                                  │
│  2. 检查模式变更通知                                        │
│  3. Todo 提醒（每 3 轮）                                     │
│  4. 时间提醒（每 3 轮，如果设置了预算）                       │
│  5. 构建系统提示词 → 调用 LLM                                │
│  6. 执行工具调用（逐一）                                     │
│  7. 检查困惑指数（≥10 → 发邮件向领导求助）                    │
│  8. Brief 提醒（每 5 轮）                                    │
│                                                             │
│  如果没有产生工具调用：                                       │
│    → 进入 IDLE 状态（轮询邮件 + 自动认领 issue）              │
└─────────────────────────────────────────────────────────────┘
```

### 与领导的关键差异

| 方面 | 领导代理 | 队友代理 |
|--------|-----------|----------------|
| **状态机** | 6 状态（PROMPT→COLLECT→LLM→HOOK→TOOL→STOP） | 简化的 while-true 循环 |
| **输入来源** | 人类用户通过 LineEditor | 邮箱轮询 |
| **工具作用域** | 完整（`main`） | 受限（`child`） |
| **写操作** | 直接文件系统访问 | 通过 IPC 到父进程 |
| **空闲行为** | 不适用（始终等待用户） | 轮询邮件 + 自动认领 issue |
| **心跳** | 不适用 | 每 30 秒发送给领导 |
| **错误处理** | 崩溃时重试提示 | 记录并继续（永不崩溃） |

### 没有用户输入
队友没有人类用户。它的"提示"来自邮箱。在循环开始时，它检查新邮件而不是等待键盘输入。

### 受限工具
队友不能：
- 生成自己的队友（`tm_create`、`tm_remove`、`tm_await`）
- 向团队广播（`broadcast`）
- 使用 `order`（组合 mail_to + await）
- 打开交互式终端（`hand_over`）
- 切换模式（`plan_on`、`plan_off`）

如果队友需要这些，它必须**通过 mail_to 向领导请求**。

### IPC 写操作
当队友调用 `write_file` 或 `edit_file` 时，操作通过 IPC 进行：
1. 队友发送 `sendRequest` 到父进程
2. 父进程评估**授权系统**（工作树所有权、模式检查）
3. 父进程执行操作并将结果发送回来
4. 队友接收响应并继续

### 自动认领（Auto-Claim）
空闲时，队友自动认领未分配的 issue。**自动认领**系统每 **5 秒**（`POLL_INTERVAL = 5000ms`）轮询符合以下条件的 issue：
- 状态：`pending`
- 无所有者
- 无阻塞器

找到后，队友原子性地调用 `issue_claim(id, owner)` 并开始工作。

### 心跳
每 **30 秒**，工作中的队友通过 IPC 向领导发送心跳：

```
[PROGRESS] 45s elapsed, still working.
```

这让领导知道队友还活着并在工作。

---

## 第三幕：通过 Issue 分配任务

领导为每个任务创建 issue：

```typescript
issue_create({ title: "提取数学工具函数", content: "将数学函数移动到 src/math/" })
issue_create({ title: "为数学模块添加测试", content: "编写单元测试..." })
issue_create({ title: "更新导入", content: "更新所有导入数学函数的文件..." })
```

然后分配它们：

```typescript
issue_claim({ id: 1, owner: "extractor" })
issue_claim({ id: 2, owner: "tester" })
issue_claim({ id: 3, owner: "importer" })
```

并通过邮件通知：

```typescript
mail_to({
  name: "extractor",
  title: "Issue #1 已分配给你",
  content: "你拥有 issue #1：将数学工具函数提取到 src/math/..."
})
```

### Issue 生命周期

每个 issue 经历一个清晰的生命周期：

```
pending → in_progress → completed
                        → failed
                        → abandoned
```

Issue 还可以有**阻塞关系**：

```typescript
issue_create({ title: "重构数学工具", blockedBy: [1] })
// 这个 issue 在 #1 完成之前不能被认领
```

当阻塞器被关闭时，依赖的 issue 自动解除阻塞。

### 邮件系统

邮件是**基于文件**的——每个代理在 `.mycc/mail/{name}.jsonl` 有一个 JSONL 文件。消息作为 JSON 行追加，包含：
- `id`：唯一消息 ID
- `from`：发送者名称
- `title`：主题
- `content`：正文
- `timestamp`：ISO 日期

接收者在每次循环迭代开始时通过 `collectMails()` 检查邮箱。`collectMails()` 读取文件、截断它（原子性读取并清除）、并返回消息。消息作为 `MAIL` 笔记注入到 triologue 中。

---

## 第四幕：并行执行

现在三个代理同时工作：

```
领导:     [COLLECT] → [LLM] → [HOOK] → [TOOL] → [STOP] → [PROMPT]
                ↑
                | IPC
                ↓
提取者:   [COLLECT] → [LLM] → [HOOK] → [TOOL] → [STOP] → [PROMPT]
测试者:   [COLLECT] → [LLM] → [HOOK] → [TOOL] → [STOP] → [PROMPT]
导入者:   [COLLECT] → [LLM] → [HOOK] → [TOOL] → [STOP] → [PROMPT]
```

每个代理独立运行，拥有自己的：
- **Triologue**：独立的对话历史
- **Mindmap**：独立实例（`.mycc/mindmap-{name}.json`）
- **困惑指数**：独立评分
- **工具执行**：每个代理内顺序执行

### 时间提醒

如果队友有预算（ETA 截止时间），系统每 **3 轮**发送**时间提醒**，告知剩余时间。这防止队友陷入无底洞。

---

## 第五幕：通信模式

### mail_to——异步消息

主要通信渠道。代理发送异步消息：

```typescript
// 队友发给领导
mail_to({
  name: "lead",
  title: "Issue #1 的进展",
  content: "已提取 3 个数学函数。发现对 src/utils.ts 有依赖——需要检查它是否在其他地方使用。"
})

// 领导回复队友
mail_to({
  name: "extractor",
  title: "回复：对 src/utils.ts 的依赖",
  content: "那个依赖只在数学函数中使用。把它包含在提取中。"
})
```

### broadcast——团队公告

对于每个人都应该看到的消息：

```typescript
broadcast({
  title: "所有任务完成——收尾",
  content: "重构已完成。请关闭你的 issue 并准备审查。"
})
```

### order——同步任务分配

`order` 工具将 `mail_to` + `tm_await` 组合为单个调用：

```typescript
order({
  name: "extractor",
  title: "修复这个特定文件",
  content: "编辑 src/math/fib.ts 添加错误处理..."
})
// 阻塞直到 extractor 完成
```

这在领导需要在继续之前完成特定任务时很有用。

---

## 第六幕：监控和等待

### 两阶段等待

当领导调用 `tm_await()` 时，系统进入**两阶段等待**：

1. **阶段 1**（working → idle）：等待所有工作中的队友完成当前任务。当队友转换到空闲时，订阅者被通知。
2. **阶段 2**（idle → shutdown）：等待空闲队友关闭。这发生在他们没有更多工作要做时。

每个阶段都有可配置的超时。如果队友超过其 ETA，领导会被通知。

### Issue 追踪

领导可以随时检查进度：

```typescript
issue_list()
// Issues:
//   [>] #1: 提取数学工具函数 @extractor
//   [>] #2: 为数学模块添加测试 @tester
//   [>] #3: 更新导入 @importer
```

当队友完成一个 issue 时，他们关闭它：

```typescript
issue_close({ id: 1, status: "completed", comment: "已提取到 src/math/", poster: "extractor" })
```

关闭阻塞器会自动解除依赖 issue 的阻塞。

---

## 第七幕：处理问题

### 卡住的队友

每个队友追踪一个**困惑指数**：

| 事件 | 分数变化 |
|-------|-------------|
| 每轮助手回合 | +1 |
| 非重复动作工具 | -1 |
| 重复动作工具 | +1 |
| 重复 mail_to | +2 |
| 工具返回错误 | +2 |

当困惑指数达到 **10** 时，队友向领导发送求助邮件：

```
来自：tester
主题：卡住了——需要指导
内容：我卡住了（困惑指数：10）。测试一直失败，因为数学模块的导出发生了变化。
      我应该针对什么进行测试？
```

领导可以通过 `mail_to` 回复指导。

### 错过截止时间

如果队友超过其 ETA，领导会被通知。领导可以：
- 通过带有更新 ETA 的新 `mail_to` 延长截止时间
- 将工作重新分配给另一个队友
- 直接接手任务

### 无响应的队友

如果队友停止响应，领导可以：
1. 使用 `tm_print` 检查状态
2. 发送邮件检查状态
3. 使用 `tm_remove({ name: "tester", force: true })` 强制移除

---

## 第八幕：收集结果

当所有队友完成时，领导收集结果：

```typescript
tm_await()  // 等待所有队友

// 检查结果
issue_list()
// 所有 issue 应该已关闭

// 读取最终邮件
// 队友应该已发送完成报告

// 清理
tm_remove({ name: "extractor" })
tm_remove({ name: "tester" })
tm_remove({ name: "importer" })
```

然后领导向用户报告：

```typescript
brief({
  message: "重构完成。数学工具函数已提取到 src/math/，测试已添加，导入已更新。",
  confidence: 10
})
```

---

## 对话记录：一个真实的团队协作

团队会话的 triologue 展示了来自领导、队友和系统笔记的消息：

### 步骤 1：领导生成队友并创建 issue

```
[assistant] tm_create(name="extractor", role="dev", prompt="...")
[tool]    OK
[assistant] tm_create(name="tester", role="tester", prompt="...")
[tool]    OK
[assistant] issue_create(title="提取数学工具")
[tool]    已创建 issue #1
[assistant] issue_create(title="添加测试")
[tool]    已创建 issue #2
[assistant] issue_claim(id=1, owner="extractor")
[tool]    已认领
[assistant] issue_claim(id=2, owner="tester")
[tool]    已认领
```

### 步骤 2：队友自动认领并开始工作

```
[user]    [MAIL] 来自 extractor 的邮件：开始处理 issue #1
[assistant] (extractor 的内部循环)
            tool: read_file("src/utils.ts")
[tool]    (文件内容...)
[assistant] tool: write_file("src/math/index.ts", ...)
[tool]    OK
```

### 步骤 3：队友遇到问题

```
[user]    [MAIL] 来自 tester 的邮件：卡住了——需要指导
           "测试一直失败，因为数学模块的导出发生了变化。"
[assistant] 让我检查一下情况。
            tool: mail_to(name="tester", content="导出已经最终确定了。")
[tool]    OK
```

### 步骤 4：队友完成并报告

```
[user]    [MAIL] 来自 extractor 的邮件：Issue #1 完成
[user]    [MAIL] 来自 tester 的邮件：Issue #2 完成
[assistant] 让我收集结果。
            tool: tm_await()
[tool]    OK
[assistant] tool: issue_list()
[tool]    所有 issue 已关闭
[assistant] 完成！让我向用户报告。
            tool: brief("重构完成。", 10)
[tool]    OK
```

在团队模式下，triologue 包含系统生成的笔记，如 `[MAIL]`（来自队友）和 `[TEAM_STATUS]`（定期状态更新）。领导将这些视为 user 角色的消息并相应回复。

---

## 尾声：架构全景

### 进程模型

```
┌─────────────────┐     IPC (fork)     ┌──────────────────┐
│   协调器         │◄──────────────────►│   领导代理        │
│  (src/index.ts)  │                    │  (src/lead.ts)    │
└─────────────────┘                    └────────┬──────────┘
                                                │
                                    ┌───────────┼───────────┐
                                    │           │           │
                                    ▼           ▼           ▼
                            ┌──────────┐ ┌──────────┐ ┌──────────┐
                            │ 队友 1   │ │ 队友 2   │ │ 队友 3   │
                            │ (子进程)  │ │ (子进程)  │ │ (子进程)  │
                            └──────────┘ └──────────┘ └──────────┘
```

三层进程：

1. **协调器（Coordinator）**（`src/index.ts`）：父进程。管理领导，在终端和领导之间转发 I/O，处理 Ctrl+C/ESC，检测目录变更以重启。

2. **领导（Lead）**（`src/lead.ts`）：主代理。运行 6 状态机，处理用户交互，生成队友，收集结果。

3. **队友（Teammates）**（`teammate-worker.ts`）：子进程。每个运行一个自主循环，带有受限工具和基于 IPC 的写操作。

### 通信流程

```
                    ┌─────────────────────────────────────┐
                    │         文件系统                      │
                    │  .mycc/mail/extractor.jsonl          │
                    │  .mycc/mail/tester.jsonl            │
                    │  .mycc/mail/importer.jsonl          │
                    └─────────────────────────────────────┘
                               ▲          │
                    mail_to    │          │  mail_to
                    (追加)      │          │  (收集)
                               │          ▼
                    ┌─────────────────────────────────────┐
                    │         IPC 通道                     │
                    │  (child_process.fork)               │
                    │  - 写操作 (write_file)              │
                    │  - 授权请求                          │
                    │  - 心跳                              │
                    │  - 状态更新                          │
                    │  - 问题                              │
                    └─────────────────────────────────────┘
```

- **mail_to**：异步，基于文件。发送者追加到 JSONL 文件；接收者读取并清除。
- **IPC**：同步请求-响应。用于写操作、授权请求和状态更新。
- **broadcast**：向所有队友的邮箱发送相同邮件。
- **order**：mail_to + tm_await 组合为一个阻塞调用。

### 独立的 Mindmap

每个代理有自己的 mindmap 实例：
- 领导：`.mycc/mindmap.json`
- 队友：`.mycc/mindmap-{name}.json`

这防止了知识访问上的竞态条件。如果队友需要共享知识，他们使用 **Wiki**（RAG）或 `mail_to`。

### 关键设计决策

1. **基于文件的邮件**而非直接 IPC：解耦代理——它们不需要同步。即使接收者忙碌，邮件也会持久存在。
2. **两阶段等待**：防止竞态条件——领导先等待工作完成，再等待关闭。
3. **自动认领**：消除了显式任务分配的需要——空闲队友自动接手工作。
4. **子作用域限制**：队友不能生成自己的队友（防止失控进程）。写操作通过 IPC 进行（强制执行工作树所有权）。
5. **困惑指数与求助**：队友自我检测卡住状态并升级到领导。

---

## 状态机图

领导运行 6 状态机。队友运行简化的 while-true 循环。

### 领导的状态机

```
        ┌────────────────────────────────────────────┐
        │                                            │
   ┌─── PROMPT ◄────────────────────┐               │
   │    │   ▲                       │               │
   │    ▼   │                       │               │
   │  SLASH─┘                       │               │
   │                                │               │
   │    ▼                           │               │
   │  COLLECT ◄─────── TOOL ─────┐ │               │
   │    │              ▲         │ │               │
   │    ▼              │         │ │               │
   │  LLM ────► HOOK ──┘       STOP ──────────────┘
   │                │              │           │
   │          has calls        no calls    has mail
   │                                        or question
   └── (pendingSlashQuery set by SLASH)
```

### 队友的循环

```
  [收集邮件] → [LLM 调用] → [执行工具] → [检查困惑]
       │                                              │
       └── 无工具：进入 IDLE 状态                      │
           ├── 轮询邮箱（5 秒）                         │
           ├── 自动认领 issue                          │
           └── 检查关闭标志                            │
                                                      │
              ┌───────────────────────────────────────┘
              │ (困惑 ≥ 10)
              ▼
         mail_to(lead, "卡住了——需要指导")
```

---

## 术语表

参见 [glossary.md](glossary.md) 获取本文中使用的术语定义。

---

*漫游指南结束：普通团队模式*
