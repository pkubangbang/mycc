# mycc

Node.js coding agent implementation using Ollama for LLM inference.

## Features

- **Agent Context Pattern**: Modular state container with core, todo, mail, skill, issue, bg, wt, and team modules
- **STAR Principle Loop**: Situation → Task → Action → Result cycle for agent execution
- **Child Process Teammates**: Teammates run as child processes via `fork()` with IPC message routing
- **Dynamic Loading**: Tools loaded from `src/tools/` (built-in) and `.mycc/tools/` (user-defined with hot-reload)
- **SQLite Persistence**: Issues, teammates, and worktrees stored in `.mycc/state.db`

## Quick Start

```bash
pnpm install        # Install dependencies
pnpm start          # Run the agent
```

## Environment Setup

Copy `.env.example` to `.env` and configure:

- `OLLAMA_HOST` - Ollama server URL (default: http://127.0.0.1:11434)
- `OLLAMA_MODEL` - Model name (default: glm-5:cloud)
- `OLLAMA_API_KEY` - API key for cloud models (optional)

## Commands

```bash
pnpm install        # Install dependencies
pnpm start          # Run the agent (src/index.ts)
pnpm typecheck      # TypeScript type checking
pnpm build          # Compile to dist/
pnpm format          # Format with Prettier
```

## Architecture

### AgentContext Pattern

All tools receive an `AgentContext` object containing state modules:

```
AgentContext
├── core      - Work directory and logging
├── todo      - Temporary checklist
├── mail      - Async mailbox
├── skill     - Skill loading
├── issue     - Persisted tasks with blocking
├── bg        - Background bash tasks
├── wt        - Git worktree management
├── team      - Child process teammates
└── transcript - Chat history logging
```

### Tools Reference

| Tool | Scope | Description |
|------|-------|-------------|
| bash | main, child, bg | Run shell commands |
| read_file | main, child, bg | Read file contents |
| write_file | main, child, bg | Write content to file |
| edit_file | main, child, bg | Replace text in file |
| brief | main, child | Display status message |
| question | main, child | Ask user for input |
| mail_to | main, child | Send async message to teammate/lead |
| broadcast | main | Broadcast to all teammates |
| issue_create | main, child | Create new issue |
| issue_claim | main, child | Claim an issue |
| issue_close | main, child | Close an issue |
| issue_comment | main, child | Add comment to issue |
| blockage_create | main, child | Create blocking relationship |
| blockage_remove | main, child | Remove blocking relationship |
| tm_create | main | Create teammate (child process) |
| tm_remove | main | Remove teammate |
| tm_await | main | Wait for teammate(s) |
| todo_write | main, child | Update todo list |
| skill_load | main, child | Load skill by name |

### Key Concepts

1. **Agent Loop (STAR principle)**: Situation → Task → Action → Result cycle with:
   - Mail collection at each iteration
   - Todo nudging every 3 turns
   - Auto-compact when tokens exceed threshold
   - Bounce pattern to wait for teammates

2. **Child Process Teammates**: Teammates run as child processes via `fork()`. Lead acts as IPC broker routing all messages between teammates.

3. **Dynamic Loading**: Tools loaded from `src/tools/` (built-in) and `.mycc/tools/` (user-defined with hot-reload). Skills loaded from `.mycc/skills/*.md` with YAML frontmatter.

4. **SQLite Persistence**: Issues, teammates, and worktrees stored in `.mycc/state.db`. Lead process handles all DB access.

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

## Adding a Tool

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

Skills are hot-reloaded when files change.

## Database Schema

SQLite tables in `.mycc/state.db`:

- `issues` - Persisted tasks with blocking relationships
- `teammates` - Team member state
- `worktrees` - Git worktree records

See `src/context/db.ts` for schema definitions.

## License

MIT