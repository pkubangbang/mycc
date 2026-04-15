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

To make the chat *roughly* recoverable, we introduced the concept of `session`. There are in total two types of sessions: `project session` and `user session`. Project sessions are persisted as a metadata file inside `current working directory`, while user sessions are inside the user's home dir, to be specific, `~/.mycc/sessions`.

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

To add a skill:
1. refer to existing files in skills/ to get pattern.
2. create file in `.mycc/skills` folder. This is a hot-reloadable folder
3. let the user test it manually, and iterate from feedbacks.
4. once qualified, migrate it back into `skills/`, to make it built-in.

## Reference Documents

- `docs/agent-context.md` - AgentContext module documentation (Chinese)
- `docs/agent-loop.md` - Agent loop implementation details (Chinese)
- `docs/agent-tools.md` - Built-in tools reference
- `docs/child-context.md` - Child process context and IPC design (Chinese)
- `docs/database-schema.md` - SQLite schema documentation (Chinese)
- `docs/dynamic-loading.md` - Tool/skill loading mechanism
