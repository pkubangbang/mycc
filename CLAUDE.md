# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js coding agent implementation using Ollama for LLM inference. The architecture follows a modular design with AgentContext as the central state container.

## Commands

```bash
pnpm install        # Install dependencies
pnpm start          # Run the agent (src/index.ts)
pnpm typecheck      # TypeScript type checking
pnpm build          # Compile to dist/
pnpm format          # Format with Prettier
```

## Environment Setup

Copy `.env.example` to `.env` and configure:
- `OLLAMA_HOST` - Ollama server URL (default: http://127.0.0.1:11434)
- `OLLAMA_MODEL` - Model name (default: glm-5:cloud)
- `OLLAMA_API_KEY` - API key for cloud models (optional)

## Tool Scope Constraints

Different agent contexts have access to different tools:

| Agent Type | Available Tools |
|------------|-----------------|
| Lead (main) | All tools |
| Teammate (child) | Cannot use: tm_create, tm_remove, tm_await, broadcast |
| Background (bg) | Can only use: bash, read_file, write_file, edit_file |

**Main-only tools**: tm_create, tm_remove, tm_await, broadcast

## Architecture

### AgentContext Pattern

All tools receive an `AgentContext` object containing state modules:

```
AgentContext
├── core      - Work directory and logging (core.ts)
├── todo      - Temporary checklist (todo.ts)
├── mail      - Async mailbox (mail.ts)
├── skill     - Skill loading (skill.ts)
├── issue     - Persisted tasks with blocking (issue.ts)
├── bg        - Background bash tasks (bg.ts)
├── wt        - Git worktree management (wt.ts)
├── team      - Child process teammates (team.ts)
└── transcript - Chat history logging (transcript.ts)
```

### Key Concepts

1. **Agent Loop (STAR principle)**: Situation → Task → Action → Result cycle with:
   - Mail collection at each iteration
   - Todo nudging every 3 turns
   - Auto-compact when tokens exceed threshold
   - Bounce pattern to wait for teammates

2. **Child Process Teammates**: Teammates run as child processes via `fork()`. Lead acts as IPC broker routing all messages between teammates.

3. **Dynamic Loading**: Tools loaded from `src/tools/` (built-in) and `.mycc/tools/` (user-defined with hot-reload). Skills loaded from `.mycc/skills/*.md` with YAML frontmatter.

4. **SQLite Persistence**: Issues, teammates, and worktrees stored in `.mycc/state.db`. Lead process handles all DB access.

5. **Append-only Mailboxes**: Each teammate has `.mycc/mail/<name>.jsonl` for async messaging.

## File Structure

```
src/
├── index.ts           # Entry point
├── types.ts           # All type definitions
├── ollama.ts          # Ollama client config
├── context/
│   ├── index.ts       # AgentContext factory
│   ├── db.ts          # SQLite setup
│   ├── loader.ts      # Dynamic tool/skill loader
│   ├── core.ts        # Work directory, logging, questions
│   ├── todo.ts        # Temporary checklist
│   ├── mail.ts        # Async mailbox
│   ├── skill.ts       # Skill loading
│   ├── issue.ts       # Persisted tasks with blocking
│   ├── bg.ts          # Background bash tasks
│   ├── wt.ts          # Git worktree management
│   ├── team.ts        # Child process teammates
│   ├── transcript.ts  # Chat history logging
│   └── child-context/ # Child process IPC wrappers
├── tools/
│   ├── bash.ts        # Shell commands
│   ├── read.ts        # File reading
│   ├── write.ts       # File writing
│   ├── edit.ts        # File editing
│   ├── brief.ts       # Status messages
│   ├── question.ts    # User questions
│   ├── mail_to.ts     # Inter-agent messaging
│   ├── broadcast.ts   # Broadcast to all teammates
│   ├── issue_create.ts    # Create issue
│   ├── issue_claim.ts     # Claim issue
│   ├── issue_close.ts     # Close issue
│   ├── issue_comment.ts   # Comment on issue
│   ├── blockage_create.ts # Create blocking
│   ├── blockage_remove.ts # Remove blocking
│   ├── tm_create.ts   # Create teammate
│   ├── tm_remove.ts   # Remove teammate
│   ├── tm_await.ts    # Wait for teammates
│   ├── todo_write.ts  # Todo list updates
│   └── skill_load.ts  # Load skill by name
└── loop/
    ├── agent-loop.ts  # STAR-principle loop
    └── agent-utils.ts # System prompt building

.mycc/                 # Runtime data (gitignored)
├── state.db           # SQLite database
├── mail/              # Mailboxes
├── tools/             # User tools (optional)
└── skills/            # Skill definitions
```

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

## Database Schema

SQLite tables in `.mycc/state.db`:

- `issues` - Persisted tasks with blocking relationships
- `teammates` - Team member state
- `worktrees` - Git worktree records

See `src/context/db.ts` for schema definitions.

## Reference Documents

- `docs/agent-context.md` - AgentContext module documentation (Chinese)
- `docs/agent-loop.md` - Agent loop implementation details (Chinese)
- `docs/dynamic-loading.md` - Tool/skill loading mechanism
- `docs/s11-design.md` - Reference architecture for child process teammates