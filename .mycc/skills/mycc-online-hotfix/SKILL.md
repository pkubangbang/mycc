---
name: mycc-online-hotfix
description: >
  Hotfix workflow for debugging and fixing mycc's own tools using bash + tmux.
  Use when mycc's tools have bugs and need live testing without restarting the app.
  Covers the iterative process: edit source, test with bash + tmux (non-interruptive), debug via capture-pane, commit.
  Platform-agnostic - works on Windows, Linux, macOS.
keywords: [hotfix, debug, bash, tmux, live-testing, fix, tool-bug]
when: after tool execution error, if the user has mentioned "tmux" to test the mycc
---

# mycc-online-hotfix

Hotfix workflow for debugging and fixing mycc's own tools using bash + tmux.

## Overview

This skill provides a systematic approach to debug and fix mycc's own code by:
1. Editing source code
2. Testing via bash + tmux (non-interruptive to user)
3. Iterating until the fix works
4. Committing the changes

**Key benefit:** No need to restart mycc - test fixes immediately in a live session. No user interruption required.

## Why bash + tmux (NOT hand_over)

The `hand_over` tool opens a popup terminal that **interrupts the user**. It should only be used when the user explicitly requests an interactive terminal.

Instead, use `bash` tool with tmux commands - this runs non-interactively without blocking:

```bash
# Create session (non-blocking)
bash command: "tmux new-session -s mycc-test -d -x 120 -y 40"
bash intent: "Create detached tmux session for testing"
bash timeout: 5

# Send commands (non-blocking)
bash command: "tmux send-keys -t mycc-test 'mycc --skip-healthcheck' Enter"
bash intent: "Start mycc in test session"
bash timeout: 5

# Capture output (non-blocking)
bash command: "tmux capture-pane -t mycc-test -p -S -100"
bash intent: "Check mycc output for testing"
bash timeout: 5
```

## When to Use

Use this skill when:
- A mycc tool (git_commit, bash, etc.) fails with errors
- The error is in mycc's own code, not external factors
- You need to test fixes before committing
- Platform-independent - works on Windows, Linux, macOS

## The Workflow

### Step 1: Identify the Problem

Before starting, understand what's broken:
- Read the relevant source files
- Check error messages from previous attempts
- Identify the root cause hypothesis

### Step 2: Make the Fix

Edit the source file with your fix:
```
edit_file path: "src/tools/xxx.ts"
```

Always run typecheck after editing:
```
pnpm typecheck
```

### Step 3: Test with bash + tmux

**Important:** Use `bash` tool with tmux commands, NOT `hand_over`. The `hand_over` tool opens a popup terminal that interrupts the user. Use bash + tmux for non-interruptive testing.

Create a tmux session and start mycc:
```
# Create detached session (use unique session name)
bash command: "tmux new-session -s mycc-test -d -x 120 -y 40"
bash intent: "Create detached tmux session for testing"
bash timeout: 5

# Start mycc in the session
bash command: "tmux send-keys -t mycc-test 'mycc --skip-healthcheck' Enter"
bash intent: "Start mycc in test session"
bash timeout: 5
```

Note the session name (e.g., `mycc-test`). Use a consistent, predictable name for easier cleanup.

### Step 4: Interact via tmux (bash tool)

**Check output:**
```
bash command: "tmux capture-pane -t mycc-test -p -S -100"
bash intent: "Check mycc output for testing"
bash timeout: 5
```

**Send commands:**
```
bash command: "tmux send-keys -t mycc-test 'your command here' Enter"
bash intent: "Send test command to mycc"
bash timeout: 5
```

**Important:** When sending single character responses like `y` or `n`, do NOT use quotes:
- Correct: `tmux send-keys -t mycc-test y Enter`
- Wrong: `tmux send-keys -t mycc-test "y" Enter` (passes literal quotes)

Wait for prompts by repeatedly capturing the pane until you see:
- `agent >>` - ready for input
- `[question]` - waiting for user response
- `> ` - input prompt

### Step 5: Iterate

If the fix doesn't work:
1. Read the error output from capture-pane
2. Kill the session: `bash command: "tmux kill-session -t mycc-test" intent: "Kill test session" timeout: 5`
3. Go back to Step 2 with a new fix

### Step 6: Clean Up and Commit

After successful test:
```
bash command: "tmux kill-session -t mycc-test"
bash intent: "Kill test session after successful test"
bash timeout: 5
```

Then commit the changes (can use the tested mycc session or direct git).

## Common Issues

### tmux send-keys Quote Handling

**Problem:** `tmux send-keys "y"` passes the quotes as part of the string.

**Solution:** Send without quotes:
```bash
tmux send-keys -t session y Enter  # NOT "y"
```

And strip quotes in response parsing:
```typescript
let normalized = response.trim().toLowerCase();
if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))) {
  normalized = normalized.slice(1, -1).trim();
}
```

### Shell Quoting Differences (Platform-Specific)

**Windows cmd.exe:** Treats quotes differently, may pass them literally to commands.

**Solution:** Use `spawn()` directly instead of shell-wrapping:
```typescript
import { spawn } from 'child_process';
const proc = spawn('git', args, { cwd: workDir });
```

**Unix bash:** Usually handles quotes correctly, but still test via bash + tmux.

### Path Handling

**Windows:** Convert backslashes to forward slashes for cross-platform tools like git:
```typescript
const gitPath = process.platform === 'win32'
  ? tempFile.replace(/\\/g, '/')
  : tempFile;
```

## Debugging Tips

1. **Add debug logging first** - Use `ctx.core.brief()` or temporary `console.log`
2. **Read error messages carefully** - They often reveal the exact issue
3. **Test incrementally** - Make one change at a time
4. **Check lint and typecheck** - After each edit

## Example Session

```
# 1. Edit the file
edit_file path: "src/tools/git_commit.ts"

# 2. Verify
pnpm typecheck

# 3. Create tmux session and start mycc (using bash tool, NOT hand_over)
bash command: "tmux new-session -s mycc-test -d -x 120 -y 40"
bash intent: "Create detached tmux session for testing"
bash timeout: 5

bash command: "tmux send-keys -t mycc-test 'mycc --skip-healthcheck' Enter"
bash intent: "Start mycc in test session"
bash timeout: 5

# 4. Send test command
bash command: "tmux send-keys -t mycc-test 'commit the changes' Enter"
bash intent: "Send test command to mycc"
bash timeout: 5

# 5. Wait and check output
bash command: "tmux capture-pane -t mycc-test -p -S -100"
bash intent: "Check mycc output"
bash timeout: 5

# 6. Respond to prompt (no quotes!)
bash command: "tmux send-keys -t mycc-test y Enter"
bash intent: "Respond yes to prompt"
bash timeout: 5

# 7. Verify result
bash command: "tmux capture-pane -t mycc-test -p -S -100"
bash intent: "Verify commit result"
bash timeout: 5

# 8. Clean up
bash command: "tmux kill-session -t mycc-test"
bash intent: "Kill test session"
bash timeout: 5
```

## Verification Checklist

- [ ] Identified the root cause before fixing
- [ ] Made minimal, targeted changes
- [ ] Ran typecheck after editing
- [ ] Tested via bash + tmux (NOT hand_over)
- [ ] Verified the fix works
- [ ] Cleaned up tmux sessions
- [ ] Committed the changes