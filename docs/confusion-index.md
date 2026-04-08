## 什么是 Confusion Index

Confusion Index（混淆指数）是一个量化 LLM agent "是否陷入困境" 的指标。当 agent 在循环中反复探索却无法推进任务时，混淆指数上升；当 agent 采取有效行动时，指数下降。一旦指数达到阈值，系统自动触发 hint round（提示轮），让 LLM 自我分析问题并给出建议。

## 计算公式

混淆指数是一个累加积分，由以下五个因子决定：

| 因子 | 分值 | 含义 |
|------|------|------|
| Assistant Response | +1 | 每次助手回复都加分，因为每轮回复意味着 agent 还在转 |
| Exploration Tool | 0 | 只读工具（read_file, question 等），不加分也不减分 |
| Action Tool | -1 | 修改状态的工具（write_file, edit_file 等），代表在推进任务 |
| Repetition | +1 | 最近 5 次工具调用中重复使用同一工具，可能陷入循环 |
| Tool Error | +2 | 工具执行结果包含错误，说明 agent 遇到障碍 |

### 计算时机

每个 agent loop 迭代中，混淆指数在两个时机更新：

1. **assistant 回复后**：调用 `confusion.onAssistantResponse()`，+1
2. **工具执行后**：调用 `triologue.onToolResult(toolName, args, result)`，依次：
   - `confusion.onToolCall(toolName, args)` — 根据工具类型加减分
   - `confusion.onError(result)` — 检测结果是否包含错误

### 重置

以下情况会重置混淆指数为 0：

- 用户发送新消息（`triologue.resetHint()`）
- autoCompact 触发压缩后
- hint round 生成后

## 工具分类

### Exploration Tools（探索工具，0 分）

只读操作，用于获取信息：

```
read_file, web_search, web_fetch, brief,
issue_list, wt_print, bg_print, tm_print, question
```

### Action Tools（行动工具，-1 分）

修改状态的操作，代表任务推进：

```
write_file, edit_file, todo_write,
issue_create, issue_close, issue_claim, issue_comment,
blockage_create, blockage_remove,
tm_create, tm_remove,
wt_create, wt_remove,
bg_create, bg_remove,
mail_to, broadcast
```

### Bash 工具（特殊处理）

Bash 命令根据内容动态分类：

- **只读命令**（0 分）：`ls`, `cat`, `pwd`, `head`, `tail`, `wc`, `find`, `which`, `git status/log/diff/branch/show/ls-files`
- **其他命令**（-1 分）：默认视为行动工具

## 错误检测

`isErrorResult()` 函数检测工具返回值中的错误模式：

| 模式 | 示例 |
|------|------|
| 错误前缀 | `Error:`, `Error `, `fatal:` |
| Shell 退出码 | `command failed with exit code 1` |
| Node.js 错误码 | `EACCES`, `ENOENT`, `EPERM` |
| 权限拒绝 | `permission denied` |
| 未找到 | `not found`, `does not exist`, `no such file` |

只有被识别为错误的结果才会加 2 分，普通结果不影响混淆指数。

## Hint Round 触发机制

当混淆指数 >= 阈值（默认 10）时，`needsHintRound()` 返回 true，触发以下流程：

```
score >= threshold
  ↓
hintGenerated == false?（每个用户查询最多触发一次）
  ↓
lastRole == 'assistant' || 'tool'?（需要在合法转折点）
  ↓
触发 hint round
```

Hint round 的执行步骤：

1. 将当前对话摘要构建为分析 prompt
2. 调用 LLM 分析对话中的问题和阻塞
3. 将分析结果以 `[HINT]` 前缀注入为 user 消息
4. 获取 assistant 确认
5. 设置 `hintGenerated = true`，防止重复触发

## 示例计算

以下是一个典型的陷入困境的场景：

| 步骤 | 事件 | 分值变化 | 累计 |
|------|------|----------|------|
| 1 | Assistant 回复 | +1 | 1 |
| 2 | read_file（探索） | 0 | 1 |
| 3 | Assistant 回复 | +1 | 2 |
| 4 | bash ls（只读） | 0 | 2 |
| 5 | Assistant 回复 | +1 | 3 |
| 6 | read_file（重复） | 0 +1 | 4 |
| 7 | Assistant 回复 | +1 | 5 |
| 8 | edit_file（行动） | -1 | 4 |
| 9 | Tool Error（EACCES） | +2 | 6 |
| 10 | Assistant 回复 | +1 | 7 |
| 11 | read_file（重复） | 0 +1 | 8 |
| 12 | Assistant 回复 | +1 | 9 |
| 13 | edit_file（行动，重复） | -1 +1 | 9 |
| 14 | Tool Error（ENOENT） | +2 | 11 |
| — | score >= 10，触发 hint round | | |

对比一个顺利推进的场景：

| 步骤 | 事件 | 分值变化 | 累计 |
|------|------|----------|------|
| 1 | Assistant 回复 | +1 | 1 |
| 2 | write_file（行动） | -1 | 0 |
| 3 | Assistant 回复 | +1 | 1 |
| 4 | edit_file（行动） | -1 | 0 |

行动工具的 -1 分抵消了每轮回复的 +1 分，指数不会累积。

## 配置

阈值通过 `TriologueOptions.hintThreshold` 设置，默认值为 10。在 `main()` 中创建 Triologue 实例时可自定义：

```ts
const triologue = new Triologue({
  hintThreshold: 15, // 更宽松，允许更多探索
});
```