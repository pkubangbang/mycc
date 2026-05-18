---
name: test-after-edit
description: >
  Remind to run pnpm test before committing or finishing, if code changes
  were made after the last test run. Uses lastIndexOf for ordering-aware checks.
when: before git_commit or LLM finishes reply (no tool calls pending), if edit_file or write_file was used this session and the last edit is newer than the last pnpm test run
---

# Test After Edits

This hook injects `pnpm test` before git_commit or stop, but only if code
changes were made **after** the last test run.

## Behavior

- If tests were run AFTER the last edit → skip (already covered)
- If the last edit is NEWER than the last test → inject `pnpm test`
- Uses `seq.lastIndexOf()` to compare edit position vs test position

## How It Works

1. Agent makes code changes (edit_file/write_file)
2. Agent tries to git_commit or finish (stop)
3. Hook checks: is lastIndexOf(edit) >= lastIndexOf(bash#test)?
4. If yes → inject `pnpm test`
5. Agent sees result and can fix or proceed

## Required Command

```bash
pnpm test
```
