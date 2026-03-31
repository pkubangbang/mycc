# Built-in Tools Reference

This document describes the built-in tools available to the coding agent. Tools are implemented in `src/tools/` and loaded at startup.

## Tool Interface

All tools conform to `ToolDefinition`:

```typescript
interface ToolDefinition {
  name: string;           // Unique identifier
  description: string;    // Description for LLM
  input_schema: {         // JSON Schema for parameters
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  scope: string[];       // Contexts: ['main', 'child', 'bg']
  handler: (ctx: AgentContext, args: Record<string, unknown>) => string | Promise<string>;
}
```

---

## bash

**File**: `src/tools/bash.ts`

**Scope**: `['main', 'child', 'bg']`

**Description**: Run a shell command (blocking).

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| command | string | yes | The shell command to execute |

**Behavior**:
- Executes command in the current working directory
- Blocks until completion (timeout: 120s)
- Output truncated to 50,000 characters
- Blocks dangerous commands: `rm -rf /`, `sudo`, `shutdown`, `reboot`

**Example**:
```json
{ "command": "ls -la" }
```

---

## read_file

**File**: `src/tools/read.ts`

**Scope**: `['main', 'child']`

**Description**: Read file contents from the workspace.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| path | string | yes | File path relative to workspace |
| limit | integer | no | Maximum number of lines to read |

**Behavior**:
- Validates path doesn't escape workspace
- Returns content truncated to 50,000 characters
- If `limit` specified, shows first N lines with "... (X more lines)" suffix

**Example**:
```json
{ "path": "src/index.ts", "limit": 100 }
```

---

## write_file

**File**: `src/tools/write.ts`

**Scope**: `['main', 'child']`

**Description**: Write content to a file in the workspace.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| path | string | yes | File path relative to workspace |
| content | string | yes | Content to write to the file |

**Behavior**:
- Creates parent directories if they don't exist
- Validates path doesn't escape workspace
- Overwrites existing file if present
- Returns bytes written

**Example**:
```json
{ "path": "src/new-file.ts", "content": "export const hello = 'world';" }
```

---

## edit_file

**File**: `src/tools/edit.ts`

**Scope**: `['main', 'child']`

**Description**: Replace exact text in a file. Use this for making targeted edits.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| path | string | yes | File path relative to workspace |
| old_text | string | yes | The exact text to replace (must exist in file) |
| new_text | string | yes | The replacement text |

**Behavior**:
- Validates path doesn't escape workspace
- Fails if `old_text` not found in file
- Fails if `old_text` appears multiple times (need more context)
- Only replaces first occurrence

**Example**:
```json
{
  "path": "src/index.ts",
  "old_text": "const x = 1;",
  "new_text": "const x = 2;"
}
```

---

## todo_write

**File**: `src/tools/todo_write.ts`

**Scope**: `['main', 'child']`

**Description**: Update the todo list with new items or modify existing items. Merges changes into the current todo list.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| items | array | yes | Array of todo items to add or update |

**Item Properties**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | no | Item ID (0 or undefined for new items, existing ID to update) |
| name | string | yes | Todo item name/description |
| done | boolean | no | Whether the item is completed (default: false) |
| note | string | no | Optional note for the item |

**Behavior**:
- Merges provided items into the existing todo list
- If `id` matches existing item, updates it
- If `id` is 0 or undefined, creates new item with auto-assigned ID
- Returns the current todo list after merge
- Logs action to console with colored prefix

**Example**:
```json
{
  "items": [
    { "name": "Review PR", "done": false },
    { "id": 1, "name": "Setup project", "done": true, "note": "Completed yesterday" }
  ]
}
```

---

## skill_load

**File**: `src/tools/skill_load.ts`

**Scope**: `['main', 'child']`

**Description**: Load a skill by name and return its content. Skills contain specialized knowledge and instructions for specific tasks.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | The name of the skill to load |

**Behavior**:
- Looks up skill by name from loaded skills (`.mycc/skills/*.md`)
- Returns full skill content including description and keywords
- If skill not found, lists available skills
- Skills are loaded from markdown files with YAML frontmatter

**Example**:
```json
{ "name": "typescript" }
```

---

## Scope Reference

| Scope | Description |
|-------|-------------|
| `main` | Lead agent (primary) |
| `child` | Teammate agents spawned as child processes |
| `bg` | Background task agents |

---

## Adding a New Tool

1. Create `src/tools/<name>.ts`:

```typescript
import type { ToolDefinition, AgentContext } from '../types.js';

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Description for LLM',
  input_schema: {
    type: 'object',
    properties: {
      arg: { type: 'string', description: 'Description' },
    },
    required: ['arg'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    // Implementation
    return 'result';
  },
};
```

2. Import and add to `builtInTools` array in `src/context/loader.ts`

3. Update this document (`docs/agent-tools.md`) with the new tool's reference