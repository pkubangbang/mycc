# CLAUDE.md

This file provides guidance for Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project builds a tool called "mycc" -- A node.js coding agent implementation using Ollama for LLM inference. The architecture follows a modular design with AgentContext as the central state container.


## Setup

Refer to `README.md` for instructions.

Prefer using pnpm instead of npm. The only exception is `npm link` to install the mycc globally.

## Terminology

This section captures the terms specific to this project.

### tools/skills/hooks/routine

tools are callable functions that uses the AgentContext. They have the same shape, are loaded by the 
"loader", and called by llm.

skills are markdown files with yaml-front-matter metadata. They provide extra knowledge for the llm
to utilize, mostly specialist experiences.

hooks are a special case of skills. They have a `when` property that can be compiled into a trigger condition.
The trigger targets a specific timing in the agent loop, while the condition tells whether to apply
the knowledge or not.

routine is another way of speaking of the agent loop, where sevaral steps of logic take place in order.

### project tools, user tools, built-in tools

project tools are in `./.mycc/tools`, and are loaded only in this project.
user tools are in `~/.mycc-store/tools`, and are loaded for every project (for the current user).
built-in tools are inside the `src/tools`, and are loaded unconditionally.

The first two locations are treated as extention points. Tools are loaded by name, if there are
conflicts, the built-in always wins, and the project ones will shadow the user ones.

### project skills, user skills, built-in skills

project skills are in `./.mycc/skills`, and are loaded only in this project.
user skills are in `~/.mycc-store/skills`, and are loaded for every project (for the current user).
built-in skills are inside the `skills` of this project root, and are loaded unconditionally.

The first two locations are treated as extention points. Skills are loaded by name, if there are
conflicts, the built-in always wins, and the project ones will shadow the user ones.

### neglection and esc return

Neglection is triggered when the user presses ESC during LLM inference. It signals the agent to quickly wrap up the current response without further tool calls. The "neglected mode" aborts ongoing LLM calls, buffers subsequent output, and forces the agent to finish with a text-only response.

Key components:
- `agentIO.isNeglectedMode()` - Check if ESC was pressed
- `agentIO.setNeglectedMode(value)` - Set/clear neglected flag
- `agentIO.onNeglected(callback)` - Register callbacks for ESC events
- IPC message `{ type: 'neglection' }` - Coordinator sends to Lead on ESC press

### slash commands

User-initiated commands starting with `/` that are handled outside the LLM tool system. They provide meta-operations like viewing help, managing sessions, switching modes, and managing knowledge bases.

Registry pattern (`src/slashes/index.ts`):
- `slashRegistry.register(command)` - Register a command
- `slashRegistry.execute(name, context)` - Execute a command by name

Built-in commands:
- `/team`, `/todos`, `/skills`, `/issues` - Team and task management
- `/save`, `/load`, `/clear` - Session management
- `/wiki`, `/domain`, `/mindmap` - Knowledge base management
- `/compact`, `/mode`, `/plan` - Mode and state control
- `/help` - Show available commands

### user session, project session

Sessions are persisted conversation states stored as JSON files. **Project sessions** are stored in `.mycc/sessions/` and are project-specific. **User sessions** are stored in `~/.mycc-store/sessions/` and can be shared across projects.

Session structure (`src/session/types.ts`):
- `id` - Unique identifier
- `create_time` - Creation timestamp
- `project_dir` - Project directory path
- `lead_triologue` - Lead conversation history
- `child_triologues` - Teammate conversation histories
- `teammates` - Active teammate information
- `first_query` - First user query (used as bookmark title)

Use `/save` to copy a project session to user directory and `/load` to restore any session.

### mindmap

A tree-structured knowledge system that compiles markdown files (like `CLAUDE.md`) into a navigable JSON structure. Each node has an ID (slash-separated path), text, title, summary (LLM-generated), level, children, and links. The agent can query specific nodes via `get_node` tool for efficient context retrieval without loading entire documentation.

Key concepts:
- **Node**: Knowledge unit with `id`, `text`, `title`, `summary`, `level`, `children`, `links`
- **Mindmap**: Root structure with `dir`, `hash`, `compiled_at`, `root` node
- **Compilation**: One-way process: `CLAUDE.md --> [compile_mindmap] --> mindmap.json`
- **Process Isolation**: Each agent (lead/teammate) has independent mindmap instance

See `docs/mindmap-design.md` for detailed design.

### wiki, vector store

The wiki is a persistent knowledge base using LanceDB for vector similarity search. Knowledge is stored via WAL (Write-Ahead Log) files for audit and rebuild capabilities. Each document has a hash, domain, title, content, references, and embedding vector. Domains organize knowledge (e.g., "project", "skills").

Key components (`src/context/parent/wiki.ts`):
- `wiki.get(query, options)` - Search documents by similarity
- `wiki.put(document)` - Store document with embedding
- `wiki.rebuild()` - Rebuild vector store from WAL files
- `wiki.listDomains()` - List all knowledge domains

Tools:
- `wiki_get` - Search by similarity
- `wiki_put` - Add documents with auto-generated embeddings
- `wiki_prepare` - Prepare domain before adding documents

Configuration:
- Embedding model: `nomic-embed-text` (via `OLLAMA_EMBEDDING_MODEL`)
- Duplicate threshold: 0.95 similarity marks duplicates
- Content limits: 50-1000 characters per document

### lead and teammates

The **Lead** is the main agent process that handles user interaction, spawns teammate processes, and coordinates work. **Teammates** are child processes that execute assigned tasks.

Architecture:
```
Terminal -> Coordinator -> Lead (main agent) -> Teammates (child processes)
```

Key constraints:
- Teammates have restricted capabilities—they cannot use `tm_create`, `tm_remove`, `tm_await`, or `broadcast` directly (must request via mail to lead)
- Team mode is orthogonal to normal/plan mode (combinations: solo-normal, solo-plan, team-normal, team-plan)

Key operations (`src/context/parent/team.ts`):
- `team.createTeammate(name, role, prompt)` - Spawn teammate
- `team.listTeammates()` - List all teammates
- `team.awaitTeam(timeout)` - Wait for all teammates
- `team.mailTo(name, title, content)` - Send mail to teammate/lead
- `team.broadcast(title, content)` - Broadcast to all (lead only)

### health-check

Runs at startup to validate Ollama connectivity and model availability. Checks:
1. Ollama server is reachable
2. Model exists and can process requests
3. `TOKEN_THRESHOLD` does not exceed 80% of model's context length

Implementation (`src/setup/ollama-health-check.ts`):
- `checkHealth(tokenThreshold)` - Returns `HealthCheckResult`
- `HealthCheckResult` - `{ ok, error?, warnings?, modelInfo? }`
- Model info: `name`, `contextLength`, `family`, `parameterSize`

CLI flag `--skip-healthcheck` bypasses the check. If failed, prompts user to retry or exit.

### normal mode, plan mode

mycc starts with normal mode, where it can explore the code base and make changes.

plan mode can be enabled by slash command `/mode plan` or by llm using `plan_on` tool.

in plan mode, mycc should only use explorational tools, while other tool uses are prohibited.

plan mode also differs from the normal mode in the system prompt they bear.

### team mode

team mode is not actually a mode, but a state where teammates are spawned to help the lead.

team mode is orthogonal to normal/plan, so we have solo-normal, solo-plan, team-normal, team-plan mode
to speak in detail.

team mode handles the particular challenges of collaboration by using dedicated system prompt.

### todo and issue

**Todos** are simple task tracking items with title, status, and blockedBy dependencies. **Issues** are more structured task objects with ID, status, owner, blockedBy/blocks dependencies, and comments. Issues support team coordination—teammates claim issues and close them when done.

Key types:
- `Todo` - `{ id, subject, description, status, blockedBy, blocks, owner, activeForm }`
- `Issue` - `{ id, title, status, owner, content, comments, blockedBy, blocks, createdAt }`

Tools:
- `todo_write` - Create/update todos
- `issue_create` - Create issue with dependencies
- `issue_claim` - Assign issue to teammate
- `issue_list` - List all issues
- `issue_close` - Mark completed/failed/abandoned
- `issue_comment` - Add comment to issue

Slash commands:
- `/todos` - View all todos
- `/issues` - View all issues

### bang command

The bang command (`!<command>`) is a UI shortcut that opens an external tmux terminal popup for interactive command execution. When the user types `!` at the prompt start, the prompt changes to a magenta `run cmd ! ` prompt. This bypasses the LLM and lets the user run shell commands interactively in a separate terminal.

Key behavior:
- Typing `!` switches prompt to bang mode (`run cmd ! `)
- Opens tmux popup terminal in current working directory
- User works interactively in popup
- Press Enter to capture output and kill session, or 'k' to keep session
- Persistent sessions (e.g., `npm run dev`, `ssh`) can be kept for later reattachment

See `docs/bang-command-design.md` for detailed design.

### prompt line and letter box

The prompt line is where the user can type and submit the query. When in normal mode, it displays as `agent >> `.
When in plan mode, it displays as `plan >> `. If the user is typing bang command, it displays as `run cmd ! `.

The letter box is what the llm reply to the user formally. It is actually the last message from the llm before 
leaving the agent loop. It displays as a green block of text with the first line like below:

```
.================================ 17:32:45 =================================.
```


### tmux

Tmux is a required external dependency for interactive terminal operations. mycc uses tmux to create popup terminals where users can run commands interactively (with prompts, TUIs, etc.). It's also used for e2e testing to simulate interactive terminal sessions.

Key use cases:
1. **Bang command** - Opens tmux popup for interactive shell commands
2. **E2E testing** - Simulate user input and capture output
3. **Persistent sessions** - Keep dev servers, SSH sessions alive

Testing commands (from CLAUDE.md):
```bash
tmux new-session -s mycc-test -d -x 80 -y 24
tmux send-keys -t mycc-test "/help" Enter
tmux capture-pane -t mycc-test -p
tmux kill-session -t mycc-test
```

### AgentContext

A modular state container that provides coding agent tools with access to state data. It's the central interface through which tools interact with the system.

Modules encapsulated:
- `core` - Work directory, logging, user questions
- `todo` - Temporary checklist
- `mail` - Async mailbox for inter-agent communication
- `team` - Teammate management
- `issue` - Persisted tasks
- `skill` - Skill loader
- `bg` - Background tasks
- `wt` - Git worktree management
- `wiki` - Knowledge base

Two implementations: `ParentContext` (main process, direct access) and `ChildContext` (child processes, IPC wrappers).

### Triologue

The conversation state manager that tracks message history, manages compaction, and handles hint rounds. Central to the agent loop.

Key responsibilities:
- Stores conversation message history
- Manages `microCompact()` and `autoCompact()` for token management
- Tracks the `Sequence` for hookish skill conditions
- Supports hint round generation for confusion recovery

### IPC and IOC

**IPC (Inter-Process Communication)** enables communication between the main process (lead agent) and child processes (teammate agents) using Node.js `child_process.fork()` and message passing.

**IOC (Inversion of Control)** is a design pattern where the `TeamManager` acts as a dispatcher. Modules register handlers for specific message types, following the Open-Closed Principle.

Key components:
- `IpcRegistry` - Dispatcher that routes messages to registered handlers
- `sendRequest`/`sendNotification` - Communication primitives
- Request-Response pattern for operations requiring results

### Loader

A class that provides unified loading of tools and skills with hot-reload capability for dynamic content.

Loading priority (highest wins):
1. Built-in tools/skills (`src/tools/`, `skills/`)
2. Project tools/skills (`.mycc/tools/`, `.mycc/skills/`)
3. User tools/skills (`~/.mycc-store/`)

Key methods:
- `loadAll()` - Load everything at startup
- `watchDirectories()` - Enable hot-reload for project/user directories
- `getToolsForScope(scope)` - Get tools filtered by context

### Hookish Skills

Skills that actively trigger based on patterns in the conversation sequence, as opposed to passive skills that only load on explicit request.

Defined with `when:` field in skill YAML frontmatter:
```yaml
---
name: lint-after-edit
when: run pnpm lint after code changes before commit
---
```

Condition language can query conversation history:
- `seq.has(toolName)` - Tool exists in conversation
- `seq.hasAny([tool1, tool2])` - Any of these tools exist
- `seq.lastError()` - Last error result
- `seq.sinceEdit()` - Events after last file edit

Actions: `inject_before`, `inject_after`, `block`, `replace`, `message`

### Sequence

A wrapper around Triologue that provides query methods for hookish skill conditions to inspect conversation history. Enables conditions like `seq.has('edit_file')`, `seq.count('bash')`, `seq.since('git_commit')`.

### Confusion Index

A metric that quantifies how "stuck" an agent is, used to trigger hint rounds when making no progress.

Scoring:
- `+1` per assistant response (cycling without progress)
- `+0` for exploration tools (read-only)
- `-1` for action tools (making changes)
- `+2` for tool errors
- `+1` for repetition

When score >= threshold (default 10): Main process triggers hint round (LLM self-analysis), child sends mail to lead requesting guidance.

### Grant System

A permission system for child processes to request approval before performing sensitive operations.

Grant flow:
```
Child → requestGrant(tool, args) → IPC → Parent
Parent → check mode → check worktree → grant/deny
Child → proceed or show error
```

In `plan` mode: All code changes blocked. In `normal` mode: Auto-grant for owned worktree, reject otherwise.

### WAL (Write-Ahead Log)

An append-only log file for the Wiki knowledge base that records all changes before they are applied. Used for auditing and rebuilding the vector store.

- Stored in `~/.mycc-store/wiki/logs/YYYY-MM-DD.wal` as JSON lines
- Each entry records operation (put/delete) with timestamp
- Can rebuild vector store from WAL files using `/wiki rebuild`

### State Machine

A design for the agent loop using explicit states and transitions instead of a single `while(true)` loop.

States:
- **prompt** - Get user input, handle slash/bang/exit
- **collect** - Pre-LLM pipeline: questions, mail, hint round, todo nudge
- **llm** - Build system prompt, call LLM with retry
- **hook** - Augment tool calls, evaluate hook conditions
- **tool** - Execute tool calls sequentially
- **stop** - Handle no-tool-call case, await teammates

### Auto-Claim

Feature where idle child processes automatically claim unassigned issues. When a child enters IDLE state (no tool calls), it polls for new mail and scans issues for `pending` + no owner + no blockers, then atomically claims the first matching issue.

## Tool Scope Constraints

| Agent Type | Available Tools |
|------------|-----------------|
| Lead (main) | All tools |
| Teammate (child) | Cannot use: tm_create, tm_remove, tm_await, broadcast |
| Background (bg) | Can only use: bash, read_file, write_file, edit_file |

**Main-only tools**: tm_create, tm_remove, tm_await, broadcast

## How to add a tool/skill

To add a tool:
1. refer to existing code in src/tools/ to get coding pattern
2. create file in `.mycc/tools` folder. This is a hot-reloadable folder
3. let the user test it manually, and iterate from feedbacks.
4. once qualified, migrate it back into `src/tools` and update the loader, to make it built-in.

The detailed information can be found at `skills/add-tool/SKILL.md`.

To add a skill:
1. refer to existing files in skills/ to get pattern.
2. create file in `.mycc/skills` folder. This is a hot-reloadable folder
3. let the user test it manually, and iterate from feedbacks.
4. once qualified, migrate it back into `skills/`, to make it built-in.

## Tool Development Guidelines

**Fail Early**: Tools should fail early and explicitly rather than silently degrading. Explicit errors help the agent understand what went wrong and take corrective action.

**No Direct Console Output in Tools**: Tools MUST NOT use `console.log`, `console.error`. Use `ctx.core.brief()` for all user-facing output.

## How to test this app

Use tmux to simulate interactive terminal sessions:

```bash
# Create session
tmux new-session -s mycc-test -d -x 80 -y 24

# Send keys
tmux send-keys -t mycc-test "/help" Enter

# Capture output
tmux capture-pane -t mycc-test -p

# Kill session
tmux kill-session -t mycc-test
```

## Unit Tests

Uses **vitest** for unit testing. Tests in `src/tests/`.

```bash
pnpm test                    # Run all tests
pnpm test src/tests/tools/   # Run specific directory
```

## Code Cleanup

Use TypeScript's strict checks to find unused imports/variables:

```bash
pnpm typecheck --noUnusedLocals --noUnusedParameters
```

Use pnpm for linting (you MUST do it before commit):

```bash
pnpm lint                    # Run lint on all files
pnpm lint src/tools/screen.ts  # Run lint on specific files
```

Use prettier for formatting (run after significant changes):

```bash
pnpm format
```

## Reference Documents

- `docs/agent-context.md` - AgentContext module (Chinese)
- `docs/agent-loop.md` - Agent loop (Chinese)
- `docs/agent-tools.md` - Built-in tools reference
- `docs/child-context.md` - Child process and IPC (Chinese)
- `docs/dynamic-loading.md` - Tool/skill loading mechanism
- `docs/database-schema.md` - SQLite schema (Chinese)