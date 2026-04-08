# /dump Slash Command Design

## Overview

The `/dump` command provides a way to export the conversation history (trialogue) to a formatted markdown file for debugging, auditing, or offline analysis.

## Command Syntax

```
/dump           # Dump lead agent's trialogue
/dump <agent>   # Dump a specific teammate's trialogue
```

## Behavior

1. **Lead Agent Dump**: When called without arguments, dumps the current lead agent's trialogue from memory.

2. **Teammate Dump**: When called with an agent name, reads the teammate's trialogue from the persisted transcript file at `.mycc/transcripts/<agent>-trialogue.jsonl`.

3. **Output Format**: Generates a markdown file with:
   - Title: `# Trialogue Dump - <agent name>`
   - Timestamp: `**Generated:** <ISO timestamp>`
   - Message sections separated by `---`
   - Each message shows role (USER/ASSISTANT/TOOL), content, and tool calls if present

4. **File Location**: Temp file in `os.tmpdir()` with name `dump-<timestamp>.md`

5. **Editor Integration**: Opens the file in the system editor:
   - Uses `$EDITOR` or `$VISUAL` environment variable if set
   - Falls back to platform defaults: `open` (macOS), `start` (Windows), `xdg-open` (Linux)
   - Uses `agentIO.exec()` to allow graceful interruption via Ctrl+C

6. **Cleanup Strategy**:
   - **Blocking editors** (vim, nano, etc.): Delete temp file after editor closes
   - **Non-blocking editors** (xdg-open, open, start): Keep temp file since editor returns immediately

## Implementation Details

### formatTrialogueAsMarkdown Function

```typescript
function formatTrialogueAsMarkdown(
  messages: Message[], 
  agentName: string = 'Lead Agent'
): string
```

Formats an array of `Message` objects into markdown:

- Creates header with agent name and timestamp
- Iterates through messages, formatting each with:
  - Role as `## <ROLE>` header
  - Content (if present)
  - Tool calls (if present) as nested list
  - Tool name (if present)

### Message Format

```
# Trialogue Dump - Lead Agent
**Generated:** 2024-01-15T10:30:00.000Z

---
## USER
Please help me fix the bug in auth.ts

---
## ASSISTANT
I'll analyze the file...

**Tool Calls:**
- `read_file`
  - args: { "path": "src/auth.ts" }

---
## TOOL
**Tool:** read_file
<file contents>

---
```

### Integration Points

1. **Slash Command Handler**: Registered in the slash commands array in `main()`
2. **Trialogue Access**: Lead agent's trialogue accessed via `trialogue.getMessages()`
3. **Teammate Trialogues**: Read from `.mycc/transcripts/<name>-trialogue.jsonl` as JSONL (one message per line)
4. **AgentIO**: Uses `agentIO.exec()` for interruptible editor spawning

### Non-Blocking Editor Detection

```typescript
const nonBlockingEditors = ['xdg-open', 'open', 'start'];
const isNonBlockingEditor = nonBlockingEditors.includes(editor);
```

Non-blocking editors return immediately while the actual viewer opens in background. The temp file must be kept for these cases.

## Use Cases

1. **Debugging**: Inspect conversation history when agent behaves unexpectedly
2. **Auditing**: Review what tools were called and with what arguments
3. **Documentation**: Export conversation for external analysis or reporting
4. **Offline Review**: Share agent conversations with team members

## Potential Enhancements

1. **Output Format Options**: Add flags for JSON output (`/dump --json`)
2. **Filtering**: Add ability to filter by role, tool name, or time range
3. **Direct Output**: Add `--stdout` flag to print to console
4. **Persistent Storage**: Option to save to a specific file path instead of temp
5. **Search**: Add ability to search within trialogue history

## Restoration Notes

When restoring this functionality, the following components are needed:

1. `formatTrialogueAsMarkdown()` function in `agent-loop.ts`
2. Import for `getMyccDir` from `../context/db.js`
3. Import for `spawn` from `child_process`
4. Import for `os` and `fs` modules
5. `/dump` case handling in the slash command switch
6. Add `/dump` to the `slashCommands` array