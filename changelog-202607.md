# Changelog Archive - July 2026

This file contains archived changelog entries from the mycc project for July 2026.
For current changelog, see `changelog-todo.md`.

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

## 2026-07-04
### Refactoring & Docs
- **Worktree**: Remove `wt_*` tools / `WtModule`, add `worktree` built-in skill + `tm_create` cwd (v0.9.5).
### Fixes
- **Skill**: Narrow `mycc-online-hotfix` hook trigger to prevent self-perpetuating loop.
### Docs
- **plan_on**: Clarify `allowed_file` works in both directions of plan mode.
- **Tools**: Clarify `issue_*` tools are team-shared vs private todos.
- **Changelog**: Rotate June 2026 changelog into `changelog-202606.md` archive.

## 2026-07-05
### Features
- **Todo**: Auto-clear items when all done, keep `nextId` monotonic.
- **Hint Round**: Surface hook skill name in minified triologue excerpt.
### Fixes
- **Hook**: `skill_compile` updates runtime `ConditionRegistry` without restart.
- **Team**: Reframe guidance-request mail as not-a-blocker.
### Refactoring
- **Triologue**: Tidy `NoteCategory` to 5 types + track hook injection in minifier.

## 2026-07-06
### Features
- **Session**: Graceful `/load` degradation + ready-event child summaries + verbose teammate startup logs.
### Refactoring
- **Coordination**: Rewrite skill with OB theory, executable specs, enforcement.
### Fixes
- **Team**: Spawn teammate with lead workDir as cwd, not `PROJECT_ROOT`.

## 2026-07-07
### Features
- **Intent Parser**: Identify malformed PARAM format.
### Fixes
- **DeepSeek**: Prevent unrecoverable "reading 'role'" crash after `/compact`.

## 2026-07-08
### Fixes
- **Intent Parser**: Rigid single-pass compiler detects all PARAM violations.
- **grep**: Emit visible brief line on every successful search.
### Refactoring
- **Worktree**: Drop `worktrees.json`, query git live; add `cwd` to `git_commit`.
### Tests
- **ESC Neglection**: Add ESC-neglection loop tests (42 tests across 9 files).

## 2026-07-09
### Features
- **Tools**: Detect U+FFFD encoding corruption to prevent `edit_file` mismatches.
### Docs
- **Skill**: Add Windows UTF-8 encoding guard; trim env-detection description.

## 2026-07-10
### Release & Features
- **v0.9.6**: Add `embeddinggemma` provider via `rag-provider` facade.
### Fixes
- **ask()**: Add re-entrancy guard to prevent concurrent call orphaning.
- **Triologue**: Filter holes in `getMessagesRaw()` and enrich COLLECT error logging.

## 2026-07-13
### Features
- **Line Editor**: Add Shift+Left/Right text selection support.
- **learn-from-past**: Add `learn-from-past` (lfp) built-in hookish skill.
- **read_picture**: Add disk-based multi-focus image cache for `read_picture`.
### Fixes
- **Grant**: Allow writes to tool-output dirs in plan mode.
### Docs
- **Prompt Cache**: Document prompt-cache invariant for fork/recap and pass `toolChoice:'none'`.

## 2026-07-14
### Performance & Fixes
- **Loader**: Speed up "Indexed N skills to wiki" startup step.
- **Teammate Worker**: Add `autoCompact` check after tool execution.

## 2026-07-15
### Fixes
- **Restoration**: Only scan `[READY]` events in user-role messages.
- **Teammate Worker**: Add per-turn watchdog to abort stuck LLM calls.
### Refactoring & Style
- **Mindmap**: Remove dead `exploreAndSummarize`, inline exploration loop, add offset pagination to explorer `read_file`.
- **Line Editor**: Use template literal for ellipsis concatenation.
### Docs
- **Teammates**: Clarify lead should trust teammate's autonomous cycle.

## 2026-07-16
### Refactoring
- **Mindmap**: Remove dead `exploreAndSummarize`, inline exploration loop, add offset pagination to explorer `read_file`.

## 2026-07-17
### Features & Fixes
- **Todo**: Pinned-todo and reactivation feature.
- **Crossroad**: Add one-pass cooldown gate to break stuck-loop.

## 2026-07-18
### Features
- **mdcalc**: Add Markdown Calculator as skill + CLI bin.

## 2026-07-20
### Features
- **Serve / Web UI**: Add Vue web UI with serve hub, steering, and bugfixes (PR #9).
- **Web UI**: File upload in chat box + `--host` flag for network binding.
- **Web UI**: Dark/light theme toggle + tool intent detail in chat bubbles.
- **Web UI**: Render bash command logs as a reinforced monospace card.
- **Serve**: Unified `[?/?]` bracket protocol for enhanced question cards.
- **Grant**: `hand_over` Socratic hints, tmux nesting guard, `dangerous=i_know` escape.
- **Grant**: Add `batch=i_know` PARAM to skip LLM safeguard for batch deletions.
### Fixes
- **Serve**: Harden serve lifecycle — prevent dead-ends, port leaks, and Vite orphans.
- **Serve**: Prevent two dead-ends in serve/webui lifecycle.
- **Web UI**: Strip ANSI from all out-of-band fields and render crossroad as markdown.
- **Grant**: Gate `dangerous=i_know` escape hatch on intent grammar.
- **Ollama**: Capture thinking field and strip inline think tags from content.

## 2026-07-21
### Features
- **Web UI**: Teammate accordion UI with `@name`/tool label routing.
- **Web UI**: Teammate retirement — route exit notice to drawer, mark done, collapse card.
- **Serve**: Support drag-drop file upload with size cap and folder rejection.
### Fixes
- **Serve**: Keep Web UI alive across system suspend/hibernate.
- **Session**: `--from` branches a new session; seal old session files.

## 2026-07-22
### Features
- **Web UI**: 悬浮折叠式 TodoCard 替换内联 todoList (floating collapsible TodoCard).

## 2026-07-23
### Features
- **Issue**: Add `draft` status + `issue_publish` to prevent auto-claim race.
- **Issue Close**: Make comment required.
- **Web UI**: Add last-message time and four-corner layout to TeammateCard.
### Fixes
- **Teammate**: Remove per-turn confusion increment to stop spurious hint rounds.
- **Teammate**: Prevent teammate loop hang on Ollama network errors.
- **Web UI**: Persist real user submissions to `user.jsonl` for refresh restoration.
- **Config**: Support optional port value on `--serve` flag.
### Refactoring & Chores
- **Order Tool**: Remove the `order` tool (redundant with `mail_to` + `tm_await`).
- **Read**: Drop non-cross-platform suggestions and trim redundant tokens.
- **Chore**: Un-ignore `.mycc/skills/` for git tracking; remove `.claude` directory.
- **Chore**: Normalize line endings to LF and enforce via `.gitattributes`.
- **Style (Web UI)**: Narrow TeammateCard width to 180px and fix row height.

## 2026-07-24
### Features
- **CLI**: Add `--help`/`-h` startup flag.
- **Web UI**: Add download/copy/quote toolbar to agent markdown reply cards.
### Fixes
- **Serve**: Restore prompt after ESC quit by deferring `abortInput` in `gracefulShutdown`.
- **Engine**: Escalate first-token timeout per retry attempt.
- **Hint Round**: Strengthen `wiki_query` generation guidance.
- **plan_on**: Default empty response to strict plan mode (deny).
- **Recap**: Correct recap note field ordering and make comment required.
### Refactoring
- **Prompts**: Trim tool descriptions to reduce semantic conflicts and verbosity.

## 2026-07-26
### Features
- **Wiki**: Integrity verification for export/import + honest re-import reporting.

## 2026-07-27
### Features
- **Restoration**: Use `minifyMessages` with iterative ux-boundary folding.
- **Hint Round**: Encourage batching independent tool calls via `next_step`.
### Fixes
- **Bash**: Coerce timeout to `[1,60]` with pushback warning and few-shot schema.
- **DeepSeek**: Handle truncated SSE streams causing JSON parse errors.
- **Serve**: Show LAN IP in startup message when bound to `0.0.0.0`.
- **Prompts**: (Reverted) instruct LLM to batch independent tool calls — reverted same day.
### Tests
- **Stale Expectations**: Fix 5 stale test expectations to match current source behavior.

## 2026-07-28
### Features
- **Web UI**: Allow pasting files/images from clipboard into the chat input.
### Fixes
- **Web UI**: Disable chat input when a card is pending to prevent silent drop.
- **plan_off**: Treat empty Enter response as No at `[y/N]` prompt.

## 2026-07-29
### Features & Fixes
- **Tools**: Platform-aware line endings, BOM control, `edit_file` verification.
- **Web UI**: Refine drag-drop resize behavior.

## 2026-07-30
### Fixes
- **Tools**: `edit_file` crash/`strip_bom`/BOM-verify + `git_commit` Enter-as-No + bracket-default.

## 2026-07-31
### Features
- **Checkpoint**: Add required `if_abandoned` param for recap-abandon continuity.
### Fixes
- **Windows**: Suppress PowerShell CLIXML noise and progress stream.
- **grep**: Allow searching paths outside workspace via grant flow.