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
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const command = args.command as string;
    // ... implementation
    return result;
  },
};
```

### Custom Tools

Custom tools come from two layers:
- **User tools** (`~/.mycc-store/tools/`) — loaded at startup, not watched for changes
- **Project tools** (`.mycc/tools/` relative to cwd) — loaded dynamically at startup and hot-reloaded when files change

User tools cannot shadow project or built-in tools; project tools cannot shadow built-in tools.

### Tool Scope

Tools can be available in different contexts:
- `main` - Lead agent
- `child` - Teammate agents

## Skill Loading

### Skill Sources

Skills are loaded from three sources in priority order (later can shadow earlier):

1. **User skills** (`~/.mycc-store/skills/`)
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
  when?: string;       // Natural language hook condition (optional)
  sourceFile?: string; // Source file path (format: "layer:path")
}
```

## Hot-Reload

Only project directories are watched:
- `.mycc/tools/` - Project tools
- `.mycc/skills/` - Project skills (recursive, including subdirectories)

User tools/skills and built-in content are static and not watched. File watches are debounced (300ms) to handle multiple events per save.

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
- `execute(name, ctx, args, signal?)` - Execute a tool
- `loadSkills()` - Load all skills (deprecated — use loadAll() instead)
- `getSkill(name)` - Get a skill by name
- `listSkills()` - List all skills (without content)
- `getSkillKeywords()` - Get deduplicated, sorted list of all skill keywords
- `compileCondition(skillName, feedback?)` - Compile a skill's "when" condition into a hook
- `indexAllSkillsToWiki(wiki)` - Index all skills into wiki for semantic search

A singleton instance is exported as `loader` from `src/context/shared/loader.ts`.

## Skill Discovery

Skills are discovered by the LLM through two tools:
- `skill_search(search="<keywords>")` — Search skills by keywords (semantic + name/keyword matching). Use when you don't know the exact skill name.
- `skill_load(name="<exact_name>")` — Load a skill by exact name and return its full content. If the skill is not found, lists available skills.

The system prompt includes a "Knowledge Boundary" section that teaches the LLM to recognize knowledge gaps and actively seek skills when needed.