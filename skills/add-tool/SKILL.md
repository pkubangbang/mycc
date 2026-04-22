---
name: add-tool
description: >
  Use this BEFORE writing any new tool.

  Required for:
  - creating new tools
  - extending agent capabilities
  - adding custom functionality

  This skill MUST be used before any tool implementation.

  Relevant for:
  tool, create, add, new, implement, extend

  Example requests:
  - "add a new tool for X"
  - "create a tool that does Y"
  - "implement a custom tool"

  Do NOT start coding without using this skill first.
keywords: [tool, development, workflow, extension, required]
---

# Adding a New Tool

## Two-Phase Workflow

| Phase | Location | Purpose |
|-------|----------|---------|
| **1. Prototype** | `.mycc/tools/<name>.ts` | Rapid testing with hot-reload |
| **2. Migrate** | `src/tools/<name>.ts` | Built-in for production |

---

## Prerequisites

Ensure mycc is linked globally for type imports:

```bash
cd /path/to/mycc
pnpm install
npm link
```

This enables `import type { ToolDefinition } from 'mycc'` in your tools.

---

## Phase 1: Prototype in .mycc/tools/

Create a dynamic tool for rapid testing. Hot-reload is automatic.

### Template (`.mycc/tools/<name>.ts`)

```typescript
import type { ToolDefinition, AgentContext } from 'mycc';

export default {
  name: '<name>',
  description: 'What this tool does. Be specific for LLM.',
  input_schema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Parameter description' },
    },
    required: ['param1'],
  },
  scope: ['main', 'child'],

  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const param1 = args.param1 as string;
    if (!param1) return 'Error: param1 is required';

    ctx.core.brief('info', '<name>', `Processing ${param1}`);

    try {
      // Implementation
      return 'Success message';
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', '<name>', err.message);
      return `Error: ${err.message}`;
    }
  },
} as ToolDefinition;
```

### Test the Prototype

Let user test the tool manually, and iterate on feedback.
**You MUST NOT skip this step. Ask for grant to start Phase 2**.

---

## Phase 2: Migrate to Built-in

After user confirms prototype works, migrate to `src/tools/`.

### Step 1: Create Built-in Tool (`src/tools/<name>.ts`)

Move the file from `.mycc/tools/<name>.ts` to `src/tools`, and update imports accordingly.

### Step 2: Register in loader.ts

```typescript
// Add import at top
import { myTool } from '../tools/my_tool.js';

// Add to builtInTools array
const builtInTools: ToolDefinition[] = [
  bashTool,
  readTool,
  // ... other tools
  myTool,
];
```

### Step 3: Specify Tool Color (Optional)

In `src/context/core.ts`, add to `TOOL_COLORS`:

```typescript
const TOOL_COLORS: Record<string, (text: string) => string> = {
  // ... existing colors
  my_tool: chalk.cyan,
};
```

### Step 4: Update `docs/agent-tools.md`

Edit the `docs/agent-tools.md` to reflect the recent change.

---

## Key Points

### 1. ctx.core.brief() - ALWAYS Log

```typescript
// DO: Log meaningful info at start
ctx.core.brief('info', 'my_tool', `Processing ${param1}, ${param2}`);

// DON'T: Truncate or be vague
ctx.core.brief('info', 'my_tool', 'working');  // BAD
```

### 2. Scope Selection

| Scope | Use Case |
|-------|----------|
| `['main', 'child', 'bg']` | Safe read-only (bash, read) |
| `['main', 'child']` | Most tools (write, edit, mail) |
| `['main']` | Sensitive (team management) |

### 3. Export Difference

| Phase | Export Style |
|-------|--------------|
| Prototype (`.mycc/tools/`) | `export default { ... } as ToolDefinition` |
| Built-in (`src/tools/`) | `export const myTool: ToolDefinition = { ... }` |

### 4. Async Handlers

```typescript
handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
  const result = await ctx.team.createTeammate(name, role, prompt);
  return result;
}
```

---

## Checklist

### Phase 1: Prototype
- [ ] Created in `.mycc/tools/<name>.ts`
- [ ] Uses `export default { ... } as ToolDefinition`
- [ ] User tested manually
- [ ] Confirmed working

### Phase 2: Migrate
- [ ] Created in `src/tools/<name>.ts`
- [ ] Uses `export const myTool: ToolDefinition = { ... }`
- [ ] Import added to `loader.ts`
- [ ] Added to `builtInTools` array
- [ ] Color added to `core.ts` (optional)
- [ ] `pnpm typecheck` passes
- [ ] Prototype file deleted