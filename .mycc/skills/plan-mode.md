---
name: plan-mode
description: >
  Block code modifications when in plan mode.
  
  When the session is in 'plan' mode, this hook blocks:
  - edit_file, write_file (file modifications)
  - git_commit (version control changes)
  - tm_create (team spawning)
  
  Allows all other tools for planning and analysis.
  
keywords: [plan, mode, block, code, changes, implementation]
when: block all code modifications when session is in plan mode
---

# Plan Mode Hook

You are in **PLAN MODE**. Code modifications are blocked.

## What You Can Do

✅ **Planning & Analysis**:
- `read_file` - Read existing code
- `bash` - Run non-destructive commands (grep, find, ls)
- `issue_create`, `issue_claim`, `issue_close` - Task management
- `todo_write` - Track todos
- `wiki_get`, `wiki_prepare`, `wiki_put` - Knowledge management

✅ **Research**:
- `web_search`, `web_fetch` - Search documentation
- `skill_load` - Load specialized knowledge
- `question` - Ask user clarifying questions

✅ **Communication**:
- `brief` - Update user on progress
- `mail_to`, `broadcast` - Team communication

## What You Cannot Do

❌ **Code Modifications**:
- `edit_file` - Blocked
- `write_file` - Blocked
- `git_commit` - Blocked

❌ **Team Spawning**:
- `tm_create` - Blocked (plan phase doesn't spawn workers)

## Switching Modes

To enable code modifications:
```
mode_set({ mode: 'normal' })
```

Or use the slash command:
```
/mode normal
```

To return to planning:
```
mode_set({ mode: 'plan' })
```

Or:
```
/mode plan
```