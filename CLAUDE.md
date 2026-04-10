# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js coding agent implementation using Ollama for LLM inference. The architecture follows a modular design with AgentContext as the central state container.

## Setup

Refer to `README.md` for instructions.

## Tool Scope Constraints

Different agent contexts have access to different tools:

| Agent Type | Available Tools |
|------------|-----------------|
| Lead (main) | All tools |
| Teammate (child) | Cannot use: tm_create, tm_remove, tm_await, broadcast |
| Background (bg) | Can only use: bash, read_file, write_file, edit_file |

**Main-only tools**: tm_create, tm_remove, tm_await, broadcast

See `docs/agent-tools.md` for complete tool reference.

## Architecture

All tools receive an `AgentContext` object containing state modules. See `docs/agent-context.md` for module documentation.

Key architectural concepts:

- **Agent Loop (STAR principle)**: See `docs/agent-loop.md`
- **Child Process Teammates**: See `docs/child-context.md`
- **Dynamic Loading**: See `docs/dynamic-loading.md`
- **SQLite Persistence**: See `docs/database-schema.md`

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

## Resource Cleanup (CRITICAL)

When adding features that acquire resources (database connections, file watchers, timers, 
child processes, etc.), you MUST ensure proper cleanup on exit:

1. **Database connections** - Must be closed via `closeDb()` in `src/context/db.ts`
2. **File watchers** - Must be closed via `stopWatching()` (already handled in loader)
3. **Child processes** - Must be killed/dismissed (handled in team manager)
4. **Timers/intervals** - Must be cleared

The main exit paths are in `src/loop/agent-loop.ts`:
- Normal exit: end of `main()` function
- SIGINT handler: `process.on('SIGINT', ...)` 

**Before adding new resources**, check both exit paths and add cleanup calls.

## Reference Documents

- `docs/agent-context.md` - AgentContext module documentation (Chinese)
- `docs/agent-loop.md` - Agent loop implementation details (Chinese)
- `docs/agent-tools.md` - Built-in tools reference
- `docs/child-context.md` - Child process context and IPC design (Chinese)
- `docs/database-schema.md` - SQLite schema documentation (Chinese)
- `docs/dynamic-loading.md` - Tool/skill loading mechanism