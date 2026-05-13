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

## 2026-03-31
### Project Initialization
- **Core Architecture**: Implemented `AgentContext` with modular components (core, todo, mail, skill, issue, bg, wt, team).
- **Built-in Tools**: Added `bash`, `read_file`, `write_file`, `edit_file`, and `todo_write`.
- **Infrastructure**: Implemented colored logging and expanded tool scope to background agents.
- **Documentation**: Created `README.md` and `agent-tools.md`.
- **Fixes**: Resolved quitting issues and successfully built `better-sqlite3`.

## 2026-04-01
### IPC & Child Context
- **Child Context**: Implemented a complete rewrite of child process context for better teammate management.
- **IPC Registry**: Added inter-process communication registry and `ctx.core.question` for lead-teammate coordination.
- **Mail System**: Updated mail sending functions and introduced transcript logging.
- **Auto-Compact**: Implemented LLM-based summarization for chat history (`autoCompact`) replacing simple truncation.
- **Issue Management**: Integrated issue tools (create, close, comment, claim) into `src/tools`.
- **Web Integration**: Added Ollama web search API.

## 2026-04-02
### New Toolsets & UX
- **Tool Expansion**: Added `web_search`, `web_fetch`, git worktree tools (`wt_create`, `wt_remove`, etc.), and background tools (`bg` tools).
- **Interaction**: Implemented `agentio` for better readline and added Ctrl+C support for the bash tool.
- **Collaboration**: Migrated `tm_await` to built-in tools and improved teammate mail reading behavior.
- **Documentation**: Calibrated all docs with the codebase, updated architecture diagrams, and tool/skill workflows.

## 2026-04-03
### Coordination & Stability
- **Collaboration**: Rewrote child team module; improved lead-teammate coordination and question handling.
- **Resilience**: Implemented retry logic with exponential backoff for transient Ollama API errors.

## 2026-04-04
### Conversation Management
- **Triologue**: Encapsulated chat history into a dedicated `triologue` module for structured conversation management.
- **Prompts**: General improvements to agent prompts.

## 2026-04-05
### Logging & Config
- **Web Tools**: Refined logging for `web_search` and `web_fetch`.
- **Configuration**: Made `TOKEN_THRESHOLD` configurable via environment variables.

## 2026-04-06
### Diagnostics & Skills
- **Debugging**: Added `/dump` command for both lead and child processes.
- **Skill System**: Added documentation and skills on how to create custom skills.
- **Cleanup**: Removed transcript module in favor of session storage.

## 2026-04-07
### Guidance System
- **Hints**: Implemented the hint mechanism in triologue; triggers only after 10 steps of "running away".
- **Stability**: Added HTTP 503 to recoverable errors; fixed main process exit hang.

## 2026-04-08
### Session & UI
- **Session Management**: Implemented session design, including creating empty session files on start and designing the session manager.
- **Screen Tool**: Added `screen` tool for Ubuntu 24.04 Wayland.
- **Self-Regulation**: Updated confusion index calculation and integrated it into the hint triggering logic.

## 2026-04-09
### Architecture Refactoring
- **AgentContext**: Migrated to a class-based architecture and removed factory functions.
- **Session Ops**: Implemented session restoration and the `/load` command (auto-opens DOSQ file).
- **Infrastructure**: Modularized slash commands with session cleanup; migrated to `pnpm` (removed `package-lock.json`).

## 2026-04-10
### Robustness & Loading
- **API Handling**: Added comprehensive error handling for all Ollama API calls.
- **Tool Loading**: Implemented a 3-layer priority loading system (built-in, project, user).
- **Interrupts**: Ensured Ctrl+C reliably interrupts agent execution.
- **Editor**: Replaced `open-editor` dependency with a local implementation.

## 2026-04-11
### Utility Tools & UX
- **New Tools**: Added `read-read` tool for summarizing long file results.
- **Conversation**: Added `/clear` command to reset conversation history.
- **Logging**: Added `-v` flag for verbose logging and descriptive headers for dumped tool result files.

## 2026-04-12
### Input Enhancements
- **Multi-line Input**: Added support via a popup editor.
- **Startup**: Implemented tool-based startup with a Message Of The Day (MOTD) in health checks.
- **Environment**: Fixed loading of both global and local `.env` files.

## 2026-04-13
### Lifecycle Management
- **Coordinator**: Introduced the coordinator pattern and Coordinator IPC to ensure clean process exit and prevent hangs.

## 2026-04-14
### Input Handling
- **Line Editor**: Implemented a custom line-editor for the lead agent and `rawMode` for the coordinator.

## 2026-04-15
### Knowledge Base (RAG)
- **Wiki Module**: Implemented the wiki module for Retrieval-Augmented Generation (RAG); added wiki deletion and bash output summarization.
- **Help**: Added `/help` slash command and updated documentation.

## 2026-04-16
### Refactoring & Stability
- **Tool Migration**: Moved the `order` tool to the built-in set.
- **Session Init**: Extracted session initialization helpers and ensured session data is always cleared.
- **Prompts**: Updated tool descriptions to be LLM-facing for better tool-use accuracy.

## 2026-04-17
### Session Isolation & Context
- **Project Context**: Implemented auto-injection of `CLAUDE.md` and `README.md` into chat history.
- **Isolation**: Resolved SQLite multiple statement errors and implemented session isolation.
- **UX**: Renamed user directory to `~/.mycc-store`; updated `/load` to hide the current session.
- **Version**: Bumped version to `v0.3.0`.

## 2026-04-18
### Interactive Bash
- **Passthrough**: Added passthrough mode for interactive bash commands.
- **Recovery**: Improved ESC interruption handling and recovery of orphaned tool calls.

## 2026-04-19
### Neglected Mode
- **ESC Workflow**: Polished the ESC workflow for quick wrap-up; consolidated "neglected mode".
- **Optimization**: Subprocesses are now skipped automatically on ESC.

## 2026-04-20
### Vision & Storage
- **Vision**: Added `imgDescribe` to core and implemented the `read-picture` tool.
- **Storage**: Removed SQLite dependency entirely, replacing it with in-memory storage.
- **UX**: Added verbose output to bash and read tools; implemented output buffering during user interaction.

## 2026-04-21
### Testing & Process Isolation
- **Testing**: Added comprehensive unit tests via `vitest` for issue tools, todo, brief, skill_load, worktree, and blockage tools.
- **Tmux**: Added `tmux` tool and "bang" command support.
- **Isolation**: Isolated subprocesses from `/dev/tty` using `setsid`.
- **Version**: Released `v0.4.1` with network error handling and user retry prompts.

## 2026-04-22
### Planning & Skill Architecture
- **Parallel Context**: Restructured context into a parallel parent/child structure.
- **Planning**: Added skills for creating coding plans and a "make a plan" skill.
- **Skill-Wiki**: Implemented skill wiki indexing (Phase 1) and wiki-matching hints (Phase 2).
- **DX**: Enabled TypeScript tool development with a unified runtime; added ESLint with `typescript-eslint`.

## 2026-04-23
### Cross-Platform Support
- **Windows**: Implemented full support for Windows startup and cross-platform image processing.
- **Screen Tool**: Added PowerShell integration for Windows screen capture.

## 2026-04-24
### Knowledge Boundaries
- **Knowledge Boundary**: Replaced skill hint injection with a formal knowledge boundary mechanism.
- **Prompts**: Added platform detection and shell guidance to system prompts.
- **Healthcheck**: Added diagnostics for `OLLAMA_VISION_MODEL`.

## 2026-04-25
### Permissions & Setup
- **Git Commit**: Added `git_commit` tool with mandatory user permission checks.
- **Setup Wizard**: Added an interactive setup wizard for environment configuration.

## 2026-04-26
### UX
- **Hand-over**: Refined the prompt and interaction flow for the `hand_over` tool.

## 2026-04-27
### Hook System
- **Hookish Skills**: Implemented active skill triggers based on "when" conditions.
- **Compilation**: Added capability to compile skill hooks into executable conditions.
- **Hotfix**: Added `mycc-online-hotfix` skill and enhanced the `hand_over` tool.

## 2026-04-28
### Error Handling
- **Transient Errors**: Implemented retry for transient errors without returning to the prompt.
- **Hooks**: Reorganized the hook system and added stop trigger support.

## 2026-04-29
### Plan Mode & State Machine
- **Plan Mode**: Implemented "Plan Mode" to block code changes; added documentation and hook skills.
- **State Machine**: Refactored the agent loop into a state machine (`v0.6.0`).
- **Evaluation**: Replaced `Function` constructor with `jsep` AST evaluation for hook conditions.
- **Child Processes**: Implemented a mode and grant system for child processes.

## 2026-04-30
### Mode Control
- **Mode Tools**: Added `plan_on` and `plan_off` for explicit mode control.
- **Prompts**: Added verification guidelines to the system prompt and initial prompts in `tm_create`.

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
- [ ] mindmap not updated when only removal is included.
- [ ] line-editor structure: 1 hint line + n prompt line + 1 blank line
- [ ] improve hook log output
