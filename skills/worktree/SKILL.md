---
name: worktree
description: >
  Manage git worktrees for parallel branch work using bash commands. Create a
  worktree, spawn a teammate inside it via tm_create's cwd parameter, list and
  remove worktrees, and clean up stale ones. Replaces the removed wt_* tools.
keywords:
  - worktree
  - git
  - parallel
  - branch
  - cwd
---

# Git Worktree Management (out-of-tree skill)

mycc no longer has built-in `wt_*` tools. Worktrees are managed with plain
`bash` + git commands. A teammate can be spawned **directly inside** a worktree
using `tm_create`'s `cwd` parameter — this is the recommended pattern for
parallel branch work.

## Lifecycle

### 1. Create a worktree

```bash
git worktree add .worktrees/<name> -b <branch>
```

This creates `./.worktrees/<name>` checked out onto a new branch `<branch>`.

### 2. Spawn a teammate inside it

Use `tm_create` with the `cwd` parameter pointing at the worktree path:

```
tm_create(name="feat-agent", role="coder", prompt="...", cwd=".worktrees/feat")
```

- The teammate process starts with that directory as its working directory
  (agent WORKDIR), so `bash` and file tools operate inside the worktree.
- The child process itself runs with `process.cwd()` at the project root, so
  `.mycc/` store paths (sessions, mail, issues) resolve correctly — no separate
  `.mycc/` is needed inside the worktree.
- mycc **auto-records** the worktree in its store (`.mycc/worktrees.json`) and
  **auto-creates** a cleanup todo: `Remove worktree for teammate '<name>'`.
- When you later `tm_remove(name="feat-agent")`, mycc auto-closes that todo and
  removes the store record. You still run the git command below to delete the
  directory.

### 3. List worktrees

```bash
git worktree list
```

### 4. Remove a worktree

After the teammate is done and removed:

```bash
git worktree remove .worktrees/<name>
```

If the directory has untracked/modified files, add `--force`.

### 5. Prune stale metadata

```bash
git worktree prune
```

## Stale-worktree nudge

The COLLECT state periodically checks `.mycc/worktrees.json`. If worktree
records exist, it injects a `REMINDER` note listing them and suggesting
cleanup. This is a nudge only — you decide when to remove. The file
`worktrees.json` is the single source of truth (file-as-state pattern).

## Notes

- Worktrees live under `./.worktrees/` by convention; `syncWorkTrees()` only
  reconciles records for paths containing `.worktrees`.
- The main project directory is the "main worktree" and is never tracked.
- On startup, `syncWorkTrees()` reconciles the JSON store with actual git
  worktrees (removes orphaned records, adds missing ones).