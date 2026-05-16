---
name: tool-and-skill-development
description: >
  Use this skill when developing new tools or skills for the mycc project.
  Covers the two-phase workflow: prototype in .mycc/ directory first, then
  migrate to built-in (tools/, skills/) when approved.
  
  This is mycc-specific workflow. For general skill creation guidance, use
  the create-skill skill instead.
  
  Keywords: tool, skill, development, migrate, prototype, workflow, mycc.
keywords: [tool, skill, development, workflow, mycc]
---

# Tool and Skill Development Workflow

This skill documents the mycc-specific development workflow for tools and skills.

## Purpose

Use this skill when:
- Creating a new tool for mycc
- Creating a new skill for mycc
- Developing features that may become tools or skills

This workflow ensures quality through iterative testing before migration.

## Two-Phase Workflow

### Phase 1: Prototype in .mycc/

All new tools and skills start in the `.mycc/` directory for testing:

```
.mycc/
├── tools/           # Prototype tools
└── skills/          # Prototype skills
```

**Why prototype first?**
- Allows iterative testing
- User can provide feedback
- Prevents premature migration
- Keeps built-in tools/skills stable

### Phase 2: Migrate When Approved

Only migrate after user approval:

```
# Tools
mv .mycc/tools/tool-name.ts tools/

# Skills
mv .mycc/skills/skill-name skills/
```

**When to migrate:**
- User explicitly approves the tool/skill
- All tests pass
- Documentation is complete
- User agrees it's ready

## Tool Development Process

Tools follow the `ToolDefinition` interface pattern — a plain object with `name`, `description`, `input_schema`, `scope`, and `handler`.

### Step 1: Create Prototype

Create the tool in `.mycc/tools/` as a `.ts` file:

```typescript
// .mycc/tools/my-tool.ts
import type { ToolDefinition, AgentContext } from '../../src/types.js';

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Description for the tool — what it does and when to use it.',
  input_schema: {
    type: 'object',
    properties: {
      param1: {
        type: 'string',
        description: 'Description of param1',
      },
    },
    required: ['param1'],
  },
  // scope: where this tool is available
  //   ['main'] — only lead agent
  //   ['main', 'child'] — both lead and teammates
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const param1 = args.param1 as string;

    // Validate
    if (!param1) {
      return 'Error: param1 is required';
    }

    // Report via brief
    ctx.core.brief('info', 'my_tool', `Processing with param1: ${param1}`);

    // Implementation...
    const result = `Result: ${param1}`;
    return result;
  },
};
```

**Key rules:**
- The file must `export` a `ToolDefinition` object
- Use `name`, `description`, `input_schema`, `scope`, `handler`
- `scope`: `['main']` for lead-only, `['main', 'child']` for all agents
- `handler` signature: `(ctx: AgentContext, args: Record<string, unknown>) => Promise<string> | string`
- Always validate required parameters
- Use `ctx.core.brief()` for status updates

### Step 2: Test Iteratively

- Place the file in `.mycc/tools/` — it will be auto-loaded (hot-reload supported)
- Test the tool with various inputs
- Let user test and provide feedback
- Fix issues and improve
- Update documentation

### Step 3: Migrate When Approved

When user approves:

```bash
# Move tool file to built-in directory
mv .mycc/tools/my-tool.ts src/tools/

# Register in loader.ts:
# 1. Add import: import { myTool } from '../../tools/my-tool.js';
# 2. Add to builtInTools array
```

### Step 4: Register in Built-in

In `src/context/shared/loader.ts`:

1. Add the import at the top:
```typescript
import { myTool } from '../../tools/my-tool.js';
```

2. Add to the `builtInTools` array:
```typescript
const builtInTools: ToolDefinition[] = [
  // ... existing tools
  myTool,
];
```

## Skill Development Process

### Step 1: Create Prototype

Create in `.mycc/skills/skill-name/SKILL.md`:

```markdown
---
name: skill-name
description: >
  Detailed description for RAG search...
keywords: [tag1, tag2]
---

# Skill Title
...
```

### Step 2: Test Iteratively

- Load the skill with `skill_load`
- Test that it provides useful guidance
- Let user test and provide feedback
- Improve based on feedback

### Step 3: Migrate When Approved

When user approves:

```bash
mv .mycc/skills/skill-name skills/
```

### Step 4: Verify

Test that the skill loads correctly from the new location.

## Directory Structure

### Tools

```
.mycc/tools/          # Prototype tools (testing, auto-loaded, hot-reload)
├── my-tool.ts

src/tools/            # Built-in tools (stable, registered in loader.ts)
├── bash.ts
├── read_file.ts
├── ... (all built-in tools)
└── my-tool.ts        # (after migration)

src/context/shared/loader.ts  # Tool registration (builtInTools array)
```

### Skills

```
.mycc/skills/          # Prototype skills (testing, auto-loaded, hot-reload)
└── my-skill/
    └── SKILL.md

skills/                # Built-in skills (stable)
├── create-skill/
│   └── SKILL.md
└── coordination/
    └── SKILL.md

~/.mycc-store/skills/  # User-level skills (shared across projects)
└── my-global-skill/
    └── SKILL.md
```

## Checklist for Migration

Before migrating from `.mycc/` to built-in:

- [ ] User has tested and approved
- [ ] All functionality works correctly
- [ ] Documentation is complete
- [ ] Code follows project conventions
- [ ] No known issues or bugs

## Common Pitfalls

### Pitfall 1: Migrating Too Early

**Problem:** Tool/skill has bugs, user hasn't tested enough.

**Solution:** Wait for explicit user approval. Test thoroughly in `.mycc/` first.

### Pitfall 2: Forgetting to Register

**Problem:** Tool/skill is moved but not registered in index.

**Solution:** Always update the appropriate `index.ts` or verify loading.

### Pitfall 3: Breaking Imports

**Problem:** Moving files breaks import paths.

**Solution:** Update all import paths after migration. Test that everything still works.

## Summary

The mycc development workflow:
1. **Prototype** in `.mycc/` (tools or skills)
2. **Test** iteratively with user feedback
3. **Migrate** to built-in only when approved
4. **Register** in appropriate index file
5. **Verify** everything works after migration

This ensures quality and stability while allowing rapid iteration during development.