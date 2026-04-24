# Dynamic Tool and Skill Loading

## Overview

The `Loader` class provides unified loading of tools and skills with hot-reload capability for dynamic content. It implements `DynamicLoader`, `ToolLoader`, and `SkillModule` interfaces.

## Loader Class

The `Loader` class (in `src/context/shared/loader.ts`) is the single entry point for loading:

```typescript
const loader = new Loader();
await loader.loadAll();      // Load all tools and skills
loader.watchDirectories();   // Watch for changes (hot-reload)
loader.stopWatching();       // Cleanup on shutdown
```

## Tool Loading

### Built-in Tools

Built-in tools are imported directly in `loader.ts` and loaded at startup. They cannot be hot-reloaded.

**Example (`src/tools/bash.ts`):**
```typescript
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

### Custom Tools

Custom tools are stored in `.mycc/tools/` (relative to where `mycc` command starts). They are:
- Loaded dynamically at startup
- Hot-reloaded when files change

### Tool Scope

Tools can be available in different contexts:
- `main` - Lead agent
- `child` - Teammate agents
- `bg` - Background task agents

## Skill Loading

### Skill Sources

Skills are loaded from three sources in priority order (later can shadow earlier):

1. **User skills** (`~/.mycc/skills/`)
   - Loaded at startup
   - Not watched for changes
   - Lowest priority (can be shadowed)

2. **Project skills** (`.mycc/skills/` relative to cwd)
   - Loaded at startup
   - Hot-reloaded when files change
   - Medium priority

3. **Built-in skills** (`skills/` directory relative to package root)
   - Loaded once at startup
   - Not watched for changes
   - Highest priority (cannot be shadowed)

### Skill Files

Skills are Markdown files with YAML frontmatter:
- `skills/${name}.md` - Single file skill
- `skills/${name}/SKILL.md` - Skill with folder structure

**Example:**
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

## Hot-Reload

Only project directories are watched:
- `.mycc/tools/` - Project tools
- `.mycc/skills/` - Project skills

User tools/skills and built-in content are static and not watched.

## Usage in AgentContext

The loader is passed to `createAgentContext` as the skill module:

```typescript
const loader = new Loader();
await loader.loadAll();
loader.watchDirectories();

const ctx = createAgentContext(process.cwd(), loader);
```

The `Loader` instance provides:
- `getToolsForScope(scope)` - Get tools formatted for LLM API
- `execute(name, ctx, args)` - Execute a tool
- `loadSkills()` - Load all skills
- `getSkill(name)` - Get a skill by name
- `listSkills()` - List skills without content

## Skill Discovery

Skills are discovered by the LLM through the `skill_load` tool:
- `skill_load(name="list", intent="...")` - List all available skills
- `skill_load(name="<name>", intent="...")` - Load a specific skill
- Partial names trigger semantic search using the `intent` parameter

The system prompt includes a "Knowledge Boundary" section that teaches the LLM to recognize knowledge gaps and actively seek skills when needed.