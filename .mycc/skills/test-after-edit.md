---
name: test-after-edit
description: >
  Remind to run pnpm test before committing or finishing, if code changes
  were made after the last test run. Uses lastIndexOf for ordering-aware checks.
when: block git_commit (and message on stop) if NOT in plan mode, edit_file or write_file was used this session, and the last edit is newer than the last pnpm test run, requiring tests to pass before commit can proceed
---

# Test After Edits

This hook **blocks** `git_commit` until tests run and pass, if code
changes were made after the last test run. For `stop` (finishing), it
uses `message` to remind without blocking.

## Behavior

- If tests were run AFTER the last edit → allow commit (already covered)
- If the last edit is NEWER than the last test → **block** the commit
- Agent must run `pnpm test`, fix issues, then retry commit
- Uses `seq.lastIndexOf()` to compare edit position vs test position

## How It Works

1. Agent makes code changes (edit_file/write_file)
2. Agent tries to git_commit or finish (stop)
3. Hook checks: is lastIndexOf(edit) >= lastIndexOf(bash#test)?
4. If yes → block git_commit (or message on stop)
5. Agent runs tests, sees results, fixes or retries commit

## Required Command

```bash
pnpm test
```
