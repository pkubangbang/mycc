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

> **Archive**: For changelog entries before May 2026, see `changelog-202604.md`.

## 2026-05-01
### Mindmap Memory
- **Mindmap**: Added the mindmap module for agent memory, featuring an autonomous explorer agent.
- **Compilation**: Implemented lock-based progressive compilation with resume capabilities.
- **Tooling**: Renamed `get_node` to `recall` and increased its visibility in system prompts.

## 2026-05-02
### Performance & UI
- **Shortcuts**: Added `/plan` slash command for quick mode switching.
- **Optimization**: Optimized the hint round with a single LLM call and focused context.
- **UI**: Fixed display flushing in LineEditor and implemented terminal window titles via ANSI sequences.

## 2026-05-03
### Read Tool Enhancements
- **File Detection**: Added file type detection and progress info to the `read` tool.
- **Cleanup**: Replaced `magic-bytes.js` dependency with a custom utility.

## 2026-05-04
### Background Tasks
- **ESC**: Added ESC handling to the `bg_await` tool.

## 2026-05-05
### Built-in Skills & Recall
- **Skills**: Moved `clear-sessions` skill to the built-in set.
- **Recall**: Improved drill-down guidance and added Unicode support for node IDs.
- **Sessions**: Fixed session save path messages and added source indicators to `/load`.

## 2026-05-06
### Self-Regulation & Streaming
- **Confusion Index**: Implemented v2 with confidence-based self-regulation.
- **Streaming**: Updated Ollama to use stream mode with two-tier timeouts for better responsiveness.
- **Version**: Released `v0.7.2` with a specific plan mode system prompt.

## 2026-05-07
### Guidance & Responsiveness
- **Hint Round**: Added wiki search suggestions and notification about uncompiled skills.
- **Responsiveness**: Improved first-token responsiveness and restored ESC responsiveness during tool execution.

## 2026-05-08
### Parallelism & Forking
- **Mindmap**: Implemented parallel compilation with concurrency limits and progress displays.
- **Forking**: Added `/fork` slash command to save sessions and open them in new tmux windows.
- **Abstraction**: Introduced `escAware` for interruptible operations.

## 2026-05-09
### Intent Language
- **Bash Tool**: Implemented "intent language" for bash tools to ensure safety and clarity in plan mode.
- **UX**: Ensured prompt displays after ESC and improved prompt clarity.

## 2026-05-10
### Context Management
- **Meta-tools**: Added `checkpoint` and `recap` for structured context management.
- **Cleanup**: Removed 'bg' scope and fixed brief nudge behavior.

## 2026-05-11
### Context Refinement
- **Recap**: Added `abandon` option to `recap` for discarding distracted subtasks.
- **Interaction**: Added double Ctrl+L to clear history with "whisper line" visual feedback.
- **Teammates**: Enabled `checkpoint/recap` for teammate agents.
- **Stability**: Fixed triologue parity and early return issues in `checkpoint/recap`.

## 2026-05-12
### Final Polish
- **Worktrees**: Added confirmation and notification for worktree entry/exit.
- **Knowledge**: Added pitfall awareness to the agent knowledge boundary section.
- **Setup Wizard**: Fixed location-specific configuration for wizard prompts.
- **UI**: Implemented scrollback-preserving clear in `clearScreen()`.
- **Refactoring**: Consolidated environment loading and refactored token estimation into a utility module.
- **Hotfix**: Updated `mycc-online-hotfix` to use bash+tmux instead of `hand_over`.

# Todo

- [ ] add e2e test using tmux, with meaningful test cases, written as a skill
- [ ] triologue parity issues
   - [x] recap (2026-05-13)
   - [x] auto-compaction (2026-05-13)
- [x] mindmap not updated when only removal is included. (2026-05-13)
- [ ] line-editor structure: 1 hint line + n prompt line + 1 blank line
- [x] improve hook log output (2026-05-13)
- [x] improve verbose logs (2026-05-13)
   - [x] hint round - log request prompt and response with chalk.cyan
   - [x] read tool - show first 50 lines of file content
   - [x] context consumption - log token count increments in triologue.updateTokenCount
