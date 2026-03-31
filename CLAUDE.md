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
└── team      - Child process teammates (team.ts)
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

## Reference Documents

- `docs/agent-context.md` - AgentContext module documentation (Chinese)
- `docs/agent-loop.md` - Agent loop implementation details (Chinese)
- `docs/dynamic-loading.md` - Tool/skill loading mechanism
- `docs/s11-design.md` - Reference architecture for child process teammates