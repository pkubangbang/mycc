# Mindmap Usage Guide

This guide explains how to use the mindmap feature from a user's perspective.

## Overview

The mindmap is a navigable knowledge structure compiled from your project's `CLAUDE.md` file. It enables the agent to efficiently retrieve project-specific knowledge on-demand, rather than loading the entire CLAUDE.md into context at startup.

### Why Use Mindmap?

- **Efficient Context**: Only load the knowledge you need, when you need it
- **Structured Navigation**: Traverse knowledge hierarchically via paths
- **On-Demand Retrieval**: Agent pulls relevant context via `get_node` tool
- **Persistent Memory**: Compiled mindmap persists across sessions

## Slash Commands

The mindmap feature provides several slash commands for management.

### `/mindmap compile [file]`

Compile a markdown file into a mindmap.

**Usage:**
```
/mindmap compile              # Compile ./CLAUDE.md
/mindmap compile ./docs/api.md   # Compile specific file
```

**What it does:**
1. Parses the markdown file into a tree structure
2. Generates summaries for each node using A-N-C-E algorithm
3. Creates `.mycc/mindmap.json` with the compiled structure
4. Stores hash of source file for validation

**Output:**
- `.mycc/mindmap.json` - The compiled mindmap

**Example:**
```
> /mindmap compile
Compiling CLAUDE.md...
Parsed 15 sections into tree structure.
Summarizing nodes (bottom-up)...
✓ Mindmap compiled: 15 nodes, root summary: "Project overview..."
```

### `/mindmap get <path>`

Query a node's information by path.

**Usage:**
```
/mindmap get /                     # Get root node
/mindmap get /skill               # Get skill section
/mindmap get /skill/example       # Get nested section
```

**Output:**
- Node ID (path)
- Title
- Summary
- Children list (for navigation)

**Example:**
```
> /mindmap get /skill
Node: /skill
Title: Skills
Summary: Dynamic skill loading system for specialist knowledge...
Children:
  - /skill/example
  - /skill/anti-pattern
  - /skill/loading
```

### `/mindmap patch <path> <text>`

Update a node's content and trigger cascading summary updates.

**Usage:**
```
/mindmap patch /skill/example "New content here"
```

**What it does:**
1. Updates the node's text
2. Re-summarizes all descendants (bottom-up)
3. Re-summarizes all ancestors (up to root)
4. Updates `.mycc/mindmap.json`

**Note:** This updates the mindmap only, not the source CLAUDE.md file. To persist changes, update CLAUDE.md and recompile.

### `/mindmap validate`

Check if the mindmap is in sync with the source file.

**Usage:**
```
/mindmap validate
```

**Output:**
- Valid/Invalid status
- If invalid: suggestion to recompile

**Example:**
```
> /mindmap validate
✓ Mindmap is valid and in sync with CLAUDE.md
```

## Tool Usage: get_node

The `get_node` tool is available to the agent for knowledge retrieval.

### Tool Definition

```
Tool: get_node
Description: Retrieve a node from the mindmap by path.
Parameters:
  - path (required): Slash-separated path to the node (e.g., "/skill/example")
Returns:
  - Node information including title, summary, and children
```

### How Agents Use It

When an agent needs project-specific knowledge:

1. **Start from root**: Agent queries `/` to see top-level topics
2. **Navigate down**: Agent follows children paths to relevant sections
3. **Retrieve context**: Agent uses node summaries for understanding

**Example Agent Workflow:**
```
Agent receives query about skills →
Agent calls get_node(path="/") →
Sees "skill" in children →
Agent calls get_node(path="/skill") →
Sees "loading" in children →
Agent calls get_node(path="/skill/loading") →
Gets detailed summary about skill loading
```

### Context Injection

At startup, the agent receives:
- Root node summary
- Instruction: "Use `get_node` tool to navigate project knowledge as needed"

This replaces loading the entire CLAUDE.md into context.

## Startup Behavior

### Mindmap Loading

When mycc starts:

```
┌────────────────────────────────────────────────────────────────┐
│                       Startup Sequence                          │
├────────────────────────────────────────────────────────────────┤
│  1. Check for .mycc/mindmap.json                               │
│     │                                                           │
│     ├─ File exists?                                             │
│     │  ├─ Yes → Validate hash against CLAUDE.md                │
│     │  │         ├─ Valid → Load mindmap into context           │
│     │  │         └─ Invalid → Warning, suggest recompile       │
│     │  │                                                        │
│     │  └─ No → Warning: "Run /mindmap compile"                 │
│     │                                                           │
│  2. Prepare agent context                                       │
│     ├─ Load root node summary (if available)                   │
│     └─ Add navigation instruction                               │
│                                                                 │
│  3. Agent ready with minimal context                            │
│     └─ Agent uses get_node for on-demand knowledge             │
└────────────────────────────────────────────────────────────────┘
```

### Validation Check

The startup validation compares:
- Stored hash in `mindmap.json`
- Current hash of `CLAUDE.md`

If they differ, the mindmap is stale and a warning is shown.

### Fallback Behavior

If mindmap is missing or invalid:
- Agent still starts with minimal context
- Warning message displayed
- Agent may lack project-specific knowledge
- User advised to run `/mindmap compile`

## Process Isolation

### Independent Instances

Each agent process has its own mindmap instance:

| Process | Mindmap File | Isolation |
|---------|--------------|------------|
| Lead (main) | `.mycc/mindmap.json` | Independent |
| Teammate A | `.mycc/mindmap-teammate-a.json` | Independent |
| Teammate B | `.mycc/mindmap-teammate-b.json` | Independent |

### Why Isolation?

1. **No IPC Overhead**: Each process loads its own copy
2. **No Race Conditions**: Updates don't conflict
3. **Worktree Independence**: Teammates in different worktrees have separate contexts
4. **Clean Isolation**: Process failures don't affect others

### Cross-Process Knowledge Sharing

If knowledge must be shared between agents:

| Method | Use Case |
|--------|----------|
| Wiki (wiki_put/wiki_get) | Shared persistent knowledge |
| mail_to | Point-to-point communication |
| Issue system | Shared task tracking |

**Mindmap is NOT for inter-process communication.**

### Compilation Per Process

Each process compiles its own mindmap:

```
Lead process:
  CLAUDE.md → compile_mindmap → .mycc/mindmap.json

Teammate process (in worktree):
  worktree/CLAUDE.md → compile_mindmap → .mycc/mindmap-{name}.json
```

Each worktree may have different CLAUDE.md content, leading to different mindmaps.

## Wiki vs Mindmap

These are **separate concerns** with different purposes:

| Aspect | Wiki | Mindmap |
|--------|------|---------|
| **Purpose** | General knowledge storage | CLAUDE.md navigation |
| **Content** | User-curated facts/rules | Compiled from markdown |
| **Storage** | Vector database (RAG) | JSON file |
| **Query** | Semantic search (similarity) | Path traversal |
| **Scope** | Project-level, shared | Process-level, isolated |
| **Tools** | wiki_put, wiki_get, wiki_prepare | get_node |
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

## Best Practices

### CLAUDE.md Structure

Organize your CLAUDE.md for effective mindmap navigation:

```markdown
# Project Overview
Brief description of the project...

## Architecture
High-level architecture decisions...

### Components
Details about components...

## Development
How to develop...

### Setup
Development environment setup...
```

This creates a navigable tree:
- `/` (root)
- `/architecture`
- `/architecture/components`
- `/development`
- `/development/setup`

### Code Block Handling

The compiler properly handles headings inside code blocks - they are NOT parsed as sections:

**Example:**
```markdown
# Main Section

Regular content here.

```markdown
## This is NOT a separate section
It stays as code block content.
```

## Real Section

This becomes a child section.
```

**Compilation result:**
- Main Section (H1) - contains the code block in its text
- Real Section (H2) - child of Main Section
- The `## This is NOT a separate section` inside the code block is **ignored**

**How it works:**
- Code blocks (\`\`\`...\`\`\`) are detected during parsing
- Any headings inside code blocks are treated as literal text
- This prevents unintended sections from code examples
- Both standard (\`\`\`) and language-specific (\`\`\`markdown, \`\`\`bash, etc.) blocks are supported

### When to Recompile

Recompile when:
- CLAUDE.md is modified
- Starting a new session after CLAUDE.md changes
- Validation fails at startup

### Performance Tips

- Keep CLAUDE.md reasonably sized (mindmap is for navigation, not storing everything)
- Use clear section headings for predictable paths
- Let the agent navigate rather than loading everything upfront
