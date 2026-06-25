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

> **Archive**: For changelog entries before June 2026, see `changelog-202605.md`. For April 2026, see `changelog-202604.md`.

## 2026-06-02
### Fixes
- **CJK Alignment**: Fixed string-width for CJK-aware banner alignment in `mycc_title`.
- **Checkpoint/Recap**: Refactored checkpoint/recap with transparent recap, forkChat, and teammate cleanup.

## 2026-06-03
### Features & Fixes
- **Multi-line**: Chinese "、" (enumeration comma) at end of line now also triggers multi-line editing.
- **Hook**: Checkpoint/recap isolation failures now return COLLECT instead of STOP.
- **skill_load**: Added retrospect showing skill location and level on load.

## 2026-06-05
### Fixes
- **read_file**: Show head+tail preview for minified/single-long-line files.


## 2026-06-22
### Fixes
- **Fork on Windows**: Fixed `/fork` command on Windows. Three root causes: (1) `mycc` not on PATH → `0x80070002`; (2) `shell:true` in open-terminal.ts wrapped command in `cmd.exe /d /s /c` which broke nested quoting and created double windows; (3) `wt.exe` has a known bug (microsoft/terminal#13264) where it splits on `;` even inside quoted arguments, causing the forked command to be treated as two separate wt actions. Fixed by using `node.exe + bin/mycc.js` (no PATH dependency), removing `shell:true` from Windows terminal configs (spawn powershell directly), and encoding the PowerShell script as UTF-16LE Base64 via `-EncodedCommand` (eliminates all `;`, spaces, and quotes from the command line).
- **Loader**: Normalize skill keywords to array on parse to prevent TypeError when keywords is a single string.

## 2026-06-23
### Features
- **Background Tools**: Expose bg tool output, grant integration, killed status, and output cap for better background task management.

### Documentation
- **environment-detection**: Document PowerShell lacks `&&` operator in cheatsheet.

## 2026-06-24
### Features
- **Crossroad**: Shorten continuations and log alternatives with selection for better decision tracking.
- **ESC Cancel**: Allow ESC to cancel prompt input and return to fresh prompt instead of ignoring it.
- **Walkthrough Docs**: Added walkthrough documentation for common workflows.

### Fixes
- **Hook/Crossroad**: Restructure crossroad as first-class branch, fix `duplicate_assistant` TP recovery.
- **Setup**: Preserve all config vars in `.env`, not just current provider's.
- **Config**: Inline `.env` parsing, remove `dotenv` dependency.
- **Config**: Read `args.setup` directly instead of `process.env.MYCC_SETUP`.
- **Config**: Read `--session` from minimist args instead of `process.env`.
- **Path Normalization**: Normalize path separators before regex in `ensureSameTeammate`.
- **Mail**: Allow `eta=0` in `mail_to` tool for non-budget messages.
- **Grants**: Allow child process writes to project root when no worktree assigned.
- **Prompts**: Add permission rule for lead and worktree guidance for teammates.
- **Team**: Polish `eta_update` to show styled banner with bg-color.
- **Teammate Idle**: Update teammate idle logic for better state management.

### Tests
- **Unit Tests**: Add 81 new unit tests and fix bg-create test mock.
- **bg-create**: Add `bg-create.test.ts` (13 tests) for background task creation tool.

## 2026-06-25
### Features
- **CLI Config Flags**: All env-configurable vars are now available as CLI flags via minimist. New flags: `--ollama-host`, `--ollama-api-key`, `--ollama-model`, `--ollama-vision-model`, `--ollama-embedding-model`, `--deepseek-host`, `--deepseek-api-key`, `--deepseek-model`, `--api-provider`, `--token-threshold`, `--editor`, `--skill-match-threshold`. These override `.env` files and system environment variables with highest priority.
- **Session Reorganization**: All session files now stored in session subdirectories for cleaner organization.

### Documentation
- **README**: Added "Configuration Flags" section documenting all CLI flags and their env variable mappings.

# Todo

- [x] 2026-06-22 Fix `/fork` on Windows — `mycc` not found, shell:true nested quoting, wt.exe semicolon splitting bug
- [x] 2026-06-24 Remove `dotenv` dependency, inline .env parsing
- [x] 2026-06-24 Add unit tests (81 new tests)
- [x] 2026-06-25 Add all env-configurable vars as cmd-args for minimist parsing
- [ ] add e2e test using tmux, with meaningful test cases, written as a skill
- [ ] racing condition: submittion without showing "mycc is wrapping up" will not show the spinner.
- [ ] In the plan mode, the produced plan will have self-debating.
- [ ] In the plan mode, the plan may well have many options but mycc does not break them down and discuss with the user.
- [ ] tool loader may have memory leak
- [ ] subsequent triologue.note() call will not show in the jsonl.
- [ ] LLM blind-spot: I see a tool/skill that could help me, but I don't load it because I think I already know the domain.