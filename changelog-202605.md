# Changelog Archive - May 2026

This file contains archived changelog entries from the mycc project for May 2026.
For current changelog, see `changelog-todo.md`.

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

## 2026-05-13
### Logging & Todo Redesign
- **Verbose Logging**: Added detailed logging for hint round requests/responses, file reads (first 50 lines), and token count increments in triologue.
- **Todo Redesign**: Replaced `todo_write` with single-item tools (`todo_create`, `todo_update`) with hash integrity protection.
- **Mindmap Fix**: Fixed mindmap re-summarization when child nodes are removed during incremental compile; persisting hash to disk after incremental compile.
- **Recap**: Added optional `comment` property to `recap`; show checkpoint ID in brief log detail; simplified recap to remove tool message from history.
- **Checkpoint**: Fixed triologue parity issues during chat compaction; always show full todo list.
- **Config**: Reversed dotenv load order so project `.env` overrides user env.
- **Intent Language**: Removed brackets from intent language format.
- **Skills**: Increased skill match threshold from 0.5 to 0.8 for stricter recommendations; updated prompt in `plan_on`.
- **Transient Errors**: Added 'overloaded' and 'overload' to transient error patterns.
- **Fork**: Added `open-terminal` utility and rewrote fork command.

## 2026-05-14
### New Tools & Resiliency
- **mycc_title**: Added `mycc_title` tool for changing terminal window title; promoted its usage in system prompts.
- **Wiki**: Added domain validation in `wiki_prepare` and `wiki_put` against registered domains.
- **Resiliency**: Made mycc resilient to runtime errors with Retry [Y/n] prompt.
- **Recap**: Fixed log recap tool calls to triologue JSONL; fixed triologue parity in recap tool handling.
- **Todo**: Added `/todo` slash command with `add`, `clear`, `done`, `undone` subcommands for todo management.
- **Line Editor**: Limited line editor width to 120 characters; fixed conversation clear message to whisper line and bang prompt reversion.
- **Intent**: Added soft intent validation with pairing tables and bash warnings.

## 2026-05-15
### Suggest Mode & Hook System
- **Suggest Mode**: Added SUGGEST state with background brown bag discovery; moved instructions from system prompt to dynamic state; added suggestion wikiNotes as domain+query pairs.
- **Hook System**: Added trigger string[] support with per-turn sequence scoping; replaced unsafe `new Function` with `Sequence.evaluate` for condition evaluation.
- **Multiline Editor**: Added `r+Enter` reload in editor wait prompt; fixed stale wrap-up state on multiline reload.
- **Letter Box**: Simplified letter box to output result directly; added optional title; preserved whitespace.
- **Verbose Logging**: Consolidated verbose logging into `agentIO` singleton; extracted hint-round instruction text into shared constant.
- **Audio/Visual**: Muted suggest loop brief output via core proxy; fixed include todo cleanup nudge in recap result strings.
- **Fixes**: Fixed escAware memory leak (Set + unsubscribe); HTTP/2 GOAWAY error resilience; hook bash timeout clamped to 30s; intent hint shown before bash output.
- **Linting**: Fixed `prefer-template` lint issues.

## 2026-05-16
### Plan Mode & Stability
- **Plan Mode**: Enabled LLM thinking mode when in plan mode; added intent language section to plan mode system prompts.
- **Memory Leaks**: Fixed ESM import cache-busting memory leak in tool watcher; fixed hookish skill compilation pipeline leaks.
- **File Access**: Allowed read/write/edit tools to access files outside workspace with session-scoped grant.
- **Bash Tool**: Fixed bash timeout max from 300 to 30 seconds; added user-visible detail and error-level brief messages.
- **Multi-line**: Fixed multi-line paste only accepting first line; fixed detached spawn for GUI editors preventing temp-file collisions.
- **skill_load**: Improved `skill_load` tool with descriptive brief messages.
- **Intent Language**: Synced intent language definitions between parser and agent prompts.
- **Hook System**: Split `seq.count` into per-turn count and session-wide totalCount; reset on `/clear`.

## 2026-05-17
### Hook Evaluation & Codegraph
- **Hook Evaluator**: Added extensive debugging for hook evaluator (debug output, eval tree printing, condition validation).
- **Codegraph**: Added codegraph support to the project.
- **Refactoring**: Extracted hint round logic to `hint-round.ts` with `HintRoundContext`; embedded `NoteCategory` as `[TITLE]` prefix in content.
- **Intent Trap**: Added compact hook action for intent language trap detection.
- **OpenEditor**: Fixed reliable GUI editor launch via 'spawn' event sync.

## 2026-05-18
### Massive Hook System Overhaul
- **Hook System**: Added `seq.lastIndexOf()` for ordering-aware conditions; enhanced `countResult` with tool filtering and search length limits; added `skill_compile` pushes compiled conditions to runtime via IPC; improved output format showing trigger→skill.
- **Evaluator**: Fixed all 38 test failures across 8 test suites; added `seq.hasCommand`→`seq.lastIndexOf` migration across codebase; fixed scope duplicate prevention per-move.
- **Hooks**: Added hook intervention FYI messages for `inject_before/after/replace`; fixed empty assistant response auto-prompt; fixed YAML parsing error in compact skill.
- **Lint**: Split `lint-typecheck-after-edit` into `lint-after-edit` + `test-after-edit`.
- **New Features**: Added `/mail` slash command with enhanced mail listing; added `mycc_title` bright yellow banner; added batch deletion gate in bash grant system.
- **Skills**: Updated skills and added keyword search fallback to `skill_load`.
- **Docs**: Updated docs and skill definitions for refined `countResult` logic.

## 2026-05-19
### Hook Debugging & Refinement
- **Evaluator Debug**: Added full debug breakdown in `evaluateNode` tree output; added action type to `skill_compile` log; stitched evaluated children into `JsepEvaluatedNode` for correct tree printing.
- **Confusion Index**: Confined confusion index increase to plan mode only; reset stat counters on all compact operations.
- **Hook Fixes**: Hook blocked messages now go to COLLECT instead of STOP; injected deferred hook messages before STOP; renamed DEFERRED→REMINDER.
- **Hint Round**: Changed output label from 'collect' to 'loop'; fixed totalCount tally bug.
- **Validation**: Fixed skip action validation for history entries in condition validator; updated system prompt.

## 2026-05-20
### DeepSeek API Support (Phase 1)
- **Architecture**: Extracted `engine/chat-helpers`; moved `ollama.ts`→`engine/ollama.ts`; created DeepSeek stub; implemented `deepseek.ts` with full API.
- **Chat Provider**: Created `chat-provider.ts` as single LLM facade; removed `ollama.*` calls from outside engine; implemented health check per provider with compound types.
- **TP Parity**: Enforced strict TP parity; removed microCompact to utilize DeepSeek prompt cache; added `--debug-tp` flag for debugging.
- **Fixes**: Removed top-level await from chat-provider; used static imports.

## 2026-05-21
### DeepSeek API Support (Phase 2)
- **DeepSeek Fixes**: Fixed thinking toggle for API compatibility; fixed `tool_calls` format; preserved `reasoning_content` through triologue; fixed empty `reasoning_content` for pre-switch assistant messages.
- **TP Parity Fixes**: Fixed TP violations in checkpoint handler and LLM empty-response path; checkpoint uses tool message instead of note for TP safety; fixed TP violation on ESC interrupt (tool→user bridge in prompt state).
- **ESC Wrap-up**: Fixed ESC wrap-up with inline triologue and rollback; added auto-recover triologue parity violations.
- **Setup Wizard**: Added optional DeepSeek provider to setup wizard flow.
- **Recap**: Fixed `recapMessages` preserving checkpoint agent→tool pair; moved teammate meta-tool dispatch before agent registration.
- **Cleanup**: Removed redundant `ctx.core.brief()` from `mycc_title` tool.
- **Docs**: Added DeepSeek provider design spec; added Loop Notation (LN) guidance to CLAUDE.md; updated README.

## 2026-05-22
### Terminology Hoisting
- **mark_term**: Added `mark_term` tool for term hoisting in mindmap; show term parameter in compilation progress display.
- **Refactoring**: Retired `minifyForHint` and added terminology hoisting design; removed dead `onHint` callback from Triologue and HintRoundContext.
- **Fixes**: Reset stat counters (confusionIndex + sequence) on all compact operations.

## 2026-05-23
### Hint Round & Mindmap
- **Hint Round**: Refactored hint round generation; reworked COLLECT injection logic with `ensureAssistant` bridge.
- **Mindmap**: Fixed link validation to allow 'term' target_type in mindmap links.

## 2026-05-24
### Suggest Refactoring
- **Suggest**: Split suggest into 3 independent probing directions; emphasized intent and behavior during probe phase.

## 2026-05-25
### Skill Search & DeepSeek Refinements
- **skill_load/skill_search**: Split `skill_load` into exact-match tool + `skill_search` for fuzzy search; added threshold 0.5 and scoped skill indexing; fixed case mismatch and fuzzy fallback.
- **DeepSeek**: Fixed wrap-up to use `tool_choice=none` preventing raw XML tool calls; fixed type error in ollama.ts.
- **Suggest**: Simplified flow to summarizing→searching→reranking; removed hallucination check, only validate JSON; include last user query alongside signal in solve phase.
- **Recap**: Preserved last user query after recap to prevent context loss; fixed skipPendingTools in beginWrapUp.
- **Setup**: Restructured wizard with delete option and new flow; swapped config location before API provider step.
- **Skill Rebuild**: Overwrite instead of avoiding duplicates on skill rebuild.

## 2026-05-26
### Skill Rebuild
- **Skills**: Made skill rebuild overwrite existing entries instead of avoiding duplicates.

## 2026-05-28
### Recap & Setup Fixes
- **Recap**: Preserved user's active query after recap compression.
- **Mindmap**: Detect incomplete mindmap on hash match and resume instead of returning partial data.
- **UX**: Added dynamic slash command hint in whisper line.
- **Setup**: Detect Ollama on Windows even when not in PATH.
- **Lint**: Fixed prefer-template warning in agent-io.ts.

## 2026-05-29
### Various Fixes
- **Session**: Squashed various fixes and features from evening session.

## 2026-05-31
### Windows Fix
- **Editor**: Removed `windowsHide` from GUI editor spawn on Windows.
