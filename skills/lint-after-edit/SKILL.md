---
name: lint-after-edit
description: >
  Hookish skill that blocks git_commit (and messages on stop) when edit_file
  or write_file was used this session and the last edit is newer than the
  last `pnpm lint` run, requiring lint to pass before commit can proceed.
  This enforces a lint-before-commit discipline so code changes are never
  committed without a fresh lint check. Use in projects with a `pnpm lint`
  script where you want commits gated on lint success.
keywords: [lint, edit, commit, git_commit, block, hook, pnpm, quality, gate, pre-commit]
when: "block git_commit (and message on stop) if edit_file or write_file was used this session and the last edit is newer than the last pnpm lint run, requiring lint to pass before commit can proceed"
---

# lint-after-edit

## Purpose

Enforce lint-before-commit: block `git_commit` when files were edited but
`pnpm lint` has not run since the last edit.

## Trigger

Fires before `git_commit` when ALL of these are true:

- `session.count('edit_file') > 0 || session.count('write_file') > 0` — at
  least one edit happened this session
- the last edit is newer than the last lint run, i.e.
  `session.lastIndex('edit_file') > session.lastIndex('bash#pnpm lint') ||
   session.lastIndex('write_file') > session.lastIndex('bash#pnpm lint') ||
   session.lastIndex('bash#pnpm lint') == -1`

The `== -1` clause covers the case where lint never ran this session.

## Action

`block` — the commit is rejected with a reason instructing the agent to run
`pnpm lint` and fix any issues before committing.

## Notes

- Uses `>` (strictly newer) rather than `>=` to avoid a false positive when
  both `lastIndex` calls return `-1` (events cleared at a turn boundary).
- `bash#pnpm lint` matches a bash clause starting with `pnpm lint`.
- Session-scoped counting persists across turn boundaries, so an edit made
  in an earlier turn still gates a commit in a later turn.