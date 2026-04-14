# mycc User Manual

**Version:** 1.0  
**Last Updated:** April 8, 2026

---

## Table of Contents

1. [Introduction](#introduction)
2. [Getting Started](#getting-started)
3. [Key Features](#key-features)
4. [Common Use Cases](#common-use-cases)
5. [Installation & Configuration](#installation--configuration)
6. [Command Reference](#command-reference)
7. [Tools Overview](#tools-overview)
8. [Troubleshooting](#troubleshooting)
9. [Technical Reference](#technical-reference)

---

## Introduction

### What is mycc?

mycc is a Node.js coding agent that uses Ollama for LLM (Large Language Model) inference. It acts as an intelligent assistant that can help you with various coding tasks - from file operations and code generation to managing complex multi-agent workflows.

### Why Use mycc?

- **Intelligent Automation**: Automate repetitive coding tasks with AI assistance
- **Multi-Agent Teamwork**: Spawn specialized teammates to work on parallel tasks
- **Persistent Task Management**: Track issues and todos across sessions
- **Git Integration**: Manage multiple worktrees for parallel development
- **Extensible**: Add custom tools and skills for your specific needs
- **Privacy-Focused**: Run locally with Ollama - no data sent to external servers

### Who Should Use This?

mycc is designed for:
- Software developers who want AI-assisted coding
- Teams working on complex projects that benefit from task decomposition
- Anyone interested in local LLM-based automation tools

---

## Getting Started

### Prerequisites

Before you begin, ensure you have:

1. **Node.js** (v18 or higher)
2. **pnpm** package manager
3. **Ollama** installed and running with a compatible model

### Quick Start

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd mycc
   pnpm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your preferred settings
   ```

3. **Start the Agent**
   ```bash
   pnpm start
   ```

4. **First Interaction**
   
   When you start mycc, you'll see a prompt where you can type commands or natural language requests. The agent will interpret your input and use appropriate tools to help you.

### Your First Task

Try asking mycc to help with something simple:

```
> Read the README.md file and summarize the project
```

The agent will use the `read_file` tool to read the file and provide a summary.

---

## Key Features

### 1. Agent Context Pattern

mycc uses a modular state container called `AgentContext` that manages:
- **Core**: Work directory, logging, and user interactions
- **Todo**: Temporary checklist for task tracking
- **Mail**: Async mailbox for inter-agent communication
- **Issue**: Persisted tasks with blocking relationships
- **Background**: Background bash tasks
- **Worktree**: Git worktree management
- **Team**: Child process teammates

### 2. STAR Principle Loop

The agent operates on the STAR principle:
- **S**ituation: Understand current progress and context
- **T**ask: Define goals clearly
- **A**ction: Execute appropriate tools
- **R**esult: Collect outcomes and iterate

### 3. Child Process Teammates

Spawn specialized teammates to work on parallel tasks:
- Each teammate runs as a separate child process
- Communicate via async mail system
- Different teammates can have different roles (coder, reviewer, tester, etc.)

### 4. Dynamic Tool Loading

- Built-in tools in `src/tools/` are always available
- User-defined tools in `.mycc/tools/` are hot-reloaded
- Skills in `.mycc/skills/` provide specialized knowledge

### 5. SQLite Persistence

All state is persisted in `.mycc/state.db`:
- Issues and blocking relationships
- Teammate status
- Worktree records

---

## Common Use Cases

### Use Case 1: File Exploration and Analysis

```
> Explore the src directory and explain the code structure
```

The agent will use `bash` to list files, `read_file` to examine code, and provide an explanation.

### Use Case 2: Managing Complex Tasks with Issues

```
> Create an issue to implement user authentication with blocking sub-issues
```

Use `issue_create` to break down complex work:
```json
{ "title": "Implement auth", "content": "User authentication system" }
{ "title": "Create user model", "content": "Database model for users" }
{ "title": "Add login endpoint", "content": "API endpoint for login" }
```

### Use Case 3: Parallel Development with Teammates

```
> Spawn a coder teammate to implement the feature and a reviewer to check the code
```

Use `tm_create` to create teammates:
```json
{ "name": "coder", "role": "developer", "prompt": "Implement feature X" }
{ "name": "reviewer", "role": "code reviewer", "prompt": "Review code quality" }
```

### Use Case 4: Background Tasks

```
> Run the build process in the background while I continue working
```

Use `bg_create` to run long commands:
```json
{ "command": "pnpm build" }
```

### Use Case 5: Git Worktree Management

```
> Create a new worktree for the feature branch
```

Use `wt_create` to isolate work:
```json
{ "name": "feature-x", "branch": "feature-x" }
```

---

## Installation & Configuration

### Environment Variables

Configure `.env` file with:

| Variable | Description | Default |
|----------|-------------|---------|
| `OLLAMA_HOST` | Ollama server URL | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Model name to use | `glm-5:cloud` |
| `OLLAMA_API_KEY` | API key for cloud models | (optional) |

### Directory Structure

```
mycc/
├── src/              # Source code
├── .mycc/            # Runtime data (gitignored)
│   ├── state.db      # SQLite database
│   ├── mail/         # Mailboxes
│   ├── tools/        # User-defined tools
│   └── skills/       # Skill definitions
├── skills/           # Built-in skills
├── docs/             # Documentation
└── dist/             # Compiled output
```

---

## Command Reference

### npm/pnpm Commands

| Command | Description |
|---------|-------------|
| `pnpm install` | Install dependencies |
| `pnpm start` | Run the agent |
| `pnpm build` | Compile TypeScript to dist/ |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm format` | Format code with Prettier |

### Slash Commands

mycc supports various slash commands for direct tool access:
- Type `/help` to see available commands
- Slash commands bypass the LLM and execute tools directly

---

## Tools Overview

### File Operations

| Tool | Description |
|------|-------------|
| `bash` | Run shell commands |
| `read_file` | Read file contents |
| `write_file` | Write content to file |
| `edit_file` | Replace text in file |

### Communication

| Tool | Scope | Description |
|------|-------|-------------|
| `brief` | main, child | Display status message to user |
| `question` | main, child | Ask user for input |
| `mail_to` | main, child | Send async message to teammate/lead |
| `broadcast` | main only | Send message to all teammates |

### Issue Management

| Tool | Description |
|------|-------------|
| `issue_create` | Create a new issue |
| `issue_claim` | Claim an issue to work on |
| `issue_close` | Close an issue |
| `issue_comment` | Add comment to issue |
| `blockage_create` | Create blocking relationship |
| `blockage_remove` | Remove blocking relationship |

### Team Management

| Tool | Scope | Description |
|------|-------|-------------|
| `tm_create` | main only | Create a teammate (child process) |
| `tm_remove` | main only | Remove a teammate |
| `tm_await` | main only | Wait for teammate(s) to finish |
| `tm_print` | all | Print team status |

### Background Tasks

| Tool | Description |
|------|-------------|
| `bg_create` | Run command in background |
| `bg_print` | List background tasks |
| `bg_remove` | Kill background task |
| `bg_await` | Wait for background tasks |

### Git Worktrees

| Tool | Description |
|------|-------------|
| `wt_create` | Create new worktree |
| `wt_print` | List worktrees |
| `wt_enter` | Switch to worktree |
| `wt_leave` | Leave current worktree |
| `wt_remove` | Remove worktree |

### Other Tools

| Tool | Description |
|------|-------------|
| `todo_write` | Update todo list |
| `skill_load` | Load skill by name |
| `screen` | Capture and describe screen |
| `web_search` | Search the web |
| `web_fetch` | Fetch web content |

---

## Troubleshooting

### Common Issues

#### Connection Failed to Ollama

**Symptoms**: "Failed to connect to Ollama" error

**Solutions**:
1. Ensure Ollama is running: `ollama serve`
2. Check `OLLAMA_HOST` in `.env`
3. Verify the URL is accessible: `curl http://127.0.0.1:11434/api/version`

#### Model Not Found

**Symptoms**: "Model not found" error

**Solutions**:
1. List available models: `ollama list`
2. Pull the model: `ollama pull <model-name>`
3. Update `OLLAMA_MODEL` in `.env`

#### SQLite Database Errors

**Symptoms**: Database locked or corrupted

**Solutions**:
1. Stop all mycc processes
2. Delete `.mycc/state.db` and `.mycc/state.db-wal`
3. Restart mycc (database will be recreated)

#### Child Process Teammates Not Responding

**Symptoms**: Teammates stuck in "working" status

**Solutions**:
1. Use `tm_print` to check status
2. Use `tm_remove` with `force: true` to terminate
3. Check for error messages in console

#### Token Limit Exceeded

**Symptoms**: "Token threshold exceeded" or auto-compact triggered frequently

**Solutions**:
1. The agent auto-compacts when tokens exceed threshold
2. If issues persist, reduce context length in conversations
3. Consider breaking tasks into smaller issues

---

## Technical Reference

### Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Lead Agent                        │
│  ┌─────────────────────────────────────────────┐   │
│  │              AgentContext                     │   │
│  │  ┌─────┬──────┬──────┬───────┬────┬────┬───┐ │   │
│  │  │core │ todo │ mail │ issue │ bg │ wt │tm │ │   │
│  │  └─────┴──────┴──────┴───────┴────┴────┴───┘ │   │
│  └─────────────────────────────────────────────┘   │
│                       │                             │
│              ┌────────┴────────┐                   │
│              ▼                 ▼                    │
│        ┌──────────┐     ┌──────────┐              │
│        │Teammate 1│     │Teammate 2│              │
│        │(child)   │     │(child)   │              │
│        └──────────┘     └──────────┘              │
└─────────────────────────────────────────────────────┘
```

### Tool Scope Constraints

| Agent Type | Available Tools |
|------------|-----------------|
| Lead (main) | All tools |
| Teammate (child) | Cannot use: `broadcast`, `tm_create`, `tm_remove`, `tm_await` |
| Background (bg) | Only: `bash`, `read_file`, `write_file`, `edit_file` |

### STAR Loop Implementation

The agent loop follows the STAR principle:

1. **Situation**: Collect mail messages and check todo nudging
2. **Task**: Build system prompt with current context
3. **Action**: Call LLM with available tools
4. **Result**: Execute tool calls and add results to message history

Key mechanisms:
- `microCompact()`: Merges consecutive tool results
- `autoCompact()`: LLM-based compression when exceeding token threshold
- Todo nudging: Reminds agent every 3 iterations about open todos

### Database Schema

SQLite tables in `.mycc/state.db`:

| Table | Purpose |
|-------|---------|
| `issues` | Persisted tasks with status, owner, content |
| `issue_blockages` | Blocking relationships between issues |
| `teammates` | Team member state and status |
| `worktrees` | Git worktree records |

### File Locations

| Path | Description |
|------|-------------|
| `src/tools/*.ts` | Built-in tool implementations |
| `.mycc/tools/*.ts` | User-defined tools (hot-reload) |
| `skills/*.md` | Built-in skill definitions |
| `.mycc/skills/*.md` | User-defined skills (hot-reload) |
| `.mycc/mail/*.jsonl` | Mailbox files for inter-agent communication |

---

## Appendix

### Adding Custom Tools

1. Create `.mycc/tools/my_tool.ts`:

```typescript
import type { ToolDefinition, AgentContext } from '../types.js';

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Description for LLM',
  input_schema: {
    type: 'object',
    properties: {
      arg: { type: 'string', description: 'Argument description' },
    },
    required: ['arg'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const arg = args.arg as string;
    return `Result: ${arg}`;
  },
};
```

2. The tool will be auto-loaded on next start (hot-reload supported)

### Adding Custom Skills

Create `.mycc/skills/my_skill.md`:

```markdown
---
name: my_skill
description: What this skill does
keywords: [keyword1, keyword2]
---

# My Skill

Detailed instructions for the LLM to follow...
```

Skills provide specialized knowledge to guide the agent's behavior.

---

## Support

For issues, questions, or contributions:
- Check the `docs/` directory for detailed documentation
- Review `CLAUDE.md` for development guidance
- Submit issues via the project repository

---

*This manual was generated for mycc - Node.js coding agent with Ollama LLM integration.*