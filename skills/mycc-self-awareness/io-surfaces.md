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

### Project-level (`.mycc/`)

| Path | Created by | Purpose |
|------|-----------|---------|
| `.mycc/sessions/<uuid>/` | session creation | Per-session triologue + metadata (sealed on exit; never written again) |
| `.mycc/mindmap.json` | mindmap compile | Compiled knowledge tree from `MYCC.md` |
| `.mycc/mindmap-patch.jsonl` | mindmap patch | Incremental mindmap edits |
| `.mycc/imgcache/` | `read_picture` / `screen` | On-disk image description cache (parent process only) |
| `.mycc/longtext/` | longtext dump | Oversized tool results stored for `read_read` summarization |
| `.mycc/skills/` | user / setup | Project-level custom skills (overrides user-level) |
| `.mycc/conditions.json` | `skill_compile` | Compiled hookish skill `when` conditions |
| `.mycc/lfplater/` | `learn-from-past` hook | Deferred learn-from-past files for future processing |
| `.mycc/.env` | setup wizard | Project-level configuration (overrides user-level) |

### User-level (`~/.mycc-store/`)

| Path | Created by | Purpose |
|------|-----------|---------|
| `~/.mycc-store/.env` | setup wizard | User-level config (applies to all projects) |
| `~/.mycc-store/sessions/` | session save (`/save`) | Saved/archived sessions (copied from project sessions) |
| `~/.mycc-store/skills/` | user | User-level custom skills (shared across projects) |
| `~/.mycc-store/discovery/identity.json` | peer registration | Cross-instance identity registry (session → workDir, mailbox) |
| `~/.mycc-store/discovery/heartbeat/<sid>.json` | peer heartbeat | Rolling liveness timestamps (every 30s) for peer discovery |
| `~/.mycc-store/discovery/channels/` | mediator | Channel file pairs (`<sid>-<channel-id>.json`) for cross-instance wiring |

### Notes

- **No SQLite database** — session storage is purely file-based (JSON +
  JSONL). There are no WAL files, locks, or table corruption to worry about.
- **`.mycc/imgcache/` and `.mycc/longtext/`** hold transient analysis
  artifacts, not project source — they are safe to clean up.
- **Skill layer priority:** built-in (`skills/` in the package) > project
  (`.mycc/skills/`) > user (`~/.mycc-store/skills/`). Project overrides
  user; built-in cannot be shadowed.

## See also

- `launching-and-locating.md` — how to launch each surface.
- `configuration.md` — env vars and CLI flags controlling the surfaces.
- `ollama-dependencies.md` — which features need Ollama.
- SKILL.md — the glossary overview.