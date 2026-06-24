# 漫游指南：普通单人模式

> *一篇 mycc 代理循环的漫游指南——讲述单个 LLM 代理如何接收用户请求、经过 6 个状态、并交付结果。*

---

## 序幕：提示符

终端上显示 `agent >>`（黄底黑字）。用户输入：

```
agent >> 在 src/math.ts 中添加一个斐波那契函数
```

按下回车键。代理循环开始。

---

## 状态 1：PROMPT

状态机处于 **PROMPT** 状态，等待用户输入。用户提交后：

1. **`markPromptBoundary()`** 被调用——清除本轮事件数组，定义轮次边界。会话级别的 `totalEventsCount` 被保留。
2. 输入被检查是否为**斜杠命令**（`/mode`、`/plan`、`/mindmap` 等）——如果以 `/` 开头，机器转换到 **SLASH** 状态。
3. 如果输入以 `!` 开头，则是 **bang 命令**——提示符切换到品红色的 `run cmd !`，命令直接在 tmux 弹出窗口中运行。
4. 否则，查询被存储在 `TurnVars.lastUserQuery` 中，机器转换到 **COLLECT**。

PROMPT 状态是唯一与人类交互的状态。其他所有状态都是 LLM 和工具在自主运行。

---

## 状态 2：COLLECT

在 LLM 看到查询之前，系统会准备上下文。**COLLECT** 状态执行多项检查：

### 邮件收集
如果有来自队友的待处理邮件，它们会被收集并格式化给 LLM。在单人模式下，这通常是空的。

### 提示轮次检查
**困惑指数（Confusion Index）** 被检查。这是在 `ctx.core` 中追踪的分数，衡量代理卡住的程度：

| 事件 | 分数变化 |
|-------|:-------:|
| 非重复动作工具 | -1 |
| 重复动作工具 | +1 |
| 工具错误 | +2 |
| 重复 `mail_to` | +2 |
| 助手回合（计划模式） | +1 |

如果分数达到 **10**，**提示轮次（hint round）** 触发：LLM 被要求分析障碍和下一步，结果作为 HINT 笔记注入。

### Todo 提醒
每 **3 轮**，如果有开放的 todo，系统会提醒 LLM。

### Brief 提醒
每 **5 轮**，系统提醒代理使用带置信度参数的 `brief` 工具。

### 主动技能发现
系统从用户查询中提取**关键词**并搜索相关技能。对于"添加斐波那契函数"，它可能找到关于 `coding`、`typescript` 或 `math` 的技能。这些技能被加载并供 LLM 使用。

---

## 状态 3：LLM

现在 LLM 被调用。这是最复杂的状态。

### 系统提示构建
系统提示被动态构建，包含：
- **角色定义**："你是一个编码代理……"
- **模式特定指令**：普通模式（所有工具可用）vs 计划模式（只读）
- **工具定义**：所有 30+ 个工具及其描述和 JSON Schema
- **意图语言表**：VERB OBJECT TO PURPOSE 格式用于 bash
- **项目上下文**：README、mindmap 指令、待处理的 hooks
- **平台信息**：Windows、PowerShell、路径分隔符

### 带 escAware 的 retryChat
LLM 调用被包裹在 `escAware` 中——如果用户按下 **ESC**，调用立即中止。`retryChat` 函数处理重试，如果 LLM 响应失败则使用指数退避。

### 十字路口检测（Crossroad）
LLM 响应后，**十字路口**系统扫描 LLM 输出中的**转折词**——表示不确定性或方向变化的短语：

| 层级 | 示例 | 检测方式 |
|------|------|----------|
| **强** | "话虽如此"、"另一方面"、"尽管如此" | 完整短语匹配 |
| **句首** | "然而，"、"但是，"、"不过，"、"等等，" | 单词 + 逗号在句首 |
| **特殊** | "但"、"However" 作为插入语 | 特定模式匹配 |

如果发现转折词：
1. **截断** LLM 响应在转折词处
2. **生成 3 个替代续写** 通过 `forkChat`（单轮侧聊）：
   - **向前走**：继续当前方法
   - **向后退**：重新考虑方法
   - **综合**：结合两者
3. **选择最佳路径** 使用另一个 LLM 调用
4. **注入续写** 在 HOOK 状态中通过合成的 `brief()` 调用

### 空响应处理
如果 LLM 返回空（无文本、无工具调用），系统注入一个合成的 `brief("Let me see what to do next.", 7)` 调用来推动 LLM 重新参与，然后重试。

---

## 状态 4：HOOK

在任何工具运行之前，**HOOK** 状态评估所有已编译的 hook 条件。

### Hook 评估
每个已编译的 hook 有：
- **触发器（Trigger）**：哪个工具/事件触发它（例如 `git_commit`、`write_file`）
- **条件（Condition）**：一个 jsep AST 表达式，针对 `Sequence` 求值（安全，无 `eval`）
- **动作（Action）**：做什么——`inject_before`、`inject_after`、`block`、`replace`、`message` 或 `compact`

例如，一个 `lint-after-edit` hook 可能：
- **触发器**：`git_commit`
- **条件**：`seq.has('edit_file') || seq.has('write_file')`
- **动作**：`block`——阻止提交直到 lint 通过

### 元工具分发
两个特殊工具——`checkpoint` 和 `recap`——在这里处理，而不是在常规的 TOOL 状态。它们需要访问 triologue，这在 `AgentContext` 之外。HOOK 状态拦截它们并直接运行。

### 十字路口续写注入
如果十字路口在 LLM 状态中被触发，选定的续写在这里作为合成的 `brief()` 调用注入，替换原始的工具调用。流程转到 COLLECT，让 LLM 重新生成工具调用。

### 压缩请求
如果 hook 请求压缩（例如由于意图语言混乱），系统立即压缩对话并返回 COLLECT。

---

## 状态 5：TOOL

现在 LLM 的工具调用被执行。

### 顺序执行
LLM 响应中的工具调用被**逐一**按顺序执行。每个工具：
1. 接收 `AgentContext` 及其参数
2. 运行其处理器
3. 返回结果字符串

### escAware 包装
每个工具执行被包裹在 `escAware` 中——如果用户按下 ESC，剩余的工具调用被跳过，系统进入**被忽略模式（neglected mode）**。

### 困惑评分
每个工具结果后，困惑指数被更新：
- **探索**：使用 `read_file`、`grep`、`web_search` → 不变
- **行动**：使用 `write_file`、`edit_file`、`bash` → 新操作 -1，重复 +1
- **错误**：工具返回错误 → +2

### 自动压缩（Auto-Compact）
每个工具结果后，系统检查 token 数是否超过 `TOKEN_THRESHOLD`（默认：50000）。如果超过：
1. 完整对话被保存到 triologue JSONL 文件
2. LLM 被调用**总结**对话为紧凑形式
3. 摘要作为 `[Conversation compressed]` 用户/助手对替换冗长的历史

---

## 状态 6：STOP

所有工具执行完毕后（或因 ESC 跳过），**STOP** 状态运行：

### 信函框显示（Letter Box）
LLM 的最终回复显示在**绿色边框的信函框**（80 字符宽，Tailwind green-500 边框，green-600 文字）中，带有时间戳标题。

```
.======================= 14:30:22 =======================.
已向 src/math.ts 添加了斐波那契函数。
'========================================================='
```

### 团队等待（单人：无操作）
在单人模式下，没有队友需要等待。但系统仍然检查——如果存在队友，它进入**两阶段等待**：
- **阶段 1**：等待工作中的队友变为空闲
- **阶段 2**：等待空闲队友关闭

### 返回 PROMPT
机器转换回 **PROMPT**，`agent >>` 提示符重新出现，循环准备再次开始。

---

## 插曲：ESC——紧急刹车

在 LLM 或 TOOL 状态的任何时刻，用户可以按下 **ESC**。这会触发：

1. **LLM 中止**：当前 LLM 调用被终止
2. **工具跳过**：剩余的工具调用被丢弃
3. **后台收尾**：一个快速的纯文本 LLM 调用生成摘要响应
4. **宽限期**：收尾结果等待 3 秒——如果用户在该时间内输入新查询，收尾被**回滚**（从 triologue 中截断）。否则，它被**永久提交**。

这就是**被忽略模式**——代理确认中断，生成简洁响应，并将控制权返回给用户。

---

## 数据流：三层架构

贯穿整个旅程，数据流经三个层级：

| 层级 | 作用域 | 内容 |
|------|--------|------|
| **MachineEnv** | 生命周期（一次） | Triologue、AgentContext、HookExecutor、InputProvider |
| **TurnVars** | 每轮（PROMPT→STOP） | 上次用户查询、提醒计数器 |
| **PassData** | 每次传递（COLLECT→STOP） | 工具调用、助手内容、hook 结果、十字路口续写 |

**MachineEnv** 在代理启动时构建一次。**TurnVars** 在每个 PROMPT 边界重置。**PassData** 在每次 COLLECT 入口重置——意味着如果十字路口触发重新生成，PassData 对新传递是全新的。

---

## 对话记录：一个真实的例子

以下是一个典型的 triologue 交互。每行是一条带有角色的消息：

```
[system]  (系统提示词 — 5000+ 字符，未显示)
[user]    在 src/math.ts 中添加一个斐波那契函数
[assistant] 我先读取现有文件。
            tool: read_file("src/math.ts")
[tool]    (文件内容...)
[assistant] 我看到文件了。让我添加斐波那契函数。
            tool: edit_file("src/math.ts", ...)
[tool]    OK
[assistant] 让我验证一下。
            tool: bash("node -e \"...\"")
[tool]    55
[assistant] 完成！斐波那契函数工作正常。
```

Triologue 遵循严格的角色轮转：`system → user → assistant → tool → assistant → tool → ...`。每条助手消息可以包含零个或多个工具调用。每个工具调用对应一条独立的 tool 响应消息。

---

## 状态机图

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

- **对话轮次**：PROMPT → ... → STOP → PROMPT（新轮次，新 TurnVars）
- **管道传递**：COLLECT → LLM → HOOK → TOOL → COLLECT（每轮多次传递）
- **斜杠命令**：PROMPT → SLASH → PROMPT（同轮次，不重置 TurnVars）
- **STOP → COLLECT**：当队友有待处理的问题或邮件，或发生超时时

---

## 术语表

参见 [glossary.md](glossary.md) 获取本文中使用的术语定义。

---

*漫游指南结束：普通单人模式*
