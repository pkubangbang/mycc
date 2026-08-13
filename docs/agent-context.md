`AgentContext`是coding agent的tools可以调用的函数，内部封装了coding agent的状态数据。

- 所谓**coding agent**，是指类似claude code的基于大模型的命令行编程工具。
- 所谓**coding agent的tools**，是指某些大模型可以可靠地调用工具：用户提供工具的说明书，包括工具名称、描述、参数格式，大模型在需要时可以返回结构化数据，该数据可以由程序自动解析并遵照执行。
- 所谓**coding agent的状态数据**，是指它在工作时需要维护工作状态，比如todoList（待办事项），skills（技能列表），mailbox（信箱）等等。它们以结构化的方式存储，有效地缓解了大模型的记忆漂移的缺点。

# 架构设计

AgentContext 采用类继承的方式实现，分为两种上下文：

## ParentContext（主进程）

用于主进程（lead agent），直接访问所有模块（`src/context/parent-context.ts`）：

```typescript
import { ParentContext } from './context/parent-context.js';

// 创建上下文（传入 session 文件路径）
const ctx = new ParentContext(sessionFilePath);
ctx.initializeIpcHandlers(); // 注册 IPC 处理器

// 使用模块
ctx.core.brief('info', 'test', 'Hello');
await ctx.issue.createIssue('Title', 'Content');
```

构造函数参数为 `sessionFilePath: string`（用于派生 sessionId、peer 模块的 mailbox 路径等）。`skill` 模块使用全局 `loader` 单例（`src/context/shared/loader.ts`）。

## ChildContext（子进程）

用于子进程（teammate），通过 IPC 与主进程通信（`src/context/child-context.ts`）：

```typescript
import { ChildContext } from './context/child-context.js';

// 创建上下文
const ctx = new ChildContext(name, workDir);

// 使用模块（IPC 转发）
await ctx.issue.createIssue('Title', 'Content'); // 通过 IPC 发送到主进程
```

子进程的 `skill` 模块使用 `silentLoader`（静默模式的 Loader 单例）。`peer` 模块使用 `NoopPeerModule`（子进程不参与 peer discovery）。

## 模块实现

AgentContext 接口包含 9 个模块（`src/types.ts` 中 `AgentContext`）。每个模块都有独立的类实现：

| 模块 | 接口 | 主进程类 | 子进程类 | 源文件 |
|------|------|----------|----------|--------|
| core | `CoreModule` | `Core` | `ChildCore`（IPC转发） | `parent/core.ts`, `child/core.ts` |
| todo | `TodoModule` | `Todo`（本地） | `Todo`（本地，共享） | `shared/todo.ts` |
| mail | `MailModule` | `MailBox`（'lead'） | `MailBox`（teammate名） | `shared/mail.ts` |
| skill | `SkillModule` | `Loader`（全局单例） | `Loader`（silentLoader，静默） | `shared/loader.ts` |
| issue | `IssueModule` | `IssueManager` | `ChildIssue`（IPC转发） | `parent/issue.ts`, `child/issue.ts` |
| bg | `BgModule` | `BackgroundTasks`（本地） | `BackgroundTasks`（本地，共享） | `shared/bg.ts` |
| team | `TeamModule` | `TeamManager` | `ChildTeam`（受限操作） | `parent/team.ts`, `child/team.ts` |
| wiki | `WikiModule` | `WikiManager` | `ChildWiki`（IPC转发） | `parent/wiki.ts`, `child/wiki.ts` |
| peer | `PeerModule` | `PeerManager` | `NoopPeerModule`（no-op） | `peer/peer.ts` |

**注意：** 没有独立的 `wt`（worktree）模块。Worktree 查询通过 `src/context/worktree-store.ts` 的工具函数实现（`listWorktrees()`, `findWorktreeByName()`, `findWorktreeByPath()`），直接执行 `git worktree list --porcelain`，无 JSON 持久化。teammate→worktree 映射通过约定推导（worktree 目录名 = teammate 名）。

## IPC 处理器

主进程通过 `ParentContext.initializeIpcHandlers()` 注册所有 IPC 处理器，处理来自子进程的请求：

```typescript
// 在 ParentContext 中注册 IPC 处理器
ctx.initializeIpcHandlers();

// 处理器包括：
// - Issue 操作：db_issue_get, db_issue_list, db_issue_create, db_issue_claim, db_issue_publish, db_issue_close, db_issue_comment, db_block_add, db_block_remove, db_issue_clear_all
// - Team 操作：team_print
// - Wiki 操作：wiki_prepare, wiki_put, wiki_get, wiki_delete, wiki_get_by_domain, wiki_batch_put, wiki_wal_get, wiki_wal_append, wiki_rebuild, wiki_domains_list, wiki_domain_get, wiki_domain_register
// - Core 操作：core_img_describe, core_read_picture_cached
// - Grant 操作：grant_request, external_path_access
```

# AgentContext有哪些组成部分？

core：核心工具
todo：临时的待办事项
team：创建虚拟团队（基于多进程技术）
mail：信箱，用于异步任务与协作
skill：技能列表
issue：持久化的待办事项
bg：后台任务
wiki：持久化知识库（向量存储）
peer：跨实例 peer discovery 与通信

## core

核心工具中包含"当前工作目录"、confusion index、agent 模式（plan/normal）、auto 模式等状态（`src/context/parent/core.ts`）。

### brief：在终端打印日志信息
该函数调用时，会通过主线程在终端打印日志信息，从而避免并发带来的日志交错。

调用该函数需要提供日志级别（`'info' | 'warn' | 'error'`）、工具名称、标题、内容四部分信息。

### getWorkDir：获取当前工作目录
该函数调用时，会得到当前的工作目录，以便拼接文件路径或者执行命令。

### question：向用户提问并等待回复
该函数调用时，会在终端显示问题并等待用户输入，返回 `AskResult`（包含 `answer`、`reason`、`source`）。用于工具执行过程中需要用户澄清或补充信息的场景。

调用该函数需要提供问题内容和提问者名称，可选提供 `onEsc`（ESC 时返回值）和 `onEnter`（空 Enter 时返回值）选项。auto 模式下会自动用 `onEsc` 默认值回复，`source` 标记为 `'auto'`。

**主进程实现：** 直接调用 `agentIO.ask()` 获取用户输入。

**IPC支持：** 子进程（teammate）可以通过IPC发送`question`消息来调用此功能。TeamManager会接收消息并调用`ctx.core.question(query, sender)`，其中sender是子进程名称，然后将用户回复返回给子进程。这允许多进程协作时，子进程也能向用户提问。

### webSearch：网络搜索
该函数调用时，会使用Ollama的网络搜索功能搜索互联网信息。

调用该函数需要提供搜索查询字符串，返回搜索结果列表。

### webFetch：获取网页内容
该函数调用时，会获取指定URL的网页内容并解析。

调用该函数需要提供URL，返回网页标题和内容。

### imgDescribe / readPictureCached：图像描述
`imgDescribe(image, prompt?, signal?)` 使用视觉模型描述图像（base64 或文件路径）。
`readPictureCached(imagePath, prompt?, cacheToken?, signal?)` 带多焦点缓存的图像读取，返回 `PictureResult`（累积的 focus/description 对 + 缓存令牌）。缓存持久化到 `.mycc/imgcache/`，仅主进程操作缓存文件，子进程通过 IPC 委托。

### requestGrant：权限请求
请求敏感操作（`write_file`、`edit_file`、`bash`）的权限。主进程的 Core 内部检查模式和 worktree 所有权；子进程的 Core 通过 IPC 发送到主进程评估。

### requestExternalPathAccess：外部路径访问
请求访问工作区（cwd）之外的文件/目录。用户可选择授予文件夹访问、递归访问、仅文件访问或拒绝。授权是会话级别的。

### getMode / getAuto / setAuto：模式控制
`getMode()` 返回 `'plan'` 或 `'normal'`。`getAuto()` / `setAuto(value)` 控制自主模式（auto mode 与 plan/normal 正交，仅 lead 使用，teammate 永远返回 false）。

### escAware：ESC 感知包装
将慢操作包装为 ESC 可中断。ESC 按下时立即调用 `onCleanUp` 返回 fallback 结果，原 promise 在后台继续。

### confusion index
`getConfusionIndex()` / `increaseConfusionIndex(delta)` / `resetConfusionIndex()` — 混乱指数（0-20 范围），用于触发 hint round。工具错误增加（+2），语义重复通过 embedding 相似度检测增加，正常进展减少（-1）。

### getMindmap / setMindmap
获取/设置已加载的 mindmap 数据。

## todo

待办事项维护了一个简单列表供当前的线程使用（`src/context/shared/todo.ts`）。列表中的元素是 `TodoItem`，包括序号、名称、完成状态、备注、hash（完整性签名）、pinned（置顶标记）、reactivate（重激活条件）。

### createTodo
创建新的待办事项，返回包含自动分配 ID 和 hash 的 `TodoItem`。

### updateTodo
增量更新待办事项。需要提供 id 和当前 hash（防幻觉），返回更新后的 item 或 null（id 不存在或 hash 不匹配）。

当所有非 pinned 的 item 完成时，自动清除非 pinned 项。

### printTodoList
返回待办事项列表的 toString 表示，用于组装大模型 prompt。

### hasOpenTodo
返回 true/false，表示是否有未完成的待办事项。

### pinTodo / getReactivationCandidates
`pinTodo(id, hash, pinned, reactivate?)` — 置顶/取消置顶 todo，可选设置自然语言重激活条件。需要当前 hash。pinned todo 在所有非 pinned todo 完成时不会被自动清除。

`getReactivationCandidates()` — 返回带有重激活条件且已完成的 pinned todo，供 COLLECT 状态评估是否重新打开。

### clear / getItems / findCheckpointTodo / closeCheckpointTodo
`clear()` 清空列表。`getItems()` 返回所有项。`findCheckpointTodo(checkpointId)` 和 `closeCheckpointTodo(checkpointId)` 用于管理 checkpoint 自动创建的 todo。

## team

团队模块维护了一个团队成员列表（`src/context/parent/team.ts`）。列表的元素是 `Teammate`，包括名称、角色、工作状态（`working | idle | holding | shutdown`）、初始prompt。team 基于多进程（fork）而非多线程。

### createTeammate
创建一个新的 agent（子进程），与已有的团队协作。需要提供成员名称、角色、初始prompt，可选提供 `cwd`（worktree 路径）。会为新的agent赋予独立的 ChildContext。

### getTeammate
获取某个成员的数据。需要提供成员名称。

### listTeammates
获取成员名单，返回名称、角色、状态。不需要参数。

### awaitTeammate
等待指定成员完成工作。需要提供成员名称，可选超时时间（默认 300000ms）。

### awaitTeam
等待所有其他团队成员完成工作。每个 working 的 teammate 通过 `awaitTeammate` 等待（各自尊重 ETA deadline）。返回 `{ result: string }`，result 为 `'all done'`、`'timeout'`、`'got question'` 或 `'no teammates'`。

### printTeam
返回成员列表的 toString 表示，用于组装大模型 prompt。

### removeTeammate
立刻停止指定成员的工作并移除。可选 `force` 参数。

### dismissTeam
立刻停止所有成员的工作并清除所有成员。可选 `force` 参数。

### mailTo
向指定的成员发送信息。需要提供成员名称、信息标题、信息内容，可选 `from`（默认 'lead'）和 `eta`。信息会出现在指定成员的信箱中。

### broadcast
向所有成员发送广播信息。需要提供信息标题、信息内容。

### handlePendingQuestions
处理来自子进程的待处理问题。在 COLLECT 状态中调用。

## mail

信箱模块维护了每一个成员接收的信息（`src/context/shared/mail.ts`）。信息将在整理后组装成下一次 prompt。

### appendMail
向自己的信箱中增加一条信息。常用于后台任务结果返回。需要提供发信人（默认是自己）、信息标题、信息内容，可选 issue 编号。

### collectMails
得到信箱中的所有信息，然后清空信箱。获取到的信息会用于组装 prompt。由于 COLLECT 状态会在每次 LLM 调用前调用 collectMails，所以每次不会有很多信息。

### hasNewMails
返回 true/false，表示是否有未读邮件。

### listMails / clearUnread
`listMails()` 列出所有邮件。`clearUnread()` 清除未读标记（用于子进程 respawn 前清理）。

## skill

技能模块维护了技能列表（`src/context/shared/loader.ts`）。每一个元素是一个 `Skill`，包含名称、描述、关键字、内容、可选 `when` 条件和 `sourceFile`，从类似 `SKILLS.md` 的文档中解析得到。

### listSkills
列出所有技能的名称、描述、关键字但不包含内容。

### getSkill
得到指定技能的完整内容。需要提供技能名称。

### compileCondition
将技能的 `when` 条件编译为结构化 hook 并更新运行时条件注册表。主进程直接编译到内存 ConditionRegistry；子进程编译到磁盘后通过 IPC 通知主进程重载。

### replaceCondition
从磁盘重载技能的编译条件到运行时 ConditionRegistry。用于子进程 `compileCondition` 后主进程的 IPC 响应。

### listAllTools
列出所有可用工具的名称和描述，用于条件编译时验证触发工具名。

## issue

Issue模块维护了一个全局的待办事项列表（`src/context/parent/issue.ts`）。列表的元素是 `Issue`，包含任务编号、标题、内容、状态（`draft | pending | in_progress | completed | failed | abandoned`）、owner、先导关系（blockedBy/blocks）、评论列表。

Issue 生命周期：`draft` →（`pending` | `in_progress`）→ `completed`/`failed`/`abandoned`。`draft` 状态的 issue 对 teammate 不可见，需通过 `claimIssue` 或 `publishIssue` 终结 draft 阶段。

### createIssue
创建一个待办事项。需要提供标题、内容，可选 `blockedBy`（阻塞关系）。返回任务编号。创建后状态为 `draft`。

### getIssue
得到指定待办事项的信息。需要提供任务编号。

### listIssues
得到所有待办事项。

### printIssues / printIssue
`printIssues()` 返回所有待办事项的 toString 表示。`printIssue(id)` 返回单个 issue 的详情。

### claimIssue
获取指定待办事项的所有权（`draft` → `in_progress`），原子操作。需要提供任务编号和 owner。

### publishIssue
将 draft issue 发布为 pending（`draft` → `pending`），使其对 idle teammate 可见以供 auto-claim。

### closeIssue
关闭指定待办事项。需要提供任务编号和最终状态（`completed`/`failed`/`abandoned`），可选评论。状态变化会影响下游被阻塞的任务。

### addComment
增加指定待办事项的评论。需要提供任务编号、评论内容，可选 poster。

### createBlockage / removeBlockage
增加/移除阻塞关系。需要提供两个任务编号（blocker 和 blocked）。

### clearAll
清除所有 issue。

## bg

后台任务模块维护了所有进行中的后台任务（`src/context/shared/bg.ts`）。后台任务通常是bash命令，具有 pid。

### runCommand
创建一个后台运行的 bash 任务，返回 pid。

### printBgTasks
返回后台任务的 toString 表示。如果提供 pid，返回该任务的详情（含累积输出）；不提供 pid 则返回所有任务的紧凑列表。

### hasRunningBgTasks
返回 true/false，表示是否有运行中的后台任务。

### killTask
终止指定 pid 的后台任务。

### getTask
通过 pid 获取任务信息（用于 bg_await 状态检查）。

## wiki

Wiki 模块是持久化知识库，基于向量存储（LanceDB）（`src/context/parent/wiki.ts`）。用于存储和检索结构化知识文档。

### prepare
验证文档 before storing。需要提供 `WikiDocument`（domain, title, content, references），返回 `PrepareResult`（含 hash）。

### put
将验证通过的文档存入知识库。需要 prepare 返回的 hash 和文档。返回 `PutResult`。

### get
通过语义相似度搜索知识库。需要提供查询字符串，可选 `GetOptions`（domain, topK, threshold）。返回 `SearchResult[]`。

### getByDomain
获取一个 domain 下的所有文档（无 embedding，用于批量重建索引）。

### batchPut
批量插入预嵌入的文档。

### delete
通过 hash 删除文档。

### getWAL / parseWAL / formatWAL / appendWAL
WAL（Write-Ahead Log）用于审计和重放。

### rebuild
重建向量存储索引。

### listDomains / getDomain / registerDomain
Domain 管理：列出所有 domain、获取单个 domain、注册新 domain。

## peer

Peer 模块用于跨实例发现和通信（`src/peer/peer.ts`）。仅主进程使用（`PeerManager`），子进程使用 `NoopPeerModule`（所有方法 no-op）。

### listIdentities
获取所有已注册的 peer 身份（sessionId, workDir, mailbox, startedAt）。

### isFresh
检查远程 session 是否在 90 秒心跳窗口内活跃。

### listChannels
列出本实例拥有的所有 channel（含 peer 信息）。

### joinChannel
加入一个 channel（设置 joined=true，注入 title + firstQuery 为本地邮件）。

### sendMail / sendPeerMail
`sendMail(channelId, sessionId, topic, content)` — 通过 channel 向远程 session 发送邮件。
`sendPeerMail(sessionId, title, content)` — 发送 channel 无关的 peer 邮件（由 mail_to 工具在 name 匹配 session-id/lead 模式时使用）。

### hasActiveChannel
返回是否有至少一个已加入且 peer fresh 的 channel。用于 PROMPT autofly gate。

### setOnChannelJoin
注册 channel join 回调，允许 agent loop 在 PROMPT 等待中响应 channel 加入。

### start / stop
启动/停止 peer 子系统（注册身份 + 心跳 + channel 轮询）。

### getSelfSessionId
获取本实例的 session id。

### recordBrief
记录 brief 状态更新到本实例的心跳文件，供 `peers` 工具展示。

### getBriefs / getLatestHeartbeat
读取远程 session 的最近 brief 和最新心跳时间戳。