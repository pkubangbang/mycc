# mycc

Node.js coding agent implementation using Ollama for LLM inference.

## Features

- **Agent Context Pattern**: Modular state container with core, todo, mail, issue, bg, wt, and team modules
- **STAR Principle Loop**: Situation → Task → Action → Result cycle for agent execution
- **Child Process Teammates**: Teammates run as child processes via `fork()` with IPC message routing
- **Dynamic Loading**: Tools loaded from `src/tools/` (built-in) and `.mycc/tools/` (user-defined with hot-reload)
- **SQLite Persistence**: Issues, teammates, and worktrees stored in `.mycc/state.db`

## Quick Start

```bash
pnpm install        # Install dependencies
pnpm start          # Run the agent
pnpm typecheck      # TypeScript type checking
pnpm build          # Compile to dist/
pnpm format         # Format with Prettier
```

### Running with Options

**Verbose mode** (show debug output):
```bash
pnpm start -- -v
pnpm start -- --verbose
```

**Load a saved session**:
```bash
pnpm start -- --session <session-id>
```

**Skip health check** (faster startup):
```bash
pnpm start -- --skip-healthcheck
```

**Override environment variables**:
```bash
# Use a different model
OLLAMA_MODEL=llama3.2 pnpm start

# Connect to remote Ollama server
OLLAMA_HOST=https://api.ollama.com pnpm start

# Adjust context threshold
TOKEN_THRESHOLD=30000 pnpm start
```

**Install globally** (run `mycc` from anywhere):
```bash
pnpm build && npm link
mycc                    # Run from any directory
mycc -v                 # Verbose mode
OLLAMA_MODEL=qwen2.5 mycc  # With env override
```

## Environment Setup

Copy `.env.example` to `.env` and configure:

- `OLLAMA_HOST` - Ollama server URL (default: http://127.0.0.1:11434)
- `OLLAMA_MODEL` - Model name (default: glm-5:cloud)
- `OLLAMA_API_KEY` - API key for cloud models (optional)

## Architecture

### AgentContext Pattern

All tools receive an `AgentContext` object containing state modules. See `docs/agent-context.md` for detailed module documentation.

```
AgentContext
├── core      - Work directory, logging, questions
├── todo      - Temporary checklist
├── mail      - Async mailbox
├── issue     - Persisted tasks with blocking
├── bg        - Background bash tasks
├── wt        - Git worktree management
└── team      - Child process teammates
```

### Tools Reference

See `docs/agent-tools.md` for complete tool documentation.

| Tool | Scope | Description |
|------|-------|-------------|
| bash | main, child, bg | Run shell commands |
| read_file | main, child | Read file contents |
| write_file | main, child | Write content to file |
| edit_file | main, child | Replace text in file |
| brief | main, child | Display status message |
| question | main, child | Ask user for input |
| mail_to | main, child | Send async message to teammate/lead |
| broadcast | main | Broadcast to all teammates |
| issue_create | main, child | Create new issue |
| issue_list | main, child | List all issues |
| issue_claim | main, child | Claim an issue |
| issue_close | main, child | Close an issue |
| issue_comment | main, child | Add comment to issue |
| blockage_create | main, child | Create blocking relationship |
| blockage_remove | main, child | Remove blocking relationship |
| tm_create | main | Create teammate (child process) |
| tm_remove | main | Remove teammate |
| tm_await | main | Wait for teammate(s) |
| tm_print | main, child | Print team status |
| bg_create | main, child | Run background command |
| bg_print | main, child | List background tasks |
| bg_remove | main, child | Kill background task |
| bg_await | main, child | Wait for background tasks |
| wt_create | main, child | Create git worktree |
| wt_print | main, child | List worktrees |
| wt_enter | main, child | Switch to worktree |
| wt_leave | main, child | Leave worktree |
| wt_remove | main, child | Remove worktree |
| todo_write | main, child | Update todo list |
| skill_load | main, child | Load skill by name |
| screen | main, child | Capture and describe screen |
| web_search | main, child | Web search |
| web_fetch | main, child | Fetch web content |

### Key Concepts

See the following documentation for detailed explanations:

- **Agent Loop**: `docs/agent-loop.md` - STAR principle, microCompact, autoCompact, todo nudging
- **Child Process Teammates**: `docs/child-context.md` - IPC, state machine, auto-claim
- **Dynamic Loading**: `docs/dynamic-loading.md` - Hot-reload, tool scopes, skill format
- **SQLite Persistence**: `docs/database-schema.md` - Tables, WAL mode, transactions

## File Structure

```
src/
├── index.ts              # Entry point
├── types.ts              # All type definitions
├── ollama.ts             # Ollama client config
├── context/
│   ├── index.ts          # AgentContext factory
│   ├── db.ts             # SQLite setup
│   ├── loader.ts         # Dynamic tool/skill loader
│   ├── core.ts           # Work directory, logging, questions
│   ├── todo.ts           # Temporary checklist
│   ├── mail.ts           # Async mailbox
│   ├── issue.ts          # Persisted tasks with blocking
│   ├── bg.ts             # Background bash tasks
│   ├── wt.ts             # Git worktree management
│   ├── team.ts           # Child process teammates
│   ├── teammate-worker.ts # Child process entry point
│   └── child-context/    # Child process IPC wrappers
├── tools/                # Built-in tools (33 tools)
│   ├── bash.ts           # Shell commands
│   ├── read.ts, write.ts, edit.ts  # File operations
│   ├── brief.ts, question.ts  # User interaction
│   ├── mail_to.ts, broadcast.ts  # Inter-agent messaging
│   ├── issue_*.ts        # Issue management
│   ├── tm_*.ts           # Team management
│   ├── bg_*.ts           # Background tasks
│   ├── wt_*.ts           # Worktree management
│   ├── todo_write.ts     # Todo list updates
│   ├── skill_load.ts     # Load skill by name
│   ├── screen.ts         # Screen capture
│   └── web_*.ts          # Web search/fetch
└── loop/
    ├── agent-loop.ts     # STAR-principle loop
    ├── agent-prompts.ts  # System prompt building
    ├── agent-io.ts       # Terminal I/O handling
    ├── triologue.ts      # Conversation management
    └── slashes/          # Slash command handlers

.mycc/                    # Runtime data (gitignored)
├── state.db              # SQLite database
├── mail/                 # Mailboxes
├── tools/                # User tools (optional)
└── skills/               # Skill definitions
```

## Adding a Tool

See `docs/dynamic-loading.md` for the complete tool loading mechanism and `skills/add-tool/SKILL.md` for step-by-step instructions.

Built-in tools go in `src/tools/`:

```typescript
// src/tools/my_tool.ts
import type { ToolDefinition, AgentContext } from '../types.js';

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Description for LLM',
  input_schema: {
    type: 'object',
    properties: {
      arg: { type: 'string', description: '...' },
    },
    required: ['arg'],
  },
  scope: ['main', 'child'],  // Where tool is available
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const arg = args.arg as string;
    ctx.core.brief('info', 'my_tool', `executing: ${arg}`);
    return `Result: ${arg}`;
  },
};
```

Then import and add to the `builtInTools` array in `src/context/loader.ts`.

## Adding a Skill

Create `.mycc/skills/my_skill.md`:

```markdown
---
name: my_skill
description: What this skill does
keywords: [keyword1, keyword2]
---

# My Skill

Detailed instructions for the LLM...
```

Skills are hot-reloaded when files change. See `docs/dynamic-loading.md` for details.

## Database Schema

SQLite tables in `.mycc/state.db`:

- `issues` - Persisted tasks with blocking relationships
- `issue_blockages` - Blocking relationships between issues
- `teammates` - Team member state
- `worktrees` - Git worktree records

See `docs/database-schema.md` for complete schema documentation.

## License

MIT