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
keywords: [mycc, runtime, environment, tutor, glossary, letterbox, webui, serve, neglected, esc, session, triologue, teammate, mindmap, wiki, worktree, intent language, grant system, peer, channel, crossroad, slash command, Ollama, DeepSeek, end-user, service, service_cron, daemon, cron, scheduled, background, headless]
---

# mycc Self-Awareness: A Tutor for mycc's Own Concepts

> **This is a progressive-disclosure skill.** This entry file holds the
> glossary overview and the decision points; the detailed references are
> split into sibling files in this folder. Read the glossary entry you need
> below, and `read_file` the referenced file when the user's question
> matches its topic.
>
> Sibling references in this skill:
> - `ollama-dependencies.md` — Full HARD vs SOFT Ollama dependency analysis
>   with source-code references; which features break without Ollama and
>   which still work; the embedding auth-header gap.
> - `launching-and-locating.md` — How to launch mycc (`mycc`, `--serve`,
>   `--auto`, `--skip-healthcheck`), locate the installation directory via
>   the shim or `npm root -g`, and the "don't use raw node" warning.
> - `configuration.md` — Full config reference: env vars, CLI flags, `.env`
>   file locations (user-level vs project-level), override priority.
> - `io-surfaces.md` — The two I/O surfaces (CLI TUI vs WebUI) and every
>   folder mycc auto-creates on disk (project-level `.mycc/` and user-level
>   `~/.mycc-store/`), with what creates each and why.
> - `daemon-services.md` — The `service` / `service_cron` / `--daemon`
>   mechanism: how a skill runs as a long-lived headless background service
>   with cron-scheduled self-nudge mail. Read when the user says "design a
>   service that...", "run on a schedule/cron", "run in the background /
>   headless / as a daemon".

This skill exists for one situation: **you are running mycc inside some
other project** (not the mycc codebase), and the user starts asking about
mycc itself — "what's a letterbox?", "what does `--serve` do?", "what
happens when I press ESC?", "what's a teammate?". The user is an **end-user
of mycc**, not a mycc developer. They want plain-language explanations of
the unique concepts mycc introduces, so they can use the tool well and talk
about it accurately.

Use this skill as a **tutor glossary**: read the user's question, find the
matching concept below, and explain it in plain language (the definitions
here are the authoritative wording — keep them accurate). If the user asks
about their *current project*, do NOT use this skill — that is normal
project work.

## When to Use This Skill

- The cwd is **not** the mycc project directory (you are in another repo /
  folder), AND
- The user asks about **mycc the tool**: its UI, its modes, its
  collaboration model, its knowledge features, how to launch it, or where
  to find the install.

Do NOT use it when:
- You are working inside the mycc codebase itself (use the
  `environment-detection` / `tool-and-skill-development` skills instead).
- The user is asking about their current project (that is ordinary work).

---

## Glossary of mycc-Unique Concepts

Grouped by what an end-user actually sees and does. Each entry is a
plain-language summary; the sibling file has the full detail where noted.

### What you see & do

| Concept | One-line definition | Detail |
|---------|---------------------|--------|
| **letterbox** | The bordered green box (~80 chars) that renders the LLM's final reply at the end of a turn; tool calls happen above it. | — |
| **WebUI (`--serve`)** | A local HTTP server (default port 3173, localhost) serving a browser chat interface for the same agent loop. NOT a headless-peer mode. | `io-surfaces.md`, `launching-and-locating.md` |
| **`--auto`** | A separate flag from `--serve`; changes the lead's prompt loop to run autonomously without a human at the terminal. Orthogonal to serve mode. | `launching-and-locating.md` |
| **ESC / neglected mode** | Aborts the in-flight LLM call, skips queued tools, produces a text-only wrap-up, returns to prompt. The "interrupt and redirect" button. | — |
| **slash commands** | `/`-prefixed commands that bypass the LLM (`/mode`, `/plan`, `/mindmap`, `/load <id>`, `/clear`, `/todos`, `/team`, `/issues`, `/help`). | — |
| **session** | A new UUID each start; **sealed** on exit (read-only archive). `/load <id>` derives a brand-new session (NOT a resume) by re-reading the transcript. | `io-surfaces.md` (folder layout) |
| **plan mode** | A read-only mode where the agent can read and reason but cannot edit files or run state-changing commands. Switch with `/mode` or `/plan`. | — |

### How agents collaborate

| Concept | One-line definition | Detail |
|---------|---------------------|--------|
| **teammate / team** | A child-process agent spawned by the lead to work in parallel; shares the lead's session; cheap to coordinate. In-process. | `coordination` skill |
| **peer / channel** | A *separate* mycc instance (own process/cwd), discovered via `peers`; a channel is a file-pair a mediator writes to wire instances together. Cross-instance. | `mediator` skill |
| **communication model** | Mail is push-based: `mail_to` appends one line to the recipient's mailbox; the recipient's next COLLECT drains it and injects it as a `[MAIL]` note. Fire-and-forget; never poll. | `mediator` skill |
| **worktree** | A parallel checkout of the same git repo on a new branch (`wt_create`/`wt_enter`/`wt_leave`/`wt_remove`/`wt_print`). | `worktree` skill |
| **service / `--daemon`** | A skill that declares `service: true` in frontmatter and runs as a **long-lived headless background process** via `mycc --daemon <skill>` (auto mode on, no terminal). Cron-scheduled if it also declares `service_cron`. | `daemon-services.md` |
| **service_cron** | A cron expression (e.g. `"0/10 * * * *"`) in a service skill's frontmatter; the daemon starts a timer that periodically injects a "Service nudge" mail to drive the agent — **deterministic** scheduling, not LLM self-identification. | `daemon-services.md` |

### Knowledge & safety

| Concept | One-line definition | Detail |
|---------|---------------------|--------|
| **mindmap** | A navigable knowledge tree compiled from `MYCC.md`, queried via `recall(path=...)` for on-demand context. Answers project-structure questions. | `io-surfaces.md` |
| **wiki / RAG** | A persistent semantic knowledge base (vectors in LanceDB); two-phase store (`wiki_prepare`→`wiki_put`), query with `wiki_get`. Embedding always via Ollama. | `ollama-dependencies.md` |
| **intent language** | The `bash` tool's structured intent: `VERB OBJECT PARAM... TO PURPOSE` (VERB ∈ READ/WRITE/EDIT/DELETE/BUILD/TEST/INSTALL/RUN; OBJECT ∈ SOURCE/CONFIG/DEPENDENCY/ARTIFACT/SYSTEM/DATA/TEMP/USER). | — |
| **grant system** | The `bash` tool's 5-step judging: dangerous-pattern check → intent grammar validation → mode+verb check → LLM analysis for RUN → user prompt for uncertain cases. Destructive commands are blocked by default. | — |
| **skills** | Markdown files (YAML front-matter) giving the LLM specialist knowledge on demand (`skill_load`/`skill_search`); types: process, reference, lesson, hookish. Two layers: project `.mycc/skills/` overrides user `~/.mycc-store/skills/`. | `io-surfaces.md` |

---

## Ollama HARD vs SOFT (brief)

mycc's relationship with Ollama is **not uniform**:

- **HARD (no fallback):** Embedding for wiki/RAG and skill matching. Both
  embedding backends construct the Ollama client with only `host` — no
  `Authorization` header — so `OLLAMA_API_KEY` is read but never passed.
  Even DeepSeek-only deployments need a **local** Ollama for embeddings.
- **SOFT (alternative exists):** Chat (DeepSeek can replace Ollama;
  `OLLAMA_API_KEY` IS honored for cloud-Ollama chat); vision (only when
  `read_picture`/`screen` are used); web search (independent plumbing,
  Ollama-provider-gated).

> **Full analysis with source-code references:** see
> `ollama-dependencies.md`.

---

## Launching & Locating (brief)

- **Launch:** `mycc` from the project dir; `--skip-healthcheck` for faster
  startup; `-v` for verbose; `--serve [port]` for the WebUI.
- **Locate the install:** the `mycc` shim resolves to `bin/mycc.js`; its
  parent is the package root. Or use `$(npm root -g)/@pkubangbang/mycc`.
- **Do NOT launch peers via raw `node bin/mycc.js`** — the Lead refuses to
  start outside the Coordinator.

> **Full launch commands, flag reference, and the locate-the-install
> scripts:** see `launching-and-locating.md`.

## Daemon Services (brief)

mycc can run a skill as a **long-lived headless background service** —
"design a service that runs on a schedule" maps here. A skill opts in by
declaring `service: true` (and optionally `service_cron: "<cron expr>"`) in
its frontmatter; launch it with `mycc --daemon <skill>` (forces auto mode
on, no terminal). With `service_cron`, a `croner` timer periodically
appends a **"Service nudge"** mail to the lead's own mailbox, which the
agent loop's WAIT→COLLECT drains and acts on per the skill's workflow —
**deterministic** scheduling, not relying on the LLM deciding to check in.
Without `service_cron` → **passive daemon** (stays alive, triggered only by
external `mail_to`). Only `--daemon` activates the cron timer; a normal
lead loading a `service_cron` skill does NOT start cron. The canonical
example is the built-in `lfplater-skill-manager`.

> **Full mechanism, frontmatter fields, `daemon-init.ts` bootstrap, data
> flow, and how to design a service skill:** see `daemon-services.md`.

## Configuration (brief)

Config lives in `.env` files at two levels: user (`~/.mycc-store/.env`,
all projects) and project (`.mycc/.env`, current project only). CLI flags
override both. Key vars: `OLLAMA_HOST`, `OLLAMA_MODEL`,
`OLLAMA_EMBEDDING_MODEL`, `OLLAMA_API_KEY`, `DEEPSEEK_API_KEY`,
`TOKEN_THRESHOLD`, `EDITOR`.

> **Full env var + CLI flag tables and override priority:** see
> `configuration.md`.

## I/O Surfaces & Folders (brief)

Two I/O surfaces: the **CLI TUI** (default `agent >> ` prompt + letterbox)
and the **WebUI** (`--serve`, browser chat at localhost:3173). mycc
auto-creates folders at two scopes: project-level (`.mycc/sessions/`,
`.mycc/mindmap.json`, `.mycc/imgcache/`, `.mycc/longtext/`,
`.mycc/skills/`, `.mycc/conditions.json`, `.mycc/lfplater/`) and
user-level (`~/.mycc-store/.env`, `~/.mycc-store/sessions/`,
`~/.mycc-store/skills/`, `~/.mycc-store/discovery/` for peer identity +
heartbeats + channels).

> **Full surfaces description and every auto-created folder with its
> creator and purpose:** see `io-surfaces.md`.

---

## Summary

This skill makes you a **tutor for mycc itself** when the user is in
another project:

1. **letterbox** — the bordered box that shows the LLM's final reply.
2. **WebUI** — `mycc --serve`, a browser chat face for the same agent; NOT
   a headless-peer mode and NOT required for mediation.
3. **ESC / neglected mode** — abort the LLM call, skip queued tools, get a
   text-only wrap-up, return to prompt.
4. **session** — new UUID each start; sealed on exit; `/load` derives a
   brand-new (varied) session, it does not resume.
5. **teammate/team** — in-process child agents (coordination skill);
   **peer/channel** — separate instances wired by a mediator (mediator
   skill). **Communication model** — mail is push-based; fire-and-forget;
   never poll the mailbox.
6. **mindmap** — navigable project-structure tree from `MYCC.md`, queried
   via `recall`; **wiki/RAG** — free-form semantic knowledge. Embedding
   always via Ollama.
7. **intent language** + **grant system** — why the `bash` tool is
   structured and judged, not free-form.
8. **Ollama HARD vs SOFT** — embedding needs a local Ollama (HARD); chat
   can use DeepSeek or cloud-Ollama (SOFT). Detail in
   `ollama-dependencies.md`.
9. **service / `--daemon` / `service_cron`** — a skill that declares
   `service: true` runs as a long-lived headless background process via
   `mycc --daemon <skill>`; `service_cron` drives it on a deterministic
   cron schedule via self-nudge mail. "Design a service that..." maps
   here. Detail in `daemon-services.md`.
10. Launch with `mycc` from the project dir; find the install via the
    `mycc` shim or `npm root -g`. Detail in `launching-and-locating.md`.
11. Two I/O surfaces (CLI + WebUI) and a known set of auto-created folders.
    Detail in `io-surfaces.md`.