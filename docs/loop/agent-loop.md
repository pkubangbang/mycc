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
| `COLLECT` | LLM 前的预收集：子进程问题、邮件、hint round、peer channel nudge、brief nudge、worktree nudge、技能发现 | `src/loop/states/collect.ts` |
| `LLM` | 构建 system prompt、调用 LLM、auto-compact、crossroad 检测 | `src/loop/states/llm.ts` |
| `HOOK` | 执行 hook，处理 hook 对 tool call 的拦截/增强 | `src/loop/states/hook.ts` |
| `TOOL` | 顺序执行 tool calls，记录 sequence，语义重复检测 | `src/loop/states/tool.ts` |
| `STOP` | 无 tool call 时的收尾：neglected mode wrap-up 或 team awaiting | `src/loop/states/stop.ts` |
| `AWAIT` | auto 模式下的自主循环等待 | `src/loop/states/await.ts` |

### 数据分层

状态机使用三层数据生命周期（`src/loop/state-machine.ts`）：

- **MachineEnv**（机器生命周期）：构造一次，不重置。包含 `triologue`、`ctx`、`scope`、`conditions`、`sequence`、`hookExecutor`、`inputProvider`、`sessionFilePath`、`pendingSlashQuery`、`crossroadOccurred`、`requestEmbeddingTracker`、`nextWtNudge`。
- **TurnVars**（轮生命周期）：从 STOP/startup 进入 PROMPT 时刷新，跨 COLLECT→LLM→HOOK 迭代保持。包含 `isFirstRound`、`nextChannelNudge`(初始 3)、`lastChannelState`、`nextBriefNudge`(初始 5)、`lastUserQuery`、`extractedKeywords`。
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

### Todo List - 任务列表（projectContext populator，无 nudge）

todo 列表**不再被提醒（nudge）**，也**不再由工具结果回显**。它通过 projectContext
populator 注入（`src/loop/prompt-populators.ts`），只在 `rebuildProjectContext()`
即 startup / `compact()` / `/clear` 边界重建：

- `buildTodoMessages(todo)` — **lead 与 teammate 共享**，在 `agent-repl.ts` 与
  `teammate-worker.ts` 都注册。内容 = `## Task Management` 用法 + `## Todo List`
  快照（`todo.printTodoList()`，空列表渲染 `No todos.`）。因此列表在 auto-compact
  之后依然存在（compact 会重建 projectContext）。
- `buildPinnedTodoMessages()` — **仅 lead**（只在 `agent-repl.ts` 注册）：
  `### Pinned Todos` + `### Stop Guard` 说明。teammate 没有 `todo_pinning`，
  不能看到这段。

`todo_create` / `todo_update` / `todo_pinning` 只返回被操作的条目与它的当前 hash，
不再附加整张列表；因此列表快照可能滞后于当前轮次（tool 结果里的 hash 才是最新的，
陈旧 hash 由 `Todo.findByPreviousHash` 的 warm hint 纠正）。这条滞后**不靠 mid-run 重建去补**（重建会打破 cache-stable 的 prompt 前缀）：hint round 的 `buildStateSections()` 自带一份实时的 `## Todo List`（`getItems()` 渲染），足以补上这个缺口；`/todos` 只面向用户，agent 读不到。/clear 等边界之外的写入者（`/todos` slash、peer-wire pinned reminder）同样刻意不触发重建。

**清除顺序很重要**：`/clear` 与 double-Ctrl+L 都先 `ctx.todo.clear()` 再
`triologue.clear()` —— 后者会触发 `rebuildProjectContext()`，若顺序颠倒，新会话会
带着清空前的列表。

COLLECT 侧只剩下 **peer channel nudge**（`runChannelNudge`，`turn.nextChannelNudge`
/ `turn.lastChannelState`），peer channel 状态变化时重置计数器。

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

COLLECT（`src/loop/states/collect.ts`）在每次 LLM 调用前执行预收集管线。编号对应 `handleCollect()`
中的顺序（`collectMailsAndInput()` 内部展开为 1a–1e，其余各步平铺）：

1. **外部输入收集**（`collectMailsAndInput()`）— 全部以 note 注入 triologue，靠 auto-fix 保证 TP-safe：
   1a. **Serve 状态监视** — `isWebUiUp()` 与模块级 `lastServeReported` 做边沿触发，只在 WebUI 启停时注入 SYSTEM note（steady state 静默）。`/clear` 后由 `reconcileServeStateAfterClear()` 重新武装。
   1b. **处理子进程问题** — `ctx.team.handlePendingQuestions()`。
   1c. **收集邮件** — `ctx.mail.collectMails()`，通过 `triologue.note('MAIL', ...)` 注入。neglected mode 下额外注入 `[URGENT]` ESC note；每条 mail 自带 `↳ Reply with mail_to(...)` 回复地址。
   1d. **注入团队状态** — `ctx.team.printTeam()`，非空时作为 SYSTEM note 注入。
   1e. **Steering 队列 / 文件上传队列**（webui）— steering 以 REMINDER note 注入并返回 `firstSteerNote`（step 5 的查询来源）；上传文件保存到 `.mycc/uploaded/` 后以 REMINDER note 注入。此外 `resolveHeadlessFirstQuery()` 用本次首个事件消解 headless 会话的 first_query 标记。
2. **Hint round** — confusion index ≥ 10 且消息数 ≥ 6 时生成 hint（`CONFUSION_THRESHOLD = 10`，`MIN_MESSAGES_FOR_HINT = 6`）。整个特性由**进程级单例** `hintRound`（`src/loop/hint-round.ts`）持有：`AgentStateMachine` 构造时以 `hintRound.init(env)` 绑定 `MachineEnv`（仅 `scope === 'main'`，子进程走 `reset()` 且 `run()` 直接返回 `'continue'`），之后 COLLECT 只调用 `await hintRound.run(turn)`，由单例自行读取 triologue/ctx/sequence 并把 `[HINT]` note 推回 triologue。策略与机制（gate、状态快照、escAware、`generate`/`retryLoop`/wiki 预过滤）都在这一个模块里。

分析 prompt 只携带**转录无法重建的带外状态**（`buildStateSections()`），前缀在 `## Conversation Context` 之前：`## Todo List`（`getItems()` 渲染，note/preventStop 经过 `sanitizeField()` 压缩与截断）、`## Mode & Write Scope`（**仅 plan 模式**，列出允许写入的文件）、`## Recent Permission Blocks`（**只来自精确记录**：`Core.requestGrant()` 在 grant chokepoint 用 `recordDenial()` 记下每次拒绝的 tool / target / reason，`kind` 在记录时由 reason 结构推导；`readRecentDenials()` 只读该记录，**没有 recorder 的上下文（child/lite/测试替身）整节省略** —— 旧的 `summarizePermissionBlocks()` 用正则匹配工具输出散文已被删除，因为它会把"引用了拦截信息"的普通输出误判为拒绝，且无从得知哪条规则、哪个 target；无记录时沉默是唯一诚实输出）、`## Loop Evidence`（`detectRepeatedActions()`；无重复时输出显式的 "No repeated-action evidence…" 中性行，避免 LLM 凭长度臆造循环）。**confusion score、assistant turn 数、tool error 数已移除**：它们是转录可推导的（turn 数还是 `Math.ceil(events.length / 3)` 的估算）；confusion index 仍然只负责**触发**该轮。`HINT_SCHEMA` 未变。

3. **Peer-channel nudge** — `runChannelNudge()`，见上文「Todo List」；todo 列表不再有 nudge（由 projectContext populator 注入）。
4. **Brief + worktree nudging** — `runBriefAndWorktreeNudges()`，见上文「Brief Nudging」；worktree 清理提醒由 `env.nextWtNudge` 为 0 时的哨兵触发。
5. **技能发现** — `skillSuggester.suggestSkill()`：消费 `turn.extractedKeywords`（新查询优先取本轮的 `firstSteerNote`），匹配已加载技能名称/关键词，作为 HINT note 注入。
6. **详细日志** — verbose 模式下输出消息数和 token 利用率（`logVerboseStats()`）。

任一非瞬时异常都会结束本轮并回到 PROMPT；瞬态错误（网络抖动）则按 `turn.collectTransientRetries`
（上限 `MAX_COLLECT_TRANSIENT_RETRIES = 3`）重入 COLLECT，超限后回落 PROMPT。

## System Prompt

系统提示根据模式动态构建（`src/loop/agent-prompts.ts`）：

- **Plan 模式** — `buildPlanModePrompt(workDir, hasTeam)`：Solo plan / Team plan
- **Normal 模式** — `buildNormalModePrompt(workDir, identity?, hasTeam)`：
  - **Solo normal**（无 team）：`"You are a coding agent at ${workDir}."` + 知识边界 + 公共部分 + recap rewind（任务管理 / todo 列表 / pinned todo 均已移出 system prompt，改由 projectContext populator 交付）
  - **Team normal (Lead)**：`"You are the lead of a coding agent team at ${workDir}."` + team workflow + issue 管理 + 通信规则 + 边界规则
  - **Teammate (Child)**：`"You are ${name}, a specialized agent working as part of a team, created by the \"lead\"."` + 三种通信方式 + 时间预算协议 + worktree 用法

所有提示共享公共部分：Verification、Platform、Intent Language、Calendar、Output Behavior。Normal 模式还包含 Knowledge Boundary 和 Recap Rewind 部分。

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