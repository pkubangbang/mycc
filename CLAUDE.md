# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js coding agent implementation using Ollama for LLM inference. The architecture follows a modular design with AgentContext as the central state container.

## Setup

Refer to `README.md` for instructions.

Prefer using pnpm instead of npm. The only exception is `pnpm build && npm link` to install the mycc.

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

At the core is the llm inference and tool-using capability provided by ollama api. We call this `the model` or `llm`.

Then an `agent loop` wraps the llm to enable multi-round chat. For each round the llm will receive information from the tool result or the user's input (be it sent in direct or on behalf) and take actions to either use tool or respond with text, the latter will end the loop and come back to the prompt. The agent loop consist of `the routine` and `the repl`: routine is some pre-defined steps to take in each round, while the repl is the prompt.

The agent loop cannot finish tasks on its own; it must use `tools`. Tools are well-structured functions with schema definition that calls `the agent context` behind the scene. Besides tools, there are `skills`, which are instructions written as markdown files, to provide specialist knowledge that the llm can follow.

There are in total of 3 ways to extend (or distract!) the capabilities of the agent: tools, skills, and slash-commands. While the first two are llm-facing, `slash commands` are user-facing: user can type commands to directly talk to the agent context, for example using `/team` to get a peek of the teammates and their states.

To make the chat *roughly* recoverable, we introduced the concept of `session`. There are in total two types of sessions: `project session` and `user session`. Project sessions are persisted as a metadata file inside `current working directory`, while user sessions are inside the user's home dir, to be specific, `~/.mycc-store/sessions`.

The same hierachical design can also be found at `user skills` vs `project skills` vs `built-in tools`, and `user tools` vs `project tools` vs `built-in tools`. 

## The agent context

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

## Tool Development Guidelines

**Fail Early**: Tools should fail early and explicitly rather than silently degrading or continuing with partial functionality. This is a golden rule for agent tool development:

- If a tool requires a dependency (e.g., ImageMagick for image processing), fail immediately if it's not available rather than proceeding with degraded functionality
- If an operation fails (e.g., resize needed but unsuccessful), throw an error rather than falling back to potentially problematic behavior
- Explicit errors help the agent understand what went wrong and take corrective action, while silent degradation can lead to confusing or incorrect results

Example: The `imgDescribe` method requires ImageMagick to check image dimensions. If unavailable, it throws an error immediately rather than proceeding with potentially oversized images that could fail downstream.

**Errors as Hints, Not Failures**: In agent tool development, errors should be treated as hints for the agent to try alternative approaches, not as terminal failures. Design tools to fail fast with clear error messages that enable the agent to pivot.

Example: The bash tool uses `setsid` to run subprocesses in a new session without a controlling terminal. This prevents `/dev/tty` access, which means interactive programs (git password prompts, ssh, vim) will fail with clear errors. This is intentional - the agent receives an error like "not a terminal" and can try a different approach (e.g., use SSH keys instead of password auth, use a different tool). This "fail fast" approach prevents subtle terminal corruption issues and gives the agent clear signals to adapt its strategy.

To add a skill:
1. refer to existing files in skills/ to get pattern.
2. create file in `.mycc/skills` folder. This is a hot-reloadable folder
3. let the user test it manually, and iterate from feedbacks.
4. once qualified, migrate it back into `skills/`, to make it built-in.

## How to test this app

Use tmux to simulate interactive terminal sessions for testing the agent loop, REPL, and user interactions.

```bash
# Create session with specific dimensions
tmux new-session -s mycc-test -d -x 80 -y 24

# Send keys to running app
tmux send-keys -t mycc-test "/help" Enter

# Capture pane output for assertions
tmux capture-pane -t mycc-test -p

# Resize pane to test different screen sizes
tmux resize-pane -t mycc-test -x 80 -y 24   # standard terminal
tmux resize-pane -t mycc-test -x 40 -y 12   # small/mobile view

# Kill session when done
tmux kill-session -t mycc-test
```

See `docs/line-editor-tests.md` for LineEditor-specific test cases.

## Reference Documents

### Core Architecture
- `docs/agent-context.md` - AgentContext module documentation (Chinese)
- `docs/agent-loop.md` - Agent loop implementation details (Chinese)
- `docs/agent-tools.md` - Built-in tools reference
- `docs/child-context.md` - Child process context and IPC design (Chinese)
- `docs/dynamic-loading.md` - Tool/skill loading mechanism

### Persistence & State
- `docs/database-schema.md` - SQLite schema documentation (Chinese)
- `docs/how-to-restore-the-session.md` - Session management and restoration
- `docs/how-to-build-persistent-memory.md` - Vector store and RAG implementation
- `docs/session-isolation-plan.md` - Session isolation design and implementation

### Team & IPC
- `docs/teammate-status.md` - Teammate status state machine
- `docs/how-to-handle-child-questions.md` - IPC question handling between main and child processes
- `docs/how-to-handle-team-coordination.md` - Team coordination patterns
- `docs/ipc-ioc.md` - IPC inversion of control pattern (Chinese)

### Agent Behavior
- `docs/confusion-index.md` - Confusion index for detecting stuck agents (Chinese)
- `docs/neglected-mode.md` - Neglected mode for handling unresponsive agents

### Tools & Utilities
- `docs/read-read-tool.md` - Long content summarization tool

### User Documentation
- `docs/user-manual-20260408.md` - End-user manual

### Archived
See `docs/archived/` for historical documentation (line-editor-tests, migration guides, deprecated features).
