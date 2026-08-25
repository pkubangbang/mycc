---
name: mycc-online-hotfix
description: >
  Hookish skill that fires after a tool execution error when the user has
  mentioned "tmux" to test mycc itself, and skill_load has not been used yet
  this session. It injects a skill_load of itself before the failing tool so
  the agent picks up online-hotfix guidance for diagnosing mycc runtime issues
  observed through tmux. Use when developing or testing mycc and a tool call
  errors out while tmux is in play.
keywords: [mycc, online, hotfix, tmux, test, error, hook, reminder, runtime, diagnostic]
when: "after tool execution error, if the user has mentioned \"tmux\" to test the mycc and skill_load has not been used yet this session"
---

# mycc-online-hotfix

## Purpose

When a tool call errors out while the user is testing mycc through tmux,
inject this skill's guidance so the agent can apply online-hotfix
diagnostics for mycc runtime issues.

## Trigger

Fires after any tool execution error (`*` trigger) when:

- the last tool call errored (`session.hadError()`)
- `skill_load` has not been used yet this session
  (`session.count('skill_load') == 0`)
- the user mentioned tmux to test mycc
  (`session.lastIndex('bash#tmux') != -1`)

## Action

`inject_before` a `skill_load` of `mycc-online-hotfix` so the guidance is
loaded before the failing tool is retried.

## Notes

- The `bash#tmux` tool spec matches a bash clause starting with `tmux`.
- The `skill_load` guard prevents re-injecting once guidance is already in
  attention.