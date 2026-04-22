# Slash Commands Reference

Slash commands are special commands that start with `/` and are handled directly by the agent's REPL interface, bypassing the LLM. They provide quick access to system functions like session management, team coordination, issue tracking, and more.

## How Slash Commands Work

When you type a command starting with `/` at the `agent >>` prompt:

1. The input is intercepted before being sent to the LLM
2. The command name (without `/`) is looked up in the command registry
3. If found, the command handler executes and the result is displayed
4. If not found, an error message shows available commands

```
agent >> /todos
No todos.

agent >> /unknown
Unknown command: /unknown
Available commands: /team, /todos, /skills, /issues, /save, /load, /clear, /wiki, /compact, /domain, /help
```

## Command Aliases

Many noun-based commands support both singular and plural forms:

| Primary | Alias | Both Work |
|---------|-------|-----------|
| `/todos` | `/todo` | Yes |
| `/skills` | `/skill` | Yes |
| `/issues` | `/issue` | Yes |

---

## Simple Commands

These commands take no arguments.

### /help

**Description**: Show all slash commands and their usage.

**Usage**:
```
/help
```

**Output**:
- Lists all simple commands (no arguments)
- Lists commands with arguments
- Shows bang command syntax
- Shows exit options

---

### /team

**Description**: Print team information - shows all teammates (child agents) and their status.

**Usage**:
```
/team
```

**Output**:
- Lists each teammate's name, role, and status
- Status values: `working`, `idle`, `holding`, `shutdown`

**Example**:
```
agent >> /team
Team Members:
  coder (coder): working
  reviewer (reviewer): idle
```

---

### /todos

**Aliases**: `/todo`

**Description**: Print the current todo list.

**Usage**:
```
/todos
```

**Output**:
- Shows all todo items with status (`[x]` done, `[ ]` pending)
- Shows notes for each item if present
- Shows "No todos." if list is empty

**Example**:
```
agent >> /todos
Todo list:
  [x] 1. Read project structure
  [ ] 2. Implement feature X
  [ ] 3. Write tests
```

---

### /skills

**Aliases**: `/skill`

**Description**: Manage skills - list skills, rebuild wiki index.

**Usage**:
```
/skills           - List all available skills
/skills build     - Rebuild wiki index for semantic skill matching
```

**Output**:
- Lists all built-in, project, and user skills
- Shows skill descriptions and keywords

**Example**:
```
agent >> /skills
=== Skills ===

[User Skills]
  - excel: Guide for working with Excel files
  - open-with: Guide for opening files with specific applications

[Project Skills]
  - clear-sessions: Guide for clearing corrupted sessions
  - session-introspect: Guide for parsing session files

[Built-in Skills]
  - add-tool: REQUIRED when creating new tools
  - coordination: Guide for coordinating teammates
  - create-skill: Guide for creating new skills
```

---

### /save

**Description**: Save current session to `~/.mycc/sessions`.

**Usage**:
```
/save
```

**Behavior**:
- Saves conversation history and state
- Creates a timestamped session file
- Can be restored later with `/load`

---

### /clear

**Description**: Clear conversation history and start fresh.

**Usage**:
```
/clear
```

**Behavior**:
- Clears the message history
- Resets context but keeps the agent running
- Useful when conversation gets too long or off-track

---

### /compact

**Description**: Manually trigger conversation compaction.

**Usage**:
```
/compact
```

**Behavior**:
- Compresses conversation history using micro-compact algorithm
- Keeps important context while reducing token count
- Automatic compaction happens when threshold is reached

---

---

## Commands with Arguments

These commands accept additional arguments.

### /issues

**Aliases**: `/issue`

**Description**: List issues or show specific issue details.

**Usage**:
```
/issues           - List all issues
/issues <id>      - Show specific issue details
```

**Arguments**:
| Argument | Type | Description |
|----------|------|-------------|
| id | number | Issue ID to display (optional) |

**Output**:
- Without ID: Lists all issues with status, owner, and blocking relationships
- With ID: Shows full issue details including comments

**Example**:
```
agent >> /issues
Issues:
  #1 [in_progress] Implement feature X (owner: coder)
  #2 [pending] Write tests (blocked by #1)
  #3 [completed] Design API

agent >> /issues 1
Issue #1: Implement feature X
  Status: in_progress
  Owner: coder
  Blocked by: (none)
  Blocks: #2
  Created: 2024-04-22 10:30
  Comments:
    - [system] Issue claimed by coder
```

---

### /load

**Description**: List or load sessions.

**Usage**:
```
/load             - List available sessions
/load <id>        - Load a specific session
```

**Arguments**:
| Argument | Type | Description |
|----------|------|-------------|
| id | string | Session ID or filename (optional) |

**Output**:
- Without ID: Lists recent sessions with timestamps
- With ID: Restores the session and shows first query

**Example**:
```
agent >> /load
Recent sessions:
  fa0077b - 2024-04-22 14:30 (current)
  a1b2c3d - 2024-04-21 09:15
  e4f5g6h - 2024-04-20 16:45

agent >> /load a1b2c3d
Session loaded from a1b2c3d.json
Restored query: "Read the project structure"
```

---

### /wiki

**Description**: Manage knowledge base WAL files and domains.

**Usage**:
```
/wiki                      - Show today's WAL file
/wiki edit [date]          - Open WAL file for editing (YYYY-MM-DD)
/wiki rebuild              - Rebuild vector store from all WAL files
/wiki delete <hash>        - Delete document from vector store by hash
/wiki domains              - List all domains
/wiki domains add <name> <description>    - Add domain
/wiki domains remove <name>               - Remove domain
```

**Arguments**:
| Argument | Type | Description |
|----------|------|-------------|
| edit | keyword | Edit mode for WAL files |
| date | string | Optional date (YYYY-MM-DD format) |
| rebuild | keyword | Rebuild vector store |
| delete | keyword | Delete mode |
| hash | string | Document hash to delete |
| domains | keyword | Domain management mode |
| add/remove | keyword | Add or remove domain |
| name | string | Domain name |
| description | string | Domain description |

**Output**:
- Shows WAL entries for the date
- Lists domains with descriptions
- Confirms rebuild/delete operations

---

### /domain

**Description**: List wiki domains (shortcut for `/wiki domains`).

**Usage**:
```
/domain
```

**Output**:
- Lists all knowledge base domains
- Shows domain name, description, and creation date

---

## Bang Command (!)

The bang command provides access to an interactive terminal.

**Usage**:
```
!<command>         - Run command in interactive terminal popup
!                  - Open terminal shell
```

**Behavior**:
- Opens a tmux-based terminal popup
- Allows interactive commands (vim, htop, ssh, etc.)
- Press Enter to capture result and return to agent
- Press `Ctrl+B d` to detach tmux session

**Examples**:
```
!pnpm test         - Run tests with interactive prompts
!vim config.json   - Edit a file
!ssh user@host     - SSH to remote server
!                  - Open shell
```

---

## Exit Commands

Exit the agent using one of these methods:

| Command | Description |
|---------|-------------|
| `q` | Exit immediately |
| `exit` | Exit immediately |
| `quit` | Exit immediately |
| `Enter` (empty line) | Exit after confirmation |

---

## Implementation Details

### File Location

Slash commands are implemented in `src/slashes/`:

| File | Command |
|------|---------|
| `help.ts` | `/help` |
| `team.ts` | `/team` |
| `todos.ts` | `/todos` |
| `skills.ts` | `/skills` |
| `issues.ts` | `/issues` |
| `save.ts` | `/save` |
| `load.ts` | `/load` |
| `clear.ts` | `/clear` |
| `wiki.ts` | `/wiki` |
| `compact.ts` | `/compact` |
| `domain.ts` | `/domain` |

### Registry

Commands are registered in `src/slashes/index.ts`:

```typescript
interface SlashCommand {
  name: string;           // Command name without slash
  description: string;    // Short description for help
  aliases?: string[];     // Alternative names (e.g., ['todo'] for 'todos')
  handler: (context: SlashCommandContext) => Promise<void> | void;
}
```

### Adding a New Command

1. Create a new file in `src/slashes/`
2. Export a `SlashCommand` object with `name`, `description`, and `handler`
3. Import and register in `src/slashes/index.ts`

Example:
```typescript
// src/slashes/mycommand.ts
import type { SlashCommand } from '../types.js';

export const myCommand: SlashCommand = {
  name: 'mycommand',
  description: 'My custom command',
  aliases: ['mc'],  // Optional aliases
  handler: (context) => {
    const { args, ctx } = context;
    console.log('My command executed!');
  },
};
```

```typescript
// In src/slashes/index.ts
import { myCommand } from './mycommand.js';
slashRegistry.register(myCommand);
```