---
name: mycc-online-hotfix
description: >
  Hotfix workflow for debugging and fixing mycc's own tools using the hand_over tool.
  Use when mycc's tools have bugs and need live testing without restarting the app.
  Covers the iterative process: edit source, test with hand_over + tmux, debug via capture-pane, commit.
  Platform-agnostic - works on Windows, Linux, macOS.
keywords: [hotfix, debug, hand_over, tmux, interactive, live-testing, fix, tool-bug]
when: after tool execution error, if the error is from mycc's own code (tools, handlers, skills) and needs live debugging
---

# mycc-online-hotfix

Hotfix workflow for debugging and fixing mycc's own tools using the hand_over tool.

## Overview

This skill provides a systematic approach to debug and fix mycc's own code by:
1. Editing source code
2. Testing interactively via hand_over + tmux
3. Iterating until the fix works
4. Committing the changes

**Key benefit:** No need to restart mycc - test fixes immediately in a live session.

## When to Use

Use this skill when:
- A mycc tool (git_commit, bash, etc.) fails with errors
- The error is in mycc's own code, not external factors
- You need to test fixes interactively before committing
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
npm run typecheck
```

### Step 3: Test with hand_over

Start mycc interactively using hand_over:
```
hand_over command: "mycc --skip-healthcheck"
```

This creates a tmux session. Note the session name (e.g., `mycc-1777259047698`).

### Step 4: Interact via tmux

**Check output:**
```
tmux capture-pane -t SESSION_NAME -p
```

**Send commands:**
```
tmux send-keys -t SESSION_NAME your command here Enter
```

**Important:** When sending single character responses like `y` or `n`, do NOT use quotes:
- Correct: `tmux send-keys -t session y Enter`
- Wrong: `tmux send-keys -t session "y" Enter` (passes literal quotes)

Wait for prompts by repeatedly capturing the pane until you see:
- `agent >>` - ready for input
- `[question]` - waiting for user response
- `> ` - input prompt

### Step 5: Iterate

If the fix doesn't work:
1. Read the error output from capture-pane
2. Kill the session: `tmux kill-session -t SESSION_NAME`
3. Go back to Step 2 with a new fix

### Step 6: Clean Up and Commit

After successful test:
```
tmux kill-session -t SESSION_NAME
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

**Unix bash:** Usually handles quotes correctly, but still test via hand_over.

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
npm run typecheck

# 3. Start mycc
hand_over command: "mycc --skip-healthcheck"
# Session: mycc-1777259047698

# 4. Send test command
tmux send-keys -t mycc-1777259047698 "commit the changes" Enter

# 5. Wait and check
tmux capture-pane -t mycc-1777259047698 -p

# 6. Respond to prompt (no quotes!)
tmux send-keys -t mycc-1777259047698 y Enter

# 7. Verify result
tmux capture-pane -t mycc-1777259047698 -p

# 8. Clean up
tmux kill-session -t mycc-1777259047698
```

## Verification Checklist

- [ ] Identified the root cause before fixing
- [ ] Made minimal, targeted changes
- [ ] Ran typecheck after editing
- [ ] Tested interactively via hand_over
- [ ] Verified the fix works
- [ ] Cleaned up tmux sessions
- [ ] Committed the changes