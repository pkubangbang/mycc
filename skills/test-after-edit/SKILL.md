---
name: test-after-edit
description: >
  Hookish skill that blocks git_commit (and messages on stop) when edit_file
  or write_file was used this session and the last edit is newer than the
  last `pnpm test` run, requiring tests to pass before commit can proceed.
  This enforces a test-before-commit discipline so code changes are never
  committed without a fresh test run. Use in projects with a `pnpm test`
  script where you want commits gated on test success.
keywords: [test, edit, commit, git_commit, block, hook, pnpm, quality, gate, pre-commit]
when: "block git_commit (and message on stop) if edit_file or write_file was used this session and the last edit is newer than the last pnpm test run, requiring tests to pass before commit can proceed"
---

# test-after-edit

## Purpose

Enforce test-before-commit: block `git_commit` when files were edited but
`pnpm test` has not run since the last edit.

## Trigger

Fires before `git_commit` when ALL of these are true:

- `session.count('edit_file') > 0 || session.count('write_file') > 0` — at
  least one edit happened this session
- the last edit is newer than the last test run, i.e.
  `session.lastIndex('edit_file') > session.lastIndex('bash#pnpm test') ||
   session.lastIndex('write_file') > session.lastIndex('bash#pnpm test')`

Unlike `lint-after-edit`, this does NOT include a `== -1` clause, so if
`pnpm test` never ran this session the hook still fires whenever an edit
happened (the edit's `lastIndex` will be `>= 0`, greater than the `-1`
returned for the missing test run).

## Action

`block` — the commit is rejected with a reason instructing the agent to run
`pnpm test` to verify before committing.

## Notes

- Uses `>` (strictly newer) rather than `>=` to avoid a false positive when
  both `lastIndex` calls return `-1` (events cleared at a turn boundary).
- `bash#pnpm test` matches a bash clause starting with `pnpm test`.
- Session-scoped counting persists across turn boundaries, so an edit made
  in an earlier turn still gates a commit in a later turn.