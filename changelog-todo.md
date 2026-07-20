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

> **Archive**: For changelog entries before July 2026, see `changelog-202606.md`. For May 2026, see `changelog-202605.md`. For April 2026, see `changelog-202604.md`.

## 2026-07-01
### Features
- **Duplication Detection**: Embedding-based duplication detection for the hint round.
- **Gitignore**: Auto-add `.mycc/` to `.gitignore` when project is git-managed.
### Refactoring & Chores
- **Refactor**: Review fixes for embedding-based duplication detection.
- **Chore**: Simplify `.gitignore` rule for `.mycc` directory.

## 2026-07-02
### Features & Fixes
- **Repetition Detection**: Map delta from 2 to 3 for high similarity (reduces false positives).
- **Bash Timeout**: Update bash timeout max from 30 to 60 across all layers.
- **Agent Prompts**: Update agent prompts and tool descriptions for clarity.

## 2026-07-03
### Release
- **v0.9.4**: Auto-mail teammate's no-tool-call message to lead.
### Features
- **Wiki**: Improve wiki slash command hints and subcommand descriptions.
### Fixes
- **ESC**: Consolidate `ask()` options, add `onEsc` to all grant prompts, fix state handler ESC returns.
- **ESC Deadlock**: Fix deadlock when ESC pressed while lead awaits teammates.
- **Line Editor**: Truncate whisper line to terminal width.
- **Windows Spawn**: DEP0190-safe spawn pattern for Windows `.cmd` files.
### Refactoring & Chores
- **Prompts**: Improve `agent-prompts.ts` clarity and conciseness.
- **Chore**: Suppress "Document already exists" message on startup.
### Tests
- **grep Tool**: Thoroughly test grep tool with 72 tests covering all functions, edge cases, and failure modes.

# Todo

- [ ] add e2e test using tmux, with meaningful test cases, written as a skill
- [ ] racing condition: submittion without showing "mycc is wrapping up" will not show the spinner.
- [ ] In the plan mode, the produced plan will have self-debating.
- [ ] In the plan mode, the plan may well have many options but mycc does not break them down and discuss with the user.
- [ ] tool loader may have memory leak
- [ ] subsequent triologue.note() call will not show in the jsonl.
- [ ] LLM blind-spot: I see a tool/skill that could help me, but I don't load it because I think I already know the domain.

- [ ] webui: 详细日志只保留 brief, assistant, question, 还有letterbox
- [ ] webui: 退出按钮增加一个modal确认框
- [ ] webui: 允许steering buffer