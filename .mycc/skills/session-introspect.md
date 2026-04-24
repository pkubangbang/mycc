---
name: session-introspect
description: "Guide for parsing session files and triologues to find coordination errors. Use when debugging team coordination issues or analyzing session history."
tags: [session, debug, coordination, introspection, triologue]
---

# Session Introspection: Finding Coordination Errors

This skill guides you through parsing session files and triologues to identify potential errors in the coordination process.

## File Structure Overview

### Session File (`.mycc/sessions/*.json`)

```json
{
  "version": "1.0",
  "id": "uuid",
  "create_time": "ISO timestamp",
  "project_dir": "/path/to/project",
  "lead_triologue": "/path/to/lead-triologue.jsonl",
  "child_triologues": ["/path/to/child-triologue.jsonl"],
  "teammates": ["teammate-name"],
  "first_query": "user's first message"
}
```

**Key fields:**
- `lead_triologue`: Path to the lead agent's conversation log
- `child_triologues`: Array of paths to teammate conversation logs
- `teammates`: Array of teammate names that were spawned

### Triologue File (`.mycc/transcripts/*.jsonl`)

JSONL format - one JSON object per line:

```jsonl
{"role":"user","content":"..."}
{"role":"assistant","content":"...", "tool_calls":[...]}
{"role":"tool","tool_name":"tm_create","content":"...", "tool_call_id":"..."}
```

**Key roles:**
- `user`: Input from user or lead
- `assistant`: LLM response (lead or teammate)
- `tool`: Tool execution result

## Parsing Workflow

### Step 1: Load Session Metadata

```bash
# Find recent sessions
ls -lt .mycc/sessions/*.json | head -5

# Read session file
cat .mycc/sessions/<session-id>.json | jq .
```

**Extract:**
- Session ID and timestamps
- Teammate names from `teammates` array
- Paths to all triologue files

### Step 2: Parse Lead Triologue

```bash
# Read lead triologue (use jq for JSONL)
cat .mycc/transcripts/lead-*.jsonl | jq -c .

# Filter for tool calls only
cat .mycc/transcripts/lead-*.jsonl | jq -c 'select(.tool_calls != null)'

# Find specific tool patterns
cat .mycc/transcripts/lead-*.jsonl | jq -c 'select(.tool_name != null)'
```

**Look for coordination tools:**
- `tm_create`: Teammate spawned
- `tm_remove`: Teammate terminated
- `mail_to`: Message sent to teammate
- `tm_await`: Waiting for teammate(s)
- `tm_print`: Status check

### Step 3: Parse Child Triologues

```bash
# Read specific teammate's triologue
cat .mycc/transcripts/<teammate>-*.jsonl | jq -c .

# Find tool calls by teammate
cat .mycc/transcripts/<teammate>-*.jsonl | jq -c 'select(.tool_calls != null)'
```

**Track:**
- What tasks the teammate received (via `mail_to` from lead)
- What tools the teammate used
- What results were reported back (via `mail_to` to "lead")

## Error Patterns to Detect

### 1. Orphaned Teammates

**Pattern:** Teammate spawned but never used

```
Detection:
1. Find tm_create call in lead triologue
2. Check if mail_to was sent to that teammate
3. If no mail_to found → orphaned teammate
```

**Example error:**
```json
// Lead triologue shows tm_create
{"role":"tool","tool_name":"tm_create","content":"...created coder..."}

// But no subsequent mail_to to "coder" found
// Teammate was created but never tasked
```

### 2. Missing Cleanup

**Pattern:** Teammates not removed after use

```
Detection:
1. Count tm_create calls
2. Count tm_remove calls
3. If creates > removes → leaked teammates
```

**Note:** Some sessions intentionally keep teammates for reuse, but orphaned teammates indicate incomplete workflow.

### 3. Dead Mail

**Pattern:** Message sent to non-existent teammate

```
Detection:
1. Find all mail_to calls
2. Cross-reference with tm_create calls
3. If mail_to name not in created teammates → dead mail
```

**Example error:**
```json
// mail_to sent to "reviewer"
{"tool_name":"mail_to","arguments":{"name":"reviewer"...}}

// But tm_create for "reviewer" never called, or tm_remove already called
```

### 4. Premature Await

**Pattern:** Waiting for teammate before task sent

```
Detection:
1. Find tm_await call
2. Check if mail_to sent before tm_await
3. If await without prior mail_to → premature
```

### 5. Double Spawn

**Pattern:** Same teammate name created twice

```
Detection:
1. Extract all tm_create arguments (name field)
2. Check for duplicates
3. Duplicate names → potential conflict
```

### 6. Stale Reference

**Pattern:** Referencing removed teammate

```
Detection:
1. Build timeline: tm_create → [mail_to...] → tm_remove
2. Find any mail_to after tm_remove
3. mail_to after remove → stale reference
```

### 7. Timeout Without Handling

**Pattern:** tm_await timeout with no follow-up

```
Detection:
1. Find tm_await with timeout
2. Check subsequent messages for error handling
3. If timeout likely but no handling → potential hang
```

### 8. Empty Child Triologue

**Pattern:** Teammate created but no activity logged

```
Detection:
1. Get child_triologues paths from session
2. Check file sizes
3. Empty or minimal content → teammate never started properly
```

### 9. Mismatched Session State

**Pattern:** Session says teammate exists but triologue missing

```
Detection:
1. Get teammates array from session
2. Get child_triologues array
3. If len(teammates) != len(child_triologues) → mismatch
```

### 10. Circular Dependencies

**Pattern:** Issue blockages form a cycle

```
Detection:
1. Parse issue_create and blockage_create calls
2. Build dependency graph
3. Detect cycles in graph
```

### 11. Double-Spawn Within Session

**Pattern:** Same teammate name spawned twice in one session

```
Detection:
1. Count child_triologues in session JSON
2. Count teammates in session JSON
3. If child_triologues.length > teammates.length → double spawn occurred
4. Check for duplicate name prefixes in triologue filenames
```

**Example error:**
```json
// Session shows mismatch
{
  "teammates": ["prompt-expert", "tool-reviewer"],  // 2 teammates
  "child_triologues": [
    "prompt-expert-*.jsonl",
    "tool-reviewer-1111.jsonl",  // first spawn
    "tool-reviewer-2222.jsonl"   // second spawn (re-spawn)
  ]  // 3 triologues!
}
```

### 12. Cross-Session Orphaned Teammate

**Pattern:** Teammate from previous session blocks new spawn

```
Detection:
1. tm_create returns error: "already exists with status holding"
2. Check previous sessions for teammates not removed
3. Teammate persisted across session boundary
```

**Root cause:** Session cleanup did not remove teammates when session ended.

### 13. Todo State Corruption

**Pattern:** Todo list has duplicate or stale items

```
Detection:
1. Check for duplicate item names in todo list
2. Items numbered 1-9 and 10-18 with same content = duplication bug
3. Items marked done but reminders still appear = stale state
```

**Note:** The `todo_write` tool may append instead of replace, causing duplication.

### 14. Incomplete Teardown

**Pattern:** After error, teammates remain in invalid state

```
Detection:
1. Find tm_create error in lead triologue
2. Check if tm_remove was called for all created teammates
3. If creates != removes after error → incomplete teardown
```

**Example:**
```
tm_create("architect") → OK
tm_create("workflow-analyst") → OK
tm_create("tool-reviewer") → ERROR: already exists
// Only 2 teammates created, but 3 were attempted
// No cleanup for the 2 successful creates
```

## Diagnostic Commands

### Quick Session Summary

```bash
# Recent sessions with teammates
cat .mycc/sessions/*.json | jq -s '
  sort_by(.create_time) | reverse | 
  .[] | select(.teammates | length > 0) |
  {id, create_time, teammates, child_count: (.child_triologues | length)}
'
```

### Find All Coordination Tool Calls

```bash
# Extract coordination-related tool calls from lead
cat .mycc/transcripts/lead-*.jsonl | jq -c '
  select(.tool_calls != null) |
  .tool_calls[] | select(.function.name | 
    test("tm_|mail_to|issue_|blockage"))
'
```

### Build Teammate Timeline

```bash
# For a specific session, show teammate lifecycle
SESSION_ID="your-session-id"
SESSION=".mycc/sessions/${SESSION_ID}.json"
LEAD_TRI=$(cat $SESSION | jq -r '.lead_triologue')

echo "=== Teammate spawns ==="
cat $LEAD_TRI | jq -c 'select(.tool_name == "tm_create") | 
  {time: .tool_call_id, name: .arguments.name}'

echo "=== Messages sent ==="
cat $LEAD_TRI | jq -c 'select(.tool_name == "mail_to") | 
  {to: .arguments.name, title: .arguments.title}'

echo "=== Teammate removals ==="
cat $LEAD_TRI | jq -c 'select(.tool_name == "tm_remove") | 
  {name: .arguments.name}'
```

### Check Child Triologue Activity

```bash
# Count tool calls per child triologue
for f in .mycc/transcripts/*-triologue.jsonl; do
  if [[ "$f" != *"lead"* ]]; then
    count=$(grep -c '"tool_calls"' "$f" 2>/dev/null || echo 0)
    echo "$f: $count tool calls"
  fi
done
```

### Verify Mail Delivery

```bash
# Messages sent TO teammates
cat .mycc/transcripts/lead-*.jsonl | jq -c '
  select(.tool_name == "mail_to") | 
  select(.arguments.name != "lead") |
  {to: .arguments.name, title: .arguments.title}
'

# Messages sent FROM teammates (to lead)
cat .mycc/transcripts/*-triologue.jsonl | jq -c '
  select(.tool_name == "mail_to") |
  select(.arguments.name == "lead") |
  {from: .tool_call_id, title: .arguments.title}
' 2>/dev/null
```

## Verification Checklist

When analyzing a session for coordination errors:

- [ ] All spawned teammates received at least one task (mail_to)
- [ ] All teammates were properly removed (tm_remove) or still active
- [ ] No mail_to to non-existent teammates
- [ ] tm_await called after mail_to, not before
- [ ] No duplicate teammate names created
- [ ] child_triologues count matches teammates array length
- [ ] Child triologues contain expected activity
- [ ] No circular issue dependencies
- [ ] Timeout scenarios have error handling
- [ ] Session state consistent with triologue data
- [ ] No cross-session orphaned teammates (check "already exists" errors)
- [ ] Todo list has no duplicate items
- [ ] Teardown complete after errors (all creates have matching removes)

## Common Root Causes

### Incomplete Workflow

Teammate created but lead got distracted or hit an error before sending task. Check for tool errors near tm_create.

### Premature Shutdown

Session ended before cleanup. Check if tm_await timed out or user interrupted.

### Name Mismatch

Teammate created with one name but mail_to uses different name. Watch for typos.

### Race Condition

Lead assumed teammate ready before spawn completed. Always wait for tm_create success before mail_to.

### Cross-Session Persistence

Teammate from previous session not cleaned up, causing "already exists" error. Root cause: session management does not auto-remove teammates.

### Todo Tool Bug

Todo_write appends instead of replacing, causing duplicate items. This leads to stale reminders interrupting workflow.

### Incomplete Error Recovery

When tm_create fails, previously created teammates may not be cleaned up. Always remove all created teammates on error.

## Example Analysis

```bash
# Full session analysis script
analyze_session() {
  SESSION_FILE="$1"
  
  echo "=== Session: $(basename $SESSION_FILE) ==="
  
  # Extract paths
  LEAD=$(cat "$SESSION_FILE" | jq -r '.lead_triologue')
  CHILDREN=$(cat "$SESSION_FILE" | jq -r '.child_triologues[]')
  TEAMMATES=$(cat "$SESSION_FILE" | jq -r '.teammates[]')
  
  echo "Teammates: $TEAMMATES"
  echo "Children: $(echo $CHILDREN | wc -w)"
  
  # Check for spawns without mail
  echo ""
  echo "=== Spawns without mail ==="
  SPAWNED=$(cat "$LEAD" | jq -r 'select(.tool_name=="tm_create") | .arguments.name' 2>/dev/null)
  MAILED=$(cat "$LEAD" | jq -r 'select(.tool_name=="mail_to") | .arguments.name' 2>/dev/null)
  
  for name in $SPAWNED; do
    if ! echo "$MAILED" | grep -q "^$name$"; then
      echo "WARNING: '$name' spawned but never received mail"
    fi
  done
  
  # Check for missing removal
  echo ""
  echo "=== Missing cleanup ==="
  REMOVED=$(cat "$LEAD" | jq -r 'select(.tool_name=="tm_remove") | .arguments.name' 2>/dev/null)
  for name in $SPAWNED; do
    if ! echo "$REMOVED" | grep -q "^$name$"; then
      echo "INFO: '$name' not explicitly removed (may still be active)"
    fi
  done
}

# Run on all sessions
for s in .mycc/sessions/*.json; do
  analyze_session "$s"
  echo ""
done
```

## Summary

1. **Session file** contains metadata and paths to triologues
2. **Triologues** are JSONL conversation logs
3. **Key patterns**: orphaned teammates, missing cleanup, dead mail, stale references
4. **Use jq** to parse JSONL and extract relevant tool calls
5. **Build timelines** to understand teammate lifecycle
6. **Cross-reference** spawns vs mail vs removes to find gaps