---
name: mycc-self-awareness
description: >
  Use when the project being worked on is NOT mycc itself, but the user wants
  to talk ABOUT mycc — asking what a "letterbox" is, what the "WebUI" is, what
  ESC does, what a "session" or "teammate" or "mindmap" means, how to launch
  mycc, or where to find the mycc install. This skill turns the agent into an
  end-user's tutor for mycc's OWN unique concepts, so a user running mycc in
  another folder (a different project) can still discuss mycc knowledgeably.
  It is a reference glossary of plain-language definitions, plus launch and
  locate-the-install instructions. Do NOT use it when working ON mycc's own
  source (use the environment-detection / tool-and-skill-development skills
  for that); use it when the user's questions are about mycc the tool, not
  about the current project.
keywords: [mycc, runtime, environment, tutor, glossary, letterbox, webui, serve, neglected, esc, session, triologue, teammate, mindmap, wiki, worktree, intent language, grant system, peer, channel, slash command, Ollama, DeepSeek, end-user]
---

# mycc Self-Awareness: A Tutor for mycc's Own Concepts

This skill exists for one situation: **you are running mycc inside some other
project** (not the mycc codebase), and the user starts asking about mycc
itself — "what's a letterbox?", "what does `--serve` do?", "what happens when
I press ESC?", "what's a teammate?". The user is an **end-user of mycc**, not a
mycc developer. They want plain-language explanations of the unique concepts
mycc introduces, so they can use the tool well and talk about it accurately.

Use this skill as a **tutor glossary**: read the user's question, find the
matching concept below, and explain it in plain language (the definitions here
are the authoritative wording — keep them accurate). If the user asks about
their *current project*, do NOT use this skill — that is normal project work.

## When to Use This Skill

- The cwd is **not** the mycc project directory (you are in another repo /
  folder), AND
- The user asks about **mycc the tool**: its UI, its modes, its collaboration
  model, its knowledge features, how to launch it, or where to find the
  install.

Do NOT use it when:
- You are working inside the mycc codebase itself (use the
  `environment-detection` / `tool-and-skill-development` skills instead).
- The user is asking about their current project (that is ordinary work).

---

## Glossary of mycc-Unique Concepts

Grouped by what an end-user actually sees and does.

### What you see & do

#### letterbox
The **letterbox** is the bordered display box mycc prints to show the LLM's
final reply at the end of a turn. When the agent finishes its tool calls and
produces its concluding text, that text is rendered inside a green-bordered box
(~80 chars wide) with a timestamp header, and the prompt returns. Everything
the LLM "says" to you lives in the letterbox; tool calls and intermediate
reasoning happen above it. If you scroll up past the letterbox, you are
looking at the work-in-progress, not the answer. The term comes from the
internal component that renders it (`src/utils/letter-box.ts`); end-users
usually just call it "the reply box", but docs and transcripts say "letterbox".

#### WebUI (`--serve`)
`mycc --serve` starts the **WebUI**: a local HTTP server that serves a
browser-based chat interface for the same agent loop. Defaults: port **3173**,
bound to **localhost** (so only your machine can open it). Override with
`--serve 9000` (port) or `--host 0.0.0.0` (bind — needed if you run mycc
inside a container or want to reach it from another machine on your LAN). The
WebUI is an alternative *face* for mycc — the same tools, skills, and session
are behind it. It is **not** a "headless peer" mode and is **not** required for
cross-instance mediation: a plain `mycc` (no flags) already registers identity,
writes heartbeats, and runs the channel poll, so a mediator's `firstQuery`
auto-delivers with no special flag.

#### `--auto`
A separate flag from `--serve`. `--auto` changes the lead's own prompt loop
(PROMPT→WAIT + auto-replies to incoming mail) so the agent runs autonomously
without a human typing at the terminal. It is **orthogonal** to serve mode:
`--auto` alone (no `--serve`) runs a headless terminal agent; `--serve` alone
runs the WebUI with a human at the browser. Neither flag is needed just to
wire peers — plain `mycc` is enough.

#### ESC / neglected mode
When the LLM is mid-call and you press **ESC**, mycc enters **neglected mode**:
1. The in-flight LLM call is **aborted** (no more tokens spent).
2. Remaining tool calls the LLM had queued are **skipped**.
3. A short background "wrap-up" LLM call (no tools allowed) produces a quick
   **text-only** reply so you are not left hanging.
4. The agent returns to the `agent >> ` prompt.

Use ESC when the agent has gone astray or is doing something you do not want —
it is the "interrupt and redirect" button. The README's "hit ESC to interrupt
(enter neglected mode)" refers to exactly this.

#### slash commands
Commands starting with `/` that **bypass the LLM** — mycc handles them
directly. Common ones an end-user should know:

| Command | Purpose |
|---------|---------|
| `/mode`, `/plan` | Switch between normal and plan mode (plan mode = read-only, no edits) |
| `/mindmap` | Compile / get / patch the project's mindmap |
| `/load <id>` | Derive a brand-new session from an old one (NOT a resume — see "session") |
| `/clear` | Clear the on-screen sequence (double Ctrl+L); the saved history is unaffected |
| `/todos` | List/manage todo items |
| `/team` | List teammates |
| `/issues` | List shared issues |
| `/help` | Show help |

#### session
Every time you start `mycc`, it creates a **new session** (a UUID). Sessions
are **sealed** — once the process exits, the session file becomes a read-only
archive that is never written to again. `/load <id>` (or `mycc --from <id>`)
does **not** resume the old session; it **derives a brand-new session** from
the old one: the LLM re-reads the old transcript and generates a fresh
starting context. Loading the same id multiple times yields **different** new
sessions (variation by re-understanding) — use this to branch and explore
alternatives. Session files live under `.mycc/sessions/<uuid>/`.

#### plan mode
A read-only mode where the agent can read and reason but **cannot edit files
or run state-changing commands**. Use it when you want the agent to
investigate, plan, or review without risk. Switch with `/mode` or `/plan`.

### How agents collaborate

#### teammate / team
A **teammate** is a child-process agent spawned by the lead (via `tm_create`)
to work in parallel. Each teammate runs its own agent loop with a restricted
tool set (no team-management tools). The lead assigns work via `mail_to` or
issues; idle teammates **auto-claim** unassigned issues every ~5s. This all
happens **inside one mycc instance** — the `coordination` skill covers it.
Teammates share the lead's session, so they are cheap to coordinate.

#### peer / channel (cross-instance)
A **peer** is a *separate* mycc instance (its own process, possibly its own
working directory), discovered via the `peers` tool. A **channel** is a pair
of files (`channels/<session-id>-<channel-id>.json`, one per participant)
that a mediator writes to wire two instances together; the channel's
`firstQuery` is auto-delivered to each instance's mailbox to kick off its
role. After kickoff, the instances talk **peer-to-peer via `mail_to`** using
the identity `"<peer-session-id>/lead"`. This is the *cross-instance*
collaboration model — distinct from the in-process teammate/team model. The
`mediator` skill covers it in full.

#### communication model (how mail flows)
mycc's inter-agent messaging is **event-driven and push-based**, not
pull-based. Whether mail comes from a teammate, a peer, or a channel's
`firstQuery`, the flow is the same two halves:

- **Send (appends one line):** `mail_to(name=...)` — or a channel join
  delivering its `firstQuery` — appends a single JSONL line to the recipient's
  unread mailbox file (`unread-lead.jsonl`, found via `identity.json`).
  Appending is an atomic file append; cross-instance peer mail is
  freshness-gated (silently dropped if the peer is offline/stale).
- **Receive (injected at COLLECT):** on the recipient's **next COLLECT
  state**, the unread mailbox is drained and each mail is injected into the
  conversation as a `[MAIL]` note — automatically, exactly once. The agent does
  not read the mailbox file itself; the loop does it for it.

**Practical consequence (fire-and-forget):** after you send a `mail_to` (or
wire a channel), **do not poll the mailbox** (no `sleep`+`cat` loop). Just
finish your turn and return to the prompt; the reply arrives as a `[MAIL]`
note in a future round the moment the loop next reaches COLLECT. Busy-polling
*blocks* COLLECT (the only place mail surfaces), so you can wait forever and
never see it. The agent loop is the mail consumer — step out of its way.

For the full cross-instance wiring detail (channel-file authoring, the two
connection modes, the firstQuery reply contract, pitfalls), see the
**`mediator` skill**. For the in-process teammate/mailbox model, see the
`coordination` skill.

#### worktree
A **worktree** is a parallel checkout of the same git repo on a new branch,
created via `wt_create`. mycc can spawn worktrees so an agent (or a teammate)
can work on a branch in its own directory without disturbing the main
checkout. Manage with `wt_create` / `wt_enter` / `wt_leave` / `wt_remove` /
`wt_print`.

### Knowledge & safety

#### mindmap
The **mindmap** is a navigable knowledge tree compiled from the project's
`MYCC.md` (the project self-description at the repo root). It is compiled into
`.mycc/mindmap.json` and queried on-demand via the `recall(path=...)` tool —
the agent drills from the root down into children to retrieve just the context
it needs, rather than loading everything at once. Mindmap answers questions
about **the current project's structure and intent**. (Process isolation: each
agent — lead or teammate — has its own mindmap instance.)

#### wiki / RAG
The **wiki** is a persistent semantic knowledge base (vectors in LanceDB)
that the agent writes to and searches. Two-phase storage: `wiki_prepare`
(validate) then `wiki_put` (store); query with `wiki_get`. Domains organize it
(e.g. "project", "architecture", "pitfall"). Where the **mindmap** is
project-structure knowledge compiled from `MYCC.md`, the **wiki** is
free-form factual knowledge the agent accumulates and retrieves by similarity.
Embedding always goes through **Ollama** (see HARD vs SOFT below).

#### intent language
The `bash` tool requires an **intent** parameter — a structured string, not
free prose — in the form:
```
VERB OBJECT PARAM PARAM ... TO PURPOSE
```
`VERB` is one of `READ, WRITE, EDIT, DELETE, BUILD, TEST, INSTALL, RUN`;
`OBJECT` is one of `SOURCE, CONFIG, DEPENDENCY, ARTIFACT, SYSTEM, DATA, TEMP,
USER`; each `PARAM` is `key=value` (no spaces around `=`); `TO PURPOSE` is a
short justification. This lets mycc judge whether a command is safe without
parsing arbitrary shell. Example: `READ SOURCE path=src/foo.ts TO understand
the parser`.

#### grant system
The `bash` tool runs every command through a **5-step judging process**:
(1) check for dangerous patterns, (2) validate the intent grammar,
(3) check mode + verb, (4) LLM analysis for `RUN` verb, (5) user prompt for
uncertain cases. Destructive/irreversible commands (e.g. `rm -rf`) are
blocked by default and routed to a `[y/N]` user confirmation; system commands
like `git commit` are hard-blocked from plain bash (use the dedicated tool,
e.g. `git_commit`). This is why not every shell command just runs.

#### skills
**Skills** are Markdown files (with YAML front-matter) that give the LLM
specialist knowledge on demand, loaded via `skill_load` / `skill_search`. They
come in types: process (step-by-step workflows), reference (lookup info),
lesson (captured experiences), and hookish (auto-triggering via `when`
conditions, compiled with `skill_compile`). Loaded from two layers (project
`.mycc/skills/` overrides user `~/.mycc-store/skills/`).

---

## Dependencies on Ollama (HARD vs SOFT)

mycc's relationship with Ollama is **not uniform** across features. Some
features are architecturally hard-wired to Ollama with no fallback; others
have non-Ollama alternatives or are only needed conditionally. Knowing which
is which matters when choosing a deployment (local-only vs DeepSeek-only vs
cloud-Ollama) or when debugging "why does the README say I still need Ollama
even with DeepSeek?".

### HARD — architecturally enforced, no fallback

| Feature | Why it's hard | Evidence |
|---------|---------------|----------|
| **Embedding (wiki/RAG, skill matching)** | Both embedding backends construct the Ollama client with **only** `host` — no `Authorization` header. `OLLAMA_API_KEY` is **read but never passed** to the embedding client, so cloud embedding via an API key does NOT work. The chat client, by contrast, DOES inject the key (see SOFT row). Embedding therefore requires a reachable Ollama server that does not require auth — in practice a **local** Ollama. | `src/engine/rag-nomic.ts:11-13`: `new Ollama({ host: getOllamaHost() })` <br> `src/engine/rag-embeddinggemma.ts:14-16`: `new Ollama({ host: getOllamaHost() })` <br> Compare chat client `src/engine/ollama.ts:36-42`: `new Ollama({ host, ...(OLLAMA_API_KEY ? { headers: { Authorization: \`Bearer ${OLLAMA_API_KEY}\` } } : {}) })` <br> Accessors `src/config.ts:385` (`getOllamaHost`), `:392` (`getOllamaApiKey`) |

**Implication:** Even when `OLLAMA_HOST` points to a cloud URL and
`OLLAMA_API_KEY` is set, the embedding requests leave without an
`Authorization` header and are rejected by Ollama Cloud. The README's "an
embedding model via Ollama is still needed" (even for DeepSeek users) is
architecturally enforced: wiki/RAG and skill semantic-matching require a
local (non-auth) Ollama embedding endpoint. Supporting cloud embedding would
be a small fix — pass the same conditional `headers` object in both RAG
files that the chat client already uses.

### SOFT — has a non-Ollama alternative, or only needed conditionally

| Feature | Alternative / Condition | Evidence / Notes |
|---------|-------------------------|-------------------|
| **Chat / LLM** | **DeepSeek** can replace Ollama entirely for chat (`DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `API_PROVIDER=deepseek`). When Ollama is the chat provider, `OLLAMA_API_KEY` IS honored (cloud-compatible). | `src/engine/ollama.ts:36-42` injects `Authorization: Bearer` when `OLLAMA_API_KEY` is set. DeepSeek path is a separate provider. |
| **Vision (`read_picture` / `screen`)** | Only needed when those tools are actually used. Uses `OLLAMA_VISION_MODEL`. If unset, vision features are disabled with a warning (not a crash). Not available under DeepSeek. | Health check in `src/engine/ollama.ts` emits a warning when `OLLAMA_VISION_MODEL` is unset. |
| **Web search (`web_search` / `web_fetch`)** | Built-in mycc tools, independent of Ollama for their core plumbing — but routed through the Ollama provider's `webSearch`/`webFetch` helpers and gated behind cloud features. Not available under DeepSeek. | `src/engine/ollama.ts` `webSearch`/`webFetch`. |

**Rule of thumb:** a DeepSeek-only deployment still needs a **local Ollama**
for embeddings (HARD). A pure local-Ollama deployment needs nothing else. A
cloud-Ollama deployment works for chat (key is honored) but NOT for
embedding (key is dropped on the embedding path) — so it still needs a
local embedding server.

---

## Launching mycc & Locating the mycc Project Directory

### 1. How to launch a mycc instance

mycc is distributed as a global npm CLI (`@pkubangbang/mycc`). After
`npm install -g @pkubangbang/mycc` (or `npm link` from a source checkout),
the `mycc` command is on PATH. Launch it from the **project directory** you
want to work in:

```bash
cd /c/Proj/myapp            # or: cd C:\Proj\myapp  (adapt to your shell)
mycc                        # interactive TUI; waits at the agent >> prompt
mycc --skip-healthcheck     # faster startup, skips the Ollama health check
mycc -v                     # verbose logging
```

**Serve mode (WebUI):** `mycc --serve` starts the **WebUI** — a local HTTP
server (default port 3173, localhost-bound; `--serve 9000` or `--host 0.0.0.0`
override port/bind). It is NOT a "headless peer" mode — it launches the
browser-accessible chat UI. `--auto` is a separate flag that changes the
lead's own prompt loop (PROMPT→WAIT + auto-replies to mail) so it runs
autonomously without a human at the terminal; it is orthogonal to serve
mode. **Neither flag is required for cross-instance mediation**: a plain
`mycc` launched in a directory already registers identity + writes
heartbeats + runs the 5s channel poll, so a mediator's `firstQuery`
auto-delivers with no special flag (see the `mediator` skill).

> **Do NOT launch peers via raw `node bin/mycc.js`** (or any direct spawn of
> the engine entry). The Lead refuses to start outside the Coordinator —
> `main()` in `src/loop/agent-repl.ts` checks `process.send` and exits if the
> Coordinator IPC is absent — so a raw `node` spawn either errors out or hangs
> before identity registration, and the instance never appears in `peers()`.
> Always use the `mycc` command (the Coordinator wrapper in `bin/mycc.js`).
> This matters for the `mediator` skill's cross-instance wiring.

### 2. How to find the mycc project directory from a runnable `mycc`

**Invariant:** if `mycc` is runnable on the system, the mycc project
directory is findable via the global install path. The `mycc` shim resolves
to the package's `bin/mycc.js`, whose parent is the package root (the mycc
project directory).

Resolve the `mycc` shim to the project root (bash — adapt the symlink-follow
step to your shell; on Windows PowerShell the equivalent is chasing
`(Get-Command mycc).Source` then `(Get-Item).Target`):

```bash
# `command -v mycc` finds the shim; follow it to bin/mycc.js, then go up one dir.
shim=$(command -v mycc)          # e.g. .../npm/mycc  (a shell shim)
# The shim ultimately points at the package's bin/mycc.js; resolve symlinks:
entry=$(readlink -f "$shim" 2>/dev/null || realpath "$shim")
# bin/mycc.js -> the mycc project/package root is its parent directory.
mycc_root=$(dirname "$(dirname "$entry")")
echo "$mycc_root"
```

Alternative (robust, doesn't depend on shim chasing) — use npm's global root:

```bash
# npm root -g prints the global node_modules; @pkubangbang/mycc lives there.
pkg_root="$(npm root -g)/@pkubangbang/mycc"
echo "$pkg_root"   # this is the mycc project/package directory
```

Either way: **`mycc` runnable ⇒ mycc project dir findable**. Use this when
you need to read mycc's own source/skills/docs from another working
directory (e.g. a peer instance investigating mycc's architecture).

---

## Configuration

Configuration is stored in `.env` files:

| Level | Location | Scope |
|-------|----------|-------|
| **User** | `~/.mycc-store/.env` | All projects |
| **Project** | `.mycc/.env` | Current project only |

### Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `OLLAMA_HOST` | Ollama server URL (default: http://127.0.0.1:11434) |
| `OLLAMA_MODEL` | Chat model (default: glm-5:cloud) |
| `OLLAMA_VISION_MODEL` | Vision model for screen/image tools |
| `OLLAMA_EMBEDDING_MODEL` | Embedding model (default: nomic-embed-text) |
| `OLLAMA_API_KEY` | API key for cloud features (optional) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `DEEPSEEK_MODEL` | DeepSeek model (default: deepseek-chat) |
| `TOKEN_THRESHOLD` | Context limit for auto-compaction (default: 50000) |
| `EDITOR` | Text editor for multiline input |

---

## Summary

This skill makes you a **tutor for mycc itself** when the user is in another
project:

1. **letterbox** — the bordered box that shows the LLM's final reply.
2. **WebUI** — `mycc --serve`, a browser chat face for the same agent; NOT a
   headless-peer mode and NOT required for mediation.
3. **ESC / neglected mode** — abort the LLM call, skip queued tools, get a
   text-only wrap-up, return to prompt.
4. **session** — new UUID each start; sealed on exit; `/load` derives a
   brand-new (varied) session, it does not resume.
5. **teammate/team** — in-process child agents (coordination skill); **peer/
   channel** — separate instances wired by a mediator (mediator skill).
   **Communication model** — mail is push-based: `mail_to` appends one line to
   the recipient's mailbox; the recipient's next COLLECT drains it and injects
   it as a `[MAIL]` note. Fire-and-forget; never poll the mailbox. Detail in
   the `mediator` skill.
6. **mindmap** — navigable project-structure tree from `MYCC.md`, queried via
   `recall`; **wiki/RAG** — free-form semantic knowledge the agent writes and
   searches. Embedding always via Ollama.
7. **intent language** + **grant system** — why the `bash` tool is structured
   and judged, not free-form.
8. **Ollama HARD vs SOFT** — embedding needs a local Ollama (HARD); chat can
   use DeepSeek or cloud-Ollama (SOFT).
9. Launch with `mycc` from the project dir; find the install via the `mycc`
   shim or `npm root -g` + `@pkubangbang/mycc`.