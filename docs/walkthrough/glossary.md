# Glossary / 术语表

> Terms used in the mycc agent loop walkthroughs.

| # | English | 中文 | Description |
|---|---------|------|-------------|
| 1 | Agent | 代理 | The LLM-powered entity that processes user requests and uses tools. |
| 2 | Agent Loop | 代理循环 | The main execution cycle of the agent, moving through states. |
| 3 | Auto-Claim | 自动认领 | Feature where idle teammates automatically pick up unassigned issues. |
| 4 | Auto-Compact | 自动压缩 | When token count exceeds threshold, LLM summarizes conversation to save context. |
| 5 | Bang Command | Bang 命令 | Shortcut (`!<command>`) that opens a terminal popup, bypassing the LLM. |
| 6 | Brief | Brief | Tool for the agent to report status to the user with a confidence level. |
| 7 | Broadcast | 广播 | Send a message to all teammates at once. |
| 8 | Checkpoint | 检查点 | A marker in conversation history for subtask isolation. |
| 9 | Child Context | 子上下文 | Restricted AgentContext for teammate processes, with IPC-based write operations. |
| 10 | Child Scope | 子作用域 | Restricted tool set for teammates (no tm_create, broadcast, order, etc.). |
| 11 | COLLECT | COLLECT | State where the system prepares context before the LLM call. |
| 12 | Confusion Index | 困惑指数 | Score tracking how stuck the agent is. Triggers hint round at ≥10. |
| 13 | Coordinator | 协调器 | Parent process that manages the Lead agent and forwards I/O. |
| 14 | Crossroad | 十字路口 | Feature that detects turning words in LLM output and generates alternative continuations. |
| 15 | ESC / Neglected Mode | ESC / 被忽略模式 | User presses ESC to abort the current operation; agent produces a quick wrap-up. |
| 16 | escAware | escAware | Utility wrapping slow operations for ESC-aware quick return with AbortController. |
| 17 | forkChat | forkChat | Single-turn side-chat from current triologue state, used by crossroad and recap. |
| 18 | Grant System | 授权系统 | 5-step judging process for bash command approval. |
| 19 | Heartbeat | 心跳 | Periodic signal (every 30s) from teammate to lead indicating it's alive. |
| 20 | Hint Round | 提示轮次 | When confusion ≥10, LLM analyzes blockers and next steps, injected as HINT note. |
| 21 | HOOK | HOOK | State where compiled hook conditions are evaluated before tool execution. |
| 22 | Hookish Skill | Hook 技能 | A skill with a `when` condition that auto-triggers at specific points in the loop. |
| 23 | InputProvider | 输入提供器 | Pluggable input source; UserInputProvider for interactive mode, mailbox for teammates. |
| 24 | Intent Language | 意图语言 | Structured format `VERB OBJECT TO PURPOSE` for bash tool intent. |
| 25 | IPC | 进程间通信 | Communication between lead and teammate processes via `child_process.fork()`. |
| 26 | Issue | 任务项 | Structured task with status lifecycle (pending→in_progress→completed/failed/abandoned). |
| 27 | jsep | jsep | JavaScript Expression Parser used to safely evaluate hook conditions. |
| 28 | Lead | 领导 | Main agent process that runs the agent loop and spawns teammates. |
| 29 | Letter Box | 信函框 | Green-bordered display box (80 chars) showing the LLM's final reply. |
| 30 | LLM | 大语言模型 | The language model that processes requests and generates responses. |
| 31 | MachineEnv | 机器环境 | Lifetime data tier: Triologue, AgentContext, HookExecutor, InputProvider. |
| 32 | Mail | 邮件 | File-based async messaging between agents via JSONL files. |
| 33 | markPromptBoundary | 标记提示边界 | Method that clears per-turn events, defining a turn boundary. |
| 34 | Meta-Tool | 元工具 | checkpoint and recap — handled in HOOK state, not TOOL, because they need triologue access. |
| 35 | Mindmap | 思维导图 | Tree-structured knowledge system compiled from MYCC.md. |
| 36 | Neglected Mode | 被忽略模式 | See ESC. |
| 37 | Order | 指令 | Combined mail_to + tm_await into a single blocking call. |
| 38 | PassData | 传递数据 | Per-pass data tier: tool calls, assistant content, hook results, crossroad continuation. |
| 39 | Plan Mode | 计划模式 | Restricted mode where code changes are prohibited; only read-only tools work. |
| 40 | PROMPT | PROMPT | State where the system waits for user input. |
| 41 | Recap | 回顾 | Compresses all messages from a checkpoint into a structured summary. |
| 42 | retryChat | retryChat | LLM call with internal retry loop and exponential backoff. |
| 43 | Sequence | 序列 | Query interface over conversation history for hook condition evaluation. |
| 44 | Slash Command | 斜杠命令 | User commands starting with `/` that bypass the LLM (e.g., `/mode`, `/plan`). |
| 45 | SLASH | SLASH | State that handles slash commands. |
| 46 | STOP | STOP | State that displays results and returns to PROMPT. |
| 47 | Teammate | 队友 | Child process agent spawned by Lead for parallel work. |
| 48 | TOOL | TOOL | State where the LLM's tool calls are executed. |
| 49 | Triologue | 三方对话 | Message management class handling conversation history with role rotation: system→user→assistant→tool. |
| 50 | Turn | 轮次 | From one user query to the next. Sequence.events operate at this scope. |
| 51 | TurnVars | 轮次变量 | Per-turn data tier: last user query, nudge counters, extracted keywords. |
| 52 | Two-Phase Await | 两阶段等待 | Phase 1: wait for working→idle. Phase 2: wait for idle→shutdown. |
| 53 | Wiki | 知识库 | Persistent knowledge base using LanceDB for vector similarity search. |
| 54 | Worktree | 工作树 | Git worktree for parallel branch work without switching branches. |
| 55 | Wrap-Up | 收尾 | Background LLM call after ESC to produce a quick text-only response. |
