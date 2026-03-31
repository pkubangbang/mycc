---
name: add-tool
description: Workflow for adding new tools to the coding agent
tags: tool, development, workflow, extension
---

# Adding a New Tool - Complete Workflow

This skill describes the complete workflow for adding a new tool to the coding agent system.

## Prerequisites: Understanding AgentContext

Before creating a tool, you must understand **AgentContext** - the context object passed to every tool handler.

### What is AgentContext?

`AgentContext` is an object that encapsulates all the state and utilities a coding agent needs:

```typescript
interface AgentContext {
  core: CoreModule;      // Work directory and logging
  todo: TodoModule;     // Temporary todo list
  team: TeamModule;     // Team collaboration
  mail: MailModule;     // Inter-agent messaging
  skill: SkillModule;   // Skill management
  issue: IssueModule;   // Persistent task tracking
  bg: BgModule;         // Background tasks
  wt: WtModule;         // Git worktree management
}
```

### Most Important: ctx.core.brief()

**Use `ctx.core.brief()` to output useful logs!** This is critical for user visibility.

```typescript
ctx.core.brief(
  'info' | 'warn' | 'error',  // Log level
  'tool_name',                 // Tool name (for colored prefix)
  'message'                   // Message to display
);
```

**Best Practices:**
- Log at the START of your tool handler (show what's being done)
- Include MEANINGFUL information, not just counts
- DON'T truncate important details
- Use appropriate log levels

**Example:**
```typescript
handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
  const filepath = args.path as string;
  const content = args.content as string;
  
  // Log what we're doing - include full details!
  ctx.core.brief('info', 'write_file', `Writing ${content.length} bytes to ${filepath}`);
  
  // ... implementation
}
```

### Other Context Modules

- **core.getWorkDir()**: Get current working directory
- **todo.patchTodoList()**: Update temporary todo list
- **mail.appendMail()**: Send message to self or teammates
- **skill.getSkill()**: Load a skill by name
- **issue.createIssue()**: Create persistent task
- **bg.runCommand()**: Run background bash command
- **wt.enterWorkTree()**: Switch to git worktree

---

## Phase 1: Prototype in .mycc/tools/

Create a dynamic tool for rapid testing and iteration.

### Step 1: Create Tool File

Create `.mycc/tools/<name>.ts`:

```typescript
import type { ToolDefinition, AgentContext } from '../../src/types.js';

export default {
  name: 'my_tool',
  description: 'Description that the LLM will see when deciding which tool to use',
  input_schema: {
    type: 'object',
    properties: {
      param1: {
        type: 'string',
        description: 'Description of this parameter',
      },
      param2: {
        type: 'integer',
        description: 'Another parameter',
      },
    },
    required: ['param1'],  // Mark required parameters
  },
  scope: ['main', 'child'],  // Where this tool is available
  
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    // Extract and validate arguments
    const param1 = args.param1 as string;
    const param2 = (args.param2 as number) || 0;
    
    // LOG WHAT YOU'RE DOING - This is critical for user visibility!
    ctx.core.brief('info', 'my_tool', `Processing ${param1} with value ${param2}`);
    
    try {
      // Implementation logic
      const result = doSomething(param1, param2);
      
      // Return result string (max 50,000 chars)
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'my_tool', err.message);
      return `Error: ${err.message}`;
    }
  },
} as ToolDefinition;
```

### Step 2: Test Dynamically

Dynamic tools are auto-loaded from `.mycc/tools/`:

```bash
# Start the agent - your tool will be loaded
npm run dev

# Or restart if already running
# The hot-reload mechanism will pick up changes automatically
```

### Step 3: Iterate Quickly

Make changes to your tool file:
- Hot-reload will automatically reload `.mycc/tools/*.ts` files
- Test with real inputs from the LLM
- Refine the description and parameters
- Add error handling as you discover edge cases

**Advantages of Dynamic Tools:**
- No rebuild needed (TypeScript compiled on-the-fly)
- Hot-reload for instant testing
- Can override built-in tools with same name
- Easy to experiment and iterate

---

## Phase 2: Migrate to Built-in Tool

Once your tool works well, migrate it to the built-in tools for better performance and integration.

### Step 1: Move to src/tools/

Copy your tool to `src/tools/my_tool.ts`:

```typescript
/**
 * my_tool.ts - Brief description
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Description for LLM',
  input_schema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Parameter description' },
      param2: { type: 'integer', description: 'Optional parameter' },
    },
    required: ['param1'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const param1 = args.param1 as string;
    const param2 = (args.param2 as number) || 0;
    
    ctx.core.brief('info', 'my_tool', `Processing ${param1}`);
    
    try {
      const result = doSomething(param1, param2);
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'my_tool', err.message);
      return `Error: ${err.message}`;
    }
  },
};
```

### Step 2: Register in loader.ts

Open `src/context/loader.ts` and add your tool to `builtInTools`:

```typescript
import { myTool } from '../tools/my_tool.js';

const builtInTools: ToolDefinition[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  todoWriteTool,
  skillLoadTool,
  myTool,  // Add your tool here
];
```

### Step 3: Build

```bash
npm run build
```

This compiles TypeScript to JavaScript in `dist/`.

### Step 4: Remove Dynamic Version

Delete the dynamic tool file (optional but recommended to avoid confusion):

```bash
rm .mycc/tools/my_tool.ts
```

---

## Phase 3: Document the Tool

Update `docs/agent-tools.md` with comprehensive documentation.

### Documentation Template

```markdown
## my_tool

**File**: `src/tools/my_tool.ts`

**Scope**: `['main', 'child']`

**Description**: One-line description of what the tool does.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| param1 | string | yes | Description of parameter |
| param2 | integer | no | Optional parameter, default value |

**Behavior**:
- Describe what the tool does
- Mention any validations or checks
- Describe error handling
- Mention any side effects
- Note any limitations (timeouts, size limits)

**Example**:
\`\`\`json
{
  "param1": "example value",
  "param2": 42
}
\`\`\`

**Error Cases**:
- Invalid input: returns "Error: ..."
- Permission denied: returns "Error: ..."
- Timeout: returns "Error: ..."
```

### Add to Available Tools List

Update the table of contents or tools list in `docs/agent-tools.md`.

---

## Best Practices

### 1. Logging with ctx.core.brief()

**DO:**
```typescript
// Log meaningful information with full details
ctx.core.brief('info', 'bash', command);  // Show full command
ctx.core.brief('info', 'todo_write', `${items.length} item(s) ${action}: ${summary}`);
```

**DON'T:**
```typescript
// Don't truncate important information
ctx.core.brief('info', 'bash', command.slice(0, 60));  // BAD: truncated
ctx.core.brief('info', 'todo_write', 'updated');      // BAD: no details
```

### 2. Error Handling

Always wrap your handler in try-catch:

```typescript
handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
  try {
    // Implementation
    return result;
  } catch (error: unknown) {
    const err = error as Error;
    ctx.core.brief('error', 'my_tool', err.message);
    return `Error: ${err.message}`;
  }
}
```

### 3. Input Validation

Validate and type-cast arguments:

```typescript
handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
  // Required parameter
  const required = args.required_param as string;
  if (!required) {
    return 'Error: required_param is required';
  }
  
  // Optional parameter with default
  const optional = (args.optional_param as number) || 10;
  
  // Type validation
  if (typeof required !== 'string') {
    return 'Error: required_param must be a string';
  }
}
```

### 4. Return Values

- Return strings (max 50,000 characters)
- Use structured format for complex data (JSON, tables)
- Include helpful error messages
- Don't return empty strings - use "(no output)" instead

### 5. Scope Selection

Choose appropriate scope for your tool:
- `['main', 'child', 'bg']` - Safe operations (bash, read)
- `['main', 'child']` - Most tools (write, edit)
- `['main']` - Sensitive operations (team management)

### 6. Description Writing

Write clear descriptions for the LLM:

```typescript
// BAD: Vague
description: 'Does stuff with files'

// GOOD: Specific and actionable
description: 'Read file contents from the workspace. Use this to examine existing files.'

// BAD: Missing context
description: 'Update todo list'

// GOOD: Complete with use case
description: 'Update the todo list with new items or modify existing items. Merges changes into the current todo list.'
```

---

## Tool Checklist

Before finalizing your tool, verify:

- [ ] Tool file created in correct location
- [ ] Exported with correct name (`export const myTool`)
- [ ] Registered in `builtInTools` array
- [ ] Comprehensive `ctx.core.brief()` logging added
- [ ] Error handling with try-catch
- [ ] Input validation and type casting
- [ ] Appropriate scope set
- [ ] Clear description for LLM
- [ ] JSON Schema for parameters complete
- [ ] Built with `npm run build`
- [ ] Documentation added to `docs/agent-tools.md`
- [ ] Examples provided
- [ ] Error cases documented
- [ ] Tested with real inputs

---

## Example: Complete Tool Implementation

Here's a complete example showing all best practices:

```typescript
/**
 * file_size.ts - Get file size in bytes
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import { statSync } from 'fs';
import { resolve, relative } from 'path';
import type { ToolDefinition, AgentContext } from '../types.js';

export const fileSizeTool: ToolDefinition = {
  name: 'file_size',
  description: 'Get the size of a file in bytes. Use this to check if a file exists and how large it is.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace',
      },
    },
    required: ['path'],
  },
  scope: ['main', 'child'],
  
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    // Extract and validate argument
    const filepath = args.path as string;
    
    if (!filepath || typeof filepath !== 'string') {
      ctx.core.brief('error', 'file_size', 'Missing or invalid path parameter');
      return 'Error: path parameter is required and must be a string';
    }
    
    // Log what we're doing
    ctx.core.brief('info', 'file_size', `Checking size of ${filepath}`);
    
    try {
      // Resolve path and validate it's within workspace
      const workDir = ctx.core.getWorkDir();
      const absolutePath = resolve(workDir, filepath);
      const relativePath = relative(workDir, absolutePath);
      
      if (relativePath.startsWith('..')) {
        ctx.core.brief('warn', 'file_size', `Path escape attempt: ${filepath}`);
        return 'Error: Path must be within workspace';
      }
      
      // Get file stats
      const stats = statSync(absolutePath);
      
      if (!stats.isFile()) {
        return `Error: ${filepath} is not a file`;
      }
      
      // Return result
      return `File ${filepath}: ${stats.size} bytes`;
      
    } catch (error: unknown) {
      const err = error as Error;
      
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        ctx.core.brief('warn', 'file_size', `File not found: ${filepath}`);
        return `Error: File not found: ${filepath}`;
      }
      
      ctx.core.brief('error', 'file_size', err.message);
      return `Error: ${err.message}`;
    }
  },
};
```

---

## Summary

The workflow for adding a new tool:

1. **Understand AgentContext** - Know what's available through `ctx`
2. **Prototype in .mycc/tools/** - Fast iteration with hot-reload
3. **Use ctx.core.brief()** - Log meaningful information for visibility
4. **Test thoroughly** - Validate inputs, handle errors, check edge cases
5. **Migrate to src/tools/** - Move to built-in for production
6. **Register in loader.ts** - Add to `builtInTools` array
7. **Build** - Run `npm run build`
8. **Document** - Update `docs/agent-tools.md`

This workflow ensures rapid development, good testing, and comprehensive documentation!