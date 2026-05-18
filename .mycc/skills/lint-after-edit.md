---
name: lint-after-edit
description: >
  Remind to run pnpm lint before committing or finishing, if code changes
  were made after the last lint run. Uses lastIndexOf for ordering-aware checks.
when: before git_commit or LLM finishes reply (no tool calls pending), if edit_file or write_file was used this session and the last edit is newer than the last pnpm lint run
---

# Lint After Edits

This hook injects `pnpm lint` before git_commit or stop, but only if code
changes were made **after** the last lint run.

## Behavior

- If lint was run AFTER the last edit → skip (already covered)
- If the last edit is NEWER than the last lint → inject `pnpm lint`
- Uses `seq.lastIndexOf()` to compare edit position vs lint position

## How It Works

1. Agent makes code changes (edit_file/write_file)
2. Agent tries to git_commit or finish (stop)
3. Hook checks: is lastIndexOf(edit) >= lastIndexOf(bash#lint)?
4. If yes → inject `pnpm lint`
5. Agent sees result and can fix or proceed

## Required Command

```bash
pnpm lint
```
