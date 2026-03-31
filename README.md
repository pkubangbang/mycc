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
└── team      - Child process teammates
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
│   └── [module].ts    # Individual modules
├── tools/
│   ├── bash.ts        # Shell commands
│   ├── read.ts        # File reading
│   ├── write.ts       # File writing
│   └── edit.ts        # File editing
└── loop/
    └── agent-loop.ts  # STAR-principle loop

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