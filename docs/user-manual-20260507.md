# mycc User Manual

**Version:** 2.0  
**Last Updated:** May 7, 2026

---

## Table of Contents

1. [Introduction](#introduction)
2. [Getting Started](#getting-started)
3. [Key Features](#key-features)
4. [Common Use Cases](#common-use-cases)
5. [Installation & Configuration](#installation--configuration)
6. [Slash Commands Reference](#slash-commands-reference)
7. [Tools Overview](#tools-overview)
8. [Knowledge Management](#knowledge-management)
9. [Troubleshooting](#troubleshooting)
10. [Technical Reference](#technical-reference)

---

## Introduction

### What is mycc?

mycc is a Node.js coding agent that uses Ollama for LLM (Large Language Model) inference. It acts as an intelligent assistant that can help you with various coding tasks - from file operations and code generation to managing complex multi-agent workflows.

### Why Use mycc?

- **Intelligent Automation**: Automate repetitive coding tasks with AI assistance
- **Multi-Agent Teamwork**: Spawn specialized teammates to work on parallel tasks
- **Persistent Task Management**: Track issues and todos across sessions
- **Git Integration**: Manage multiple worktrees for parallel development
- **Knowledge Management**: Store and retrieve project knowledge with vector search
- **Extensible**: Add custom tools and skills for your specific needs
- **Privacy-Focused**: Run locally with Ollama - no data sent to external servers

### Who Should Use This?

mycc is designed for:
- Software developers who want AI-assisted coding
- Teams working on complex projects that benefit from task decomposition
- Anyone interested in local LLM-based automation tools

---

## Getting Started

### Prerequisites

Before you begin, ensure you have:

1. **Node.js** (v18 or higher)
2. **pnpm** package manager
3. **Ollama** installed and running with a compatible model

### Quick Start

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd mycc
   pnpm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your preferred settings
   ```

3. **Start the Agent**
   ```bash
   pnpm start
   ```

4. **First Interaction**
   
   When you start mycc, you'll see a prompt where you can type commands or natural language requests. The agent will interpret your input and use appropriate tools to help you.

### Your First Task

Try asking mycc to help with something simple:

```
> Read the README.md file and summarize the project
```

The agent will use the `read_file` tool to read the file and provide a summary.

---

## Key Features

### 1. Agent Context Pattern

mycc uses a modular state container called `AgentContext` that manages:
- **Core**: Work directory, logging, and user interactions
- **Todo**: Temporary checklist for task tracking
- **Mail**: Async mailbox for inter-agent communication
- **Issue**: Persisted tasks with blocking relationships
- **Background**: Background bash tasks
- **Worktree**: Git worktree management
- **Team**: Child process teammates
- **Wiki**: Persistent knowledge base with vector search

### 2. STAR Principle Loop

The agent operates on the STAR principle:
- **S**ituation: Understand current progress and context
- **T**ask: Define goals clearly
- **A**ction: Execute appropriate tools
- **R**esult: Collect outcomes and iterate

### 3. Child Process Teammates

Spawn specialized teammates to work on parallel tasks:
- Each teammate runs as a separate child process
- Communicate via async mail system
- Different teammates can have different roles (coder, reviewer, tester, etc.)
- Teammates have isolated contexts and mindmaps

### 4. Dynamic Tool Loading

- Built-in tools in `src/tools/` are always available
- User-defined tools in `.mycc/tools/` are hot-reloaded
- Skills in `.mycc/skills/` provide specialized knowledge

### 5. SQLite Persistence

All state is persisted in `.mycc/state.db`:
- Issues and blocking relationships
- Teammate status
- Worktree records

### 6. Mindmap Knowledge Navigation

Navigate project documentation efficiently:
- Compiled from CLAUDE.md for efficient context loading
- Hierarchical structure for easy navigation
- On-demand retrieval reduces token usage
- Each process has isolated mindmap instance

### 7. Plan Mode

Restrict agent to planning tasks without making code changes:
- Useful for reviewing code before modifications
- Can allow specific file edits with permission
- Helps maintain safety during planning phases

---

## Common Use Cases

### Use Case 1: File Exploration and Analysis

```
> Explore the src directory and explain the code structure
```

The agent will use `bash` to list files, `read_file` to examine code, and provide an explanation.

### Use Case 2: Managing Complex Tasks with Issues

```
> Create an issue to implement user authentication with blocking sub-issues
```

Use `issue_create` to break down complex work:
```json
{ "title": "Implement auth", "content": "User authentication system" }
{ "title": "Create user model", "content": "Database model for users" }
{ "title": "Add login endpoint", "content": "API endpoint for login" }
```

### Use Case 3: Parallel Development with Teammates

```
> Spawn a coder teammate to implement the feature and a reviewer to check the code
```

Use `tm_create` to create teammates:
```json
{ "name": "coder", "role": "developer", "prompt": "Implement feature X" }
{ "name": "reviewer", "role": "code reviewer", "prompt": "Review code quality" }
```

### Use Case 4: Background Tasks

```
> Run the build process in the background while I continue working
```

Use `bg_create` to run long commands:
```json
{ "command": "pnpm build" }
```

### Use Case 5: Git Worktree Management

```
> Create a new worktree for the feature branch
```

Use `wt_create` to isolate work:
```json
{ "name": "feature-x", "branch": "feature-x" }
```

### Use Case 6: Wiki Knowledge Base

Store and retrieve knowledge across sessions using the wiki system:

```
> Store this in the wiki: the project uses PostgreSQL 15 for the database
```

The agent will use `wiki_prepare` to validate, then `wiki_put` to store:
```json
{ "domain": "project", "title": "Database config", "content": "...", "references": [] }
```

To retrieve knowledge:
```
> What do we know about the database configuration?
```

The agent will use `wiki_get` with the domain filter to find relevant documents.

### Use Case 7: Mindmap Navigation

Navigate project documentation efficiently:

```
> /mindmap compile    # Compile CLAUDE.md into mindmap
> /mindmap get /skill  # Explore skill documentation
```

Use the `recall` tool to navigate knowledge:
```
> recall(path="/")     # Start at root
> recall(path="/skill/loading")  # Navigate to specific section
```

### Use Case 8: Wiki WAL Management

Manage the Write-Ahead Log (WAL) for knowledge base audit:

```
/wiki              - Show today's WAL entries
/wiki edit         - Edit today's WAL in ASCII format
/wiki edit 2024-01-15  - Edit a specific day's WAL
/wiki rebuild      - Rebuild vector store from all WAL files
```

WAL files are stored in `~/.mycc-store/wiki/logs/YYYY-MM-DD.wal` as JSON lines.

### Use Case 9: Plan Mode for Safe Review

Use plan mode to review before making changes:

```
> /mode plan         # Enter plan mode (blocks code changes)
> Analyze this code and suggest improvements
> /mode normal       # Exit plan mode when ready
```

Or use the `plan_on` tool directly:
```json
{ "allowed_file": "docs/plan.md" }  // Only allow editing this file
```

---

## Installation & Configuration

### Environment Variables

Configure `.env` file with:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OLLAMA_HOST` | No | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | No | `glm-5:cloud` | General/chat model |
| `OLLAMA_VISION_MODEL` | No | `none` | Vision model (set to "none" to disable) |
| `OLLAMA_EMBEDDING_MODEL` | No | (empty) | Embedding model for semantic search/RAG |
| `OLLAMA_API_KEY` | No | (empty) | API key for cloud features (sensitive) |
| `TOKEN_THRESHOLD` | No | `50000` | Context limit threshold |
| `EDITOR` | No | Platform default | Text editor for file editing |

### Interactive Setup Wizard

mycc provides an interactive setup wizard for first-time installation or environment configuration.

#### Running Setup

```bash
mycc --setup
```

The setup wizard will:
1. Display current settings (if any exist)
2. Prompt for configuration location (user-level or project-level)
3. Guide you through each environment variable
4. Pull configured models via Ollama
5. Write the `.env` file

#### When to Use Setup

- **First-time installation**: Configure mycc for the first time
- **Environment issues**: When mycc fails to start due to missing configuration
- **Model changes**: Switch to a different Ollama model
- **API key setup**: Configure cloud features with API keys

#### Setup Flow

**Step 1: Terminal Check**

The wizard first verifies you're running in an interactive terminal. If not, it displays:
- Error message explaining the requirement
- Alternative: create config file manually
- Locations: `~/.mycc-store/.env` (user-level) or `./.mycc/.env` (project-level)

**Step 2: Display Current Settings**

If existing configuration is found, the wizard shows:
- All environment variables with their values
- Sensitive values (API keys) are redacted as `****xxxx` (last 4 characters visible)
- Source indicator: `[user]`, `[project]`, `[default]`, or `(not set)`

**Step 3: Choose Configuration Location**

```
📁 Where do you want to store the configuration?
  [1] User-level (~/.mycc-store/.env) - Global, applies to all projects
  [2] Project-level (./.mycc/.env) - Local, applies only to current project

Choice [1-2, default: 1]:
```

**User-level** (`~/.mycc-store/.env`):
- Global configuration shared across all projects
- Recommended for most users
- Takes precedence when both exist

**Project-level** (`./.mycc/.env`):
- Local to current project only
- Useful for project-specific configurations
- Overrides user-level when loaded

**Step 4: Configure Environment Variables**

For each variable, the wizard prompts:

```
⚙️  Configuration

  Press Enter to accept the default or keep existing value.

Ollama server URL [default: http://127.0.0.1:11434]: 
Ollama model name (general/chat) [default: glm-5:cloud]: 
Ollama vision model (for screen/image tools) [default: none]: 
Ollama embedding model (for semantic search/RAG): 
Ollama API key (optional, for cloud features): 
Token threshold for context management [default: 50000]: 
Text editor (for file editing) [default: nano]: 
```

- Empty input = keep existing value or use default
- Input validation for URLs and numbers
- Sensitive fields (API keys) are hidden during input

**Step 5: Model Pulling**

After configuration, the wizard attempts to pull models:
1. `OLLAMA_MODEL` (required) - warns if pull fails
2. `OLLAMA_VISION_MODEL` (if set and not "none") - silent failure
3. `OLLAMA_EMBEDDING_MODEL` (if set) - silent failure

Models already installed are skipped.

**Step 6: Success**

```
✅ Configuration saved successfully!
   Location: /home/user/.mycc-store/.env
   Type: user-level

You can now run mycc normally.
```

#### Config Location Priority

When both configurations exist, loading order is:
1. User-level: `~/.mycc-store/.env` (loaded first)
2. Project-level: `./.mycc/.env` (loaded second, overrides)

This means **project-level settings take precedence** over user-level.

#### Setup Requirements

| Platform | Home Directory | Default Editor |
|----------|---------------|----------------|
| Linux | `/home/{user}` | `nano` |
| macOS | `/Users/{user}` | `nano` |
| Windows | `C:\Users\{user}` | `notepad` |

#### Edge Cases

**Non-Interactive Terminal**

When running in CI or non-interactive mode:
```
Error: Setup requires an interactive terminal.
Please run `mycc --setup` in a terminal.

Alternatively, create the config file manually:
  User-level:   ~/.mycc-store/.env
  Project-level: ./.mycc/.env
```

**Ollama Not Installed**

If Ollama is not installed:
- Wizard continues with configuration
- Model pulling is skipped
- Warning displayed: "Ollama not found, skipping model pull"

**Permission Denied**

If the configuration directory cannot be created:
- Error message shows directory path
- Instructs user to check permissions
- Exits with code 1

**Running from Home Directory**

When running from `~` (home directory):
- Warning: "Running from home directory, project-level config doesn't make sense"
- Suggests using user-level configuration instead

**CI Environment Detection**

The wizard detects CI environments (`CI` or `CONTINUOUS_INTEGRATION` env vars):
- Displays error message
- Exits with code 1
- Suggests manual configuration

#### Manual Configuration

If you prefer not to use the wizard, create the `.env` file manually:

```bash
# User-level config
mkdir -p ~/.mycc-store
cat > ~/.mycc-store/.env << 'EOF'
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=glm-5:cloud
OLLAMA_VISION_MODEL=none
TOKEN_THRESHOLD=50000
EDITOR=nano
EOF

# Project-level config
mkdir -p .mycc
cat > .mycc/.env << 'EOF'
OLLAMA_MODEL=codellama:7b
TOKEN_THRESHOLD=30000
EOF
```

### Automatic Environment Validation

When mycc starts (without `--setup`), it validates the environment:

1. **Load configuration files** (user-level then project-level)
2. **Validate required settings**
3. **Display warnings** for missing optional settings
4. **Exit with code 2** if critical settings are missing

Example validation failure:
```
Missing required environment variables:
  - OLLAMA_HOST: Set OLLAMA_HOST for your Ollama server
  - OLLAMA_MODEL: Set OLLAMA_MODEL to specify which model to use

Run 'mycc --setup' to configure your environment.
```

### Directory Structure

```
mycc/
├── src/              # Source code
├── .mycc/            # Runtime data (gitignored)
│   ├── state.db      # SQLite database
│   ├── mail/         # Mailboxes
│   ├── tools/        # User-defined tools
│   ├── skills/       # Skill definitions
│   └── mindmap.json  # Compiled mindmap
├── skills/           # Built-in skills
├── docs/             # Documentation
└── dist/             # Compiled output

~/.mycc-store/wiki/   # Wiki knowledge base (shared across projects)
├── db/               # LanceDB vector store
├── logs/             # WAL files (YYYY-MM-DD.wal)
└── domains.json      # Domain registry
```

---

## Setup Command Reference

### `mycc --setup`

Launch interactive setup wizard to configure environment variables.

**Usage**:
```bash
mycc --setup
```

**What it does**:
1. Checks for interactive terminal (exits if not TTY)
2. Displays current settings (if any)
3. Prompts for configuration location (user-level or project-level)
4. Guides through environment variable configuration
5. Pulls configured models via Ollama
6. Writes `.env` file to chosen location

**Exit Codes**:
- `0`: Setup completed successfully
- `1`: Setup failed (error)
- `2`: Non-interactive terminal (not TTY or CI environment)

**Configuration Locations**:

| Location | Path | Scope | Precedence |
|----------|------|-------|------------|
| User-level | `~/.mycc-store/.env` | Global, all projects | Loaded first |
| Project-level | `./.mycc/.env` | Local, current project | Loaded second (overrides) |

**Environment Variables**:

| Variable | Prompts | Validation | Default |
|----------|---------|------------|---------|
| `OLLAMA_HOST` | Yes | URL format | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Yes | None | `glm-5:cloud` |
| `OLLAMA_VISION_MODEL` | Yes | None | `none` |
| `OLLAMA_EMBEDDING_MODEL` | Yes | None | (empty) |
| `OLLAMA_API_KEY` | Yes | None (sensitive) | (empty) |
| `TOKEN_THRESHOLD` | Yes | Positive number | `50000` |
| `EDITOR` | Yes | None | Platform default |

**Sensitive Values**:
- API keys are redacted during display: `****xxxx` (last 4 chars visible)
- Empty input preserves existing value

**Model Pulling**:
- Checks if model is already installed via `ollama list`
- Pulls missing models automatically via `ollama pull`
- Warnings for required model failures
- Silent failures for optional models

**Example Session**:
```
$ mycc --setup

mycc --setup
  Launch interactive setup wizard to configure environment variables.

Config locations:
  User-level:   ~/.mycc-store/.env (global)
  Project-level: ./.mycc/.env (local)

Environment variables:
  OLLAMA_HOST          - Ollama server URL
  OLLAMA_MODEL         - General/chat model
  OLLAMA_VISION_MODEL  - Vision model (or "none")
  OLLAMA_EMBEDDING_MODEL - Embedding model
  OLLAMA_API_KEY       - API key for cloud features
  TOKEN_THRESHOLD      - Context limit threshold
  EDITOR               - Text editor

📋 No existing configuration found.

  This appears to be a fresh installation.
  Let's configure your environment.

📁 Where do you want to store the configuration?
  [1] User-level (~/.mycc-store/.env) - Global, applies to all projects
  [2] Project-level (./.mycc/.env) - Local, applies only to current project

Choice [1-2, default: 1]: 1

⚙️  Configuration

  Press Enter to accept the default or keep existing value.

Ollama server URL [default: http://127.0.0.1:11434]: 
Ollama model name (general/chat) [default: glm-5:cloud]: codellama:7b
Ollama vision model (for screen/image tools) [default: none]: 
Ollama embedding model (for semantic search/RAG): nomic-embed-text
Ollama API key (optional, for cloud features): 
Token threshold for context management [default: 50000]: 
Text editor (for file editing) [default: nano]: 

✓ Pulling model: codellama:7b
✓ Pulling model: nomic-embed-text

✅ Configuration saved successfully!
   Location: /home/user/.mycc-store/.env
   Type: user-level

You can now run mycc normally.
```

---

## Slash Commands Reference

Slash commands provide direct access to system functions without LLM intervention. **Current command count**: 15 commands (as of v2.0).

### How Slash Commands Work

When you type a command starting with `/` at the `agent >>` prompt:

1. The input is intercepted before being sent to the LLM
2. The command name (without `/`) is looked up in the command registry
3. If found, the command handler executes and the result is displayed
4. If not found, an error message shows available commands

### Simple Commands (No Arguments)

| Command | Description |
|---------|-------------|
| `/help` | Show all slash commands and usage |
| `/team` | Print team status (teammates and their status) |
| `/todos` | Print current todo list |
| `/skills` | List all available skills |
| `/save` | Save current session to `~/.mycc/sessions` |
| `/clear` | Clear conversation history |
| `/compact` | Manually trigger conversation compaction |
| `/domain` | List wiki domains (shortcut for `/wiki domains`) |
| `/plan` | Quick switch to plan mode |
| `/mindmap` | Show mindmap status |

### Commands with Arguments

#### `/mindmap`

Manage mindmap knowledge tree.

```
/mindmap              - Show mindmap status
/mindmap compile      - Compile mindmap from CLAUDE.md
/mindmap validate     - Validate mindmap structure
```

#### `/mode`

Switch between agent modes.

```
/mode                 - Show current mode
/mode plan            - Switch to plan mode (no code changes)
/mode normal          - Switch to normal mode
```

#### `/index`

Manage wiki domain indices.

```
/index                - Show all domain indices
/index rebuild        - Rebuild all domain indices
```

#### `/issues`

List issues or show specific issue details.

```
/issues           - List all issues
/issues <id>      - Show specific issue details
```

#### `/load`

List or load sessions.

```
/load             - List available sessions
/load <id>        - Load a specific session
```

#### `/wiki`

Manage knowledge base WAL files and domains.

```
/wiki                      - Show today's WAL file
/wiki edit [date]          - Open WAL file for editing
/wiki rebuild              - Rebuild vector store from WAL files
/wiki delete <hash>        - Delete document by hash
/wiki domains              - List all domains
/wiki domains add <name> <description>    - Add domain
/wiki domains remove <name>               - Remove domain
```

### Bang Command (!)

Access interactive terminal.

```
!<command>         - Run command in interactive terminal popup
!                  - Open terminal shell
```

**Examples**:
```
!pnpm test         - Run tests with interactive prompts
!vim config.json   - Edit a file
!ssh user@host     - SSH to remote server
```

### Exit Commands

| Command | Description |
|---------|-------------|
| `q` | Exit immediately |
| `exit` | Exit immediately |
| `quit` | Exit immediately |
| `Enter` (empty line) | Exit after confirmation |

---

## Tools Overview

### File Operations

| Tool | Description |
|------|-------------|
| `bash` | Run shell commands (blocking) |
| `read_file` | Read file contents (first 1000 lines) |
| `write_file` | Create or replace file |
| `edit_file` | Replace exact text in file |
| `hand_over` | Open interactive terminal (for commands requiring user input) |

### Communication

| Tool | Scope | Description |
|------|-------|-------------|
| `brief` | main, child | Display status message to user |
| `mail_to` | main, child | Send async message to teammate/lead |
| `broadcast` | main only | Send message to all teammates |

### Issue Management

| Tool | Description |
|------|-------------|
| `issue_create` | Create a new issue |
| `issue_claim` | Claim an issue to work on |
| `issue_close` | Close an issue |
| `issue_comment` | Add comment to issue |
| `issue_list` | List all issues |
| `blockage_create` | Create blocking relationship |
| `blockage_remove` | Remove blocking relationship |

### Team Management

| Tool | Scope | Description |
|------|-------|-------------|
| `tm_create` | main only | Create a teammate (child process) |
| `tm_remove` | main only | Remove a teammate |
| `tm_await` | main only | Wait for teammate(s) to finish |
| `tm_print` | all | Print team status |
| `order` | main only | Send task to teammate and wait for completion |

### Background Tasks

| Tool | Description |
|------|-------------|
| `bg_create` | Run command in background (async) |
| `bg_print` | List background tasks |
| `bg_remove` | Kill background task |
| `bg_await` | Wait for background tasks |

### Git Worktrees

| Tool | Description |
|------|-------------|
| `wt_create` | Create new worktree |
| `wt_print` | List worktrees |
| `wt_enter` | Switch to worktree |
| `wt_leave` | Leave current worktree |
| `wt_remove` | Remove worktree |

### Wiki Knowledge Base

| Tool | Description |
|------|-------------|
| `wiki_prepare` | Validate document before storing |
| `wiki_put` | Store document in knowledge base |
| `wiki_get` | Search knowledge base by similarity |

### Mindmap Navigation

| Tool | Description |
|------|-------------|
| `recall` | Navigate mindmap knowledge tree (start with `recall(path="/")`) |

### Git Operations

| Tool | Description |
|------|-------------|
| `git_commit` | Execute git commit with user permission check |
| `skill_compile` | Compile skill "when" condition into hook |

### Plan Mode

| Tool | Description |
|------|-------------|
| `plan_on` | Switch to plan mode (blocks code changes) |
| `plan_off` | Switch back to normal mode |

### Other Tools

| Tool | Description |
|------|-------------|
| `todo_write` | Update todo list |
| `time` | Get current date and time |
| `skill_load` | Load skill by name or semantic search |
| `screen` | Capture and describe screen |
| `read_picture` | Read and describe image file |
| `read_read` | Summarize long content from files |
| `web_search` | Search the web |
| `web_fetch` | Fetch web content |

---

## Knowledge Management

### Mindmap vs Wiki

These are **separate concerns** with different purposes:

| Aspect | Wiki | Mindmap |
|--------|------|---------|
| **Purpose** | General knowledge storage | CLAUDE.md navigation |
| **Content** | User-curated facts/rules | Compiled from markdown |
| **Storage** | Vector database (RAG) | JSON file |
| **Query** | Semantic search (similarity) | Path traversal |
| **Scope** | Project-level, shared | Process-level, isolated |
| **Tools** | wiki_put, wiki_get, wiki_prepare | recall |
| **Commands** | /wiki | /mindmap |

### When to Use Which?

**Use Wiki when:**
- Storing facts, rules, or references for semantic retrieval
- Knowledge should be shared across all agents
- Content doesn't belong in CLAUDE.md

**Use Mindmap when:**
- Navigating structured project documentation
- Agent needs hierarchical context from CLAUDE.md
- Querying specific sections by path

### Wiki Best Practices

1. **Validate before storing**: Use `wiki_prepare` to check content length and quality
2. **Use domains**: Organize knowledge by domain (e.g., "project", "architecture", "api")
3. **Add references**: Include URLs or file paths for traceability
4. **Keep content factual**: Store facts and rules, not opinions

### Mindmap Best Practices

1. **Organize CLAUDE.md well**: Use clear section headings for predictable paths
2. **Recompile after changes**: Run `/mindmap compile` when CLAUDE.md is modified
3. **Start from root**: Use `recall(path="/")` to discover top-level topics
4. **Navigate hierarchically**: Follow children paths to relevant sections

### Mindmap Code Block Handling

The mindmap compiler properly handles headings inside code blocks:

**Example:**
```markdown
# Main Section

This is regular content.

```markdown
## This is NOT a separate section
It stays as code block content
```

## Real Section

This becomes a child section.
```

**Compilation result:**
- **Main Section** (H1) - contains the code block in its text
- **Real Section** (H2) - child of Main Section
- The `## This is NOT a separate section` inside the code block is **ignored** as a section heading

**How it works:**
- Code blocks (```...```) are detected and tracked
- Headings inside code blocks are treated as literal text, not section delimiters
- The code block content is preserved in the parent node's `text` field
- This prevents unintended section creation from code examples

**Important:**
- Both standard (```) and language-specific (```markdown, ```bash, etc.) code blocks are supported
- Nested code blocks are handled correctly
- The heading syntax (`#`, `##`, etc.) is preserved in the text but not interpreted

---

## Troubleshooting

### Common Issues

#### Connection Failed to Ollama

**Symptoms**: "Failed to connect to Ollama" error

**Solutions**:
1. Ensure Ollama is running: `ollama serve`
2. Check `OLLAMA_HOST` in `.env`
3. Verify the URL is accessible: `curl http://127.0.0.1:11434/api/version`

#### Model Not Found

**Symptoms**: "Model not found" error

**Solutions**:
1. List available models: `ollama list`
2. Pull the model: `ollama pull <model-name>`
3. Update `OLLAMA_MODEL` in `.env`

#### SQLite Database Errors

**Symptoms**: Database locked or corrupted

**Solutions**:
1. Stop all mycc processes
2. Delete `.mycc/state.db` and `.mycc/state.db-wal`
3. Restart mycc (database will be recreated)

#### Child Process Teammates Not Responding

**Symptoms**: Teammates stuck in "working" status

**Solutions**:
1. Use `tm_print` to check status
2. Use `tm_remove` with `force: true` to terminate
3. Check for error messages in console

#### Token Limit Exceeded

**Symptoms**: "Token threshold exceeded" or auto-compact triggered frequently

**Solutions**:
1. The agent auto-compacts when tokens exceed threshold
2. If issues persist, reduce context length in conversations
3. Consider breaking tasks into smaller issues

#### Mindmap Missing or Invalid

**Symptoms**: Warning at startup about missing or invalid mindmap

**Solutions**:
1. Run `/mindmap compile` to create mindmap
2. Run `/mindmap validate` to check validity
3. Recompile if CLAUDE.md has been modified

#### Setup Wizard Not Starting

**Symptoms**: `mycc --setup` produces no output or exits immediately

**Solutions**:
1. **Check interactive terminal**: Setup requires a TTY
   ```bash
   # Running in CI or pipe will fail
   echo "" | mycc --setup  # ✗ Won't work
   
   # Run directly in terminal
   mycc --setup  # ✓ Works
   ```

2. **Check global link**: Ensure `mycc` is linked globally
   ```bash
   which mycc
   # Should show path like /usr/local/bin/mycc
   
   # If not found, link it
   pnpm link  # or npm link
   ```

3. **Check minimist parsing**: Verify `--setup` flag is recognized
   ```bash
   # Add debug logging temporarily
   mycc --setup --verbose
   ```

4. **Check Node.js version**: Requires Node.js v18 or higher
   ```bash
   node --version
   ```

#### Environment Validation Failure

**Symptoms**: mycc exits with code 2 and shows "Missing required environment variables"

**Solutions**:
1. **Run setup wizard**:
   ```bash
   mycc --setup
   ```

2. **Create config manually**:
   ```bash
   mkdir -p ~/.mycc-store
   nano ~/.mycc-store/.env
   ```

3. **Check config location**: Ensure `.env` is in correct directory
   - User-level: `~/.mycc-store/.env`
   - Project-level: `./.mycc/.env`

4. **Verify .env syntax**: Ensure proper format
   ```bash
   # Correct format
   OLLAMA_HOST=http://127.0.0.1:11434
   OLLAMA_MODEL=codellama:7b
   
   # Wrong format (no spaces around =)
   OLLAMA_HOST = http://127.0.0.1:11434  # ✗ Won't work
   ```

#### Ollama Not Installed

**Symptoms**: Setup wizard shows "Ollama not found, skipping model pull"

**Solutions**:
1. **Install Ollama**:
   ```bash
   # Linux/macOS
   curl https://ollama.ai/install.sh | sh
   
   # Or download from https://ollama.ai
   ```

2. **Verify installation**:
   ```bash
   ollama --version
   ollama list
   ```

3. **Start Ollama service**:
   ```bash
   ollama serve
   ```

4. **Continue without Ollama**: Setup will still save configuration
   - You can pull models manually later: `ollama pull <model>`

#### Permission Denied on Config Directory

**Symptoms**: "Permission denied" error when creating `.mycc-store` or `.mycc`

**Solutions**:
1. **Check directory permissions**:
   ```bash
   ls -la ~ | grep mycc-store
   ls -la . | grep mycc
   ```

2. **Fix permissions**:
   ```bash
   chmod 755 ~/.mycc-store
   # Or recreate
   rm -rf ~/.mycc-store
   mycc --setup
   ```

3. **Run from accessible directory**:
   - Avoid running from system directories
   - Use user home or project directories

#### Model Pull Fails

**Symptoms**: "Failed to pull model" during setup

**Solutions**:
1. **Check Ollama server**:
   ```bash
   curl http://127.0.0.1:11434/api/tags
   ```

2. **Pull model manually**:
   ```bash
   ollama pull codellama:7b
   ```

3. **Check model name**: Ensure exact model name
   ```bash
   ollama list  # List available models
   ```

4. **Network issues**: Check firewall/proxy settings
   ```bash
   # Set proxy if needed
   export HTTP_PROXY=http://proxy:8080
   export HTTPS_PROXY=http://proxy:8080
   ```

#### Config File Not Loading

**Symptoms**: Settings not applied despite `.env` file existing

**Solutions**:
1. **Check file location**:
   ```bash
   # User-level
   ls -la ~/.mycc-store/.env
   
   # Project-level
   ls -la ./.mycc/.env
   ```

2. **Check file format**: No BOM, proper line endings
   ```bash
   file ~/.mycc-store/.env
   # Should show: ASCII text
   ```

3. **Check precedence**: Project-level overrides user-level
   ```bash
   # If both exist, project-level wins
   cat ./.mycc/.env
   ```

4. **Verify loading**: Use verbose mode
   ```bash
   mycc --verbose
   # Look for "[config]" messages
   ```

---

## Technical Reference

### Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    Lead Agent                        │
│  ┌───────────────────────────────────────────────┐   │
│  │              AgentContext                     │   │
│  │  ┌─────┬──────┬──────┬───────┬────┬────┬───┬────┐ │
│  │  │core │ todo │ mail │ issue │ bg │ wt │tm │wiki│ │
│  │  └─────┴──────┴──────┴───────┴────┴────┴───┴────┘ │
│  └───────────────────────────────────────────────┘   │
│                       │                              │
│              ┌────────┴────────┐                     │
│              ▼                 ▼                     │
│        ┌──────────┐     ┌──────────┐                 │
│        │Teammate 1│     │Teammate 2│                 │
│        │(child)   │     │(child)   │                 │
│        └──────────┘     └──────────┘                 │
└──────────────────────────────────────────────────────┘
```

### Tool Scope Constraints

| Agent Type | Available Tools |
|------------|-----------------|
| Lead (main) | All tools |
| Teammate (child) | Cannot use: `broadcast`, `tm_create`, `tm_remove`, `tm_await`, `order` |
| Background (bg) | Only: `bash`, `read_file`, `write_file`, `edit_file` |

### STAR Loop Implementation

The agent loop follows the STAR principle:

1. **Situation**: Collect mail messages and check todo nudging
2. **Task**: Build system prompt with current context
3. **Action**: Call LLM with available tools
4. **Result**: Execute tool calls and add results to message history

Key mechanisms:
- `microCompact()`: Merges consecutive tool results
- `autoCompact()`: LLM-based compression when exceeding token threshold
- Todo nudging: Reminds agent every 3 iterations about open todos

### Ollama Client Architecture

The Ollama client provides resilient LLM integration:

1. **Exponential Backoff with Jitter**: Handles transient network errors
2. **Two-Tier Timeout System**: Prevents hanging on slow responses
   - First-Token Timeout: Ensures model starts responding
   - Response Timeout: Ensures stream completes
3. **Stream Collection and Cancellation**: Integrates with `AbortSignal`
4. **Error Categorization**: Determines recovery strategy
   - Transient Errors → Automatic retry
   - User-Action Errors → Stop and notify
   - Fatal Errors → Immediate stop

### Database Schema

SQLite tables in `.mycc/state.db`:

| Table | Purpose |
|-------|---------|
| `issues` | Persisted tasks with status, owner, content |
| `issue_blockages` | Blocking relationships between issues |
| `teammates` | Team member state and status |
| `worktrees` | Git worktree records |

### File Locations

| Path | Description |
|------|-------------|
| `src/tools/*.ts` | Built-in tool implementations |
| `.mycc/tools/*.ts` | User-defined tools (hot-reload) |
| `skills/*.md` | Built-in skill definitions |
| `.mycc/skills/*.md` | User-defined skills (hot-reload) |
| `.mycc/mail/*.jsonl` | Mailbox files for inter-agent communication |
| `.mycc/mindmap.json` | Compiled mindmap from CLAUDE.md |
| `~/.mycc-store/wiki/db/` | LanceDB vector store for knowledge base |
| `~/.mycc-store/wiki/logs/*.wal` | Write-Ahead Log files (daily) |
| `~/.mycc-store/wiki/domains.json` | Domain registry with metadata |

---

## Appendix

### Adding Custom Tools

1. Create `.mycc/tools/my_tool.ts`:

```typescript
import type { ToolDefinition, AgentContext } from '../types.js';

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'Description for LLM',
  input_schema: {
    type: 'object',
    properties: {
      arg: { type: 'string', description: 'Argument description' },
    },
    required: ['arg'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const arg = args.arg as string;
    return `Result: ${arg}`;
  },
};
```

2. The tool will be auto-loaded on next start (hot-reload supported)

### Adding Custom Skills

Create `.mycc/skills/my_skill.md`:

```markdown
---
name: my_skill
description: What this skill does
keywords: [keyword1, keyword2]
when: condition for automatic activation (optional)
---

# My Skill

Detailed instructions for the LLM to follow...
```

Skills provide specialized knowledge to guide the agent's behavior.

### Slash Command Registry

Commands are implemented in `src/slashes/`:

```typescript
interface SlashCommand {
  name: string;           // Command name without slash
  description: string;    // Short description for help
  aliases?: string[];     // Alternative names
  handler: (context: SlashCommandContext) => Promise<void> | void;
}
```

To add a new command:
1. Create a new file in `src/slashes/`
2. Export a `SlashCommand` object
3. Import and register in `src/slashes/index.ts`

---

## Support

For issues, questions, or contributions:
- Check the `docs/` directory for detailed documentation
- Review `CLAUDE.md` for development guidance
- Submit issues via the project repository

---

**Changes from v1.0:**
- Added interactive setup wizard (`mycc --setup`)
- Added environment validation on startup
- Added config location options (user-level vs project-level)
- Added automatic model pulling during setup
- Added cross-platform setup support (Linux, macOS, Windows)
- Added sensitive value redaction for API keys
- Added non-interactive terminal detection
- Added mindmap knowledge navigation system
- Added plan mode for safe code review
- Added `recall` tool for mindmap navigation
- Added `git_commit` tool with permission check
- Added `skill_compile` tool for hook compilation
- Added `hand_over` tool for interactive commands
- Added `order` tool for synchronous teammate tasks
- Added `read_read` tool for summarizing long content
- Added `OLLAMA_VISION_MODEL` and `OLLAMA_EMBEDDING_MODEL` env vars
- Updated slash commands (now 15 commands)
- Enhanced Ollama client with resilience patterns
- Improved startup health check sequence
- Added comprehensive knowledge management section
- Added best practices for wiki and mindmap usage
- Added setup troubleshooting guide
- Added manual configuration instructions

---

*This manual was generated for mycc - Node.js coding agent with Ollama LLM integration.*