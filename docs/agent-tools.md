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

## Scope Reference

| Scope | Description |
|-------|-------------|
| `main` | Lead agent (primary) - full access |
| `child` | Teammate agents spawned as child processes |
| `bg` | Background task agents |

**Tool Scope Constraints:**
- Tools with `['main']` only available to lead agent
- Tools with `['main', 'child']` available to lead and teammates
- Tools with `['main', 'child', 'bg']` available everywhere

**Summary:**
- **Lead (main)**: All 19 tools
- **Teammate (child)**: Cannot use `broadcast`, `tm_create`, `tm_remove`, `tm_await`
- **Background (bg)**: Can use `bash`, `read_file`, `write_file`, `edit_file`

---

## File Operations

### bash

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

### read_file

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

### write_file

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

### edit_file

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

## Communication Tools

### brief

**File**: `src/tools/brief.ts`

**Scope**: `['main', 'child']`

**Description**: Send a status update message to the user. Use this to report progress, share information, or provide updates during task execution. The message will be displayed in the terminal.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| message | string | yes | The status message to display to the user |

**Behavior**:
- Displays message prominently in terminal
- Logs to transcript if available
- Used for progress reporting during long tasks

**Example**:
```json
{ "message": "Processing 3 of 10 files..." }
```

---

### question

**File**: `src/tools/question.ts`

**Scope**: `['main', 'child']`

**Description**: Ask the user a question and wait for their response. Use this to get clarification or additional information during task execution.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | yes | The question to ask the user |

**Behavior**:
- Displays question in a formatted box
- Waits for user input (no timeout)
- Returns the user's response
- For child processes, routes through lead agent via IPC

**Example**:
```json
{ "query": "Which file should I modify?" }
```

---

### mail_to

**File**: `src/tools/mail_to.ts`

**Scope**: `['main', 'child']`

**Description**: Send an async message to a specific teammate or lead. Use this for inter-agent communication. Use "lead" to message the lead agent.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | Target name to receive the message (teammate name or "lead") |
| title | string | yes | Message title/subject |
| content | string | yes | Message body content |

**Behavior**:
- Appends message to target's mailbox file (`.mycc/mail/<name>.jsonl`)
- Messages are async - recipient collects at next iteration
- Use "lead" to send message to the lead agent

**Example**:
```json
{ "name": "coder", "title": "Task Complete", "content": "Finished implementing the feature." }
```

---

### broadcast

**File**: `src/tools/broadcast.ts`

**Scope**: `['main']` (lead agent only)

**Description**: Send a message to all teammates at once. Use this for announcements or coordinating team-wide updates.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | string | yes | Message title/subject |
| content | string | yes | Message body content |

**Behavior**:
- Delivers message to all active teammates
- Lead agent only tool
- Useful for coordination announcements

**Example**:
```json
{ "title": "Code Freeze", "content": "Please commit your current changes." }
```

---

## Issue Management Tools

### issue_create

**File**: `src/tools/issue_create.ts`

**Scope**: `['main', 'child']`

**Description**: Create a new issue with an optional list of blocking issues. Returns the issue ID.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | string | yes | Short title for the issue |
| content | string | yes | Detailed description of the issue |
| blockedBy | array[integer] | no | Optional array of issue IDs that block this issue |

**Behavior**:
- Creates issue with status "pending"
- Returns the new issue ID
- If `blockedBy` provided, creates blocking relationships
- Issues are persisted in SQLite database

**Example**:
```json
{ "title": "Fix login bug", "content": "Users cannot login with special characters in password" }
```

---

### issue_claim

**File**: `src/tools/issue_claim.ts`

**Scope**: `['main', 'child']`

**Description**: Claim an issue to start working on it. Sets status to in_progress and assigns an owner. Only works on pending issues.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | yes | ID of the issue to claim |
| owner | string | yes | Name or identifier of the owner claiming the issue |

**Behavior**:
- Changes status from "pending" to "in_progress"
- Sets owner field
- Fails if issue is already claimed or not in "pending" status
- Returns success/failure message

**Example**:
```json
{ "id": 1, "owner": "coder" }
```

---

### issue_close

**File**: `src/tools/issue_close.ts`

**Scope**: `['main', 'child']`

**Description**: Close an issue with a final status (completed, failed, or abandoned). Optionally add a closing comment.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | yes | ID of the issue to close |
| status | string | yes | Final status: "completed", "failed", or "abandoned" |
| comment | string | no | Optional closing comment |
| poster | string | no | Name of the person closing the issue (optional) |

**Behavior**:
- Updates issue status
- Optionally adds closing comment
- May unblock other issues waiting on this issue

**Example**:
```json
{ "id": 1, "status": "completed", "comment": "Fixed in commit abc123" }
```

---

### issue_comment

**File**: `src/tools/issue_comment.ts`

**Scope**: `['main', 'child']`

**Description**: Add a comment to an existing issue. The poster is automatically recorded.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | yes | ID of the issue to comment on |
| comment | string | yes | Comment text to add |
| poster | string | no | Name of the commenter (optional, defaults to anonymous) |

**Behavior**:
- Appends comment to issue's comment history
- Comments stored as JSON array in SQLite

**Example**:
```json
{ "id": 1, "comment": "Started investigating the root cause" }
```

---

### blockage_create

**File**: `src/tools/blockage_create.ts`

**Scope**: `['main', 'child']`

**Description**: Create a blocking relationship: the blocker issue blocks the blocked issue. The blocked issue cannot be worked on until the blocker is resolved.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| blocker | integer | yes | ID of the issue that is blocking |
| blocked | integer | yes | ID of the issue that is being blocked |

**Behavior**:
- Creates relationship in `issue_blockages` table
- Blocked issue cannot be claimed until blocker is resolved
- Prevents circular dependencies

**Example**:
```json
{ "blocker": 1, "blocked": 2 }
```

---

### blockage_remove

**File**: `src/tools/blockage_remove.ts`

**Scope**: `['main', 'child']`

**Description**: Remove a blocking relationship between two issues. The blocked issue will no longer be blocked by the blocker.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| blocker | integer | yes | ID of the issue that was blocking |
| blocked | integer | yes | ID of the issue that was blocked |

**Behavior**:
- Removes relationship from `issue_blockages` table
- If all blockers removed, issue becomes claimable

**Example**:
```json
{ "blocker": 1, "blocked": 2 }
```

---

## Team Management Tools

### tm_create

**File**: `src/tools/tm_create.ts`

**Scope**: `['main']` (lead agent only)

**Description**: Create a teammate as a child process agent. Use this to spawn a new agent that can work on tasks asynchronously.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | Unique identifier for the teammate (used for referencing in other commands) |
| role | string | yes | Role description for the teammate (e.g., "coder", "reviewer", "tester") |
| prompt | string | yes | Initial instructions and context for the teammate to follow |

**Behavior**:
- Spawns a child process using `fork()`
- Creates mailbox at `.mycc/mail/<name>.jsonl`
- Stores teammate info in SQLite database
- Teammate starts in "working" status
- Returns success message with teammate name

**Example**:
```json
{ "name": "coder", "role": "developer", "prompt": "Fix the bug in auth.ts" }
```

---

### tm_remove

**File**: `src/tools/tm_remove.ts`

**Scope**: `['main']` (lead agent only)

**Description**: Remove a teammate by terminating their child process. Use this when a teammate is no longer needed.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | Name of the teammate to remove |
| force | boolean | no | If true, forcefully kill the process; otherwise send soft shutdown (default: false) |

**Behavior**:
- Sends shutdown message to child process
- If `force` is true, kills process immediately
- Updates teammate status to "shutdown" in database
- Returns confirmation message

**Example**:
```json
{ "name": "coder" }
```

---

### tm_await

**File**: `src/tools/tm_await.ts`

**Scope**: `['main']` (lead agent only)

**Description**: Wait for a teammate or all teammates to finish their current task. Use this instead of polling with bash sleep. Returns when the teammate(s) reach idle/shutdown state or timeout.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | no | Teammate name to wait for. If omitted, waits for all teammates |
| timeout | integer | no | Timeout in milliseconds (default: 60000) |

**Behavior**:
- Blocks until teammate reaches "idle" or "shutdown" state
- If no name provided, waits for all teammates
- Returns after timeout even if not idle
- Returns status for each teammate

**Example**:
```json
{ "name": "coder", "timeout": 30000 }
```

---

## Task Management Tools

### todo_write

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

### skill_load

**File**: `src/tools/skill_load.ts`

**Scope**: `['main', 'child']`

**Description**: Load a skill by name and return its content. Skills contain specialized knowledge and instructions for specific tasks.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | The name of the skill to load |

**Behavior**:
- Looks up skill by name from loaded skills (`.mycc/skills/*.md` and `skills/*.md`)
- Returns full skill content including description and keywords
- If skill not found, lists available skills
- Skills are loaded from markdown files with YAML frontmatter

**Example**:
```json
{ "name": "typescript" }
```

---

## Tools Summary Table

| Tool | Scope | Category |
|------|-------|----------|
| bash | main, child, bg | File Operations |
| read_file | main, child, bg | File Operations |
| write_file | main, child, bg | File Operations |
| edit_file | main, child, bg | File Operations |
| brief | main, child | Communication |
| question | main, child | Communication |
| mail_to | main, child | Communication |
| broadcast | main | Communication |
| issue_create | main, child | Issue Management |
| issue_claim | main, child | Issue Management |
| issue_close | main, child | Issue Management |
| issue_comment | main, child | Issue Management |
| blockage_create | main, child | Issue Management |
| blockage_remove | main, child | Issue Management |
| tm_create | main | Team Management |
| tm_remove | main | Team Management |
| tm_await | main | Team Management |
| todo_write | main, child | Task Management |
| skill_load | main, child | Task Management |

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