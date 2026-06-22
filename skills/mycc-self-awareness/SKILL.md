---
name: mycc-self-awareness
description: >
  Explains what mycc is — the runtime environment that the agent runs in.
  mycc is a Node.js CLI coding agent that uses Ollama (local or cloud) or
  DeepSeek for LLM inference. It provides 30+ tools (bash, read/write/edit
  files, web search, image recognition, team collaboration, knowledge base,
  git worktrees, background tasks, etc.) for the LLM to accomplish coding
  tasks. The agent runs in a state machine loop (PROMPT→COLLECT→LLM→HOOK→
  TOOL→STOP) with triologue message management, auto-compaction, and
  ESC-aware interruption. It supports team collaboration via child process
  teammates, a mindmap knowledge tree compiled from MYCC.md, a wiki/RAG
  knowledge base using LanceDB, dynamic hot-reloadable tools and skills,
  and git worktree management for parallel branch work. Use this skill when
  the project being worked on is NOT mycc itself, and the agent needs to
  understand what runtime it is running in, what capabilities it has, and
  how the system works. This is a reference skill — it provides factual
  information about the mycc runtime environment.
keywords: [mycc, runtime, environment, agent, CLI, tool, skill, mindmap, wiki, RAG, team, teammate, IPC, triologue, state machine, hook, loader, hot-reload, worktree, session, slash command, intent language, grant system, esc, neglected, compact, context, Ollama, DeepSeek, LLM, coding agent]
---

# mycc Self-Awareness

This skill documents what **mycc** is — the runtime environment that the agent
runs in. Use this when you are working on a project **other than mycc itself**
and need to understand the capabilities and architecture of the tool you are
running inside.

## What is mycc?

**mycc** is a Node.js CLI coding agent. It connects to an LLM (via Ollama or
DeepSeek) and provides the LLM with a rich set of tools to accomplish coding
tasks. Think of it as a "runtime for AI agents" — the LLM is the brain, and
mycc provides the hands (tools), memory (wiki, mindmap), and collaboration
(teammates).

### Key Facts

| Aspect | Description |
|--------|-------------|
| **Language** | Node.js (TypeScript) |
| **LLM Provider** | Ollama (local/cloud) or DeepSeek API |
| **Embedding Model** | Always via Ollama (e.g., `nomic-embed-text`) |
| **Terminal** | Requires tmux (or psmux on Windows) for interactive sessions |
| **Package** | `@pkubangbang/mycc` on npm |
| **License** | MIT |

## Architecture Overview

### Agent Loop (State Machine)

The agent runs in a 6-state state machine:

```
PROMPT → SLASH → COLLECT → LLM → HOOK → TOOL → STOP
```

- **PROMPT**: Wait for user input
- **SLASH**: Handle `/` commands (bypass LLM)
- **COLLECT**: Gather context (mindmap, skills, wiki)
- **LLM**: Call the LLM with collected context
- **HOOK**: Evaluate hook conditions (hookish skills)
- **TOOL**: Execute tool calls from LLM response
- **STOP**: Wrap up and return to PROMPT

### Data Tiers

- **MachineEnv**: Lifetime data (constructed once per session)
- **TurnVars**: Per-turn data (fresh per user query)
- **PassData**: Per-pass data (fresh per COLLECT→LLM→HOOK cycle)

### Triologue (Message Management)

The triologue manages the conversation history with:
- **Role validation** (triologue parity): enforces correct `system→user→assistant→tool→assistant→...` ordering
- **Auto-compaction**: when token estimate exceeds `TOKEN_THRESHOLD`, compresses history
- **Micro-compaction**: compresses consecutive tool messages into single user messages
- **Session/turn/move scoping**: session (full history), turn (one user query), move (one LLM response with batched tool calls)

### ESC / Neglected Mode

When the user presses **ESC** during an LLM call:
1. The LLM call is aborted
2. Remaining tool calls are skipped
3. A background "wrap-up" LLM call produces a quick text-only response
4. The agent returns to PROMPT state

## Tools

mycc provides **30+ tools** for the LLM. Tools are defined as `ToolDefinition`
objects with `name`, `description`, `input_schema` (JSON Schema), `scope`
(`main` or `child`), and a `handler` function.

### Tool Categories

| Category | Tools |
|----------|-------|
| **File Operations** | `read_file`, `write_file`, `edit_file` |
| **Execution** | `bash` (with intent language and grant system) |
| **Web** | `web_search`, `web_fetch` |
| **Image** | `read_picture`, `screen` |
| **Knowledge** | `recall` (mindmap), `wiki_get`, `wiki_prepare`, `wiki_put` |
| **Task Management** | `todo_create`, `todo_update`, `issue_create`, `issue_claim`, `issue_close`, `issue_comment`, `issue_list` |
| **Team** | `tm_create`, `tm_remove`, `tm_await`, `tm_print`, `mail_to`, `broadcast`, `order` |
| **Worktree** | `wt_create`, `wt_enter`, `wt_leave`, `wt_remove`, `wt_print` |
| **Background** | `bg_create`, `bg_await`, `bg_print`, `bg_remove` |
| **Meta** | `checkpoint`, `recap`, `plan_on`, `plan_off`, `hand_over`, `brief`, `mycc_title` |
| **Skill** | `skill_load`, `skill_search`, `skill_compile` |

### Tool Loading Priority

Tools are loaded from three layers (highest priority first):

1. **Built-in** (`src/tools/`) — cannot be overridden
2. **Project** (`.mycc/tools/`) — hot-reloadable
3. **User** (`~/.mycc-store/tools/`) — shared across projects

### Tool Scope

- **`main` scope**: Available to the lead agent only (includes team management, meta tools)
- **`child` scope**: Available to teammate agents (subset of tools, no team management)

### Intent Language

The `bash` tool requires an `intent` parameter in the format:
```
VERB OBJECT PARAM PARAM ... TO PURPOSE
```

Where VERB is one of: `READ`, `WRITE`, `EDIT`, `DELETE`, `BUILD`, `TEST`,
`INSTALL`, `RUN` and OBJECT is one of: `SOURCE`, `CONFIG`, `DEPENDENCY`,
`ARTIFACT`, `SYSTEM`, `DATA`, `TEMP`, `USER`.

### Grant System

The `bash` tool goes through a 5-step judging process:
1. Check for dangerous command patterns
2. Validate intent grammar
3. Check mode + verb
4. LLM analysis for RUN verb
5. User prompt for uncertain cases

## Skills

Skills are Markdown files with YAML front-matter that provide specialist
knowledge to the LLM. They are loaded on-demand via `skill_load` or
`skill_search`.

### Skill Types

| Type | Description |
|------|-------------|
| **Process** | Step-by-step workflows and procedures |
| **Reference** | Lookup information, formats, configurations |
| **Lesson** | Captured experiences and learnings |
| **Hookish** | Auto-triggering skills with `when` conditions |

### Hookish Skills

A hookish skill has a `when` field in its frontmatter. When compiled via
`skill_compile`, it becomes a structured hook with:
- **Trigger**: Which tool/event fires the hook
- **Condition**: Expression evaluated via jsep AST (safe, no eval)
- **Action**: What to do (inject_before, inject_after, block, replace, message, compact)

Hooks are evaluated in the HOOK state between LLM and TOOL execution.

### Skill Loading Priority

Same as tools (highest first):
1. **Built-in** (`skills/`) — cannot be overridden
2. **Project** (`.mycc/skills/`) — hot-reloadable
3. **User** (`~/.mycc-store/skills/`) — shared across projects

## Mindmap (Knowledge Tree)

The mindmap is a tree-structured knowledge system compiled from `MYCC.md`
(the project's self-description document at the project root).

### Key Concepts

- **Compilation**: `MYCC.md` is parsed into a JSON tree (`.mycc/mindmap.json`)
- **Explorer Agent**: An autonomous LLM agent explores the codebase to generate enriched summaries
- **A-N-C-E Context**: Summarization algorithm using Ancestors + Node text + Children summaries + Environment guidance
- **Rotation-based writes**: Atomic file rotation for crash safety
- **Process isolation**: Each agent (lead/teammate) has its own mindmap instance
- **Querying**: Via `recall(path="/")` tool or `/mindmap get` slash command

### Node Structure

Each mindmap node has: `id` (slash-separated path), `text`, `title`, `summary`,
`level`, `children`, and `links` (to files, URLs, or project terms).

## Wiki (RAG Knowledge Base)

The wiki is a persistent knowledge base using **LanceDB** (embedded vector
database) for semantic search.

### Key Concepts

- **Embedding model**: Always via Ollama (default: `nomic-embed-text`, 768-dim vectors)
- **Domains**: Organizational categories (e.g., "project", "architecture", "pitfall")
- **Two-phase storage**: `wiki_prepare` (validate) → `wiki_put` (store)
- **WAL (Write-Ahead Log)**: Per-date JSON-lines log files for audit and rebuild
- **Storage location**: `~/.mycc-store/wiki/db/`

## Team Collaboration

mycc supports spawning **teammate agents** as child processes.

### Communication

- **IPC**: Via `child_process.fork()` message passing
- **Mailbox**: File-based append-only JSONL format
- **Patterns**: Sequential (blocking dependencies), parallel (independent tasks), issue-based handoff

### Lifecycle

1. Lead spawns teammate via `tm_create`
2. Teammate runs its own agent loop with restricted tools
3. Lead assigns work via `mail_to` or `order`
4. Teammate auto-claims issues when idle (5-second polling)
5. Lead collects results via `tm_await`
6. Lead terminates via `tm_remove`

### Auto-Claim

Idle teammates automatically claim unassigned issues by polling every 5 seconds
for issues matching: pending + no owner + no blockers.

## Dynamic Loading (Hot-Reload)

Tools and skills in `.mycc/tools/` and `.mycc/skills/` are watched by an
FSWatcher. When a file changes, the ESM cache is invalidated and the module
is re-imported at runtime — no restart needed.

## Sessions

- Each startup creates a new **session** (UUID-based)
- Session metadata stored at `.mycc/sessions/{uuid}.json`
- Full conversation log at `.mycc/transcripts/lead-{ts}-triologue.jsonl` (append-only JSONL)
- Previous sessions can be loaded via `/load` slash command
- `/clear` or double Ctrl+L clears the sequence (not the triologue)

## Slash Commands

User-initiated commands starting with `/` that bypass the LLM:

| Command | Purpose |
|---------|---------|
| `/mode` | Switch between normal and plan mode |
| `/plan` | Enter/exit plan mode |
| `/mindmap` | Compile, get, patch, validate mindmap |
| `/load` | Load a previous session |
| `/clear` | Clear sequence (double Ctrl+L) |
| `/todos` | List/manage todo items |
| `/team` | List teammates |
| `/issues` | List issues |
| `/help` | Show help |

## Configuration

Configuration is stored in `.env` files:

| Level | Location | Scope |
|-------|----------|-------|
| **User** | `~/.mycc-store/.env` | All projects |
| **Project** | `.mycc/.env` | Current project only |

### Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `OLLAMA_HOST` | Ollama server URL (default: http://127.0.0.1:11434) |
| `OLLAMA_MODEL` | Chat model (default: glm-5:cloud) |
| `OLLAMA_VISION_MODEL` | Vision model for screen/image tools |
| `OLLAMA_EMBEDDING_MODEL` | Embedding model (default: nomic-embed-text) |
| `OLLAMA_API_KEY` | API key for cloud features (optional) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `DEEPSEEK_MODEL` | DeepSeek model (default: deepseek-chat) |
| `TOKEN_THRESHOLD` | Context limit for auto-compaction (default: 50000) |
| `EDITOR` | Text editor for multiline input |

## Common Pitfalls

### Pitfall 1: Tool Descriptions Are for LLM, Not Users

Tool descriptions are read by the LLM to understand a tool's purpose. They
should be concise and LLM-oriented, NOT verbose user-facing documentation.

### Pitfall 2: No console.log in Tools

Tools must use `ctx.core.brief()` for output, not `console.log`/`console.error`.
A custom ESLint rule (`no-console-in-tools`) enforces this.

### Pitfall 3: Date Serialization in IPC

IPC serialization converts Date objects to strings, which can break child
processes that expect Date types (e.g., `Issue.createdAt`, `IssueComment.timestamp`).

### Pitfall 4: AgentIO Singleton in Child Processes

The `AgentIO` singleton works differently in child processes. The
`isMainProcessFlag` defaults to `false` and is only set to `true` when
`initMain()` is called in the lead process.

### Pitfall 5: Loop Notation (LN)

The triologue uses a compact notation for message role rotation:
`system, user, [tool1,tool2]?, tool1!, _tool_, agent`. Understanding this
helps when debugging conversation history issues.

## Summary

mycc is a Node.js CLI coding agent that provides an LLM with:
- **30+ tools** for file operations, execution, web, image, knowledge, tasks, team, worktree, background tasks
- **Skills** for specialist knowledge (process, reference, lesson, hookish)
- **Mindmap** for project knowledge navigation
- **Wiki** for persistent RAG knowledge base
- **Team collaboration** via child process teammates
- **Dynamic loading** for hot-reloadable tools and skills
- **Session management** with load/replay capabilities
- **ESC-aware interruption** for graceful abort
- **Intent language** for safe bash execution
- **Grant system** for security-sensitive operations
