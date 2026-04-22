# CLAUDE.md

This file provides guidance for Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js coding agent implementation using Ollama for LLM inference. The architecture follows a modular design with AgentContext as the central state container.

## Setup

Refer to `README.md` for instructions.

Prefer using pnpm instead of npm. The only exception is `npm link` to install the mycc globally.

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

Use eslint for linting issues (you MUST do it before commit):

```bash
npx eslint src/loop/agent-loop.ts src/loop/agent-repl.ts
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