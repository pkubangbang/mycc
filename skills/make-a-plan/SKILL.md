---
name: make-a-plan
description: "Guide for creating structured plans for coding tasks. Use when starting new features, refactoring, or any work requiring planning."
tags: [planning, coding, workflow, best-practices]
---

# Make a Plan Skill

This skill guides the agent in creating structured plans for coding tasks.

## Two-Sided Approach

Planning is a two-sided process: user-facing first, then technical details.

### Step 1: Establish Assumptions and Common Knowledge

Before diving into any planning, **always start by stating assumptions and common knowledge**, then ask the user to confirm or correct them.

This ensures:
- Both parties share the same context
- Hidden assumptions are surfaced early
- Misunderstandings are caught before work begins

Example prompt:
> "Before we plan, let me state my assumptions: [list assumptions]. Does this match your understanding? Any corrections?"

### Step 2: Gather User Intent

After confirmation, ask the user about their intention to flesh out technical details. Wait for their response before proceeding.

## Key Components of a Plan

A complete coding plan should include:

### 1. Goal Definition
Clear, concise statement of what the plan aims to achieve. Should be specific enough to judge success.

### 2. Task Breakdown
Decompose the goal into actionable tasks. Each task should be:
- Atomic and well-scoped
- Clearly defined
- Ordered by dependencies when relevant

### 3. Acceptance Criteria
Measurable conditions that determine when the goal is achieved. Should be testable/verifiable.

### 4. Potential Impact to Existing Code
Analyze and document:
- Files/modules that may be modified
- Potential breaking changes
- Risks and mitigation strategies
- Dependencies affected

### 5. Bold Guess on Next Steps
Make educated guesses about implementation approaches or next actions. This serves as inspiration and supplements context for decision-making. Mark these explicitly as guesses, not requirements.

## PEX (Progressive Explanation)

PEX is a technique for explaining situations in an ordered list where later items build upon concepts introduced earlier. This makes it easy for the user to identify the first "stucking point" — the first item they don't understand.

### Format
- Ordered list (numbered)
- Each item introduces or uses concepts from earlier items
- Progressive complexity
- Self-contained where possible

### Purpose
- Quickly surface gaps in understanding
- Enable targeted clarification
- Reduce back-and-forth by pinpointing confusion

### Example Usage
When explaining a technical concept (e.g., eslint, module system, architecture), use PEX format so the user can say "I understand items 1-5, but item 6 is where I get stuck."

### Example: mycc Process Model

## PEX on mycc Process Model

1. mycc 的入口点是 `bin/mycc.js`。这是一个 Node.js wrapper，使用 `tsx` 直接运行 TypeScript，无需预编译。
2. `bin/mycc.js` 启动 Coordinator 进程（`src/index.ts`）。Coordinator 负责加载环境变量、验证配置、管理 Lead 进程。
3. Coordinator 启动 Lead 进程（`src/lead.ts`）。Lead 是主 agent，拥有所有工具的访问权限。
4. Lead 可以使用 `tm_create` 工具创建子进程队友。子进程队友是一个独立的 Node.js 进程，通过 `child_process.fork()` 创建。
5. 子进程队友使用 `ChildContext` 作为上下文。与 `AgentContext` 相比，`ChildContext` 的部分模块（如 issue、bg、wt）必须通过 IPC 转发到主进程执行。
6. 主进程通过 `TeamManager` 管理所有子进程。`TeamManager` 维护队友列表、处理 IPC 消息、分发任务。
7. Coordinator 与 Lead 之间也有 IPC 通信。Lead 可以发送 `restart` 或 `exit` 消息给 Coordinator，Coordinator 可以发送 `neglection` 或按键事件给 Lead。
8. 子进程队友有自己的邮箱 `mail`，通过文件系统与主进程通信。主进程的邮件发送到子进程的邮箱文件，子进程轮询读取。
9. 子进程队友实现状态机：`WORK`（执行工具）、`IDLE`（轮询等待）、`SHUTDOWN`（终止）。状态转换由工具调用结果和新邮件触发。
10. 在 `IDLE` 状态时，子进程会自动扫描并认领未分配的 Issue。认领条件：`status === 'pending'` 且 `!owner` 且 `blockedBy.length === 0`。
11. 子进程队友的工具权限受限。`tm_create`、`tm_remove`、`tm_await`、`broadcast` 是主进程专属工具，子进程调用会抛出 `FORBIDDEN` 错误。

## Critical Transitions

Two key transition moments require careful handling during planning.

### Transition 1: User Asks to Flesh Out Tech Details

**Trigger**: User confirms assumptions and requests technical elaboration.

**Handler's Responsibility**:
1. **Gather context** - Read relevant code files, understand current architecture
2. **Identify key decisions** - What choices need to be made? (data structures, APIs, patterns)
3. **Present options with trade-offs** - Don't just pick one; show alternatives and their pros/cons
4. **Ask for user preference** on major decisions before proceeding
5. **Document the chosen approach** - Update the plan with concrete tech details

**Example**:
> User: "Yes, assumptions are correct. Please flesh out the tech details."
>
> Agent: "I'll read the relevant code first...
> - Found `src/auth/login.ts` uses JWT tokens
> - Found `src/db/users.ts` for user queries
>
> Key decision: Where to store session state?
> Option A: In-memory cache (simple, but lost on restart)
> Option B: Redis (persistent, scalable, adds dependency)
> Option C: Database table (persistent, no new deps, slower)
>
> Which approach do you prefer?"

### Transition 2: User Asks to Split Plan into Phases

**Trigger**: Plan is too large or complex; user wants incremental delivery.

**Handler's Responsibility**:
1. **Identify phase boundaries** - Find natural cut points where partial work is usable
2. **Order phases by dependency** - Earlier phases must not block later ones unexpectedly
3. **Define phase deliverables** - Each phase should produce something testable
4. **Set acceptance criteria per phase** - When is phase N "done"?
5. **Consider rollback** - If phase 2 fails, can we stay on phase 1?

**Phase Splitting Principles**:
- **Phase 1**: MVP / Core functionality (minimal but working)
- **Phase 2**: Enhancements / Edge cases
- **Phase 3**: Polish / Optimizations

**Example**:
> User: "This is too big. Split into phases."
>
> Agent: "Breaking down:
>
> **Phase 1: Core Login Flow** (1-2 days)
> - Basic username/password auth
> - JWT token generation
> - Deliverable: User can log in via API
>
> **Phase 2: Session Management** (1 day)
> - Token refresh
> - Session expiry
> - Deliverable: Sessions persist 24h
>
> **Phase 3: Security Hardening** (1 day)
> - Rate limiting
> - Password hashing
> - Deliverable: Production-ready auth
>
> Shall I proceed with Phase 1?"

### Transition 3: User Asks to Start Coding

**Trigger**: User approves the plan and wants to begin implementation.

**Handler's Responsibility**:
1. **Final confirmation** - Briefly restate what will be done first
2. **Setup tracking** - Create todos or issues to track progress
3. **Start with smallest task** - Pick the most atomic, well-defined task to begin
4. **Report progress** - Use `brief` to keep user informed as work progresses

**Example**:
> User: "Looks good. Start coding."
>
> Agent: "Starting with Phase 1, Task 1: Add login endpoint.
>
> Created todo list:
> - [ ] Add login endpoint
> - [ ] Add JWT token generation
> - [ ] Add session validation
>
> Now implementing `src/auth/login.ts`..."