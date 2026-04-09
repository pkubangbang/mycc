`AgentContext`是coding agent的tools可以调用的函数，内部封装了coding agent的状态数据。

- 所谓**coding agent**，是指类似claude code的基于大模型的命令行编程工具。
- 所谓**coding agent的tools**，是指某些大模型可以可靠地调用工具：用户提供工具的说明书，包括工具名称、描述、参数格式，大模型在需要时可以返回结构化数据，该数据可以由程序自动解析并遵照执行。
- 所谓**coding agent的状态数据**，是指它在工作时需要维护工作状态，比如todoList（待办事项），skills（技能列表），mailbox（信箱）等等。它们以结构化的方式存储，有效地缓解了大模型的记忆漂移的缺点。

# 架构设计

AgentContext 采用类继承的方式实现，分为两种上下文：

## ParentContext（主进程）

用于主进程（lead agent），直接访问所有模块：

```typescript
import { ParentContext } from './context/index.js';
import { Loader } from './context/loader.js';

// 创建上下文
const loader = new Loader();
await loader.loadAll();
loader.watchDirectories();

const ctx = new ParentContext(loader);
ctx.initializeIpcHandlers(); // 注册 IPC 处理器

// 使用模块
ctx.core.brief('info', 'test', 'Hello');
await ctx.issue.createIssue('Title', 'Content');
```

## ChildContext（子进程）

用于子进程（teammate），通过 IPC 与主进程通信：

```typescript
import { ChildContext } from './context/child-context/index.js';

// 创建上下文
const ctx = new ChildContext(name, workDir);

// 使用模块（IPC 转发）
await ctx.issue.createIssue('Title', 'Content'); // 通过 IPC 发送到主进程
```

## 模块实现

每个模块都有独立的类实现：

| 模块 | 主进程类 | 子进程类 |
|------|----------|----------|
| core | `Core` | `ChildCore`（IPC转发） |
| todo | `Todo` | `Todo`（本地） |
| mail | `MailBox` | `MailBox`（独立邮箱） |
| skill | `Loader` | `Loader`（静默模式） |
| issue | `IssueManager` | `ChildIssue`（IPC转发） |
| bg | `BackgroundTasks` | `BackgroundTasks`（本地） |
| wt | `WorktreeManager` | `ChildWt`（IPC转发） |
| team | `TeamManager` | `ChildTeam`（受限操作） |

## IPC 处理器

主进程通过 `ParentContext.initializeIpcHandlers()` 注册所有 IPC 处理器，处理来自子进程的请求：

```typescript
// 在 ParentContext 中注册 IPC 处理器
ctx.initializeIpcHandlers();

// 处理器包括：
// - Issue 操作：db_issue_get, db_issue_list, db_issue_create, ...
// - Worktree 操作：wt_create, wt_print, wt_get_path, wt_remove
// - Team 操作：team_print
```

# AgentContext有哪些组成部分？

core：核心工具
todo：临时的待办事项
team：创建虚拟团队（基于多线程技术）
mail：信箱，用于异步任务与协作

skill：技能列表
issue：持久化的待办事项

bg：后台任务
wt：git worktree，允许大模型在多个分支并行工作

## core

核心工具中包含“当前工作目录”一个状态。

### brief：在终端打印日志信息
该函数调用时，会通过主线程在终端打印日志信息，从而避免并发带来的日志交错。

调用该函数需要提供工具名称、日志级别、标题、内容四部分信息。

### getWorkdir：获取当前工作目录
该函数调用时，会得到当前的工作目录，以便拼接文件路径或者执行命令。

### question：向用户提问并等待回复
该函数调用时，会在终端显示问题并等待用户输入，返回用户的回复内容。用于工具执行过程中需要用户澄清或补充信息的场景。

调用该函数需要提供问题内容，可选提供提问者名称（默认为'lead'）。

日志输出格式为 `[时间] [提问者:question] 问题内容`，这样用户可以清楚看到是哪个进程或队友在提问。

**主进程实现：** 直接调用 `agentIO.ask()` 获取用户输入。

**IPC支持：** 子进程（teammate）可以通过IPC发送`question`消息来调用此功能。TeamManager会接收消息并调用`ctx.core.question(query, sender)`，其中sender是子进程名称，然后将用户回复返回给子进程。这允许多进程协作时，子进程也能向用户提问。

### webSearch：网络搜索
该函数调用时，会使用Ollama的网络搜索功能搜索互联网信息。

调用该函数需要提供搜索查询字符串，返回搜索结果列表。

**注意：** 需要Ollama服务器支持网络搜索功能。

### webFetch：获取网页内容
该函数调用时，会获取指定URL的网页内容并解析。

调用该函数需要提供URL，返回网页标题和内容。



## todo

待办事项维护了一个简单列表供当前的线程使用，列表中的元素是任务项，包括序号、名称、完成状态、备注信息四部分内容。

### patchTodoList
该函数调用时，会增量更新待办事项列表。

调用该函数需要提供发生了变化的任务项的列表。

### printTodoList
该函数调用时，会得到待办事项的toString表示，用于组装大模型prompt。

调用该函数不需要提供参数。

### hasOpenTodo
该函数调用时，会得到true/false，表示是否有未完成的待办事项。

调用该函数不需要提供参数。



## team

团队模块维护了一个团队成员列表，列表的元素是团队成员数据，包括名称、角色、工作状态、初始prompt四部分信息，还有一些通信和协作的工具。

### createTeammate
该函数调用时，会创建一个新的agent，与已有的团队协作。

调用该函数需要提供成员信息，角色，初始prompt三部分信息。会为新的agent赋予独立的agentContext。

### getTeammate
该函数调用时，会获取某个成员的数据，包括名称、角色、工作状态、初始prompt。

调用该函数需要提供成员名称。一次返回一个成员的信息。

### listTeammates
该函数调用时，会获取成员名单，供getTeammate等函数使用。返回的信息包括成员的名称和角色。

调用该函数不需要提供参数。

### awaitTeammate
该函数调用时，当前进程会进入休眠状态，等待指定成员完成工作后恢复执行。

调用该函数需要提供成员名称。还可以指定一个超时时间，以避免无限期等待。

### awaitTeam
该函数调用时，当前进程会进入休眠状态，等待所有其他团队成员完成工作后恢复执行。

调用该函数不需要提供参数。还可以指定一个超时时间，以避免无限期等待。

### printTeam
该函数调用时，会得到成员列表的toString表示，用于组装大模型prompt。

调用该函数不需要提供参数。

### removeTeammate
该函数调用时，会立刻停止指定成员的工作，然后从成员列表中移除该成员。主要用于移除出故障的成员。

调用该函数需要提供成员名称。

### dismissTeam
该函数调用时，会立刻停止所有成员的工作，然后清除所有成员。

调用该函数不需要提供参数。

### mailTo
该函数调用时，会向指定的成员发送信息。信息会出现在指定成员的信箱中，等待agentLoop读取。

调用该函数需要提供成员名称、信息标题、信息内容。某些时候还会附加一个issue编号。

### broadcast
该函数调用时，会向所有成员发送广播信息。信息会出现在所有成员的信箱中，等待agentLoop读取。

调用该函数需要提供成员名称、信息标题、信息内容。某些时候还会附加一个issue编号。



## mail

信箱模块维护了每一个成员接收的信息。信息将在整理后组装成下一次prompt。

### appendMail
该函数调用时，会向自己的信箱中增加一条信息。常用于后台任务结果返回。

调用该函数需要提供发信人（默认是自己）、信息标题、信息内容。某些时候还会附加一个issue编号。


### collectMails
该函数调用时，会得到信箱中的所有信息，然后清空信箱。获取到的信息会用于组装prompt。

由于agentLoop会在每次循环中调用collectMails，所以每次collectMails应当期望不会有很多信息，并且该函数通常不需要有tools调用，除非搭配appendMail用于重排信箱。

调用该函数不需要提供参数。



## skill

技能模块维护了技能列表。每一个元素是一个技能，包含名称、描述、关键字、内容等信息，是从类似`SKILLS.md`的文档中解析得到的。

### listSkills
该函数调用时，会列出所有技能的名称、描述、关键字但是不包含内容。

调用该函数不需要提供参数。

### printSkills
该函数调用时，会得到所有技能的名称、描述、关键字但是不包含内容的toString形式。用于组装prompt。

调用该函数不需要提供参数。

### getSkill
该函数调用时，会得到指定技能的名称、描述、关键字、内容，供大模型学习专业知识。

调用该函数需要提供技能名称。



## issue

Issue模块维护了一个全局的待办事项列表。列表的元素是任务项，包含任务编号、标题、内容、完成状态、先导关系（阻塞了哪些任务，被哪些任务阻塞）、分配给哪个成员等信息。

### createIssue
调用该函数时，会创建一个待办事项。

调用该函数需要提供标题、内容、完成状态、先导任务、阻塞了哪些任务等，返回的结果中包含任务编号。

### getIssue
调用该函数时，会得到指定待办事项的信息，

调用该函数需要提供任务编号。

### listIssues
调用该函数时，会得到所有待办事项。

调用该函数不需要提供参数。

### printIssues
调用该函数时，会得到所有待办事项的toString表示，用于组装prompt。

调用该函数不需要提供参数。

### claimIssue
调用该函数时，会获取指定待办事项的所有权。这个动作是原子性的，可以确保一个待办事项只有一个成员认领。

调用该函数需要提供任务编号。

### closeIssue
调用该函数时，会将指定待办事项关闭。关闭的原因包括：任务完成，任务废弃，任务失败。待办事项状态的变化会影响到下游被阻塞的任务。

调用该函数需要提供任务编号，任务最终状态。还可以附加一个评论信息。

### addComment
调用该函数时，会增加指定待办事项的评论。用于更新任务的进度。

调用该函数需要提供任务编号以及评论内容。

### createBlockage
调用该函数时，会增加一个阻塞关系。被阻塞的任务会暂停执行直到解锁。

调用该函数需要提供两个任务编号，表示一个任务阻塞了另一个任务。

### removeBlockage
调用该函数时，会移除一个阻塞关系。阻塞关系的移除是通过标记实现的（逻辑删除）。

调用该函数需要提供两个任务编号，表示一个任务阻塞了另一个任务。



## bg

后台任务模块维护了所有进行中的后台任务。后台任务通常是bash命令，具有pid。

### runCommand
调用该函数时，会创建一个后台运行的bash任务，并且记录在后台任务列表中。

调用该函数需要提供bash命令。

### printBgTasks
调用该函数时，会得到所有后台运行的任务的toString表示，用于组装prompt。

调用该函数不需要提供参数。

### hasRunningBgTasks
调用该函数时，会得到true/false，表示是否有未完成的（运行中的）后台任务。

调用该函数不需要提供参数。



## wt

worktree模块用于控制git实现工作目录的变化。维护了一个全局的worktree列表。列表的元素是团队成员名称、工作目录、分支名称的组合。

### createWorkTree
调用该函数时，会在临时目录（比如`.worktrees/`目录）中创建当前项目的一个分支，并且记录在worktree列表中。

调用该函数需要提供分支名称。

### printWorkTrees
调用该函数时，会得到worktree列表的toString表示，用于组装prompt。

调用该函数不需要提供参数。

### enterWorkTree
调用该函数时，会导致当前工作目录切换为worktree，影响`core.getWorkDir`。

调用该函数需要提供分支名称。

### leaveWorkTree
调用该函数时，会导致当前工作目录由worktree回到项目根目录，影响`core.getWorkDir`。

调用该函数不需要提供分支名称。

### removeWorkTree
调用该函数时，会导致当前worktree被移除。必须先leaveWorkTree才能removeWorkTree。

调用该函数需要提供分支名称。

