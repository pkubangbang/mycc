---
updated_at: 2026-08-13
changelog:
  - "2026-08-13: Updated tool count from 45 to 48, version from v0.7.0 to v0.10.1"
  - "2026-08-13: Removed nonexistent tools: wt_create, wt_remove, wt_enter, wt_leave, wt_print, todo_write, order, time"
  - "2026-08-13: Added missing tools: grep, read_read, todo_create, todo_update, todo_pinning, issue_publish, issue_list, peers, checkpoint, recap, mycc_title, skill_search"
  - "2026-08-13: Fixed scopes: question (child-only), git_commit (main+child), skill_compile (main+child), tm_print (main+child)"
  - "2026-08-13: Fixed bash params (added intent, timeout), ToolDefinition interface (JSONSchema7, signal), summary table"
  - "2026-08-13: Updated loader path from src/context/loader.ts to src/context/shared/registry.ts"
---

# Built-in Tools Reference

This document describes the built-in tools available to the coding agent. Tools are implemented in `src/tools/` and registered in `src/context/shared/registry.ts`, loaded at startup via `src/context/shared/loader.ts`.

**Current tool count**: 48 tools (as of v0.10.1)

## Tool Interface

All tools conform to `ToolDefinition` (defined in `src/types.ts`):

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JSONSchema7;      // JSON Schema for parameters
  scope: string[];                // Contexts: ['main', 'child']
  handler: (ctx: AgentContext, args: Record<string, unknown>, signal?: AbortSignal) => string | Promise<string>;
}
```

---

## Scope Reference

| Scope | Description |
|-------|-------------|
| `main` | Lead agent (primary) - full access |
| `child` | Teammate agents spawned as child processes |

**Tool Scope Constraints:**
- Tools with `['main']` only available to lead agent
- Tools with `['main', 'child']` available to lead and teammates
- Tools with `['child']` only available to teammate agents (e.g., `question`)

**Summary:**
- **Lead (main)**: All 48 tools except `question` (child-only)
- **Teammate (child)**: Cannot use `broadcast`, `tm_create`, `tm_remove`, `tm_await`, `hand_over`, `plan_on`, `plan_off`, `checkpoint`, `recap`, `peers`, `todo_pinning`, `git_commit` (main+child). `question` is child-only.

---

## File Operations

### bash

**File**: `src/tools/bash.ts`

**Scope**: `['main', 'child']`

**Description**: Run a command in the platform shell.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| command | string | yes | The shell command to execute |
| intent | string | yes | Explain why this command is needed (use intent language) |
| timeout | number | yes | Seconds before killing the process (SIGKILL). Integer 1-60. Defaults to 30 |

**Behavior**:
- Executes command in the current working directory
- Blocks until completion or timeout
- Output truncated to 20,000 characters (head+tail with summary line)
- Enforces grant system: respects plan mode and intent validation
- Blocks direct `git commit` — must use `git_commit` tool instead
- On timeout, suggests using `bg_create` for long-running commands

**Example**:
```json
{ "command": "ls -la", "intent": "check directory contents", "timeout": 10 }
```

---

### read_file

**File**: `src/tools/read.ts`

**Scope**: `['main', 'child']`

**Description**: Read file contents from the workspace or external paths. Paths use forward slashes and can be relative to workspace root, absolute, or use `~` for home directory. Limits: reads first 1000 lines or ~1/8 of context window, whichever is smaller. Reading files outside the workspace requires user grant (session-scoped).

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| path | string | yes | File path relative to workspace root |

**Behavior**:
- Detects file type (text vs binary); binary files return a description with size
- For files with extremely long lines (e.g., minified JS): shows head+tail preview
- Hard-coded limit of 1000 lines
- Reading files outside workspace requires session-scoped grant via `requestExternalPathAccess`
- Strips BOM if present; warns on encoding corruption (U+FFFD replacement chars)

**Example**:
```json
{ "path": "src/index.ts" }
```

---

### write_file

**File**: `src/tools/write.ts`

**Scope**: `['main', 'child']`

**Description**: Create or completely replace a file. Parent directories are created automatically.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| path | string | yes | File path relative to workspace root |
| content | string | yes | Content to write to the file |

**Behavior**:
- Creates parent directories if they don't exist
- Validates path doesn't escape workspace (unless external grant given)
- Overwrites existing file if present
- Supports `newline` and `bom` options for line-ending/BOM control

**Example**:
```json
{ "path": "src/new-file.ts", "content": "export const hello = 'world';" }
```

---

### edit_file

**File**: `src/tools/edit.ts`

**Scope**: `['main', 'child']`

**Description**: Replace exact text in an existing file. Use for targeted edits instead of rewriting entire files.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| path | string | yes | File path relative to workspace root |
| old_text | string | yes | The exact text to replace (literal string match, NOT regex) |
| new_text | string | yes | The replacement text |

**Behavior**:
- `old_text` is a LITERAL string match (characters like `) $ [ .` matched verbatim)
- Fails if `old_text` not found in file
- Fails if `old_text` appears multiple times (need more context for uniqueness)
- Replaces the single occurrence; file re-read and verified after write
- On verification failure, original content is restored

**Example**:
```json
{
  "path": "src/index.ts",
  "old_text": "const x = 1;",
  "new_text": "const x = 2;"
}
```

---

### grep

**File**: `src/tools/grep.ts`

**Scope**: `['main', 'child']`

**Description**: Search for a pattern in files. Automatically excludes `node_modules` and respects `.gitignore` when using ripgrep. Searching a directory outside the workspace requires user grant (session-scoped).

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| pattern | string | yes | The search pattern (regex compatible) |
| path | string | no | Directory to search (default: workspace root) |
| include | string | no | File glob pattern to include (e.g., `*.ts`) |
| exclude | string | no | File glob pattern to exclude (e.g., `*.min.js`) |
| maxResults | number | no | Maximum results to return (default: 200, max: 500) |

**Behavior**:
- Hierarchical fallback: native `rg` → ripgrep WASM → system grep/PowerShell
- If output exceeds 20,000 chars, summarizes via LLM
- External directory search requires session-scoped grant

**Example**:
```json
{ "pattern": "ToolDefinition", "include": "*.ts" }
```

---

## Communication Tools

### brief

**File**: `src/tools/brief.ts`

**Scope**: `['main', 'child']`

**Description**: Talk to yourself and let the user know. Use to report progress or findings during task execution. Always include a confidence parameter (0-10).

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| message | string | yes | The status message to display to the user |
| confidence | number | yes | Confidence level (0-10) |

**Behavior**:
- Displays message prominently in terminal
- Used for progress reporting during long tasks
- Also recorded into the peer discovery heartbeat (lead only) so other instances can see progress

**Example**:
```json
{ "message": "Processing 3 of 10 files...", "confidence": 8 }
```

---

### question

**File**: `src/tools/question.ts`

**Scope**: `['child']` (teammate only)

**Description**: Ask the user a question and wait for response. Blocks until user answers. Only available in child process (scope: child). Use for clarification during work.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | yes | The question to ask the user |

**Behavior**:
- Displays question in a formatted box
- For child processes, routes through lead agent via IPC
- Returns the user's response

**Example**:
```json
{ "query": "Which file should I modify?" }
```

---

### mail_to

**File**: `src/tools/mail_to.ts`

**Scope**: `['main', 'child']`

**Description**: Send an async message to a teammate or "lead". Non-blocking. Use for task assignment and inter-agent communication. Also supports cross-instance peer routing via `"<session-id>/lead"` identity.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | Target name (teammate name, "lead", or cross-instance `"<session-id>/lead"`) |
| title | string | yes | Message title/subject |
| content | string | yes | Message body content |
| eta | number | no | Estimate duration in seconds (mandatory on first mail to lead) |

**Behavior**:
- Appends message to target's mailbox file (`.mycc/mail/<name>.jsonl`)
- Messages are async - recipient collects at next iteration
- Cross-instance peer mail routed through peer discovery module
- `eta` converted to absolute deadline when set

**Example**:
```json
{ "name": "coder", "title": "Task Complete", "content": "Finished implementing the feature." }
```

---

### broadcast

**File**: `src/tools/broadcast.ts`

**Scope**: `['main']` (lead agent only)

**Description**: Send a message to all teammates at once. Use for announcements or coordinating team-wide updates.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | string | yes | Message title/subject |
| content | string | yes | Message body content |

**Behavior**:
- Delivers message to all active teammates
- Lead agent only tool

**Example**:
```json
{ "title": "Code Freeze", "content": "Please commit your current changes." }
```

---

### mycc_title

**File**: `src/tools/mycc_title.ts`

**Scope**: `['main', 'child']`

**Description**: Add a notification banner among the chat, to mark the change of topic in discussion.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | string | yes | The new title. Keep it concise and descriptive. |

**Behavior**:
- Sets terminal window/tab title via ANSI OSC escape sequences
- Prints a prominent bright-yellow banner to stdout
- Normalizes any "mycc" prefix to canonical `mycc: ` form

**Example**:
```json
{ "title": "Refactoring auth module" }
```

---

## Issue Management Tools

### issue_create

**File**: `src/tools/issue_create.ts`

**Scope**: `['main', 'child']`

**Description**: Create a new shared issue to track team work. Returns the issue ID. Draft issues are not visible to teammates for auto-claim — use `issue_publish` to make them claimable.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | string | yes | Concise summary of the issue (1-10 words recommended) |
| content | string | yes | Detailed description of the issue |
| blockedBy | array[integer] | no | Optional list of issue IDs that must be completed before this issue |

**Behavior**:
- Creates issue with status "draft"
- Returns the new issue ID and full issue list
- If `blockedBy` provided, creates blocking relationships
- Issues are stored in-memory (session-scoped, lost on exit)

**Example**:
```json
{ "title": "Fix login bug", "content": "Users cannot login with special characters in password" }
```

---

### issue_claim

**File**: `src/tools/issue_claim.ts`

**Scope**: `['main', 'child']`

**Description**: Claim a pending shared issue to start work. Sets status to in_progress and assigns owner.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | yes | Issue ID number to claim |
| owner | string | yes | Name or identifier of who is claiming the issue |

**Behavior**:
- Changes status from "pending" to "in_progress"
- Sets owner field
- Fails if issue is already claimed or not in "pending" status
- Returns full issue list

**Example**:
```json
{ "id": 1, "owner": "coder" }
```

---

### issue_close

**File**: `src/tools/issue_close.ts`

**Scope**: `['main', 'child']`

**Description**: Close a shared issue with final status: completed, failed, or abandoned. A non-empty comment is REQUIRED.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | yes | Issue ID number to close |
| status | string | yes | Final status: "completed", "failed", or "abandoned" |
| comment | string | yes | Non-empty comment explaining the resolution or reason for closure |
| poster | string | no | Name of the person or agent closing the issue |

**Behavior**:
- Updates issue status
- Adds closing comment (required, non-empty)
- Closing a blocker unblocks dependent issues
- Returns full issue list

**Example**:
```json
{ "id": 1, "status": "completed", "comment": "Fixed in commit abc123" }
```

---

### issue_comment

**File**: `src/tools/issue_comment.ts`

**Scope**: `['main', 'child']`

**Description**: Add a comment to a shared issue for progress updates or discussion visible to all agents.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | yes | Issue ID number to add a comment to |
| comment | string | yes | Comment text |
| poster | string | no | Name of the commenter (defaults to anonymous) |

**Behavior**:
- Appends comment to issue's comment history
- Returns full issue list

**Example**:
```json
{ "id": 1, "comment": "Started investigating the root cause" }
```

---

### issue_publish

**File**: `src/tools/issue_publish.ts`

**Scope**: `['main', 'child']`

**Description**: Publish a draft issue, transitioning it from draft to pending so it becomes visible to idle teammates for auto-claim. Use when you want any available teammate to pick up the issue.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | yes | Issue ID number to publish (must be in draft status) |

**Behavior**:
- Transitions status from "draft" to "pending"
- Only pending issues are auto-claimed by idle teammates
- Returns full issue list

**Example**:
```json
{ "id": 1 }
```

---

### issue_list

**File**: `src/tools/issue_list.ts`

**Scope**: `['main', 'child']`

**Description**: List all shared issues with status, owner, and blocking relationships.

**Parameters**: None

---

### blockage_create

**File**: `src/tools/blockage_create.ts`

**Scope**: `['main', 'child']`

**Description**: Declare that one issue blocks another. The blocked issue cannot be claimed until the blocker is resolved.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| blocker | integer | yes | ID of the issue that is blocking |
| blocked | integer | yes | ID of the issue that is being blocked |

**Behavior**:
- Creates relationship in memory blockages map
- Blocked issue cannot be claimed until blocker is resolved
- Creates blocking relationships automatically

**Example**:
```json
{ "blocker": 1, "blocked": 2 }
```

---

### blockage_remove

**File**: `src/tools/blockage_remove.ts`

**Scope**: `['main', 'child']`

**Description**: Remove a blocking relationship between two issues. The blocked issue becomes claimable if it has no other blockers.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| blocker | integer | yes | ID of the issue that was blocking |
| blocked | integer | yes | ID of the issue that was being blocked |

**Example**:
```json
{ "blocker": 1, "blocked": 2 }
```

---

## Team Management Tools

### tm_create

**File**: `src/tools/tm_create.ts`

**Scope**: `['main']` (lead agent only)

**Description**: Spawn a new teammate agent with a specific role. Assign work via mail_to after creation.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | Unique identifier for the teammate |
| role | string | yes | Role description for the teammate |
| prompt | string | yes | Initial instructions and context for the teammate |

**Behavior**:
- Spawns a child process using `fork()`
- Creates mailbox at `.mycc/mail/<name>.jsonl`
- Stores teammate info in memory (session-scoped)
- Optional `cwd` parameter (worktree path) assigned at spawn time
- Returns success message with teammate name

**Example**:
```json
{ "name": "coder", "role": "developer", "prompt": "Fix the bug in auth.ts" }
```

---

### tm_remove

**File**: `src/tools/tm_remove.ts`

**Scope**: `['main']` (lead agent only)

**Description**: Remove a teammate by terminating their child process.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | Name of the teammate to remove |
| force | boolean | no | If true, forcefully kill the process (default: false) |

**Behavior**:
- Sends shutdown message to child process
- If `force` is true, kills process immediately
- Updates teammate status to "shutdown"

**Example**:
```json
{ "name": "coder" }
```

---

### tm_await

**File**: `src/tools/tm_await.ts`

**Scope**: `['main']` (lead agent only)

**Description**: Wait for a teammate or all teammates to finish their current task.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | no | Teammate name to wait for. If omitted, waits for all |
| timeout | integer | no | Timeout in milliseconds (default: 60000) |

**Behavior**:
- Blocks until teammate reaches "idle" or "shutdown" state
- Returns after timeout even if not idle

**Example**:
```json
{ "name": "coder", "timeout": 30000 }
```

---

### tm_print

**File**: `src/tools/tm_print.ts`

**Scope**: `['main', 'child']`

**Description**: List all teammates with roles and status. Shows deadline and remaining time for working teammates.

**Parameters**: None

---

## Background Task Tools

### bg_create

**File**: `src/tools/bg_create.ts`

**Scope**: `['main', 'child']`

**Description**: Run a bash command asynchronously (non-blocking). Returns pid for use with bg_await/bg_print/bg_remove.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| command | string | yes | Bash command to run in background |
| intent | string | yes | Explain why this command is needed |

**Behavior**:
- Spawns a background process
- Returns immediately with process ID (PID)
- Use `bg_print` to check status, `bg_await` to wait for completion

**Example**:
```json
{ "command": "npm run build", "intent": "build the project" }
```

---

### bg_print

**File**: `src/tools/bg_print.ts`

**Scope**: `['main', 'child']`

**Description**: List all background tasks with status, or show accumulated output for a specific task by pid.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| pid | number | no | Process ID. Omit to list all tasks; provide to see task detail |

**Behavior**:
- Without pid: compact status list (running/completed/failed/killed)
- With pid: detailed view including accumulated output (tail-capped ~100KB)

---

### bg_remove

**File**: `src/tools/bg_remove.ts`

**Scope**: `['main', 'child']`

**Description**: Terminate a background task by pid.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| pid | integer | yes | Process ID of the background task to kill |

---

### bg_await

**File**: `src/tools/bg_await.ts`

**Scope**: `['main', 'child']`

**Description**: Block until background tasks complete.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| pid | number | no | Process ID to wait for. Omit to wait for all tasks |
| timeout | integer | no | Timeout in milliseconds (default: 60000) |

**Behavior**:
- With pid: returns accumulated task output on completion
- Without pid: returns OK when all tasks complete (use bg_print to inspect)

---

## Screen & Image Tools

### screen

**File**: `src/tools/screen.ts`

**Scope**: `['main', 'child']`

**Description**: Capture a screenshot and use vision model to read/describe screen content.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| prompt | string | no | Custom prompt for the vision model |
| desktop | number | no | Monitor to capture on multi-monitor setups (1-based index) |

**Behavior**:
- Auto-detects OS, display server (Wayland/X11), and available screenshot tools
- Selects the best tool for the environment (screencapture, gnome-screenshot, grim, scrot, import)
- Auto-resizes large screenshots (>1280px wide) using ImageMagick if available
- Sends base64-encoded image to configured vision model

**Example**:
```json
{ "prompt": "What error message is shown in the terminal?" }
```

---

### read_picture

**File**: `src/tools/read-picture.ts`

**Scope**: `['main', 'child']`

**Description**: Read and describe an image file using the vision model. Returns accumulated [focus, description] pairs and a cache token (M).

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| path | string | yes | Path to the image file (supports PNG, JPG, GIF, etc.) |
| prompt | string | no | Custom prompt for the vision model (becomes the focus label) |
| cache | string | no | Cache token (M) from a previous read to add a new focus |

**Behavior**:
- Multi-focus caching: persists to `.mycc/imgcache/` on disk
- Returns `PictureResult` with accumulated [focus, description] pairs and cache token
- Pass cache token back with a new prompt to add a focus without re-reading
- Parent process touches cache files; child processes delegate via IPC

**Example**:
```json
{ "path": "screenshots/error-dialog.png" }
```

---

### read_read

**File**: `src/tools/read-read.ts`

**Scope**: `['main', 'child']`

**Description**: Summarize long content from `.mycc/longtext/` files. Use when tool results are too large for context.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| file | string | yes | Path to file in `.mycc/longtext/` to summarize |
| focus | string | yes | What to focus on during summarization |

**Behavior**:
- Uses two-turn rolling summary: first turn summarizes each chunk, second turn refines
- Chunks content based on token threshold (60% of threshold per chunk)
- ESC-aware: checks abort signal between chunks

**Example**:
```json
{ "file": ".mycc/longtext/large-output.txt", "focus": "error messages" }
```

---

## Task Management (Todo) Tools

### todo_create

**File**: `src/tools/todo_create.ts`

**Scope**: `['main', 'child']`

**Description**: Create a new todo item. Returns the item with its id and hash — save these to reference the item later with todo_update.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | Todo item name/description |
| note | string | no | Optional note for the item |

**Behavior**:
- Creates a new todo with auto-assigned ID and integrity hash
- Returns the created item with id, name, done (false), and hash
- Returns the full todo list after creation

**Example**:
```json
{ "name": "Review PR" }
```

---

### todo_update

**File**: `src/tools/todo_update.ts`

**Scope**: `['main', 'child']`

**Description**: Update an existing todo item by id. Must provide the item's current hash (anti-staleness protection).

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | yes | Item ID to update |
| hash | string | yes | Current hash of the item (must match stored hash) |
| name | string | yes | Todo item name/description |
| done | boolean | yes | Whether the item is completed |
| note | string | no | Optional note for the item |

**Behavior**:
- Hash mismatch rejected (prevents stale updates)
- Returns updated item and full todo list

**Example**:
```json
{ "id": 1, "hash": "abc12345", "name": "Setup project", "done": true }
```

---

### todo_pinning

**File**: `src/tools/todo_pinning.ts`

**Scope**: `['main']` (lead agent only)

**Description**: Pin or unpin a todo item. Pinned todos are NOT auto-cleared when all todos are completed. Optionally set a reactivation condition.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | integer | yes | Todo item ID to pin/unpin |
| hash | string | yes | Current hash of the item |
| pinned | boolean | yes | true to pin, false to unpin |
| reactivate | string | no | Natural-language reactivation condition (only when pinned=true) |

**Behavior**:
- Pinned todos persist as long-term reminders
- Reactivation condition: system evaluates completed pinned todos against conversation context and auto-reactivates when condition is met
- Requires current hash (anti-staleness)

**Example**:
```json
{ "id": 1, "hash": "abc12345", "pinned": true, "reactivate": "when the users table is modified" }
```

---

## Skill Tools

### skill_load

**File**: `src/tools/skill_load.ts`

**Scope**: `['main', 'child']`

**Description**: Load a skill by exact name. Returns the full skill content.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | The exact name of the skill to load |

**Behavior**:
- Looks up skill by name from loaded skills
- Returns full skill content including description and keywords
- If skill not found, lists available skills

**Example**:
```json
{ "name": "typescript" }
```

---

### skill_search

**File**: `src/tools/skill_search.ts`

**Scope**: `['main', 'child']`

**Description**: Search skills by keywords. Returns matching skill names and descriptions using semantic similarity and name/keyword matching.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| search | string | yes | Short keywords/phrases (2-5 words) describing the skill |

**Behavior**:
- Combines semantic search (via wiki embeddings) with name/keyword fuzzy matching
- Returns matched skills with match type (semantic % or name/keyword)
- Use skill_load with the exact name to load full content

**Example**:
```json
{ "search": "typescript testing" }
```

---

### skill_compile

**File**: `src/tools/skill_compile.ts`

**Scope**: `['main', 'child']`

**Description**: Compile a skill's "when" condition into a structured hook. Use when a skill has a "when" field but no compiled condition.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | string | yes | Skill name to compile |
| feedback | string | no | Optional feedback for refining condition |

**Behavior**:
- Lead process: compiles directly on runtime ConditionRegistry (in-memory + disk persist)
- Child process: compiles to disk, then sends 'condition_replace' IPC so lead reloads
- Updates runtime condition registry immediately (no restart needed)

**Example**:
```json
{ "name": "environment-detection" }
```

---

## Knowledge Discovery Tools

### recall

**File**: `src/tools/recall.ts`

**Scope**: `['main', 'child']`

**Description**: Explore the mindmap knowledge tree for project structure, available skills, and context.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| path | string | yes | Node path (e.g., "/" for root, "/skill/example") |

**Example**:
```json
{ "path": "/" }
```

---

## Web Access Tools

### web_search

**File**: `src/tools/web_search.ts`

**Scope**: `['main', 'child']`

**Description**: Search the web for information. Returns titles, URLs, and snippets.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | yes | The search query to execute |

---

### web_fetch

**File**: `src/tools/web_fetch.ts`

**Scope**: `['main', 'child']`

**Description**: Fetch and parse content from a URL. Returns page title, main content, and links.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| url | string | yes | The URL to fetch content from |

---

## Knowledge Base Tools

### wiki_prepare

**File**: `src/tools/wiki_prepare.ts`

**Scope**: `['main', 'child']`

**Description**: Validate a document before storing in knowledge base. Returns hash if accepted.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| domain | string | yes | Category tag for the knowledge |
| title | string | yes | Document title |
| content | string | yes | Document content (50-1000 characters) |
| references | array[string] | no | Optional reference URLs or file paths |

---

### wiki_put

**File**: `src/tools/wiki_put.ts`

**Scope**: `['main', 'child']`

**Description**: Store a validated document in knowledge base. Requires hash from wiki_prepare.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| hash | string | yes | The hash from wiki_prepare |
| document | object | yes | The document that was validated |

---

### wiki_get

**File**: `src/tools/wiki_get.ts`

**Scope**: `['main', 'child']`

**Description**: Search knowledge base for relevant documents sorted by similarity.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | yes | The search query |
| domain | string | yes | The domain to search within |
| topK | number | no | Number of results (default: 5) |
| threshold | number | no | Minimum similarity threshold (0-1, default: 0) |

---

## Mode Control Tools

### plan_on

**File**: `src/tools/plan_on.ts`

**Scope**: `['main']`

**Description**: Switch to plan mode where code changes are prohibited. Use for planning without making changes.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| allowed_file | string | no | Optional file that can be edited in plan mode |

---

### plan_off

**File**: `src/tools/plan_off.ts`

**Scope**: `['main']`

**Description**: Switch back to normal mode where code changes are allowed.

**Parameters**: None

---

## Checkpoint & Recap Tools

### checkpoint

**File**: `src/tools/checkpoint.ts`

**Scope**: `['main']`

**Description**: Create a checkpoint marker for context management. Use before exploration or investigation tasks that generate many messages. Must be called alone (no other tools in same turn).

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| description | string | yes | What the subtask will accomplish |
| if_abandoned | string | yes | Declare original direction; injected into abandon note if later abandoned |

**Note**: Meta-tool — actual execution happens in the state machine (`hook.ts`), not the handler.

---

### recap

**File**: `src/tools/recap.ts`

**Scope**: `['main']`

**Description**: Close a checkpoint and compress its messages into a summary. Must be called alone.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| checkpoint_id | string | yes | The checkpoint ID (8-character hash) |
| abandon | boolean | no | If true, discard without summarizing |
| comment | string | yes | REQUIRED. Directive determining the direction of the next turn |

**Note**: Meta-tool — actual execution happens in the state machine (`hook.ts`), not the handler.

---

## Peer Discovery Tool

### peers

**File**: `src/tools/peers.ts`

**Scope**: `['main']` (lead only — child uses NoopPeerModule)

**Description**: List online mycc instances (cross-instance peer discovery). Returns each instance's session-id, workDir, and status.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| include_self | boolean | no | If true, include local instance (marked self=true). Default false |
| all | boolean | no | If true, list all registered identities regardless of freshness. Default false |

**Behavior**:
- Reads peer discovery registry (`~/.mycc-store/discovery/`)
- Peers older than 1 hour omitted entirely (even with all=true)
- Surfaces recent briefs from each peer

---

## Interactive Shell Tool

### hand_over

**File**: `src/tools/hand_over.ts`

**Scope**: `['main']`

**Description**: Opens an interactive terminal popup. Use ONLY when user explicitly requests interactive terminal or command requires user interaction.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| command | string | yes | Initial command to run |
| justification | string | yes | Justify why this must be interactive |

---

## Git Operations Tool

### git_commit

**File**: `src/tools/git_commit.ts`

**Scope**: `['main', 'child']`

**Description**: Execute git commit with mandatory user permission check. Always use this tool instead of 'bash' for git commits — bash git commit is blocked.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| message | string | yes | The commit message |
| amend | boolean | no | Set to true to amend the previous commit |
| cwd | string | no | Working directory for the git commit (e.g., a worktree path) |

---

## Tools Summary Table

| Tool | Scope | Category |
|------|-------|----------|
| bash | main, child | File Operations |
| read_file | main, child | File Operations |
| write_file | main, child | File Operations |
| edit_file | main, child | File Operations |
| grep | main, child | File Operations |
| brief | main, child | Communication |
| question | child | Communication |
| mail_to | main, child | Communication |
| broadcast | main | Communication |
| mycc_title | main, child | Communication |
| issue_create | main, child | Issue Management |
| issue_claim | main, child | Issue Management |
| issue_close | main, child | Issue Management |
| issue_comment | main, child | Issue Management |
| issue_publish | main, child | Issue Management |
| issue_list | main, child | Issue Management |
| blockage_create | main, child | Issue Management |
| blockage_remove | main, child | Issue Management |
| tm_create | main | Team Management |
| tm_remove | main | Team Management |
| tm_await | main | Team Management |
| tm_print | main, child | Team Management |
| bg_create | main, child | Background Tasks |
| bg_print | main, child | Background Tasks |
| bg_remove | main, child | Background Tasks |
| bg_await | main, child | Background Tasks |
| screen | main, child | Screen & Image |
| read_picture | main, child | Screen & Image |
| read_read | main, child | Content Summarization |
| todo_create | main, child | Task Management |
| todo_update | main, child | Task Management |
| todo_pinning | main | Task Management |
| skill_load | main, child | Skill Tools |
| skill_search | main, child | Skill Tools |
| skill_compile | main, child | Skill Tools |
| hand_over | main | Interactive Shell |
| git_commit | main, child | Git Operations |
| plan_on | main | Mode Control |
| plan_off | main | Mode Control |
| checkpoint | main | Checkpoint & Recap |
| recap | main | Checkpoint & Recap |
| recall | main, child | Knowledge Discovery |
| web_search | main, child | Web Access |
| web_fetch | main, child | Web Access |
| wiki_prepare | main, child | Knowledge Base |
| wiki_put | main, child | Knowledge Base |
| wiki_get | main, child | Knowledge Base |
| peers | main | Peer Discovery |

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

2. Import and add to `builtInTools` array in `src/context/shared/registry.ts`

3. Update this document (`docs/agent-tools.md`) with the new tool's reference