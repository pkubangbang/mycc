# Dynamic Tool and Skill Loading

## Overview

The AgentContext architecture supports dynamic loading of tools and skills with hot-reload capability. This allows adding or modifying tools and skills without restarting the agent.

## Tool Loading

### Built-in Tools

Built-in tools are TypeScript files in `src/tools/` that export a `ToolDefinition` object. They are loaded automatically when the agent starts.

**Example (`src/tools/bash.ts`):**
```typescript
import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Run a shell command (blocking).',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
    },
    required: ['command'],
  },
  scope: ['main', 'child', 'bg'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const command = args.command as string;
    // ... implementation
    return result;
  },
};
```

### ToolDefinition Interface

```typescript
interface ToolDefinition {
  name: string;                    // Unique identifier
  description: string;             // Description for LLM
  input_schema: {                  // JSON Schema for parameters
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  scope: string[];                 // Contexts where tool is available
  handler: (ctx: AgentContext, args: Record<string, unknown>) => string | Promise<string>;
}
```

### Tool Scope

Tools can be available in different contexts:
- `main` - Lead agent
- `child` - Teammate agents
- `bg` - Background task agents

### Handler Signature

The handler receives:
- `ctx: AgentContext` - The agent context with all modules (core, todo, mail, skill, issue, bg, wt, team)
- `args: Record<string, unknown>` - Parsed arguments from LLM tool call

Returns: `string` (or `Promise<string>`)

## Skill Loading

### Skill Files

Skills are Markdown files in `.mycc/skills/` with YAML frontmatter.

**Example (`.mycc/skills/git.md`):**
```markdown
---
name: git
description: Git version control operations
keywords: [git, version, control, commit, branch]
---

# Git Skill

Git is a distributed version control system...

## Common Commands
...
```

### Skill Interface

```typescript
interface Skill {
  name: string;        // Unique identifier
  description: string; // Short description
  keywords: string[];  // Keywords for matching
  content: string;     // Full skill content (markdown)
}
```

### Loading Skills

Skills are loaded by the `SkillLoader` class:
1. Reads all `.md` files from `.mycc/skills/`
2. Parses YAML frontmatter using `gray-matter`
3. Stores in memory map for fast access

## Hot-Reload Mechanism

### File Watching

The loader uses Node.js `fs.watch()` to monitor directories:

```typescript
watchDirectories(): void {
  const toolsDir = getToolsDir();
  const skillsDir = getSkillsDir();

  // Watch tools directory
  this.toolWatcher = watch(toolsDir, async (event, filename) => {
    if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
      const filepath = path.join(toolsDir, filename);
      console.log(`[loader] Reloading tool: ${filename}`);
      await this.reloadTool(filepath);
    }
  });

  // Watch skills directory
  this.skillWatcher = watch(skillsDir, (event, filename) => {
    if (filename && filename.endsWith('.md')) {
      const filepath = path.join(skillsDir, filename);
      console.log(`[loader] Reloading skill: ${filename}`);
      this.reloadSkill(filepath);
    }
  });
}
```

### Cache Busting for Tools

Dynamic tool imports use cache-busting to ensure fresh code is loaded:

```typescript
const module = await import(`${pathToFileURL(filepath).href}?t=${Date.now()}`);
```

This adds a timestamp query parameter to force Node.js to reload the module.

## Loading Order

1. **Built-in tools** are loaded first from `src/tools/`
2. **Dynamic tools** are loaded second from `.mycc/tools/`
3. Dynamic tools can override built-in tools with the same name

This allows users to customize behavior without modifying source code.

## Directory Structure

```
.mycc/
├── state.db           # SQLite database
├── mail/              # Append-only mailboxes
│   ├── lead.jsonl
│   └── <name>.jsonl
├── tools/             # Dynamic tools (optional)
│   └── custom.ts      # Can override built-in tools
└── skills/            # Skill definitions
    ├── git.md
    └── testing.md
```

## Usage in Agent Loop

```typescript
// Create loader
const loader = createLoader();
await loader.loadAll();
loader.watchDirectories();

// Create tool loader
const toolLoader = createToolLoader(loader);

// In agent loop
const tools = toolLoader.getToolsForScope('main');
const result = await toolLoader.execute('bash', ctx, { command: 'ls' });
```

## Adding a New Tool

### Option 1: Built-in Tool

1. Create `src/tools/my_tool.ts`:
```typescript
import type { ToolDefinition, AgentContext } from '../types.js';

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: '...',
  input_schema: { ... },
  scope: ['main'],
  handler: (ctx, args) => { ... },
};
```

2. Import and add to `builtInTools` in `src/context/loader.ts`

### Option 2: Dynamic Tool

1. Create `.mycc/tools/my_tool.ts`:
```typescript
import type { ToolDefinition, AgentContext } from '../../src/types.js';

export default {
  name: 'my_tool',
  description: '...',
  input_schema: { ... },
  scope: ['main'],
  handler: (ctx, args) => { ... },
} as ToolDefinition;
```

2. The tool will be auto-loaded on next restart or hot-reload.

## Adding a New Skill

1. Create `.mycc/skills/my_skill.md`:
```markdown
---
name: my_skill
description: What this skill does
keywords: [keyword1, keyword2]
---

# My Skill

Detailed instructions for the LLM...
```

2. The skill will be auto-loaded on next restart or hot-reload.

## Tool Execution Flow

```
LLM Response
    │
    ▼
Tool Call (name, arguments)
    │
    ▼
ToolLoader.execute(name, ctx, args)
    │
    ├── Get tool definition
    │
    ├── Validate arguments against schema
    │
    ├── Call tool.handler(ctx, args)
    │
    ▼
Return result string
```