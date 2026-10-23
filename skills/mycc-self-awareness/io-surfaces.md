# I/O Surfaces & Auto-Created Folders

mycc has two I/O surfaces (how a user interacts with the agent) and a set
of folders it creates automatically on disk. This reference documents both.

## Two I/O Surfaces

### 1. CLI (terminal TUI) — the default

The default interactive interface. mycc boots, prints the `agent >> `
prompt, and waits for user input. The LLM's final reply is rendered in a
green-bordered **letterbox** (~80 chars wide) with a timestamp header.
Tool calls and intermediate reasoning appear above the letterbox.

Key CLI interactions:
- **ESC** — enter neglected mode: abort the in-flight LLM call, skip queued
  tools, get a text-only wrap-up, return to prompt.
- **Slash commands** (`/mode`, `/plan`, `/mindmap`, `/load <id>`,
  `/clear`, `/todos`, `/team`, `/issues`, `/help`) — bypass the LLM; mycc
  handles them directly.
- **Enter at empty prompt** — exit. **Ctrl+C** — quit anytime.

### 2. WebUI (`--serve`) — browser-based chat

`mycc --serve` starts a local HTTP server serving a browser-based chat
interface for the same agent loop. It is an alternative *face* for mycc —
the same tools, skills, and session are behind it.

| Setting | Default | Override |
|---------|---------|----------|
| Port | 3173 | `--serve 9000` or `--port 9000` |
| Bind | localhost | `--host 0.0.0.0` (needed for containers / LAN) |
| File upload | up to 50 MB/file | `--max-upload-mb <n>` / `MYCC_MAX_UPLOAD_MB` |

The WebUI is **not** a "headless peer" mode and is **not** required for
cross-instance mediation: a plain `mycc` (no flags) already registers
identity, writes heartbeats, and runs the channel poll. `--auto` is a
separate, orthogonal flag (autonomous terminal agent, no human typing).

## Auto-Created Folders

mycc creates these directories/files automatically. They fall into two
scopes: **project-level** (inside the working directory's `.mycc/`) and
**user-level** (inside `~/.mycc-store/`, shared across projects).

> **There is no single declared manifest of "well-known" subfolders.**
> `src/config.ts` holds `MYCC_DIR = '.mycc'` plus the accessors and the one
> `ensureDirs()` that creates the core set; everything else is written by a
> module that hard-codes `path.join(<root>, '.mycc', ...)`. The tables below
> mark each entry as **declared** (accessor + `ensureDirs()`) or
> **conventional** (module-owned, no accessor) — that distinction is the
> honest answer to "does mycc know about this folder?".

### Project-level (`.mycc/`, one per project)

**Declared** — `src/config.ts`: `MYCC_DIR`, `getMyccDir()`, and
`ensureDirs()` (creates the directory if missing on boot):

| Path | Accessor | Purpose |
|------|----------|---------|
| `.mycc/` | `MYCC_DIR` / `getMyccDir()` | runtime root (relative to cwd) |
| `.mycc/sessions/<uuid>/` | `getSessionDir()`, `getSessionsDir()` | per-session triologue + metadata (sealed on exit; never written again) |
| `.mycc/sessions/<uuid>/unread-<owner>.jsonl`, `readmail-<owner>.jsonl` | `MailBox` (`src/context/shared/mail.ts`) | the current mail inbox + backlog, one file per owner |
| `.mycc/skills/` | `getSkillsDir()` | project-level custom skills (overrides user-level) |
| `.mycc/tools/` | `getToolsDir()` | project-level custom tools |
| `.mycc/longtext/` | `getLongtextDir()` | oversized tool results stored for `read_read` summarization |
| `.mycc/imgcache/` | `getImgCacheDir()` | on-disk image description cache (`read_picture` / `screen`, parent process only) |

`getPlanModeWritableDirs()` returns exactly `longtext/` + `imgcache/`: they are
transient analysis output, the only `.mycc/` dirs writable in plan mode.
`tools/`, `skills/`, `sessions/` are state/config, not output.

**Conventional** — no accessor, written by their own module:

| Path | Written by | Purpose |
|------|-----------|---------|
| `.mycc/mindmap.json` | mindmap compile (`src/mindmap/load.ts`) | compiled knowledge tree from `MYCC.md` |
| `.mycc/mindmap-patch.jsonl` (+ `.bak`) | mindmap patch (`src/mindmap/patch-jsonl.ts`) | incremental mindmap edits. **Written automatically by `recap`** (one add/update/delete per recap, via a hidden second LLM fork) — *not* only when the agent explicitly edits the mindmap. Replayed over `mindmap.json` at startup. See the "Known Blind Spot" section in `SKILL.md`. |
| `.mycc/conditions.json` (+ `.backup`) | `skill_compile` (`src/hook/conditions.ts`) | compiled hookish skill `when` conditions |
| `.mycc/skill-index-cache.json` | `src/context/parent/wiki-skill-index.ts` | per-project hash cache that lets an unchanged skill set skip wiki re-indexing |
| `.mycc/public/` | agent (`src/serve/serve-hub.ts`) | agent-authored static assets served by `--serve` |
| `.mycc/uploaded/` | Web UI upload (`src/loop/states/{prompt,collect}.ts`) | files uploaded through the browser chat |
| `.mycc/transcripts/` | mindmap explorer (`src/mindmap/explorer-agent.ts`) | transcripts of the mindmap explorer sub-agent |
| `.mycc/worktrees.json` | worktree tooling | worktree registry |
| `.mycc/lfplater/` | `learn-from-past` skill (agent-written) | deferred learn-from-past pointer docs, consumed and deleted by the `lfplater-skill-manager` daemon |
| `.mycc/.env` | setup wizard (`src/setup/paths.ts`) | project-level configuration (overrides user-level) |
| `.mycc/tmp/` | **agents, ad hoc** | scratch space; not part of the contract, safe to purge |

**Legacy / dead:** `.mycc/mail/<name>.jsonl` (old per-agent mailboxes, last
written 2026-04) — current mail lives inside `sessions/<uuid>/`. Do not
recreate that path. Loose files at the `.mycc/` root (probe scripts, one-off
dumps) are agent scratch, never a contract.

### User-level (`~/.mycc-store/`, shared by all projects)

**Declared** — `src/config.ts` accessors; `ensureDirs()` creates `wiki/`,
`wiki/logs/`, `wiki/db/`, `discovery/`, `discovery/heartbeat/`,
`discovery/channels/`:

| Path | Accessor | Purpose |
|------|----------|---------|
| `~/.mycc-store/.env` | `getUserConfigPath()` — `src/setup/paths.ts` | user-level config (applies to all projects) |
| `~/.mycc-store/skills/` | `getUserSkillsDir()` | user-level custom skills (below project, above built-in) |
| `~/.mycc-store/tools/` | `getUserToolsDir()` | user-level custom tools |
| `~/.mycc-store/wiki/` | `getWikiDir()` | RAG store root |
| `~/.mycc-store/wiki/db/` | `getWikiDbDir()` | LanceDB tables |
| `~/.mycc-store/wiki/logs/` | `getWikiLogsDir()` | wiki logs |
| `~/.mycc-store/wiki/reindex.lock` | `getWikiReindexLockFile()` | serializes re-indexing across every instance sharing the wiki |
| `~/.mycc-store/wiki/domains.json` | `getWikiDomainsFile()` | registered wiki domains |
| `~/.mycc-store/discovery/` | `getDiscoveryDir()` — `MYCC_DISCOVERY_DIR` overrides it | peer discovery protocol (myccdp) |
| `~/.mycc-store/discovery/identity.json` | `getIdentityFile()` | machine-wide cross-instance identity registry |
| `~/.mycc-store/discovery/heartbeat/<sid>.json` | `getHeartbeatFile()` | rolling liveness timestamps (every 30s) |
| `~/.mycc-store/discovery/channels/<sid>-<cid>.json` | `getChannelFile()` | channel file pairs wired by a mediator |

**Conventional:** `~/.mycc-store/sessions/<uuid>/` — the same per-session
layout, used when mycc runs from a user-level cwd; there is no dedicated
accessor (the layout is documented in the header of `src/session/index.ts`).
Check **both** `.mycc/sessions/` and `~/.mycc-store/sessions/` before
concluding a session is missing.

### Notes

- **No SQLite database** — session storage is purely file-based (JSON +
  JSONL). There are no WAL files, locks, or table corruption to worry about.
- **The mindmap on disk is two lines, merged only in memory.** At startup
  mycc loads `.mycc/mindmap.json` (the `MYCC.md` base) and then replays
  every action in `.mycc/mindmap-patch.jsonl` on top. `recall` reads the
  merged in-memory tree. Because `recap` appends to that patch log on its
  own, **the knowledge tree can change without the agent (or user) asking**
  — a documented blind spot; see `SKILL.md`.
- **`.mycc/imgcache/` and `.mycc/longtext/`** hold transient analysis
  artifacts, not project source — they are safe to clean up.
- **Skill layer priority:** built-in (`skills/` in the package) > project
  (`.mycc/skills/`) > user (`~/.mycc-store/skills/`). Project overrides
  user; built-in cannot be shadowed.

- **`MYCC_DISCOVERY_DIR`** can relocate the discovery store (tests and
  `mycc-compose` rely on it) — never hard-code `~/.mycc-store/discovery`.
- **Adding new state?** Put the path in `src/config.ts` next to its siblings
  (do not inline `path.join(cwd, '.mycc', 'x')`), add it to `ensureDirs()` if
  it must exist at boot, and pick the scope: `.mycc/` for anything tied to
  this codebase, `~/.mycc-store/` for anything shared across projects
  (skills, wiki, peers). Only transient tool output belongs in
  `getPlanModeWritableDirs()`.
- **Keep `.mycc/` out of git** — use the contents-only ignore `/.mycc/*`
  (not `/.mycc/`), so a negation such as `!.mycc/skills/` can still track one
  subfolder later.

## See also

- `launching-and-locating.md` — how to launch each surface.
- `configuration.md` — env vars and CLI flags controlling the surfaces.
- `ollama-dependencies.md` — which features need Ollama.
- SKILL.md — the glossary overview.