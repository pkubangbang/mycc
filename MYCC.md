# MYCC.md

This file provides guidance for Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project builds a tool called "mycc" -- A node.js coding agent implementation using Ollama (default) or DeepSeek API for LLM inference. The architecture follows a modular design with AgentContext as the central state container. Two API providers are supported: Ollama (full features including web_search, screen, read_picture) and DeepSeek (cloud-based, no web/screen tools but with prompt caching). Embedding for wiki/RAG always uses Ollama regardless of provider.

## Setup

Refer to `README.md` for instructions. Prefer pnpm instead of npm. The only exception is `npm link` to install the mycc globally.

**Cross-Platform Notes (Windows / PowerShell):** mycc runs on Windows, Linux, and macOS. On Windows, all `bash` tool commands execute via **PowerShell** (not cmd) — use `Get-Content file`, `Copy-Item src dest`, concatenate with `;` not `&&`, escape with backtick `` ` ``. Set `PYTHONIOENCODING=utf-8` for Python subprocesses; write operations use explicit `utf-8` encoding; the bash tool prepends `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` for CJK display. Always use forward slashes `/` in tool file paths (`normalizePathSeparators` handles `\` → `/` before regex matching). `/fork` uses `PowerShell -EncodedCommand` to spawn terminals (avoids `wt.exe` semicolon bugs; `shell:true` removed, paths single-quoted). `psmux` replaces `tmux` on Windows (`winget install psmux`). Binary detection uses `Where.exe`/`Get-Command` instead of `which`. GUI editor spawn does not use `windowsHide` (prevents freezing).

## Terminology

This section captures the terms specific to this project.

**tools/skills/hooks/routine:** tools are callable functions using the AgentContext, loaded by the "loader" and called by the LLM. skills are markdown files with yaml-front-matter metadata providing extra knowledge. hooks are skills with a `when` property compiled into a trigger condition (targets a timing in the agent loop; condition decides whether to apply the knowledge). routine is another name for the agent loop's ordered steps.

**project / user / built-in tools & skills:** project tools/skills are in `./.mycc/tools` / `./.mycc/skills` (loaded only in this project). user tools/skills are in `~/.mycc-store/tools` / `~/.mycc-store/skills` (loaded for every project). built-in tools are in `src/tools`, built-in skills in `skills/` (loaded unconditionally). The first two are extension points; on name conflicts, built-in always wins and project shadows user.

**session / turn / chat:** **session** = livelog lifetime — from session start (or last compact) to the next compact or process restart. `Sequence` session-level counters (`totalEventsCount`, `toolCallTally`, `sessionPatternLog`) reset on `clear()`, which is co-called with `triologue.compact()`. Hook conditions see livelog, not backlog. **turn** = from one user query to the next (begins at prompt submit, ends when agent returns to PROMPT; `Sequence.events` and `turn.*` functions operate here, cleared at each `markPromptBoundary()` in PROMPT). **chat** = a single LLM response including all tool calls in its delta (tool calls batched; hooks evaluate against prior chats in the same turn, not sibling tools in the same delta).

**backlog / livelog / TP constraint:** **backlog** = the triologue JSONL file (`triologue-lead-{ts}.jsonl`) — the append-only, never-truncated authoritative record of every message that ever occurred. Written via `fs.appendFileSync` in `onMessage` (`agent-repl.ts`). Used by `/load`, `/history`, session archiving. **livelog** = the Triologue object's in-memory `messages` array — the actual context window sent to the LLM. Truncated and summarized by `triologue.compact()` / `triologue.recapMessages()`. The hook condition API (`Sequence`) tracks livelog, not backlog — `sequence.clear()` is co-called with compact, so counters reset when livelog shrinks. **TP constraint** (Triologue Parity) = role alternation constraint that both backlog and livelog must satisfy: `system → user → assistant → tool → assistant → tool → ...`. Violations (tool→user, tool without preceding assistant, consecutive assistant) are auto-recovered by `tp-auto-fixer.ts` (or thrown with `--debug-tp`).

**PROMPT vs prompt (naming collision):** **PROMPT** (all-caps) = a *stage* in the loop state machine (`src/loop/states/prompt.ts`), one of the loop phases alongside COLLECT, LLM, HOOK, TOOL, STOP. It is where the loop decides whether to engage auto mode / WAIT vs. show the prompt and block. **prompt** (lowercase) = the *terminal component* — the interactive input UI with the whisper line and multi-line edit, shown to the user when the loop blocks for input (the `agent >> ` prompt line). The autofly gate lives at the PROMPT stage and decides whether to show the prompt (terminal component) or auto-continue into WAIT. The collision was a recurring source of confusion, so keep the casing distinction precise when discussing the loop.

**autofly / streak:** autofly engages auto mode automatically once a turn has gained enough "momentum." The **streak** counts **LLM stages within the current turn** (autofly momentum): reset to 0 at PROMPT entry (`resetStreak()` in `prompt.ts`), +1 per LLM stage (`recordLlmSuccess()` in `llm.ts`). The autofly gate at the NEXT PROMPT entry evaluates `streak >= threshold` (default 3) when a trigger is armed (`--debug-autofly` OR an active peer channel, `ctx.peer.hasActiveChannel()`). A turn with ≥ threshold LLM stages engages auto mode (→ WAIT + "auto mode is on." note); a turn with fewer does not. The PROMPT-entry reset makes the count strictly per-turn, so prior turns never carry over. ESC flips auto off and resets the streak (`setAuto(false)`), giving the user a breathing window to intervene.

**prompt line / whisper line / letter box:** The **prompt line** is where the user types/submits queries: `agent >> ` (normal), `plan >> ` (plan), `run cmd ! ` (bang). The **whisper line** is a subtle hint above the prompt for transient UI feedback (e.g., "Mycc is wrapping up..." during ESC wrap-up; "Press Ctrl+L again to clear history" for the double-press window). The **letter box** is the LLM's formal reply — the last message before leaving the agent loop, a green block with a timestamp header. With DeepSeek, the letter-box strips internal DSML markup (`<ds_safety>`, `<ds_thinking>`, etc.) via regex; if stripping removes all content, a friendly fallback is shown.

**prompt N (p0, p1):** **p0** = the main `agent >> ` prompt line (`UserInputProvider.getInput()`). **p1** = the secondary `Press Enter to submit (r to return) > ` prompt after the editor closes (`openMultilineEditor()`). Flow: p0 → user types `\` + Enter → editor → p1. Enter submits; `r` + Enter reloads content back to p0 without submitting. See `docs/archived/multiline-input-case-study.md`.

**bang command:** `!<command>` opens an external tmux popup for interactive command execution (bypasses the LLM; prompt switches to magenta `run cmd ! `). Press Enter to capture output and kill session, or 'k' to keep it (persistent sessions like `npm run dev`, `ssh` can be reattached). See `docs/bang-command-design.md`.

**checkpoint and recap:** meta-tools for context management. **Checkpoint** creates a marker before a focused subtask (must be called ALONE, only ONE open at a time, creates a tracking todo, returns an 8-char hash ID). **Recap** compresses all messages from a checkpoint into a summary (requires valid checkpoint ID, uses LLM, replaces those messages, marks the todo done). Main agent only; implementation is in the state machine (`hook.ts`), not the tool handler, because it requires `triologue` outside `AgentContext`.

## Architecture & Core Concepts

**AgentContext** — the modular state container and central interface through which tools interact with the system. Modules: `core` (work dir, logging, user questions), `todo`, `mail` (async inter-agent mailbox), `team`, `issue`, `skill`, `bg`, `wt` (git worktree), `wiki`. Two implementations: `ParentContext` (main, direct access) and `ChildContext` (child, IPC wrappers).

**Triologue** — the conversation state manager: tracks message history, manages `microCompact()`/`autoCompact()` for token management, tracks the `Sequence` for hookish skill conditions, supports hint round generation for confusion recovery.

**AgentIO Singleton** (`src/loop/agent-io.ts`) — manages I/O state: the LineEditor (prompt input), ESC/neglected mode, process type detection. Key: `isMainProcess()` (true in lead, false in child/teammate), `isNeglectedMode()`/`setNeglectedMode(value)`, `onNeglected(callback)`, `ask(prompt)` (main-only), `exec(cmd)` (main-only), `execEditor(args)`. Bang mode: typing `!` at prompt start switches to `run cmd ! ` (`BANG_PROMPT`). **Child processes cannot use `ask()`/`exec()` — they throw.** Use `ctx.core.question()` (IPC) for user questions and `ctx.core.brief()` for logging.

**IPC and IOC** — IPC enables main↔child communication via Node.js `child_process.fork()` and message passing. IOC: `TeamManager` acts as a dispatcher — modules register handlers for specific message types (Open-Closed Principle). Key: `IpcRegistry` (dispatcher), `sendRequest`/`sendNotification` (primitives), Request-Response pattern for operations requiring results.

**Loader** — unified loading of tools and skills with hot-reload for dynamic content. Priority (highest wins): (1) built-in (`src/tools/`, `skills/`), (2) project (`.mycc/tools/`, `.mycc/skills/`), (3) user (`~/.mycc-store/`). Methods: `loadAll()`, `watchDirectories()` (hot-reload), `getToolsForScope(scope)`.

**State Machine** — the agent loop uses explicit states instead of a single `while(true)`: **prompt** (get user input, handle slash/bang/exit), **collect** (pre-LLM pipeline: questions, mail, hint round, todo nudge), **llm** (build system prompt, call LLM with retry), **hook** (augment tool calls, evaluate hook conditions), **tool** (execute tool calls sequentially), **stop** (handle no-tool-call case, await teammates).

**Sequence** — a wrapper around Triologue providing query methods for hookish skill conditions to inspect conversation history (`seq.has('edit_file')`, `seq.count('bash')`, `seq.since('git_commit')`).

**Confusion Index** — a metric quantifying how "stuck" an agent is, triggering hint rounds. Scoring: `+1` per assistant response, `+0` for exploration tools, `-1` for action tools, `+2` for tool errors, `+1` for repetition. When score >= threshold (default 10): main triggers hint round (LLM self-analysis); child sends mail to lead requesting guidance.

**mindmap** — a tree-structured knowledge system compiling markdown files (like `MYCC.md`) into a navigable JSON structure. Each node has an ID (slash-separated path), text, title, summary (LLM-generated), level, children, links. The agent queries nodes via `get_node`/`recall` for efficient context retrieval. Compilation is one-way: `MYCC.md --> [compile_mindmap] --> mindmap.json`. Each agent has an independent mindmap instance (process isolation). **Patch line**: agent-discovered knowledge is recorded as append-only patches in `.mycc/mindmap-patch.jsonl` (add/update/delete), replayed into the in-memory tree at load time. `/mindmap compile` rebuilds patches (BFS dedup/stale-removal) and **preserves MYCC.md-deleted nodes as `add` patches** so trimmed content survives as patch-added knowledge. See `docs/mindmap-design.md` and `docs/mindmap-redesign.md`.

**wiki, vector store** — a persistent knowledge base using LanceDB for vector similarity search, with WAL (Write-Ahead Log) files for audit and rebuild. Each document has hash, domain, title, content, references, embedding vector. Components (`src/context/parent/wiki.ts`): `wiki.get/put/rebuild/listDomains`. Tools: `wiki_get`, `wiki_put`, `wiki_prepare`. Config: embedding model `nomic-embed-text` (`OLLAMA_EMBEDDING_MODEL`), duplicate threshold 0.95, content limits 50-1000 chars. WAL stored in `~/.mycc-store/wiki/logs/YYYY-MM-DD.wal`; rebuild via `/wiki rebuild`.

**Auto-Claim** — idle child processes automatically claim unassigned issues. When a child enters IDLE state (no tool calls), it polls for new mail and scans issues for `pending` + no owner + no blockers, then atomically claims the first match.

**health-check** — runs at startup to validate Ollama connectivity and model availability: (1) server reachable, (2) model exists and can process requests, (3) `TOKEN_THRESHOLD` ≤ 80% of model's context length. Implementation `src/setup/ollama-health-check.ts` (`checkHealth` → `HealthCheckResult`). CLI flag `--skip-healthcheck` bypasses; on failure, prompts retry or exit.

### Hookish Skills

Skills that actively trigger based on patterns in the conversation sequence (vs. passive skills loaded on explicit request). Defined with a `when:` field in YAML frontmatter. Condition language queries conversation history using two scope prefixes: `turn.*` (current turn, since last user query) and `session.*` (entire livelog, since session start or last compact). Functions: `turn.count(tool?)`, `turn.lastIndex(tool)`, `turn.countResult(tool, pattern, maxChars?)`, `turn.hadError(tool?)`, `session.count(tool?)`, `session.lastIndex(tool)`, `session.countResult(tool, pattern, maxChars?)`, `session.hadError(tool?)`, plus global `isPlanMode()`. Tool spec (three-class): plain tool (`"toolName"`), skill_load (`"skill_load#skillName"`), bash (`"bash#commandPrefix"` — clause-split by `;`/`&&`/`||`, then prefix match). Call context: `call.metadata.*` (filePath, newLoc, existingLoc, isDestructive), `call.args.*` (raw tool args). Actions: `inject_before`, `inject_after`, `block`, `replace`, `message`, `compact`.

**Condition Compiler Principles** — translates natural-language `when` into structured `{ trigger, condition, action }` via a safety-first pipeline: (1) **Lazy Compilation** — conditions are NOT compiled eagerly; a skill with `when` is "pending" until `skill_compile` is invoked (pending hooks are injected into LLM context at startup). (2) **LLM Translation with Structured Output** — `when` is sent to the LLM with all tools and a JSON schema enforcing the output shape. (3) **Expression Safety via jsep AST** — conditions are parsed with jsep and walked recursively (NOT `eval`/`new Function`); only `seq`/`call` root identifiers, only known `seq.*` functions, no dangerous identifiers, only safe string/array methods on results. (4) **Retry with Error Feedback** — up to 3 retries. (5) **Smoke Test** — evaluate against an empty mock sequence before persisting. (6) **Atomic Persistence** — temp file + rename, with backup. (7) **Source File Tracking & Orphan Cleanup** — `sourceFile` as `"{layer}:{path}"`; orphans auto-removed. (8) **Version History** — every compilation creates a new version in the `history` array (full audit trail). Key files: `src/hook/conditions.ts`, `src/hook/condition-validator.ts`, `src/hook/evaluator.ts`, `src/tools/skill_compile.ts`.

### Grant System

A permission system for child processes to request approval before performing sensitive operations.

**Intent Language**: The `bash` tool requires an `intent` parameter in the format `VERB OBJECT PARAM PARAM ... TO PURPOSE`, where VERB is one of READ/WRITE/EDIT/DELETE/BUILD/TEST/INSTALL/RUN and OBJECT is one of SOURCE/CONFIG/DEPENDENCY/ARTIFACT/SYSTEM/DATA/TEMP/USER. Example: `READ SOURCE dir=src TO understand dependencies`. Most PARAMs are free-form; a few reserved PARAMs change routing:

- **`dangerous=i_know`** — escape hatch for destructive/irreversible commands (e.g., `rm -rf`, force pushes). Declaring it skips the block AND the LLM safeguard, routing directly to the user `[y/N]` — the human's approval is the real authorization. Only affects `destructive`/`irreversible` categories (the `system` category like `git commit` stays hard-blocked — use `git_commit` instead). Unavailable in child processes. Without it, a blocked command returns a Socratic hint naming the *existence* of a PARAM override but withholding the exact key/value. Example: `DELETE DATA path=build/ dangerous=i_know TO reclaim disk space`.
- **`batch=i_know`** — skip the LLM safeguard for batch deletions (multiple files/globs/recursive paths). Routes directly to user `[y/N]`. Only affects the DELETE + batch-delete path (does NOT bypass a hard block, does NOT cover `dangerous=i_know` patterns). Unavailable in child processes. Example: `DELETE TEMP batch=i_know TO clean build artifacts` (for `rm -rf dist/ node_modules/`).

Implementation: `src/context/grant/bash-judge.ts`. The full system-prompt wording is emitted by `buildIntentLanguageSection()` in `src/loop/agent-prompts.ts`. The `hand_over` tool requires `intent` as `VERB OBJECT TO PURPOSE`; the correct VERB/OBJECT is `RUN USER TO <purpose>` (running an interactive human session) — any other dimension returns a Socratic hint. `command` is a JSON string (multi-line scripts escape newlines as `\n`, but prefer one-lining with `&&`/`;`/`||`). It refuses to spawn a nested popup if the agent is itself inside tmux. Grant flow: `Child → requestGrant → IPC → Parent → check mode → check worktree → grant/deny`. In `plan` mode: all code changes blocked. In `normal` mode: auto-grant for owned worktree, reject otherwise.

## Modes & Team

**normal mode / plan mode:** mycc starts in normal mode (explore + make changes). plan mode is enabled by `/mode plan` or the `plan_on` tool; in plan mode only explorational tools are allowed and the system prompt differs.

**team mode:** not actually a mode, but a state where teammates are spawned to help the lead. Orthogonal to normal/plan (solo-normal, solo-plan, team-normal, team-plan). Uses a dedicated system prompt for collaboration challenges.

**lead and teammates:** the **Lead** is the main agent process (user interaction, spawns teammates, coordinates). **Teammates** are child processes executing assigned tasks. Architecture: `Terminal -> Coordinator -> Lead -> Teammates`. Teammates cannot use `tm_create`, `tm_remove`, `tm_await`, or `broadcast` directly (must request via mail to lead). Key operations (`src/context/parent/team.ts`): `createTeammate`, `listTeammates`, `awaitTeam`, `mailTo`, `broadcast` (lead only).

**lead trusting teammate's autonomous cycle:** A teammate runs its own loop; two normal behaviors are NOT failures the lead should "fix": (1) **idle after a phase is expected, not stuck** — when a teammate finishes a phase (no open todos, no pending tool calls) it mails "phase completed" and enters `idle` (polls for mail/claimable issues every `POLL_INTERVAL`, `src/context/teammate-worker.ts` `enterIdleState`); the lead must not send nag mails nor take over the work. (2) **todo management is the teammate's internal affair** — it does not affect its ability to do assigned work, and the lead cannot manage a teammate's todos; do not instruct teammates to "skip todos" and do not treat a "no active todos" report as a problem. The lead should intervene only on a real stall (no output past the deadline, or a guidance request that genuinely blocks), a timeout, or an error — not on normal idle or internal todo state. A guidance-request mail is worded "could benefit from direction" (not necessarily blocked).

**todo and issue:** **Todos** are simple task tracking items (title, status, blockedBy dependencies). **Issues** are more structured (ID, status, owner, blockedBy/blocks, comments) supporting team coordination. Hash integrity: each todo has a SHA256-based hash (first 8 hex chars) from `name|done|note`; `todo_update` requires matching hash. `pinned`/`reactivate` are deliberately NOT part of the hash, so `todo_pinning` can modify them without a `todo_update` revalidation cycle. Tools: `todo_create`, `todo_update`, `todo_pinning` (lead-only, scope `['main']`), `issue_create`, `issue_claim`, `issue_list`, `issue_close`, `issue_comment`. Slash: `/todos` (pinned show 📌), `/issues`. `todo_write` is the legacy deprecated tool.

**Pinned todos and reactivation:** pinned todos are protected from the auto-clear that removes completed (`done`) todos at the start of each turn; a pinned done-todo also keeps `hasOpenTodo()` false. Pinning is lead-only (`todo_pinning`, scope `['main']`). **Reactivation** reopens a completed pinned todo when its `reactivate` condition becomes true — the lead evaluates candidates with a single `forkChat` call (not `structuredChat`, to preserve prompt cache and retry/ESC support) sending all done+pinned+reactivate items in one JSON-array prompt with `toolChoice='none'`. Flow (`checkReactivation()` in `src/loop/states/collect.ts`): `getReactivationCandidates()` → `forkChat` returning `[{"id":"hash","reopen":true,"reason":"..."}]` → `parseReactivationResult()` → for each `reopen:true`, `todo_update` flips `done` to `false`. Runs in COLLECT step-4 nudge block BEFORE the nudge, on the same throttle (every 3 turns). Teammates are unaffected. See `docs/pinned-todo-reactivation.md`.

**user session / project session:** sessions are persisted conversation states as JSON. **Project sessions** in `.mycc/sessions/` (project-specific); **user sessions** in `~/.mycc-store/sessions/` (shared across projects). **Sealed-session principle:** a session is NEVER shared; once its mycc process exits, its files (session JSON + triologue JSONL) are sealed read-only. `/load <id>` (mid-session, empty-current-session only) or `mycc --from <id>` (cold start, also `/fork`) does NOT resume the old session — it reads it read-only, LLM re-understands the transcript into a fresh context, and continues in a BRAND NEW session. Loading the same id multiple times yields DIFFERENT new sessions (variation by re-understanding) — the basis for branching. Session structure (`src/session/types.ts`): `id`, `create_time`, `project_dir`, `lead_triologue`, `child_triologues`, `teammates`, `first_query` (bookmark title). Use `/save` to copy a project session to user dir and `/load` to branch from any sealed one.

**session file vs triologue JSONL:** the **session file** (`.mycc/sessions/{uuid}/session-{uuid}.json`) holds metadata only (ID, creation time, triologue paths, teammates, first query) — created once, updated in place only by the session's own running process, sealed after exit. The **triologue JSONL** (`.mycc/sessions/{uuid}/triologue-lead-{ts}.jsonl`) is the append-only conversation log — every message appended via `onMessage` in `agent-repl.ts` with `fs.appendFileSync`; the authoritative record of agent activity. The session file tells *what sessions exist and where their logs live*; the triologue JSONL contains *what actually happened*.

**slash commands:** user-initiated `/`-commands handled outside the LLM tool system (meta-operations: help, sessions, modes, knowledge bases). Registry pattern (`src/slashes/index.ts`): `slashRegistry.register`/`execute`. Built-in: `/team`, `/todos`, `/skills`, `/issues`, `/save`, `/load`, `/clear`, `/wiki`, `/domain`, `/mindmap`, `/compact`, `/mode`, `/plan`, `/help`.

### Tool Scope Constraints

| Agent Type | Available Tools |
|------------|-----------------|
| Lead (main) | All tools |
| Teammate (child) | Cannot use: tm_create, tm_remove, tm_await, broadcast |
| Background (bg) | Can only use: bash, read_file, write_file, edit_file |

**Main-only tools**: tm_create, tm_remove, tm_await, broadcast, order, hand_over, plan_on, plan_off, todo_pinning

**Background Task Tools:** the bg module (`bg_create`, `bg_print`, `bg_await`, `bg_remove`) provides non-blocking command execution. `bg_create` spawns async (returns PID); `bg_print` lists tasks or shows output for a PID; `bg_await` blocks until done (optional timeout); `bg_remove` terminates by PID. Uses `spawn()` on all platforms (Windows removes `detached:true` to capture stdout/stderr); output capped ~100KB (tail-capped); killed tracked separately from failed.

**Interactive Shell / /fork Command:** `/fork` spawns a new mycc instance in a separate terminal. `/fork` (current project) or `/fork --env KEY=VALUE` (forward env vars). Linux: `gnome-terminal`/`x-terminal-emulator` with bash. Windows: `PowerShell -EncodedCommand` via `wt.exe` (`shell:true` disabled, single-quoted paths).

## WebUI Features

A Vue 3-based WebUI is served by mycc itself via an embedded Express + Vite + WebSocket stack (`src/serve/serve-hub.ts`, `src/web/`). It provides a browser-based chat interface as an alternative to the terminal REPL: Markdown rendering (letter-box → chat bubbles); interactive **cards** replacing terminal `ask()` prompts (input/confirm/choice) — `CardItem.vue`; session history via `/history` (backed by the durable triologue JSONL transcript, survives serve stop/restart and page closes); 30s disconnect-reconnect timer with graceful warm shutdown. For the developer reference (component layout, WS protocol, input/card bridges, reconnect replay), see `src/web/README.md`.

**steering (WebUI mid-task direction):** lets the user queue direction for the agent *while the LLM is mid-run* without interrupting it. The steering queue lives in `ServeHub` as an **ephemeral, in-memory** buffer (`steeringQueue`, wiped on `stop()`), distinct from the file-backed **mail** system. `pushSteer`/`drainSteering`/`getSteeringNotes` are append/consume/peek. **Two consumption paths**: (1) **COLLECT** (`src/loop/states/collect.ts`, step 2c) — in-flight notes drained and injected verbatim as a `REMINDER` (no synthesis); (2) **PROMPT** (`src/loop/states/prompt.ts`) — if the run was interrupted (ESC/停止) and the user submits a fresh query, stale notes are merged with the query via a `forkChat` synthesis call (`synthesizeWithSteering()`), replacing the raw query; the queue is drained regardless of success and raw query is the fallback. The two paths are mutually exclusive (PROMPT drains first). Frontend (`src/web/src/main.ts`, `ChatInput.vue`, `SteeringBuffer.vue`): when `isRunning`, `send()` routes to `sendSteer`; the buffer bar is populated solely by the server's `steer-echo` broadcast (single source of truth — no local push); `steer-flush` clears it. `/history` returns `{ messages, steeringBuffer }` where `steeringBuffer` is a peek (survives refresh/reconnect within the same serve session; not a serve stop/restart).

**file upload (WebUI chat-box attachments):** mirrors the steering design — same ephemeral-queue architecture in `ServeHub` (`fileUploadQueue`), same two consumption paths (COLLECT in-flight vs PROMPT stale). Key contrast: file uploads are **informational resources saved and noted, never synthesized** — no `forkChat` merge at PROMPT. Files travel inline in the JSON `WsMessage` as base64 (no multer/multipart); both `input` and `steer` carry an optional `files` array. COLLECT (step 2d) drains and saves to `./.mycc/uploaded/` as `${Date.now()}_${filename}` (base64-decoded), injecting a `REMINDER` listing each file (with truncated user-text preview if provided). PROMPT drains stale files with the same save logic and a `REMINDER` — no synthesis (files are read via `read_picture`/`read_file` in the next turn). No client-side buffer bar for files (`file-upload`/`file-flush` echoes are no-ops). The upload queue is not in `/history` and does not survive a serve stop/restart.

**neglection and esc return:** neglection is triggered when the user presses ESC during LLM inference — signals the agent to quickly wrap up without further tool calls. "Neglected mode" aborts ongoing LLM calls, buffers subsequent output, forces a text-only response. Key: `agentIO.isNeglectedMode()`, `setNeglectedMode(value)`, `onNeglected(callback)`; IPC message `{ type: 'neglection' }` (coordinator → lead on ESC).

**esc-aware wrap-up:** on ESC during LLM inference the system enters **wrap-up mode** — the LLM call is aborted via AbortController, a quick "wrap-up" LLM call runs in background to produce a concise text-only response, the prompt line reappears immediately, and the wrap-up result is displayed when ready (with commit/rollback logic). Grace period: if the user starts typing before wrap-up completes, the result is discarded. See `docs/esc-wrap-up-redesign.md`. `ctx.core.escAware(operation, onCleanUp)` wraps slow operations for ESC-aware quick return — on ESC the original promise continues in background, `onCleanUp` is invoked immediately, its result returned to the caller. `Core.escAware()` (parent) uses `agentIO.onNeglected()`; `ChildCore.escAware()` is a placeholder (TODO: IPC). Use `escAware` for high-level operations (tool execution, file ops, network requests); use a manual `AbortController` for low-level stream handling (`retryChat()`, hint round). Currently used by tool execution (`src/loop/states/tool.ts`).

**crossroad:** improves LLM response quality by detecting "turning words" (e.g., "However", "Wait", "但", "但是") in the draft response, generating alternative continuations via parallel `forkChat` calls, selecting the best path while preserving prompt cache. Implementation: `src/hook/crossroad.ts` (runs in the HOOK state before tool execution; debug with `--debug-tp`). Consecutive crossroads contribute to the hint round confusion index.

**@-prefix teammate label convention:** teammate tool output and status messages are routed to a separate `state.teammateMessages` array rather than the main chat log. Routing is decided by a string convention on the existing `label` field — no new WS message types, no `sender` field. The label is `@<teammate>/<tool>` (e.g., `@coder/bash`); `@` marks a teammate message, `/` splits teammate name from tool name. No tool tag → `@<teammate>`. Data flow: the tool tag was historically dropped at the IPC boundary, so **child** (`src/context/child/core.ts`, `ChildCore.brief()`) forwards `tool` in the `log` IPC payload, and **parent** (`src/context/parent/team.ts`, `handleChildMessage()`) builds `@${sender}/${tool}` (falls back to `@${sender}`). Other lifecycle paths (`teammate_ready`, `eta_update`, `status`, `exit`/`error`) are intentionally NOT prefixed. Frontend (`src/web/src/main.ts`): messages whose `label` starts with `@` go into `teammateMessages`; `/history` returns a flat array the client splits. Approximate persistence: teammate messages flow through the same `messageLog` (`MAX_LOG_SIZE = 1000`), replayed on reconnect, but lost on serve stop/restart (the transcript records teammate turns, not their brief/log output).

**Teammate accordion UI:** teammate messages grouped by name and rendered in an accordion UI rather than mixed into the main chat. **`TeammateCard.vue`** — floating top-right card, one row per active teammate (`@name(count): currentTool`), click to open the drawer; hides when the drawer is open or no teammate messages. **`TeammateDrawer.vue`** — right-half panel with stacked accordions per teammate; header `@name(count): current_tool`, body is a flat chronological timeline with `[tool]` prefix tags; first accordion expanded by default; multiple may be open; ✕ closes. Grouping is a frontend computed property — no backend per-teammate state.

## Development

**How to add a tool/skill:** to add a tool — (1) refer to existing code in `src/tools/` for the pattern; (2) create a file in `.mycc/tools` (hot-reloadable); (3) let the user test it manually and iterate from feedback; (4) once qualified, migrate it into `src/tools` and update the loader to make it built-in. See `skills/add-tool/SKILL.md`. To add a skill — same flow with `skills/` as the reference and `.mycc/skills` as the hot-reloadable folder, migrating into `skills/` to make it built-in.

**Tool Development Guidelines:** **Fail Early** — tools should fail early and explicitly rather than silently degrading. **No Direct Console Output in Tools** — tools MUST NOT use `console.log`/`console.error`; use `ctx.core.brief()` for all user-facing output.

**How to test this app** — use tmux to simulate interactive terminal sessions:

```bash
tmux new-session -s mycc-test -d -x 80 -y 24
tmux send-keys -t mycc-test "/help" Enter
tmux capture-pane -t mycc-test -p
tmux kill-session -t mycc-test
```

**Unit Tests** — uses **vitest**; tests in `src/tests/`. `pnpm test` (all) or `pnpm test src/tests/tools/` (specific directory).

**Output Behavior Principles:** **High-Contrast Explanations** — (1) lead with the conclusion (state what changed in ONE line); (2) use tables for comparison (before/after); (3) use diff notation (`+` added, `-` removed, `→` renamed/moved); (4) one change = one line (3 changes = 3 bullets, not a story); (5) avoid filler narration. **Ponytail (Simplicity First) Principle** — in plan mode, responses should be concise and avoid over-explaining; state the conclusion, provide reasoning only if requested (documented in the plan-mode system prompt).

**Code Cleanup** — use TypeScript's strict checks: `pnpm typecheck --noUnusedLocals --noUnusedParameters`. Use ESLint (MUST do before commit); the project uses `typescript-eslint` with a custom `no-console-in-tools` rule (disallows `console.log`/`console.error` in `src/tools/` — use `ctx.core.brief()`). Use prettier after significant changes. `pnpm lint` (all), `pnpm lint src/tools/screen.ts` (specific), `pnpm format`.

**中文顿号 Multi-line Edit:** the `edit_file` tool supports multi-line mode triggered by Chinese enumeration punctuation. When `old_text` ends with `、` (顿号), the tool auto-detects that multiple matching blocks may exist and adjusts its matching strategy — handles the common case of Chinese code comments using 顿号 as separators.

**Debug Flags:**

| Flag | Effect |
|------|--------|
| `--debug-tp` | **Triologue Parity** — on a role transition violation, throw with stack trace instead of auto-recovering. For developing the auto-fixer or debugging `triologue.ts`. |
| `--debug-suggest` | **SUGGEST Background Task** — logs the LLM response/feedback of the background suggest task via `ctx.core.brief()`. Runs after each turn to discover relevant tools/skills. |
| `--debug-eval` | **Expression Evaluation** — prints the parsed AST tree for each hook condition expression during evaluation. For developing hookish skills with custom `when` conditions. |
| `--debug-prompt` | **Prompt Debug** — shows the full system prompt sent to the LLM (tool descriptions, skill content). Also shows the 'Parsing...' spinner during keyword extraction. |

Combine with `-v` (verbose) for maximum detail.

**Docker Support:** a Dockerfile is provided at project root. The Docker setup builds mycc in a Node.js container, supports auto-input/output via JSONL files, and is useful for CI/CD pipelines and automated testing. `docker build -t mycc .` then `docker run -it mycc`.

### Built-in Skills Reference

mycc ships with the following built-in skills (in `skills/` directory):

| Skill | Description |
|-------|-------------|
| `self-learning` | Bloom's 2-Sigma tutor — guides the LLM to teach the user, with `todo_create`/`todo_update` integration for progress tracking |
| `mycc-self-awareness` | Meta-knowledge about mycc itself — capabilities, architecture, and how to interact with the system |
| `coordination` | Human-in-the-loop guidance for lead-teammate collaboration workflow |
| `hint-round` | Encourages wiki search when stuck on errors or missing knowledge |
| `environment-detection` | Multi-platform directory detection with PowerShell/Bash/CMD cheatsheets |
| `add-tool` | Step-by-step guide for adding custom tools to the project |
| `create-skill` | Meta-skill for creating new skills with templates (process, reference, lesson, hookish) |
| `pdf` | PDF text extraction via unpdf and OCR via tesseract.js |
| `tech-doc-writing` | Technical documentation writing guide covering wire format, API docs, READMEs |
| `clear-sessions` | Session cleanup and management |
| `compact-on-intent-trap` | Automatic compaction when agent is stuck in intent loops |
| `set-title` | Terminal title management |
| `mycc-online-hotfix` | Live debugging and hotfix workflow using bash + tmux for tool bugs |

Skills are loaded from three layers: built-in (`skills/`), project (`.mycc/skills/`), and user (`~/.mycc-store/skills/`). Built-in skills have the highest priority.

## Pitfalls

**Tool descriptions are for LLM awareness, not user-facing:** the `description` field is read by the LLM to understand what a tool does. It should NOT be user-facing documentation with verbose parameter explanations or step-by-step workflows. The description is about **what** the tool does, not **how** it does it internally. Implementation details (confirmation prompts, mail notifications) belong in code comments, not the description field. Keep it concise and LLM-oriented.

**DeepSeek API pitfalls:** when using DeepSeek (API_PROVIDER=deepseek): no web/screen tools (`web_search`, `web_fetch`, `screen`, `read_picture` unavailable); DSML stripping (the letter-box strips internal DSML markup like `<ds_safety>`/`<ds_thinking>`); prompt caching (automatic for repeated prefixes); embedding still uses Ollama (wiki/RAG requires a local Ollama with `nomic-embed-text`); `tool_choice="none"` for wrap-up mode (prevents raw XML tool calls). Detailed reference: `docs/deepseek-api-reference.md`.

**agentIO singleton works differently in child processes:** `agentIO` (`src/loop/agent-io.ts`) is imported by both main and child, but `initMain()` is only called in the main process. `isMainProcess()` returns `true` in main (lead), `false` in child (teammates) — `isMainProcessFlag` defaults to `false` and only becomes `true` after `initMain()`. **Important**: only use `isMainProcess()` to distinguish lead vs teammate context. Other methods (`ask()`, `exec()`) throw in child processes. For code working in both contexts: use `agentIO.isMainProcess()` to check, `ctx.core.question()` for user questions (IPC), `ctx.core.brief()` for logging (IPC in child).

**Loop Notation (LN):** a compact notation for message role rotation in the agent loop. Each comma-separated unit is one message. Units: `system` (system prompt), `user` (user query), `[tool1, tool2]?` (assistant's batched tool call, `?` = called by LLM), `tool1!` (tool result, one at a time), `agent` (assistant text reply), `_tool1_` (tool call replaced with placeholder after compaction). Example single-turn: `system, user, [tool1]?, tool1!, agent`. Example with batching + compaction: `system, user, [tool1]?, tool1!, [tool2, tool3]?, tool2!, _tool3_, agent, user, agent` (system → user → tool1 call → result → tool2+tool3 batched → tool2 result → tool3 compacted → agent reply → user → agent reply). Conventions: `[]?` groups batched calls from the same delta; `!` marks a result; `_` wraps a compacted call; bare units (system/user/agent) are pure text.

## Reference Documents

- `docs/agent-context.md` - AgentContext module (Chinese)
- `docs/agent-loop.md` - Agent loop (Chinese)
- `docs/agent-tools.md` - Built-in tools reference
- `docs/child-context.md` - Child process and IPC (Chinese)
- `docs/dynamic-loading.md` - Tool/skill loading mechanism
- `docs/pinned-todo-reactivation.md` - Pinned todos and reactivation feature design
- `docs/database-schema.md` - Data storage schema (Chinese, historical reference — SQLite removed in v0.7.0)