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

# Todo

- [x] 2026-06-22 Fix `/fork` on Windows — `mycc` not found, shell:true nested quoting, wt.exe semicolon splitting bug
- [ ] add e2e test using tmux, with meaningful test cases, written as a skill
- [ ] racing condition: submittion without showing "mycc is wrapping up" will not show the spinner.
- [ ] In the plan mode, the produced plan will have self-debating.
- [ ] In the plan mode, the plan may well have many options but mycc does not break them down and discuss with the user.
- [ ] tool loader may have memory leak
- [x] deepseek api when showing wrap-up will output like
   ```
   .================================== 10:24:14 ===================================.
   <｜｜DSML｜｜tool_calls>
   <｜｜DSML｜｜invoke name="brief">
   <｜｜DSML｜｜parameter name="message" string="true">🚀 Merged into local `main` (commit 9aa4be5). The remote `origin/main` appears to be behind (at 62a9469). The push said "Everything up-to-date" — might need a force push or there's a discrepancy. Want me to investigate and push properly, or is this fine as-is?</｜｜DSML｜｜parameter>
   </｜｜DSML｜｜invoke>
   </｜｜DSML｜｜tool_calls>
   '=============================================================================='
   ```

- [ ] subsequent triologue.note() call will not show in the jsonl.
- [ ] LLM blind-spot: I see a tool/skill that could help me, but I don't load it because I think I already know the domain.