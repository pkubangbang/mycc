---
name: lint-after-edit
description: >
  Remind to run pnpm lint before committing or finishing, if code changes
  were made after the last lint run. Uses lastIndexOf for ordering-aware checks.
when: block git_commit (and message on stop) if edit_file or write_file was used this session and the last edit is newer than the last pnpm lint run, requiring lint to pass before commit can proceed
---

# Lint After Edits

This hook **blocks** `git_commit` until lint runs and passes, if code
changes were made after the last lint run. For `stop` (finishing), it
uses `message` to remind without blocking.

## Behavior

- If lint was run AFTER the last edit → allow commit (already clean)
- If the last edit is NEWER than the last lint → **block** the commit
- Agent must run `pnpm lint`, fix issues, then retry commit
- Uses `seq.lastIndexOf()` to compare edit position vs lint position

## How It Works

1. Agent makes code changes (edit_file/write_file)
2. Agent tries to git_commit or finish (stop)
3. Hook checks: is lastIndexOf(edit) >= lastIndexOf(bash#lint)?
4. If yes → block git_commit (or message on stop)
5. Agent runs lint, sees results, fixes or retries commit

## Required Command

```bash
pnpm lint
```
