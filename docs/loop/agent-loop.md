## 什么是agent loop

agent loop是一个按照STAR原则设计的循环：

1. situation：当前的工作进展是什么，有什么阶段性成果
2. task：告诉大模型，目标是什么
3. action：大模型给出解决办法，程序员写代码解析"解决办法"：
如果使用工具，那就执行工具调用
如果不使用工具，那就结束本次循环，等待用户指令
4. result：收集执行的结果，进入下一次循环。

## 状态机架构

agent loop 已从早期的 `while(true)` 命令式循环重构为**显式状态机**（`src/loop/state-machine.ts`）。状态之间通过显式转移连接，每个状态有独立的 handler：

```
        ┌────────────────────────────────────────┐
        │                                        │
   ┌─── PROMPT ◄────────────────────┐           │
   │    │   ▲                       │           │
   │    ▼   │                       │           │
   │  SLASH─┘                       │           │
   │                                │           │
   │    ▼                           │           │
   │  COLLECT ◄─────── TOOL ─────┐ │           │
   │    │              ▲         │ │           │
   │    ▼              │         │ │           │
   │  LLM ────► HOOK ──┘       STOP ──────────┘
   │                │              │
   │          has calls        no calls
   └── (pendingSlashQuery set by SLASH)
```

状态枚举（`AgentState`）：

| 状态 | 说明 | 源文件 |
|------|------|--------|
| `PROMPT` | 等待用户输入，新对话轮的起点 | `src/loop/states/prompt.ts` |
| `SLASH` | 处理 `/` 斜杠命令 | `src/loop/states/slash.ts` |
| `COLLECT` | LLM 前的预收集：子进程问题、邮件、hint round、todo nudge、brief nudge、worktree nudge、技能发现 | `src/loop/states/collect.ts` |
| `LLM` | 构建 system prompt、调用 LLM、auto-compact、crossroad 检测 | `src/loop/states/llm.ts` |
| `HOOK` | 执行 hook，处理 hook 对 tool call 的拦截/增强 | `src/loop/states/hook.ts` |
| `TOOL` | 顺序执行 tool calls，记录 sequence，语义重复检测 | `src/loop/states/tool.ts` |
| `STOP` | 无 tool call 时的收尾：neglected mode wrap-up 或 team awaiting | `src/loop/states/stop.ts` |
| `AWAIT` | auto 模式下的自主循环等待 | `src/loop/states/await.ts` |

### 数据分层

状态机使用三层数据生命周期（`src/loop/state-machine.ts`）：

- **MachineEnv**（机器生命周期）：构造一次，不重置。包含 `triologue`、`ctx`、`scope`、`conditions`、`sequence`、`hookExecutor`、`inputProvider`、`sessionFilePath`、`pendingSlashQuery`、`crossroadOccurred`、`requestEmbeddingTracker`、`nextWtNudge`。
- **TurnVars**（轮生命周期）：从 STOP/startup 进入 PROMPT 时刷新，跨 COLLECT→LLM→HOOK 迭代保持。包含 `isFirstRound`、`nextTodoNudge`(初始 3)、`lastTodoState`、`nextBriefNudge`(初始 5)、`lastUserQuery`、`extractedKeywords`。
- **PassData**（pass 生命周期）：每次进入 COLLECT 时刷新，流经 LLM→HOOK→{TOOL|STOP}。包含 `abortController`、`rawToolCalls`、`assistantContent`、`assistantReasoningContent`、`augmentedCalls`、`hookResult`、`crossroadContinuation`、`deferredCompact`。

### 转移规则

- **会话轮**：PROMPT → ... → STOP → PROMPT（重置 TurnVars）
- **管线 pass**：COLLECT → LLM → HOOK → {TOOL → COLLECT | STOP}
- **Slash**：PROMPT → SLASH → PROMPT（不重置 TurnVars）
- **Auto 模式**：PROMPT 在 auto 开启时转到 AWAIT；AWAIT 完成一个自主循环后回到 PROMPT（重置 TurnVars）

## 核心机制

### autoCompact - LLM 智能压缩

当 token 估计值超过阈值时触发。阈值默认 50000（`src/loop/triologue.ts` 中 `tokenThreshold ?? 50000`）。

**关键：auto-compact 现在在 LLM 状态顶部执行**（`src/loop/states/llm.ts`），不再在循环顶部或 TOOL 状态执行。原因：LLM 状态中 `loader.getToolsForScope(scope)` 在作用域内，且 `triologue.getMessages()` 是下一次 `retryChat` 的精确缓存前缀，使 `compact()` 内部的 `forkChat` 是缓存命中。

两个触发源（均在 LLM 状态处理）：

1. **Proactive** — `triologue.needsCompact()`：之前的 tool 结果将 token 数推过阈值。
2. **Deferred** — `pass.deferredCompact`：hook（如 compact-on-intent-trap）在 HOOK 状态请求压缩，延迟到 LLM 状态执行。

压缩流程（`triologue.compact()`）：

1. 保存完整历史到 `.mycc/transcripts/transcript_{timestamp}.jsonl`
2. 让 LLM 生成摘要，包含已完成的工作、当前状态、关键决策，并保留 `lastUserQuery`（用户最后指令）
3. 用摘要替换历史消息
4. 重置 confusion index、sequence、crossroad cooldown（旧上下文已被摘要化）

### Todo Nudging - 任务提醒

在 COLLECT 状态执行（`src/loop/states/collect.ts`）。每 3 次 pass 检查一次 open todos，提醒 agent 更新进度：

```ts
if (ctx.todo.hasOpenTodo() || activeChannels.length > 0) {
  // 状态变化时重置计数器
  if (compositeState !== turn.lastTodoState) {
    turn.nextTodoNudge = 3;
    turn.lastTodoState = compositeState;
  }
  turn.nextTodoNudge--;
  if (turn.nextTodoNudge === 0) {
    // 先检查 pinned todo 重激活，再推送 nudge
    await checkReactivation(env);
    triologue.note('REMINDER', `Update your todos. ${ctx.todo.printTodoList()}`);
    turn.nextTodoNudge = 3;
  }
}
```

注意：nudge 通过 `triologue.note('REMINDER', ...)` 注入，不再直接 push user 消息。当 todo 状态发生变化时计数器重置（避免在列表未变时重复 nudge）。同时检查 peer channel 状态并附加到同一 nudge。

### Brief Nudging - 进度报告提醒

COLLECT 状态中每 5 次 pass 提醒一次使用 brief 工具（`turn.nextBriefNudge` 初始为 5）。使用 brief 工具后重置为 5（在 `src/loop/states/tool.ts` 中）。

### Team Awaiting - 等待队友完成

在 STOP 状态处理（`src/loop/states/stop.ts`）。当 agent 没有工具调用时：

```ts
const { result } = await ctx.team.awaitTeam();

if (result === 'got question' || ctx.mail.hasNewMails()) {
  return AgentState.COLLECT;  // 有新输入，继续工作
}
if (result === 'timeout') {
  triologue.note('SYSTEM', `Timeout waiting for teammates.\n${teamInfo}...`);
  return AgentState.COLLECT;  // 超时，继续
}
// 'all done' or 'no teammates'
presentResult(triologue);
return AgentState.PROMPT;  // 轮完成，回到提示
```

## COLLECT 状态详情

COLLECT（`src/loop/states/collect.ts`）在每次 LLM 调用前执行预收集管线：

1. **处理子进程问题** — `ctx.team.handlePendingQuestions()`
2. **收集邮件** — `ctx.mail.collectMails()`，通过 `triologue.note('MAIL', ...)` 注入。neglected mode 下标记为 URGENT。
3. **注入团队状态** — `ctx.team.printTeam()`，非空时作为 SYSTEM note 注入。
4. **Steering 队列**（webui）— `getServeHub().drainSteering()`，作为 REMINDER note 注入。
5. **文件上传队列**（webui）— 保存到 `.mycc/uploaded/`，作为 REMINDER note 注入。
6. **Hint round** — confusion index ≥ 10 且消息数 ≥ 6 时生成 hint（`CONFUSION_THRESHOLD = 10`，`MIN_MESSAGES_FOR_HINT = 6`）。
7. **Todo nudging** — 见上文。
8. **Brief nudging** — 见上文。
9. **Worktree cleanup nudge** — `env.nextWtNudge` 为 0 时检查 worktree 列表，有则提醒清理。
10. **技能发现** — 消费 `turn.extractedKeywords`，匹配已加载技能名称/关键词，作为 HINT note 注入。
11. **详细日志** — verbose 模式下输出消息数和 token 利用率。

## System Prompt

系统提示根据模式动态构建（`src/loop/agent-prompts.ts`）：

- **Plan 模式** — `buildPlanModePrompt(workDir, hasTeam)`：Solo plan / Team plan
- **Normal 模式** — `buildNormalModePrompt(workDir, identity?, hasTeam)`：
  - **Solo normal**（无 team）：`"You are a coding agent at ${workDir}."` + 任务管理 + pinned todo + 知识边界 + 公共部分 + checkpoint/recap
  - **Team normal (Lead)**：`"You are the lead of a coding agent team at ${workDir}."` + team workflow + issue 管理 + 通信规则 + 边界规则
  - **Teammate (Child)**：`"You are ${name}, a specialized agent working as part of a team, created by the \"lead\"."` + 三种通信方式 + 时间预算协议 + worktree 用法

所有提示共享公共部分：Verification、Platform、Intent Language、Calendar、Output Behavior。Normal 模式还包含 Knowledge Boundary 和 Checkpoint/Recap 部分。

## 工具执行

工具在 TOOL 状态（`src/loop/states/tool.ts`）顺序执行。结果通过 `triologue.tool(toolName, output, toolCallId)` 添加到历史：

```ts
for (const toolCall of hookResult.calls) {
  const output = await ctx.core.escAware(
    async (abortController) => {
      return await loader.execute(toolName, ctx, args, abortController.signal);
    },
    () => 'Tool interrupted by user.'
  );
  triologue.tool(toolName, output, toolCallId);
}
```

注意：工具结果通过 triologue 的 `tool()` 方法添加，triologue 内部处理消息角色验证和 auto-fix。执行后返回 COLLECT 状态继续下一轮 pass。tool 结果中的错误会增加 confusion index（+2），语义重复通过 embedding 相似度检测（`requestEmbeddingTracker`）。