# MYCC.md

This file provides guidance for Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project builds a tool called "mycc" -- A node.js coding agent implementation using Ollama (default) or DeepSeek API for LLM inference. The architecture follows a modular design with AgentContext as the central state container. Two API providers are supported: Ollama (full features including web_search, screen, read_picture) and DeepSeek (cloud-based, no web/screen tools but with prompt caching). Embedding for wiki/RAG always uses Ollama regardless of provider.


## Setup

Refer to `README.md` for instructions.

Prefer using pnpm instead of npm. The only exception is `npm link` to install the mycc globally.

### Cross-Platform Notes (Windows / PowerShell)

mycc runs on Windows, Linux, and macOS. Notable differences:

- **Shell**: On Windows, all `bash` tool commands execute via **PowerShell** (not cmd). Use PowerShell syntax: `Get-Content file`, `Copy-Item src dest`. Concatenate commands with `;` not `&&`. Use backtick `` ` `` for escaping.
- **UTF-8**: On Windows, set `PYTHONIOENCODING=utf-8` for Python subprocesses. Write operations use explicit `utf-8` encoding. The bash tool prepends `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` for CJK display.
- **Path separators**: Always use forward slashes `/` in tool file paths for cross-platform compatibility. Internally, `normalizePathSeparators` handles `\` → `/` conversion before regex matching.
- **/fork command**: Uses `PowerShell -EncodedCommand` to spawn new terminals, avoiding `wt.exe` semicolon bugs. The `shell:true` option is removed and paths are single-quoted.
- **tmux alternative**: On Windows, `psmux` replaces `tmux` for interactive terminal operations. Install via `winget install psmux`.
- **Binary detection**: Uses `Where.exe` or `Get-Command` instead of `which` on Windows. The `isBinaryAvailable` helper handles platform-specific detection.
- **GUI editor**: On Windows, GUI editor spawn does not use `windowsHide` to prevent process freezing.

## Terminology

This section captures the terms specific to this project.

### tools/skills/hooks/routine

tools are callable functions that uses the AgentContext. They have the same shape, are loaded by the 
"loader", and called by llm.

skills are markdown files with yaml-front-matter metadata. They provide extra knowledge for the llm
to utilize, mostly specialist experiences.

hooks are a special case of skills. They have a `when` property that can be compiled into a trigger condition.
The trigger targets a specific timing in the agent loop, while the condition tells whether to apply
the knowledge or not.

routine is another way of speaking of the agent loop, where sevaral steps of logic take place in order.

### project tools, user tools, built-in tools

project tools are in `./.mycc/tools`, and are loaded only in this project.
user tools are in `~/.mycc-store/tools`, and are loaded for every project (for the current user).
built-in tools are inside the `src/tools`, and are loaded unconditionally.

The first two locations are treated as extention points. Tools are loaded by name, if there are
conflicts, the built-in always wins, and the project ones will shadow the user ones.

### project skills, user skills, built-in skills

project skills are in `./.mycc/skills`, and are loaded only in this project.
user skills are in `~/.mycc-store/skills`, and are loaded for every project (for the current user).
built-in skills are inside the `skills` of this project root, and are loaded unconditionally.

The first two locations are treated as extention points. Skills are loaded by name, if there are
conflicts, the built-in always wins, and the project ones will shadow the user ones.

### neglection and esc return

Neglection is triggered when the user presses ESC during LLM inference. It signals the agent to quickly wrap up the current response without further tool calls. The "neglected mode" aborts ongoing LLM calls, buffers subsequent output, and forces the agent to finish with a text-only response.

Key components:
- `agentIO.isNeglectedMode()` - Check if ESC was pressed
- `agentIO.setNeglectedMode(value)` - Set/clear neglected flag
- `agentIO.onNeglected(callback)` - Register callbacks for ESC events
- IPC message `{ type: 'neglection' }` - Coordinator sends to Lead on ESC press

### crossroad

The crossroad feature improves LLM response quality by detecting "turning words" (e.g., "However", "Wait", "但", "但是") in the LLM's draft response, generating alternative continuations via parallel `forkChat` calls, selecting the best path to enhance response quality while preserving prompt cache.

Key behaviors:
- **Turning word detection**: Scans the LLM response for signal words that indicate the LLM is about to change direction
- **Parallel continuation**: Uses `forkChat` to generate multiple alternative continuations concurrently
- **Best path selection**: Compares alternatives and selects the most coherent continuation
- **Continuation shortening**: Trims verbose continuations and logs alternatives with selection
- **Confusion index integration**: Consecutive crossroads contribute to the hint round confusion index

Implementation: `src/hook/crossroad.ts`. The crossroad runs in the HOOK state before tool execution. Debug with `--debug-tp` flag.

### esc-aware wrap-up

When the user presses ESC during LLM inference, the system enters **wrap-up mode**:
1. The LLM call is aborted via AbortController
2. A quick "wrap-up" LLM call runs in background to produce a concise text-only response
3. The prompt line reappears immediately for user input (no waiting)
4. The wrap-up result is displayed when ready, with commit/rollback logic

Grace period: If the user starts typing before wrap-up completes, the wrap-up result is discarded. If the user hasn't typed, a brief summary or the agent's last thought is displayed.

Key reference: `docs/esc-wrap-up-redesign.md`

A utility method in `ctx.core` that wraps slow operations for ESC-aware quick return. When ESC is pressed during a slow operation:
- The original promise continues in background
- The `onCleanUp` callback is invoked immediately
- The cleanup result is returned to caller

Usage:
```typescript
const result = await ctx.core.escAware(
  async (abortController) => {
    // Slow operation (e.g., tool execution, file read)
    // abortController.signal can be passed to underlying operations
    return await performOperation(abortController.signal);
  },
  () => 'fallback result'
);
```

Key behaviors:
- **No ESC pressed**: Returns original operation result
- **ESC already pressed**: Returns cleanup result immediately
- **ESC during operation**: Returns cleanup result, operation continues in background

Architecture:
- `Core.escAware()` - Parent process implementation using `agentIO.onNeglected()`
- `ChildCore.escAware()` - Child process placeholder (TODO: IPC-based handling)

**AbortController Integration**:
The `operation` function receives an `AbortController` that is automatically aborted when ESC is pressed. This allows the operation to:
1. Pass the signal to underlying libraries (e.g., fetch, retryChat)
2. Check `abortController.signal.aborted` for custom abort logic
3. Listen to abort events with `abortController.signal.addEventListener('abort', ...)`

**When to use escAware vs AbortController:**

1. **Use `escAware` for high-level operations**:
   - Tool execution (e.g., `src/loop/states/tool.ts`)
   - File operations
   - Network requests (web search, web fetch)
   - Any operation that doesn't need internal stream abort

2. **Use `AbortController` for low-level stream handling**:
   - LLM calls via `retryChat()` (needs signal for stream abort)
   - Hint round generation (uses `retryChat()` internally)
   - Any operation that needs fine-grained abort control

The key difference: `escAware` provides a clean high-level abstraction for ESC handling with automatic abort controller management, while manual `AbortController` is needed when you need more control over the abort lifecycle.

Currently used by:
- Tool execution (`src/loop/states/tool.ts`)
- LLM calls use AbortController internally (correct for stream handling)
- Hint round uses AbortController internally (correct for stream handling)

### steering (WebUI mid-task direction)

**Steering** is a webui-only feature that lets the user queue direction for the
agent *while the LLM is mid-run*, without interrupting it. The user types into
the chat input while `isRunning` is true; the note is buffered server-side and
consumed by the agent at the next natural stopping point. It is the webui
analogue of talking over the LLM's shoulder, and it deliberately does NOT flip
the prompt back on (the LLM keeps working — the user is steering, not
replacing the current turn).

The steering queue lives in `ServeHub` (`src/serve/serve-hub.ts`):

- `steeringQueue: string[]` — an **ephemeral, in-memory** buffer. It is never
  persisted, and it is wiped on `stop()`. This is the key contrast with the
  **mail** system, which is file-backed and meant for *inter-agent*
  communication; steering is *user→agent* direction for the current run only.
- `pushSteer(text)` — fire-and-forget; appends to the queue and broadcasts a
  `steer-echo` to all clients so every connected buffer bar shows the note.
- `drainSteering()` — consume-and-clear; returns all queued notes and
  broadcasts `steer-flush` so the frontend buffer bars clear.
- `getSteeringNotes()` — peek without consuming (PROMPT uses this to decide
  whether to synthesize before draining).

**WebSocket protocol** (`WsMessage.type`):

| Direction | type | meaning |
|-----------|------|---------|
| client → server | `steer` | user queued a steering note (`text`) |
| server → client | `steer-echo` | note echoed to all clients (show in buffer bar) |
| server → client | `steer-flush` | queue drained; clear all buffer bars |

**Two consumption paths** — this is the central design. Which path fires
depends on whether the queued notes are still *in-flight* (the run they were
steering is still going) or *stale* (that run was interrupted and the user
started a fresh turn):

1. **COLLECT — in-flight REMINDER injection** (`src/loop/states/collect.ts`,
   step 2c). When the LLM naturally reaches COLLECT mid-run with notes still
   queued, the notes are *current* direction for the ongoing work. They are
   drained and injected verbatim as a `REMINDER` note:

   ```
   Steering notes from the user (mid-task direction):
   (1) <note 1>
   (2) <note 2>
   ```

   No synthesis — the notes are actionable as-is. Reuses the existing
   `REMINDER` NoteCategory (no new category needed).

2. **PROMPT — stale-note synthesis via forkChat** (`src/loop/states/prompt.ts`).
   If the user pressed ESC (or hit 停止) to interrupt the run, then submitted a
   fresh query, the queued notes are *stale*: the run they were steering is
   gone, so their actionable direction no longer applies, but they may still
   carry informational value (context, constraints, references). PROMPT peeks
   via `getSteeringNotes()`; if non-empty, it runs `synthesizeWithSteering()`
   — a `forkChat` call with a tight `SYNTHESIS_RETRY_CONFIG`
   (`firstTokenTimeoutMs: 10s`, `responseTimeoutMs: 30s`, `maxRetries: 1`) —
   that merges the stale notes + fresh query into a single user-voiced prompt.
   The synthesized text *replaces* the raw fresh query as the user message.
   The queue is drained after synthesis **regardless of success** (so COLLECT
   never re-injects the same notes — no double-count). On any failure or empty
   synthesis, the raw fresh query is used as the fallback. The synthesis call
   itself is wrapped in `ctx.core.escAware(...)` so a second ESC aborts it
   cleanly and falls back to the raw query.

   The synthesis path only fires when the query came from the input provider
   (a genuine fresh post-interrupt submission) — not for slash commands or
   restored initial queries, which represent automated/restored state rather
   than a fresh user submission.

**Frontend behavior** (`src/web/src/main.ts`, `ChatInput.vue`,
`SteeringBuffer.vue`):

- `ChatInput.send()` routes by state: when `isRunning`, `send()` calls
  `sendSteer(text)` instead of `sendInput(text)`. The placeholder switches to
  a "等待回复中…" hint so the user knows their typing will steer, not submit.
- `sendSteer` locally echoes the note as a user chat bubble, then sends
  `{type:'steer', text}` over the WS. It deliberately does **not** flip
  `isWaiting`/`isRunning` (the LLM is still working) and does **not** push to
  `state.steeringBuffer` locally — the buffer bar is populated solely by the
  server's `steer-echo` broadcast (see "Single source of truth" below).
- `SteeringBuffer.vue` renders an amber `🧭 转向` chip bar between the
  StatusBar and the ChatLog, showing `state.steeringBuffer`. It appears only
  when there are queued notes (`v-if="notes.length > 0"`).
- On `steer-echo`, the note is pushed to `steeringBuffer` (bar grows). On
  `steer-flush`, `steeringBuffer` is cleared (bar disappears).

**Refresh / reconnect survival:** the buffer bar is restored on a page
refresh or WS reconnect. The `/history` endpoint returns
`{ messages, steeringBuffer }`, where `steeringBuffer` is a **peek** (via
`getSteeringNotes()`, not a drain) of the current in-memory queue. On load,
`fetchHistory()` splices the peeked notes into `state.steeringBuffer`, so the
bar reappears with the still-queued notes; the notes remain queued for
COLLECT/PROMPT to drain later, and the next `steer-flush` broadcast clears
the restored bar. This survives any refresh within the same serve session
(serve stays running across a page refresh — only `stop()` clears the queue).
It does NOT survive a serve stop/restart — the queue is ephemeral by design.

**Single source of truth for the buffer bar:** the originating client does
NOT push to `steeringBuffer` locally in `sendSteer` — it only echoes the note
as a user chat bubble. The buffer bar is populated solely by the server's
`steer-echo` broadcast, which reaches all clients (including the sender).
This avoids a double-push that would otherwise show the note twice on the
originating client.

**Why two paths instead of always injecting at COLLECT?** If the user
interrupts the run, COLLECT for that run never happens — the notes would be
stranded. PROMPT synthesis rescues them by folding their informational value
into the next turn's query, while explicitly discarding the now-stale
actionable direction. If the run is *not* interrupted, COLLECT drains them as
live REMINDERs. The two paths are mutually exclusive: PROMPT drains first
(when it fires), so COLLECT sees an empty queue on the immediately following
pass.

See also: **esc-aware wrap-up** (the interrupt mechanism that makes notes
"stale"), **neglection and esc return** (ESC handling), and the WebUI section
below. `changelog-todo.md` tracks the open "webui: 允许 steering buffer" item.

### file upload (WebUI chat-box attachments)

**File upload** is a webui-only feature that lets the user attach files to a
chat submission — either a normal `input` or a `steer` — without interrupting
the run. It mirrors the **steering** design: the same ephemeral-queue
architecture, the same two consumption paths (COLLECT in-flight vs PROMPT
stale), and the same `ServeHub` as the buffer. The key contrast is that file
uploads are **informational resources to be saved and noted**, never
synthesized — there is no `forkChat` merge at PROMPT (unlike steering).

The upload queue lives in `ServeHub` (`src/serve/serve-hub.ts`):

- `fileUploadQueue: FileUploadEntry[]` — an **ephemeral, in-memory** buffer.
  Never persisted, wiped on `stop()` (same lifecycle as `steeringQueue`).
- `pushFileUpload(entry)` — fire-and-forget; appends to the queue and
  broadcasts a `file-upload` (carrying the `filename`) to all clients.
- `drainFileUploads()` — consume-and-clear; returns all queued files and
  broadcasts `file-flush` so clients can react.
- `getFileUploads()` — peek without consuming.

`FileUploadEntry` / `FileUploadMeta` shapes (serve-hub.ts):

```ts
interface FileUploadMeta {      // wire shape (client → server)
  filename: string;
  data: string;                 // base64-encoded file bytes
  mimeType: string;
}
interface FileUploadEntry {     // server-side queue entry
  filename: string;
  data: string;                 // base64 (decoded only when saved)
  mimeType: string;
  text?: string;                // the user's accompanying chat text (optional)
}
```

The optional `text` field carries the user's chat text that accompanied the
upload (passed from `msg.text` at the WS handler). It is surfaced in the
REMINDER as a truncated preview so the LLM sees the user's framing of the
file, not just the bytes.

**WebSocket protocol** (`WsMessage.type`):

| Direction | type | meaning |
|-----------|------|---------|
| client → server | `input` | user submitted a query; `files?: FileUploadMeta[]` attached |
| client → server | `steer` | user queued a steering note; `files?: FileUploadMeta[]` attached |
| server → client | `file-upload` | a file was queued (carries `filename`) |
| server → client | `file-flush` | queue drained (files saved to disk) |

Files travel inline in the JSON `WsMessage` as base64 — there is **no
multer / HTTP multipart endpoint**. Both `input` and `steer` carry an
optional `files` array; the WS handler pushes each file via `pushFileUpload`
*after* routing the text (`submitInput` for `input`, `pushSteer` for `steer`),
so a single submission can carry text + files in one round trip.

**Two consumption paths** — identical structure to steering, but with a
critical difference at PROMPT:

1. **COLLECT — in-flight save + REMINDER** (`src/loop/states/collect.ts`,
   step 2d). When the LLM naturally reaches COLLECT mid-run with files still
   queued, the files are *current* uploads for the ongoing work. They are
   drained and saved to `./.mycc/uploaded/` as `${Date.now()}_${filename}`
   (base64-decoded via `Buffer.from(file.data, 'base64')`). A `REMINDER` note
   lists each file:

   ```
   User uploaded file(s):
   - <filename> → .mycc/uploaded/<ts>_<filename> (<mimeType>)
     Text: "<first 200 chars of user text>..."   (only if text was provided)
   ```

2. **PROMPT — stale save + REMINDER, NO synthesis** (`src/loop/states/prompt.ts`).
   If the user pressed ESC (or 停止) to interrupt the run, then submitted a
   fresh query, the queued files are *stale*: the run they were uploaded for
   is gone. PROMPT drains them and saves them with the same `${Date.now()}_`
   prefix logic, then injects:

   ```
   Previously uploaded file(s) (from interrupted run):
   - <filename> → .mycc/uploaded/<ts>_<filename> (<mimeType>)
   ```

   **No `forkChat` synthesis** — this is the deliberate contrast with
   steering. Files are informational resources saved as-is; the REMINDER
   carries forward into the next turn so the LLM can read them (e.g. via
   `read_picture` for images, `read_file` for text). The code comment states
   this explicitly: *"file uploads don't need synthesis — they are
   informational resources to be saved and noted."*

   The stale-files drain sits **inside the same `hub.isRunning() && query
   !== null` guard** as steering synthesis — so it only fires for a genuine
   fresh post-interrupt submission, not for slash commands or restored
   initial queries. It runs **after** the steering synthesis block, so a
   submission carrying both a stale steering note and stale files handles
   the note first (synthesis) and the files second (save).

**Frontend behavior** (`src/web/src/main.ts`):

- `chatApi.sendInput(text, files?)` — echoes a user bubble (`text || '(uploaded
  files)'`), clears `inputText`/`pendingFiles`, flips `isWaiting`/`isRunning`,
  sends `{type:'input', text, files}`.
- `chatApi.sendSteer(text, files?)` — echoes a user bubble, clears state, sends
  `{type:'steer', text, files}`. Like the text-only steering path, it does
  **not** flip `isWaiting`/`isRunning` (the LLM is still working).
- `state.pendingFiles: FileInfo[]` — the staged attachments in the chat box,
  cleared on send.
- `file-upload` and `file-flush` echoes are **no-ops** in the WS handler
  (comments: "could show a transient indicator" / "nothing to clear on the
  client side"). Unlike steering's `steer-echo`/`steer-flush`, there is no
  client-side buffer bar for files — the echoes exist for protocol symmetry
  and future use.
- The `/history` filter drops `file-upload`/`file-flush` from the visible
  chat log (they are not chat content).

**Save location & naming**: `./.mycc/uploaded/` is created on demand
(`fs.mkdirSync(..., { recursive: true })`). Each file is written as
`${Date.now()}_${filename}` to avoid collisions when the same name is
uploaded twice. The RELATIVE path from `process.cwd()` is what the REMINDER
reports, so the LLM can open it directly with `read_file`/`read_picture`.

**Refresh / reconnect survival**: the upload queue is **not** included in
the `/history` payload (only `steeringBuffer` is peeked there). On a page
refresh or WS reconnect, queued-but-undrained uploads are invisible to the
client — but they remain queued server-side and will still be drained by the
next COLLECT/PROMPT pass. This is consistent with the "no client-side buffer
bar" decision: uploads have no UI state to restore. Like steering, the queue
does NOT survive a serve stop/restart (ephemeral by design, wiped in
`stop()`).

See also: **steering** (the sibling ephemeral-queue feature this mirrors),
and the WebUI section below.

### slash commands

User-initiated commands starting with `/` that are handled outside the LLM tool system. They provide meta-operations like viewing help, managing sessions, switching modes, and managing knowledge bases.

Registry pattern (`src/slashes/index.ts`):
- `slashRegistry.register(command)` - Register a command
- `slashRegistry.execute(name, context)` - Execute a command by name

Built-in commands:
- `/team`, `/todos`, `/skills`, `/issues` - Team and task management
- `/save`, `/load`, `/clear` - Session management
- `/wiki`, `/domain`, `/mindmap` - Knowledge base management
- `/compact`, `/mode`, `/plan` - Mode and state control
- `/help` - Show available commands

### user session, project session

Sessions are persisted conversation states stored as JSON files. **Project sessions** are stored in `.mycc/sessions/` and are project-specific. **User sessions** are stored in `~/.mycc-store/sessions/` and can be shared across projects.

Session structure (`src/session/types.ts`):
- `id` - Unique identifier
- `create_time` - Creation timestamp
- `project_dir` - Project directory path
- `lead_triologue` - Lead conversation history
- `child_triologues` - Teammate conversation histories
- `teammates` - Active teammate information
- `first_query` - First user query (used as bookmark title)

Use `/save` to copy a project session to user directory and `/load` to restore any session.

### session file vs triologue JSONL

The system uses two distinct file types for persistence:

- **Session file** (`.mycc/sessions/{uuid}.json`): Metadata only — session ID, creation time, lead/teammate triologue paths, teammates list, and first query. Written once at session creation, never updated after that. Used for session discovery and restoration routing.

- **Triologue JSONL** (`.mycc/transcripts/lead-{ts}-triologue.jsonl`): The append-only conversation log. Every message (user, assistant, tool call/result) is appended via the `onMessage` callback registered in `agent-repl.ts` using `fs.appendFileSync`. This is the authoritative record of agent activity. Each line is a JSON-encoded `Message` object.

Key distinction: the session file tells you *what sessions exist and where their logs live*; the triologue JSONL contains *what actually happened* during a session.

### session, turn, and move

These terms define the temporal scopes of agent operations, from broadest to narrowest:

- **session**: The full conversation history from agent start to exit. Encompasses all turns and moves. `Sequence.totalEventsCount` and `seq.totalCount()` operate at this scope.

- **turn**: From one user query to the next. Begins when the user submits a query at the prompt line and ends when the agent returns to PROMPT state. `Sequence.events` and most `seq.*` functions (`has`, `hasAny`, `count`, `countResult`, `last`, `lastError`, `lastIndexOf`, `since`, `sinceEdit`) operate at this scope — they are cleared at each `markPromptBoundary()` call in the PROMPT state.

- **move**: A single LLM response, including all tool calls in its delta. Within a move, tool calls are batched — hooks evaluate against prior moves in the same turn, not sibling tools in the same delta (those haven't executed yet).

### mindmap

A tree-structured knowledge system that compiles markdown files (like `MYCC.md`) into a navigable JSON structure. Each node has an ID (slash-separated path), text, title, summary (LLM-generated), level, children, and links. The agent can query specific nodes via `get_node` tool for efficient context retrieval without loading entire documentation.

Key concepts:
- **Node**: Knowledge unit with `id`, `text`, `title`, `summary`, `level`, `children`, `links`
- **Mindmap**: Root structure with `dir`, `hash`, `compiled_at`, `root` node
- **Compilation**: One-way process: `MYCC.md --> [compile_mindmap] --> mindmap.json`
- **Process Isolation**: Each agent (lead/teammate) has independent mindmap instance

See `docs/mindmap-design.md` for detailed design.

### wiki, vector store

The wiki is a persistent knowledge base using LanceDB for vector similarity search. Knowledge is stored via WAL (Write-Ahead Log) files for audit and rebuild capabilities. Each document has a hash, domain, title, content, references, and embedding vector. Domains organize knowledge (e.g., "project", "skills").

Key components (`src/context/parent/wiki.ts`):
- `wiki.get(query, options)` - Search documents by similarity
- `wiki.put(document)` - Store document with embedding
- `wiki.rebuild()` - Rebuild vector store from WAL files
- `wiki.listDomains()` - List all knowledge domains

Tools:
- `wiki_get` - Search by similarity
- `wiki_put` - Add documents with auto-generated embeddings
- `wiki_prepare` - Prepare domain before adding documents

Configuration:
- Embedding model: `nomic-embed-text` (via `OLLAMA_EMBEDDING_MODEL`)
- Duplicate threshold: 0.95 similarity marks duplicates
- Content limits: 50-1000 characters per document

### lead and teammates

The **Lead** is the main agent process that handles user interaction, spawns teammate processes, and coordinates work. **Teammates** are child processes that execute assigned tasks.

Architecture:
```
Terminal -> Coordinator -> Lead (main agent) -> Teammates (child processes)
```

Key constraints:
- Teammates have restricted capabilities—they cannot use `tm_create`, `tm_remove`, `tm_await`, or `broadcast` directly (must request via mail to lead)
- Team mode is orthogonal to normal/plan mode (combinations: solo-normal, solo-plan, team-normal, team-plan)

### lead trusting teammate's autonomous cycle

a teammate runs its own loop, and two of its normal behaviors are NOT failures the lead should "fix".

idle after a phase is expected, not stuck. when a teammate finishes a phase (no open todos, no pending tool calls), it mails "phase completed" to the lead and enters `idle` — the between-rounds gap where it polls for new mail or claimable issues and resumes the instant new mail arrives (`src/context/teammate-worker.ts` `enterIdleState`, polls every `POLL_INTERVAL`). the lead must not send nag mails ("don't idle", "speed up", "send the next instruction this round") nor take over the teammate's work to "push things forward" — both waste the lead's turns and disrupt the teammate's rhythm.

todo management is the teammate's internal affair. whether a teammate builds/maintains todos is its own work organization (todo nudging in `teammate-worker.ts` uses the teammate's own `ChildContext` todo module); it does not affect its ability to do assigned work, and the lead cannot manage a teammate's todos. do not instruct teammates to "skip todos" / "stop fussing over todos", and do not treat a "no active todos" report as a problem — focus on whether the task goal is met, not the teammate's internal management.

the lead should intervene only on a real stall (no output past the teammate's deadline, or an explicit guidance request that genuinely blocks), a timeout, or an error — not on normal idle, and not on internal todo state. a guidance-request mail is worded as "could benefit from direction", which is not necessarily blocked (the worker's comment notes this wording was tuned to avoid false stuck alarms).

Key operations (`src/context/parent/team.ts`):
- `team.createTeammate(name, role, prompt)` - Spawn teammate
- `team.listTeammates()` - List all teammates
- `team.awaitTeam(timeout)` - Wait for all teammates
- `team.mailTo(name, title, content)` - Send mail to teammate/lead
- `team.broadcast(title, content)` - Broadcast to all (lead only)

### health-check

Runs at startup to validate Ollama connectivity and model availability. Checks:
1. Ollama server is reachable
2. Model exists and can process requests
3. `TOKEN_THRESHOLD` does not exceed 80% of model's context length

Implementation (`src/setup/ollama-health-check.ts`):
- `checkHealth(tokenThreshold)` - Returns `HealthCheckResult`
- `HealthCheckResult` - `{ ok, error?, warnings?, modelInfo? }`
- Model info: `name`, `contextLength`, `family`, `parameterSize`

CLI flag `--skip-healthcheck` bypasses the check. If failed, prompts user to retry or exit.

### normal mode, plan mode

mycc starts with normal mode, where it can explore the code base and make changes.

plan mode can be enabled by slash command `/mode plan` or by llm using `plan_on` tool.

in plan mode, mycc should only use explorational tools, while other tool uses are prohibited.

plan mode also differs from the normal mode in the system prompt they bear.

### team mode

team mode is not actually a mode, but a state where teammates are spawned to help the lead.

team mode is orthogonal to normal/plan, so we have solo-normal, solo-plan, team-normal, team-plan mode
to speak in detail.

team mode handles the particular challenges of collaboration by using dedicated system prompt.

### todo and issue

**Todos** are simple task tracking items with title, status, and blockedBy dependencies. **Issues** are more structured task objects with ID, status, owner, blockedBy/blocks dependencies, and comments. Issues support team coordination—teammates claim issues and close them when done.

Hash integrity: Each todo item has a SHA256-based hash (first 8 hex chars) computed from `name|done|note`. `todo_update` requires matching hash to prevent stale or mangled updates — if the hash doesn't match, the update is rejected. The `pinned` and `reactivate` fields are deliberately NOT part of the hash, so pinning/reactivating a todo does not change its hash — this allows `todo_pinning` to modify those fields without forcing a `todo_update` hash revalidation cycle.

Key types:
- `Todo` - `{ id, subject, description, status, blockedBy, blocks, owner, activeForm }`
- `TodoItem` - `{ id, name, done, note, hash, pinned?, reactivate? }` — `pinned` marks the item as protected from auto-clear; `reactivate` holds a natural-language condition for later reactivation
- `Issue` - `{ id, title, status, owner, content, comments, blockedBy, blocks, createdAt }`

Tools:
- `todo_create` - Create a todo item with name, optional note; returns id and integrity hash
- `todo_update` - Update a todo item by id; requires matching hash to prevent stale updates
- `todo_pinning` - Pin/unpin a todo and set its reactivation condition (lead-only, scope `['main']`); requires id+hash validation; toggles `pinned` and sets `reactivate`
- `issue_create` - Create issue with dependencies
- `issue_claim` - Assign issue to teammate
- `issue_list` - List all issues
- `issue_close` - Mark completed/failed/abandoned
- `issue_comment` - Add comment to issue

Slash commands:
- `/todos` - View all todos (pinned items show a 📌 marker)
- `/issues` - View all issues

Note: `todo_write` is the legacy tool (deprecated) — use `todo_create` and `todo_update` instead.

#### Pinned todos and reactivation

**Pinned todos** are protected from the auto-clear that normally removes completed (`done`) todos at the start of each turn. A pinned done-todo also keeps `hasOpenTodo()` returning false so it does not falsely extend a "still working" state. Pinning is a lead-only capability via the `todo_pinning` tool — teammates never see the tool (scope `['main']`) and never get the pinned-todo section in their system prompt.

**Reactivation** reopens a previously completed pinned todo when its `reactivate` condition becomes true. The lead evaluates candidates with a single `forkChat` call (not `structuredChat`) that sends all done+pinned+reactivate items in one JSON-array prompt with `toolChoice='none'`. `forkChat` is chosen to preserve prompt cache and to retain retry/ESC support that `structuredChat` lacks.

Reactivation flow (`checkReactivation()` in `src/loop/states/collect.ts`):
1. `getReactivationCandidates()` returns todos that are `done && pinned && reactivate` (empty list = skip this round)
2. One `forkChat` call asks the LLM to return a JSON array `[{"id": "hash", "reopen": true, "reason": "..."}]`
3. `parseReactivationResult()` extracts JSON from the raw text (strips markdown fences, finds first `[`/last `]`, validates fields); returns `null` on any failure → caller skips that round
4. For each `reopen: true` entry, `todo_update` flips `done` back to `false` using the returned hash

Reactivation runs in the COLLECT step's step-4 nudge block, BEFORE the nudge itself, on the same throttle cycle (every 3 turns). Ordering matters: running reactivation before the nudge prevents the nudge from showing "done" and then the reactivation showing "reactivated" in the same turn, which would be a contradiction.

Teammates are unaffected: their loop (`teammate-worker.ts`) has its own separate todo nudge at step 3 with no reactivation logic and no `forkChat` import.

See `docs/pinned-todo-reactivation.md` for the full design.

### bang command

The bang command (`!<command>`) is a UI shortcut that opens an external tmux terminal popup for interactive command execution. When the user types `!` at the prompt start, the prompt changes to a magenta `run cmd ! ` prompt. This bypasses the LLM and lets the user run shell commands interactively in a separate terminal.

Key behavior:
- Typing `!` switches prompt to bang mode (`run cmd ! `)
- Opens tmux popup terminal in current working directory
- User works interactively in popup
- Press Enter to capture output and kill session, or 'k' to keep session
- Persistent sessions (e.g., `npm run dev`, `ssh`) can be kept for later reattachment

See `docs/bang-command-design.md` for detailed design.

### checkpoint and recap

**Checkpoint** and **recap** are meta-tools for context management. They work together to compress long conversation histories into concise summaries, helping manage the token budget during extended exploration tasks.

**Checkpoint** creates a marker in the conversation history before starting a focused subtask. It:
- Must be called ALONE (no other tools in same turn)
- Only ONE open checkpoint allowed at a time
- Creates a todo item to track the checkpoint
- Returns an 8-character hash as the checkpoint ID

**Recap** compresses all messages from a checkpoint into a summary. It:
- Requires a valid checkpoint ID
- Uses LLM to summarize messages from checkpoint to end
- Replaces those messages with the summary
- Marks the corresponding todo as done

Workflow:
```
1. checkpoint({ description: "find auth logic" })
   → Returns checkpoint ID like "abc12345"

2. [explore files, read code, investigate]
   → Generates many messages

3. recap({ checkpoint_id: "abc12345" })
   → Compresses messages into summary, cleans context
```

Scope: Main agent only (not available to teammates). Implementation is in the state machine (`hook.ts`), not the tool handler, because it requires access to `triologue` which is outside `AgentContext`.

### prompt line, whisper line, and letter box

The prompt line is where the user can type and submit the query. When in normal mode, it displays as `agent >> `.
When in plan mode, it displays as `plan >> `. If the user is typing bang command, it displays as `run cmd ! `.

The whisper line is a subtle visual hint displayed above the prompt line for transient UI feedback. It's used for
short-lived hints that guide user actions. The first use case is "Mycc is wrapping up..." shown during ESC wrap-up.
Another use case is after pressing Ctrl+L once, showing "Press Ctrl+L again to clear history" to indicate the
double-press window is active. The whisper line appears and disappears automatically based on context.

The letter box is what the llm reply to the user formally. It is actually the last message from the llm before 
leaving the agent loop. It displays as a green block of text with the first line like below:

```
.================================ 17:32:45 =================================.
```

**DSML stripping**: When using DeepSeek as the API provider, the response may contain internal DSML markup tags
(`<ds_safety>`, `<ds_thinking>`, etc.) that are not meant for user display. The letter-box automatically strips
these tags using regex before rendering. If stripping removes all content, a friendly fallback message is shown.


### prompt N (p0, p1)

Shorthand notation for distinct prompt stages in the multiline input flow:

- **p0** — the main `agent >> ` prompt line where the user types and submits queries. Controlled by `agentIO.ask()` in `UserInputProvider.getInput()`.
- **p1** — the secondary `Press Enter to submit (r to return) > ` prompt that appears after the editor closes in the multiline input flow. Controlled by `agentIO.ask()` in `openMultilineEditor()`.

Flow: `p0` → user types `\` + Enter → editor pops up → `p1` waits. On Enter: content submitted to LLM. On `r` + Enter: content reloaded back to `p0` (pre-filled on the input line) without submitting.

See `docs/archived/multiline-input-case-study.md` for the design rationale.


### tmux

Tmux is a required external dependency for interactive terminal operations. mycc uses tmux to create popup terminals where users can run commands interactively (with prompts, TUIs, etc.). It's also used for e2e testing to simulate interactive terminal sessions.

Key use cases:
1. **Bang command** - Opens tmux popup for interactive shell commands
2. **E2E testing** - Simulate user input and capture output
3. **Persistent sessions** - Keep dev servers, SSH sessions alive

Testing commands (from MYCC.md):
```bash
tmux new-session -s mycc-test -d -x 80 -y 24
tmux send-keys -t mycc-test "/help" Enter
tmux capture-pane -t mycc-test -p
tmux kill-session -t mycc-test
```

### AgentContext

A modular state container that provides coding agent tools with access to state data. It's the central interface through which tools interact with the system.

Modules encapsulated:
- `core` - Work directory, logging, user questions
- `todo` - Temporary checklist
- `mail` - Async mailbox for inter-agent communication
- `team` - Teammate management
- `issue` - Persisted tasks
- `skill` - Skill loader
- `bg` - Background tasks
- `wt` - Git worktree management
- `wiki` - Knowledge base

Two implementations: `ParentContext` (main process, direct access) and `ChildContext` (child processes, IPC wrappers).

### Triologue

The conversation state manager that tracks message history, manages compaction, and handles hint rounds. Central to the agent loop.

Key responsibilities:
- Stores conversation message history
- Manages `microCompact()` and `autoCompact()` for token management
- Tracks the `Sequence` for hookish skill conditions
- Supports hint round generation for confusion recovery

### AgentIO Singleton

`AgentIO` (`src/loop/agent-io.ts`) is a singleton that manages I/O state for the agent process. It provides the LineEditor (prompt input), handles ESC/neglected mode, and detects process type.

Key methods and properties:
- `agentIO.isMainProcess()` — Returns `true` in the lead process (main), `false` in child/teammate processes
- `agentIO.isNeglectedMode()` / `agentIO.setNeglectedMode(value)` — Check/set the neglected flag
- `agentIO.onNeglected(callback)` — Register callbacks for ESC events
- `agentIO.ask(prompt)` — Display a prompt and wait for user input (main process only)
- `agentIO.exec(cmd)` — Execute a command with output display (main process only)
- `agentIO.execEditor(args)` — Open external editor for multi-line input

Bang mode (LineEditor): When user types `!` at the prompt start, the `checkPromptChange` method switches the prompt to a magenta `run cmd ! ` prompt (BANG_PROMPT). The `!` prefix is preserved in the submitted content for slash command routing.

Important: Child processes cannot use `agentIO.ask()` or `agentIO.exec()` — they will throw errors. Use `ctx.core.question()` for user questions (works via IPC) and `ctx.core.brief()` for logging.

### IPC and IOC

**IPC (Inter-Process Communication)** enables communication between the main process (lead agent) and child processes (teammate agents) using Node.js `child_process.fork()` and message passing.

**IOC (Inversion of Control)** is a design pattern where the `TeamManager` acts as a dispatcher. Modules register handlers for specific message types, following the Open-Closed Principle.

Key components:
- `IpcRegistry` - Dispatcher that routes messages to registered handlers
- `sendRequest`/`sendNotification` - Communication primitives
- Request-Response pattern for operations requiring results

### Loader

A class that provides unified loading of tools and skills with hot-reload capability for dynamic content.

Loading priority (highest wins):
1. Built-in tools/skills (`src/tools/`, `skills/`)
2. Project tools/skills (`.mycc/tools/`, `.mycc/skills/`)
3. User tools/skills (`~/.mycc-store/`)

Key methods:
- `loadAll()` - Load everything at startup
- `watchDirectories()` - Enable hot-reload for project/user directories
- `getToolsForScope(scope)` - Get tools filtered by context

### Hookish Skills

Skills that actively trigger based on patterns in the conversation sequence, as opposed to passive skills that only load on explicit request.

Defined with `when:` field in skill YAML frontmatter:
```yaml
---
name: lint-after-edit
when: run pnpm lint after code changes before commit
---
```

Condition language can query conversation history:
- `seq.has(toolName)` - Tool exists in conversation
- `seq.hasAny([tool1, tool2])` - Any of these tools exist
- `seq.lastIndexOf(pattern)` - Index of last matching tool/command (-1 if not found). Supports `"bash#pattern"` for bash command substring matching
- `seq.lastError()` - Last error result
- `seq.sinceEdit()` - Events after last file edit
- `seq.totalCount(toolName?)` - Count tool occurrences across entire session
- `seq.isPlanMode()` - Whether agent is in plan mode

Actions: `inject_before`, `inject_after`, `block`, `replace`, `message`, `compact`

#### Condition Compiler Principles

The condition compiler translates natural-language `when` fields into structured `{ trigger, condition, action }` objects. It follows a strict safety-first pipeline with these principles:

**1. Lazy Compilation** — Conditions are NOT compiled eagerly. A skill with a `when` field is marked as "pending" and only compiled when `skill_compile` is invoked (by user command or LLM initiative). This avoids unnecessary LLM calls for unused skills.

**Pending Hook Injection**: At startup, any skills with un-compiled `when` conditions are detected and their names are injected as "pending hooks" into the LLM context. The agent is informed that these skills can be activated via `skill_compile(name="<skill_name>")`. This ensures the agent is aware of available hooks without eagerly compiling them.

**2. LLM Translation with Structured Output** — The `when` natural language is sent to the LLM along with the list of all available tools and a JSON schema that enforces the output shape (`trigger`, `condition`, `action`). The LLM chooses appropriate triggers from known tool names, writes a condition expression using `seq.*` functions, and selects the right action type.

**3. Expression Safety via jsep AST** — Conditions are parsed with **jsep** into an AST and walked recursively to enforce safety **at compile time** (not runtime). This is NOT `eval` or `new Function()` — the evaluator walks the jsep tree manually. The validator checks:
- Only `seq` and `call` are allowed as root identifiers
- Only known `seq.*` functions are used (`has`, `hasAny`, `lastIndexOf`, `last`, `lastError`, `count`, `totalCount`, `countResult`, `since`, `sinceEdit`, `isPlanMode`)
- No dangerous identifiers (`eval`, `Function`, `require`, `process`, `fs`, `constructor`, `__proto__`, etc.)
- No direct function calls — only `seq.XXX()` or `call.metadata.X.method()` patterns
- Method calls on results only allow safe string/array methods (`includes`, `indexOf`, `startsWith`, etc.)

**4. Retry with Error Feedback** — Up to 3 retries. When a compilation fails (validation error, bad trigger, parse failure), the error is fed back to the LLM in the next attempt's prompt, so it can self-correct.

**5. Smoke Test Before Persistence** — The compiled expression is evaluated against an empty mock sequence to verify it doesn't throw. Expressions that fail the smoke test are rejected and trigger a retry.

**6. Atomic Persistence** — Conditions are written to a temp file in the same directory, then renamed over the target file. This prevents corruption from partial writes. A backup of the existing file is created before overwriting.

**7. Source File Tracking & Orphan Cleanup** — Each condition records its `sourceFile` using `"{layer}:{path}"` notation (e.g., `"project:lint-check/SKILL.md"`). When loading, conditions whose source skill files no longer exist are detected as **orphans** and automatically removed from the registry. This keeps `conditions.json` clean when skills are deleted.

**8. Version History** — Every compilation creates a new version. The `history` array preserves all past conditions with their version numbers, expressions, actions, and reasons for change. This provides a full audit trail of how a condition evolved over time.

**Key files:**
- `src/hook/conditions.ts` — `ConditionRegistry` class: load/save/compile/refine, pending tracking, trigger matching, orphan cleanup
- `src/hook/condition-validator.ts` — `compileCondition()` pipeline: JSON extraction → schema validation → jsep expression validation → smoke test
- `src/hook/evaluator.ts` — jsep-based expression evaluator (walks AST, no `eval`)
- `src/tools/skill_compile.ts` — The `skill_compile` tool that triggers lazy compilation

### Sequence

A wrapper around Triologue that provides query methods for hookish skill conditions to inspect conversation history. Enables conditions like `seq.has('edit_file')`, `seq.count('bash')`, `seq.since('git_commit')`.

### Confusion Index

A metric that quantifies how "stuck" an agent is, used to trigger hint rounds when making no progress.

Scoring:
- `+1` per assistant response (cycling without progress)
- `+0` for exploration tools (read-only)
- `-1` for action tools (making changes)
- `+2` for tool errors
- `+1` for repetition

When score >= threshold (default 10): Main process triggers hint round (LLM self-analysis), child sends mail to lead requesting guidance.

### Grant System

A permission system for child processes to request approval before performing sensitive operations.

**Intent Language**: The `bash` tool requires an `intent` parameter in a structured format:
```
VERB OBJECT PARAM PARAM ... TO PURPOSE
```
Where VERB is one of: READ, WRITE, EDIT, DELETE, BUILD, TEST, INSTALL, RUN, and OBJECT is one of: SOURCE, CONFIG, DEPENDENCY, ARTIFACT, SYSTEM, DATA, TEMP, USER.
Example: `READ SOURCE dir=src TO understand dependencies`.

Most PARAMs are free-form descriptors (the LLM chooses the key). A few reserved PARAMs change how the bash judge routes the command:

- **`dangerous=i_know`** — escape hatch for destructive/irreversible commands. Some bash commands (e.g. `rm -rf`, force pushes, dropping tables) are blocked by default. If the LLM genuinely intends such a command and understands the risk, it declares `dangerous=i_know` in its intent. The system then **skips its own block AND skips its own LLM safeguard**, and routes the decision directly to the user via a `[y/N]` confirmation — the human's approval is the real authorization; the LLM's declaration only honestly acknowledges the risk.
  - Only affects `destructive` and `irreversible` categories. The `system` category (e.g. `git commit`, `npm publish`) is a routing nudge, not a danger gate — it stays hard-blocked with no escape hatch (use the dedicated tool, e.g. `git_commit`, instead).
  - Unavailable in child processes: a child cannot reach the user prompt, so `dangerous=i_know` is rejected there — the child must ask the lead agent to perform the operation instead.
  - Without this PARAM, a blocked dangerous command returns a Socratic hint that names the *existence* of a PARAM override but withholds the exact key/value; the LLM must consult the intent language PARAM conventions to find it.
  - Example: `DELETE DATA path=build/ dangerous=i_know TO reclaim disk space before rebuild`

- **`batch=i_know`** — skip the LLM safeguard for batch deletions. A `DELETE` command that targets multiple files / globs / recursive paths (e.g. `rm -rf node_modules/`, `rm a b c`, `find . -delete`) is normally sent to an LLM classifier (SAFE / DANGEROUS / UNCERTAIN) before possibly asking the user — costing latency and tokens even for obvious-safe cleanup. If the LLM knows the deletion is a batch operation, it declares `batch=i_know` to skip the LLM call and route directly to the user `[y/N]`. The human's approval is the real authorization; the declaration only honestly names the operation type.
  - Only affects the `DELETE` + batch-delete path. It does NOT bypass a hard block (batch deletion is not hard-blocked — it is LLM-judged), and it does NOT cover the catastrophic patterns handled by `dangerous=i_know` (those match the dangerous-command check first and never reach the batch path).
  - Unavailable in child processes: a child cannot reach the user prompt, so `batch=i_know` is rejected there — the child must ask the lead agent to perform the operation instead.
  - Example: `DELETE TEMP batch=i_know TO clean build artifacts before rebuild` (for `rm -rf dist/ node_modules/`)

Implementation: `src/context/grant/bash-judge.ts` (`declaresDangerousIKnow`, `dangerousSocraticHint`, `declaresBatchIKnow`, and steps 1 & 4 of `judgeBash`). The full system-prompt wording is emitted by `buildIntentLanguageSection()` in `src/loop/agent-prompts.ts` (the "PARAM Conventions" subsection).

The `hand_over` tool requires an `intent` parameter in the intent language format: `VERB OBJECT TO PURPOSE`. Choose the VERB and OBJECT that best describe needing a human to interact with a terminal popup (e.g. to type a sudo password).

#### hand_over usage

`hand_over` opens a tmux popup terminal and **blocks** until the user finishes interacting with it (pressing Enter to capture output and close, or `k` to keep the session). It is the only way the agent can hand a real interactive prompt (sudo password, y/N confirmation, TUI, SSH session) to the human.

- **Intent rule (spelled out):** the correct VERB/OBJECT for hand_over is `RUN USER TO <purpose>` — you are *running* a *user* (interactive human) session. Any other VERB (READ/WRITE/EDIT/...) or OBJECT (SOURCE/CONFIG/...) is a dimension mismatch; the tool returns a Socratic hint naming which dimension is wrong, never the answer.
- **Multi-line `command`:** the `command` parameter is a JSON string, so a multi-line shell script must escape newlines as `\n`. Prefer collapsing the script to a single line with `&&` / `;` / `||` so the intent stays readable and the JSON stays on one line. Only fall back to `\n`-separated lines when the script genuinely cannot be one-lined.
- **tmux nesting self-check:** if the agent is itself running inside a tmux session, hand_over refuses to spawn a nested popup (nested popups break key handling) and tells the agent to either exit tmux first or run the command directly.
- **Examples:**
  - `hand_over(command="sudo apt install -y tmux", intent="RUN USER TO install tmux needing sudo password")`
  - `hand_over(command="ssh root@10.0.0.1", intent="RUN USER TO open interactive SSH session to remote host")`
  - `hand_over(command="vim /etc/hosts", intent="RUN USER TO let user edit system hosts file in vim")`

Grant flow:
```
Child → requestGrant(tool, args) → IPC → Parent
Parent → check mode → check worktree → grant/deny
Child → proceed or show error
```

In `plan` mode: All code changes blocked. In `normal` mode: Auto-grant for owned worktree, reject otherwise.

### WAL (Write-Ahead Log)

An append-only log file for the Wiki knowledge base that records all changes before they are applied. Used for auditing and rebuilding the vector store.

- Stored in `~/.mycc-store/wiki/logs/YYYY-MM-DD.wal` as JSON lines
- Each entry records operation (put/delete) with timestamp
- Can rebuild vector store from WAL files using `/wiki rebuild`

### State Machine

A design for the agent loop using explicit states and transitions instead of a single `while(true)` loop.

States:
- **prompt** - Get user input, handle slash/bang/exit
- **collect** - Pre-LLM pipeline: questions, mail, hint round, todo nudge
- **llm** - Build system prompt, call LLM with retry
- **hook** - Augment tool calls, evaluate hook conditions
- **tool** - Execute tool calls sequentially
- **stop** - Handle no-tool-call case, await teammates

### Auto-Claim

Feature where idle child processes automatically claim unassigned issues. When a child enters IDLE state (no tool calls), it polls for new mail and scans issues for `pending` + no owner + no blockers, then atomically claims the first matching issue.

## Tool Scope Constraints

| Agent Type | Available Tools |
|------------|-----------------|
| Lead (main) | All tools |
| Teammate (child) | Cannot use: tm_create, tm_remove, tm_await, broadcast |
| Background (bg) | Can only use: bash, read_file, write_file, edit_file |

**Main-only tools**: tm_create, tm_remove, tm_await, broadcast, order, hand_over, plan_on, plan_off, todo_pinning

## Background Task Tools

The bg module (`bg_create`, `bg_print`, `bg_await`, `bg_remove`) provides non-blocking command execution:

- **bg_create**: Spawn a bash command asynchronously, returns PID immediately
- **bg_print**: List all background tasks (running/completed/failed/killed) or show output for a specific PID
- **bg_await**: Block until background task(s) complete (with optional timeout)
- **bg_remove**: Terminate a background task by PID

Process management:
- Uses `spawn()` on all platforms (not `exec()`)
- On Windows, `detached:true` is removed to capture stdout/stderr properly
- Output is capped to ~100KB (tail-capped) for each task
- Killed status is tracked separately from failed

## Interactive Shell / /fork Command

The **/fork** slash command spawns a new mycc instance in a separate terminal window. Usage:

```
/fork                          # Spawn new mycc in current project
/fork --env KEY=VALUE          # Forward environment variables to child
```

Implementation details:
- On Linux: Uses `gnome-terminal` or `x-terminal-emulator` with bash
- On Windows: Uses `PowerShell -EncodedCommand` via `wt.exe`, with `shell:true` disabled and single-quoted paths

## Built-in Skills Reference

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

## How to add a tool/skill

To add a tool:
1. refer to existing code in src/tools/ to get coding pattern
2. create file in `.mycc/tools` folder. This is a hot-reloadable folder
3. let the user test it manually, and iterate from feedbacks.
4. once qualified, migrate it back into `src/tools` and update the loader, to make it built-in.

The detailed information can be found at `skills/add-tool/SKILL.md`.

To add a skill:
1. refer to existing files in skills/ to get pattern.
2. create file in `.mycc/skills` folder. This is a hot-reloadable folder
3. let the user test it manually, and iterate from feedbacks.
4. once qualified, migrate it back into `skills/`, to make it built-in.

## Tool Development Guidelines

**Fail Early**: Tools should fail early and explicitly rather than silently degrading. Explicit errors help the agent understand what went wrong and take corrective action.

**No Direct Console Output in Tools**: Tools MUST NOT use `console.log`, `console.error`. Use `ctx.core.brief()` for all user-facing output.

## How to test this app

Use tmux to simulate interactive terminal sessions:

```bash
# Create session
tmux new-session -s mycc-test -d -x 80 -y 24

# Send keys
tmux send-keys -t mycc-test "/help" Enter

# Capture output
tmux capture-pane -t mycc-test -p

# Kill session
tmux kill-session -t mycc-test
```

## Unit Tests

Uses **vitest** for unit testing. Tests in `src/tests/`.

```bash
pnpm test                    # Run all tests
pnpm test src/tests/tools/   # Run specific directory
```

## Output Behavior Principles

### High-Contrast Explanations

When explaining code changes, design choices, or analysis results, the agent follows high-contrast style:

1. **Lead with the conclusion** — State what changed in ONE line before explanation
2. **Use tables for comparison** — Before/after, old/new side-by-side
3. **Use diff notation** — `+` added, `-` removed, `→` renamed/moved
4. **One change = one line** — 3 changes = 3 bullet points, not a story
5. **Avoid filler narration** — No "Let me take a look..." or "I can see that..."

### Ponytail (Simplicity First) Principle

In plan mode, responses should be concise and avoid over-explaining. Prioritize simple, direct answers. State the conclusion, provide the reasoning only if requested. This is documented in the plan-mode system prompt.

## Code Cleanup

Use TypeScript's strict checks to find unused imports/variables:

```bash
pnpm typecheck --noUnusedLocals --noUnusedParameters
```

Use ESLint for linting (you MUST do it before commit):

```bash
pnpm lint                    # Run lint on all files
pnpm lint src/tools/screen.ts  # Run lint on specific files
```

The project uses `typescript-eslint` with a custom rule (`no-console-in-tools`) that disallows `console.log`/`console.error` calls in `src/tools/` — use `ctx.core.brief()` instead.

Use prettier for formatting (run after significant changes):

```bash
pnpm format
```

### 中文顿号 Multi-line Edit

The `edit_file` tool supports multi-line mode triggered by Chinese enumeration punctuation. When `old_text` ends with `、` (顿号), the tool auto-detects that multiple matching blocks may exist and adjusts its matching strategy accordingly. This handles the common case in Chinese-language code comments where enumerated items use 顿号 as separators.

## Debug Flags

mycc provides several `--debug-*` flags for investigating specific subsystems:

| Flag | Effect |
|------|--------|
| `--debug-tp` | **Triologue Parity** — when a role transition violation occurs, throw an error with stack trace instead of auto-recovering. For developing the auto-fixer or debugging `triologue.ts`. |
| `--debug-suggest` | **SUGGEST Background Task** — logs the LLM response and feedback of the background suggest task to the terminal via `ctx.core.brief()`. The SUGGEST task runs after each turn to proactively discover relevant tools/skills. |
| `--debug-eval` | **Expression Evaluation** — prints the parsed AST tree for each hook condition expression during evaluation. For developing hookish skills with custom `when` conditions. |
| `--debug-prompt` | **Prompt Debug** — shows the full system prompt sent to the LLM, including tool descriptions and skill content. Also shows the 'Parsing...' spinner during keyword extraction. |

Combine with `-v` (verbose) for maximum detail.

## Pitfalls

### Tool descriptions are for LLM awareness, not user-facing

The `description` field in tool definitions is read by the LLM to understand what a tool does and how to use it. It should NOT be written as user-facing documentation with verbose explanations of parameters or step-by-step workflows.

**Bad example** - Verbose, user-facing style:
```typescript
description: `Switch to a git worktree. Changes working directory to the worktree path.

For teammates: If you are not in an owned worktree, this tool will ask for user confirmation before entering.

Parameters:
- name: Name of the worktree to enter (required)

The tool will:
1. For teammates not in owned worktree: Ask user for confirmation [y/N]
2. Enter the worktree if confirmed
3. Send mail notification to lead about the worktree entry`
```

**Good example** - Concise, LLM-oriented style:
```typescript
description: 'Switch to a git worktree. Changes working directory to the worktree path. All subsequent file operations will be relative to that worktree.'
```

The LLM only needs to know the tool's purpose and parameters. Implementation details like confirmation prompts and mail notifications should be in code comments or file-level documentation, not in the description field. The description is about **what** the tool does, not **how** it does it internally.

### DeepSeek API pitfalls

When using DeepSeek as the API provider (API_PROVIDER=deepseek):

- **No web/screen tools**: `web_search`, `web_fetch`, `screen`, `read_picture` are unavailable
- **DSML stripping**: DeepSeek may wrap content in internal DSML markup (`<ds_safety>`, `<ds_thinking>`, etc.) — the letter-box automatically strips these
- **Prompt caching**: DeepSeek supports automatic prompt caching for repeated prefixes, reducing cost on long conversations
- **Embedding still uses Ollama**: Wiki/RAG still requires a local Ollama instance with an embedding model like `nomic-embed-text`
- **tool_choice=none for wrap-up**: When using DeepSeek in wrap-up mode, set `tool_choice="none"` to prevent raw XML tool calls in the response

Detailed reference: `docs/deepseek-api-reference.md`

### agentIO singleton works differently in child processes

The `agentIO` singleton from `src/loop/agent-io.ts` is imported by both main and child processes, but `initMain()` is only called in the main process. This means:

- `agentIO.isMainProcess()` returns `true` in main process (lead)
- `agentIO.isMainProcess()` returns `false` in child processes (teammates)

This works correctly because `isMainProcessFlag` defaults to `false` and only becomes `true` after `initMain()` is called. However, this is implicit behavior that can be confusing.

**Important**: Only use `agentIO.isMainProcess()` for distinguishing lead vs teammate context. Other `agentIO` methods like `ask()` and `exec()` will throw errors in child processes because they require main process I/O capabilities.

For code that needs to work in both contexts:
- Use `agentIO.isMainProcess()` to check if in main process
- Use `ctx.core.question()` for user questions (works in both main and child via IPC)
- Use `ctx.core.brief()` for logging (works in both via IPC for child)

### Loop Notation (LN)

A compact notation for describing message role rotation in the agent loop. Each unit is separated by commas, and represents one message in the conversation sequence.

Available unit types:

- `system` → The system prompt
- `user` → The user's query
- `[tool1, tool2]?` → The assistant's tool call (batched, `?` means called by LLM)
- `tool1!` → The result of a tool call, one at a time
- `agent` → The assistant's text reply
- `_tool1_` → A tool call replaced with a placeholder (after compaction)

Examples:

A simple single-turn sequence:
```
system, user, [tool1]?, tool1!, agent
```

A multi-turn conversation with tool batching and compaction:
```
system, user, [tool1]?, tool1!, [tool2, tool3]?, tool2!, _tool3_, agent, user, agent
```

This represents:
1. System prompt loads
2. User asks a question
3. LLM calls `tool1`
4. `tool1` returns its result
5. LLM calls `tool2` and `tool3` in the same delta
6. `tool2` returns its result
7. `tool3`'s call was compacted (replaced with placeholder)
8. LLM replies to the user
9. User asks another question
10. LLM replies directly (no tool calls needed)

Key conventions:
- `[]?` groups batched tool calls from the same LLM delta
- `!` marks a tool result
- `_` wraps a compacted/placeholder tool call
- Units without special markers (system, user, agent) are pure text messages


## Docker Support

A Dockerfile is provided at project root for containerized deployment. The Docker setup:
- Builds the mycc application in a Node.js container
- Supports auto-input and output via JSONL files (`auto in/out jsonl`)
- Useful for CI/CD pipelines and automated testing environments

```bash
docker build -t mycc .
docker run -it mycc
```

## WebUI

A Vue 3-based WebUI is served by mycc itself via an embedded Express + Vite +
WebSocket stack (`src/serve/serve-hub.ts`, `src/web/`). It provides a
browser-based chat interface as an alternative to the terminal REPL:

- Markdown rendering for LLM responses (letter-box → chat bubbles)
- Interactive **cards** replacing terminal `ask()` prompts (input / confirm /
  choice) — see `CardItem.vue`
- Session history via the `/history` endpoint, backed by the durable
  triologue JSONL transcript (survives serve stop/restart and page closes)
- 30s disconnect-reconnect timer with graceful warm shutdown
- **Steering** — mid-task user direction queued while the LLM is running;
  see the **steering (WebUI mid-task direction)** chapter above for the full
  data flow, the two consumption paths (COLLECT in-flight REMINDER vs PROMPT
  forkChat synthesis), and the ephemeral vs persistent design.
- **File upload** — chat-box attachments carried on `input`/`steer` messages,
  saved to `./.mycc/uploaded/` and surfaced via REMINDER; see the **file
  upload (WebUI chat-box attachments)** chapter above. Mirrors steering's
  ephemeral-queue architecture, but with no `forkChat` synthesis at PROMPT.

The WebUI is merged into `main`. For the developer reference (component
layout, WS protocol, input/card bridges, reconnect replay), see
`src/web/README.md`.

## Reference Documents

- `docs/agent-context.md` - AgentContext module (Chinese)
- `docs/agent-loop.md` - Agent loop (Chinese)
- `docs/agent-tools.md` - Built-in tools reference
- `docs/child-context.md` - Child process and IPC (Chinese)
- `docs/dynamic-loading.md` - Tool/skill loading mechanism
- `docs/pinned-todo-reactivation.md` - Pinned todos and reactivation feature design
- `docs/database-schema.md` - Data storage schema (Chinese, historical reference — SQLite removed in v0.7.0)