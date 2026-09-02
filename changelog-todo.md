# Preamble

This file is the `changelog` as well as `todo` for mycc project.

The changelog is recorded on daily basis, with summaries generated from LLM according to the actual code changes.
The todo items are kept without order. We pick the tasks with priority and finish them using mycc.
Once the task is marked done, it will stay in the list for an extra week after appearing in the changelog.

## The workflow

1. The user will add items to the `todo` section without order.
2. During development, an item will be picked up by evaluating the priority.
3. Once the item is done, mark it as done, togethe with a date on finish.
4. The changelog is updated on demand. Once update, todo items order than one week will be removed.

## How to update the changelog

When updating the changelog, use the following procedure:

1. **Create a checkpoint** using `checkpoint` tool to focus on the task.
2. **Get git commits** for the target date range using `git log --since="YYYY-MM-DD" --until="YYYY-MM-DD" --pretty=format:"%h %ad %s" --date=short`.
3. **Group commits by date** and summarize each day's changes into meaningful categories (e.g., "New Tools", "Fixes", "Refactoring", "Documentation").
4. **Write category-style summaries** similar to the existing format (e.g., "- **feature name**: description").
5. **Update the changelog file** by adding new date sections or appending to existing ones.
6. **Clean up todo items** that appear in the changelog and are older than one week.
7. **Call recap tool** to close the checkpoint and compress context.

# Change Log

> **Archive**: For changelog entries before September 2026, see `changelog-202608.md`. For July 2026, see `changelog-202607.md`. For June 2026, see `changelog-202606.md`. For May 2026, see `changelog-202605.md`. For April 2026, see `changelog-202604.md`.

<!-- July 2026 entries rotated to changelog-202607.md on 2026-08-03. -->
<!-- August 2026 entries rotated to changelog-202608.md on 2026-09-02. -->
<!-- Add new (September 2026 onward) entries below this line. -->

## 2026-08-29
### Chores
- **Package**: Update package info.

## 2026-08-30
### Features
- **DeepSeek**: Update README and design docs for DeepSeek `web_search` support; refine the deepseek engine.

## 2026-08-31
### Fixes
- **Peer**: Show `/peer` and `peers` timestamps in local time (was UTC via `toISOString()`); add `formatLocalDateTime()` util in `src/utils/time.ts` and use it at all four call sites.

## 2026-09-01
### Features
- **ProjectContext**: Add node_modules detection populator — detects `node_modules/` in cwd and reminds the agent to exclude it from `ls`/`grep` (the grep tool auto-excludes it, but the bash tool does not); registered for lead + teammates, no-op for non-Node projects.
- **WebUI**: Add state-machine stage tag chip row (verboseLogs only) for `isWaiting` desync diagnosis — derived stage label, raw boolean chips, buffer counters, and last server message type/timestamp; add `ChatState.lastServerMsg` + `DebugSnapshot` mirror + send→running latch with 15s expiry.
### Fixes
- **Windows**: Fix PS 5.1 `Get-Content` read-side mojibake (add `$PSDefaultParameterValues['Get-Content:Encoding']='utf8'` to the 5.1 Layer-2 patch); make `bg_create` symmetric with the bash tool (use detected shell, per-shell preamble, filter CLIXML noise, add `PYTHONUTF8`).
### Refactoring
- **Prompts**: Split the 574-line `agent-prompts.ts` monolith into `prompts/{common,lead,teammate}.ts` (no barrel re-export); repoint importers + test mocks; delete stale empty `agent-prompts/` dir.

## 2026-09-02
### Refactoring
- **Prompts**: Extract the intent-lang section into `intent-lang.ts` and move the plan-base prompt to `lead.ts`; convert `common.ts` section builders to array-literal join style; replace `lines.push` with array literals in intent-lang; fix `bg.ts` lint (prefer-template). Output byte-identical (baseline round-trip test); tsc + eslint (0 warnings) + 2691 vitest tests pass.
### Docs
- **README**: Fix inconsistencies — C++ compiler only needed when building from source (native deps ship prebuilt binaries/WASM); note `@pkubangbang/mycc` is not published (must run from source); tmux is optional (only used by `hand_over`); document auto mode and daemon mode; add `--auto`/`--daemon` flags to config table.

# Todo

> Todo - Or never?
> The below todo items have inherit gap with mycc's current implementation.
> With the existing archetecture, these todos may not be easily completed.
> Let's write them down to admit our limitation.

- [ ] add e2e test using tmux, with meaningful test cases, written as a skill.
- [ ] enable "boostrap install" mode via Docker. 
- [ ] make `/save` generate a "rich" session backup in addition to the original "slim" one.
- [ ] enable "remote shell" -- make local mycc able to control remote codebase.