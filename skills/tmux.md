---
name: tmux
description: Manage tmux sessions for remote SSH connections. Use when user needs to work with remote servers via tmux.
tags: [tmux, ssh, remote, server]
---

# Tmux Session Management

This skill manages tmux sessions for remote SSH work. It uses:
- `bash` tool to execute tmux commands
- `todo_write` tool to remember active sessions (agent memory)
- `question` tool to get user input (child agents only)

## Session Memory with todo_write

Use `todo_write` to remember which tmux session is active. The agent cannot use database persistence, so todos serve as session memory:

```json
// Remember: there is an active tmux session named "mycc-project"
{
  "items": [
    { "name": "tmux session: mycc-project", "done": false, "note": "→ api-prod-1" }
  ]
}
```

The `note` field stores the remote hostname. Mark `done: true` when the session is killed.

## Workflow

### 1. Create New Session

```bash
# Create session with project-based name
tmux new-session -d -s "mycc-$(basename $(pwd) | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')"
```

**Immediately**: Use `todo_write` to remember the session:

```json
{
  "items": [
    { "name": "tmux session: mycc-myapp", "done": false, "note": "→ ? (waiting for SSH)" }
  ]
}
```

Tell the user to attach and SSH:
```
Session created. Please:
1. tmux attach -t mycc-myapp
2. ssh user@remote-host
3. Detach with Ctrl+B D
4. Tell me the hostname
```

### 2. Update Session Memory

When user confirms hostname, update the todo:

```json
{
  "items": [
    { "name": "tmux session: mycc-myapp", "done": false, "note": "→ api-prod-1" }
  ]
}
```

### 3. Use the Session

Before running commands, check the todo to remember the session name:

```bash
# Send command to the remembered session
tmux send-keys -t "mycc-myapp" 'tail -f /var/log/app.log' Enter

# Capture output
tmux capture-pane -t "mycc-myapp" -p -S -100
```

### 4. List Sessions

```bash
tmux list-sessions -F "#{session_name}" 2>/dev/null || echo "No sessions"
```

### 5. Kill Session

```bash
tmux kill-session -t "mycc-myapp"
```

**After killing**: Mark todo as done:

```json
{
  "items": [
    { "name": "tmux session: mycc-myapp", "done": true }
  ]
}
```

## Example Workflow

```
User: "I need to check logs on prod-api"

Agent:
1. bash: tmux new-session -d -s "mycc-myapp"
2. todo_write: { "name": "tmux session: mycc-myapp", "done": false, "note": "→ ?" }
3. Tell user: "Created session. Please: tmux attach -t mycc-myapp, ssh to prod-api, Ctrl+B D"

User: "Connected to api-prod-1"

Agent:
4. todo_write: { "name": "tmux session: mycc-myapp", "done": false, "note": "→ api-prod-1" }
5. bash: tmux send-keys -t "mycc-myapp" 'tail -100 /var/log/app.log' Enter
6. bash: tmux capture-pane -t "mycc-myapp" -p -S -50
   → Show output to user

User: "Done"

Agent:
7. bash: tmux kill-session -t "mycc-myapp"
8. todo_write: { "name": "tmux session: mycc-myapp", "done": true }
```

## Command Reference

| Action | Bash Command |
|--------|-------------|
| Create session | `tmux new-session -d -s "name"` |
| List sessions | `tmux list-sessions -F "#{session_name}"` |
| Check session exists | `tmux has-session -t "name" 2>/dev/null && echo exists \|\| echo not_found` |
| Send command | `tmux send-keys -t "name" 'cmd' Enter` |
| Capture output | `tmux capture-pane -t "name" -p -S -100` |
| Kill session | `tmux kill-session -t "name"` |

## Naming Convention

Use `mycc-{project}` where project is derived from working directory:

```bash
mycc-$(basename $(pwd) | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
```

This helps identify sessions created by this agent.

## Security Notes

- Never send passwords via `send-keys`
- For sensitive operations, ask user to run commands manually in the session

## Checklist

- [ ] Create session with project-based name
- [ ] Use `todo_write` to remember the session name
- [ ] Update `note` field with remote hostname after SSH
- [ ] Mark `done: true` when session is killed