# Dynamic Tool and Skill Loading

## Overview

The `Loader` class provides unified loading of tools and skills with hot-reload capability for dynamic content. It implements `DynamicLoader`, `ToolLoader`, and `SkillModule` interfaces.

## Loader Class

The `Loader` class (in `src/context/loader.ts`) is the single entry point for loading:

```typescript
const loader = createLoader();
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

Skills are loaded from two sources:

1. **Built-in skills** (`skills/` directory relative to package root)
   - Loaded once at startup
   - Not watched for changes

2. **Custom skills** (`.mycc/skills/` relative to cwd)
   - Loaded at startup
   - Hot-reloaded when files change

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

Only dynamic directories are watched:
- `.mycc/tools/` - Custom tools
- `.mycc/skills/` - Custom skills

Built-in content (`src/tools/` imports and `skills/` directory) is static and not watched.

## Usage in AgentContext

The loader is passed to `createAgentContext` as the skill module:

```typescript
const loader = createLoader();
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
- `printSkills()` - Format skills for prompt