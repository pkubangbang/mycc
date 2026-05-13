# Changelog Archive - April 2026

This file contains archived changelog entries from the mycc project for April 2026.
For current changelog, see `changelog-todo.md`.

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