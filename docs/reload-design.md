# reload slash command - design doc

> **状态：已实施。** 见 `src/slashes/reload.ts`（命令）与 `src/index.ts`（协调端
> `reloadLead`）。保留为设计文档。

The `/reload` slash command restarts mycc with fresh code **without spawning a
new terminal or a new coordinator** — only the lead process is killed and
respawned. It is the "in-place hot reload" counterpart to `/fork`.

## When to use /reload vs /fork

| | `/fork` | `/reload` |
|---|---|---|
| Coordinator | A brand-new coordinator+lead in a **new terminal window** | **Reuses** the current coordinator; only the lead is restarted |
| Context | Pre-populated from the current session via `--from` (LLM re-understands the old transcript) | **Cleared** — a fresh empty session, no `--from` |
| Old instance | Keeps running in parallel (two mycc) | Killed (replaced by the respawned lead) |
| Teammates | Live on in the old instance | Killed (they are children of the old lead) |
| Web UI | Not preserved (new terminal, new port) | **Preserved** — rebinds to the same port; browser auto-reconnects |
| Best for | Branching/exploring alternatives in parallel | Picking up code edits to the lead process without a full restart |

## Workflow

1. The user edits mycc source code (typically lead-side files).
2. The user enters `/reload` at the prompt (terminal or web UI).
3. The lead reads its current serve state (active? port? host?) from the
   `ServeHub` singleton and sends a `reload` IPC message to the coordinator.
4. The coordinator's `reloadLead()`:
   - Gracefully shuts down the old lead's Vite/HTTP server (the
     `serve_shutdown` → `serve_shutdown_done` handshake, critical on Windows
     where `SIGTERM` → `TerminateProcess` and no signal handler runs).
   - `SIGTERM`s the old lead. Teammates are child processes of the lead, so
     they are naturally killed (process group) — no explicit dismissal needed.
   - Respawns a **fresh lead with NO `--from` flag** → `initializeSession()`
     calls `createNewSession()` → a fresh empty triologue. No context is
     pre-populated; the conversation is cleared.
   - If serve was active, forwards `--serve <port> --host <host>` so the new
     lead re-activates the web UI on the **same port**.
5. The new lead's `agent-repl.ts` checks `shouldServe()` + `getServePort()` /
   `getServeHost()` and calls `activateServe()`, rebinding the same port.
6. The browser's WebSocket `onclose` handler (see `src/web/src/main.ts`)
   schedules a reconnect; once the new server is up, the client re-fetches
   `/history` (now empty — fresh session) and reopens the WebSocket. From the
   user's perspective the web UI disconnects briefly then resumes with a
   cleared context.

## The effect boundary (IMPORTANT)

`/reload` only restarts the **lead** process. The **coordinator** (`src/index.ts`)
stays alive and keeps the code it was compiled with at startup. This means
`/reload` picks up changes to **lead-process** code but **NOT** to
coordinator-process code.

### What `/reload` DOES pick up (lead process)

The lead is `src/lead.ts` and everything it imports — effectively the entire
agent: the agent loop, all tools, all slash command handlers, skills, the
mindmap, the serve/webui stack, peer discovery, etc. Concretely, any file
under `src/` **except** the coordinator-process modules listed below is
lead-process code and is reloaded by `/reload`. Examples of lead-side files:

- `src/lead.ts`, `src/loop/**` (agent-repl, agent-io, states, triologue, …)
- `src/slashes/**` (every slash command, including `/reload` itself)
- `src/tools/**`, `src/skills/**` resolution, `src/mindmap/**`, `src/serve/**`
- `src/context/**`, `src/engine/**` (Ollama/DeepSeek providers), `src/session/**`

### What `/reload` does NOT pick up (coordinator process)

The coordinator (`src/index.ts`) directly imports and holds these modules in
its **own** process; they are loaded once at startup and never reloaded by
`/reload`. Editing any of these requires a **full mycc restart** (exit +
relaunch `mycc`) to take effect:

| File | Why it lives in the coordinator |
|---|---|
| `src/index.ts` | The coordinator itself — spawn/IPC/stdin-forwarding logic, `restart()` and `reloadLead()` |
| `src/config.ts` | Parses CLI args **once at module load** (`const args = minimist(...)`). `--serve`, `--from`, `--port`, etc. are read here. A reload can't re-parse argv of the already-running coordinator. |
| `src/loop/agent-io.ts` | Imported by the coordinator for startup warnings/briefs. (Also imported by the lead — the lead gets a fresh copy on respawn.) |
| `src/utils/key-parser.ts` | Used by the coordinator to parse raw stdin key events for forwarding |
| `src/utils/tsx-run.ts` | `spawnTsx()` — used by the coordinator to spawn the lead |
| `src/help.ts` | `--help` output (only matters at coordinator startup) |

> **Practical rule of thumb:** if your edit is to `src/index.ts` or
> `src/config.ts` (or a module that only the coordinator imports), run a full
> `mycc` restart. For any other edit, `/reload` is enough.

### A subtle consequence

Because `src/config.ts` is a coordinator-process module, **CLI flags are frozen
for the coordinator's lifetime.** `/reload` respawns the lead, but the
coordinator decides which flags to forward to the new lead. `/reload` itself
only forwards `--serve <port> --host <host>` (when serve was active) plus the
`--skip-healthcheck` the coordinator was started with — it does **not** let you
change `--token-threshold`, `--ollama-model`, etc. via `/reload`. To change
those, restart mycc with the new flags.

## Implementation details

- `src/slashes/reload.ts` — the command. Reads `hub.getPort()` / `hub.getHost()`
  from the `ServeHub` singleton, sends a `reload` IPC message carrying
  `{ serveActive, servePort, serveHost }`, then blocks forever (the
  coordinator SIGTERMs the lead). Mirrors the `/load` block-forever pattern.
- `src/index.ts` — the coordinator-side `reloadLead()`, structurally mirroring
  the existing `restart()` (used by `/load`). The graceful serve-shutdown
  handshake is reused so the port is released before the new lead rebinds it.
- `src/serve/serve-hub.ts` — added `getPort()` / `getHost()` public getters so
  `/reload` can read the current binding without reaching into private fields.

## Special notice

Just like `/fork`, `/reload` reloads the **lead process** code. The first time
you use `/reload` after editing the coordinator-side code (`src/index.ts`,
`src/config.ts`, …), you must do one full `mycc` restart first so the
coordinator picks up the new coordinator-side code — after that, `/reload`
works for all subsequent lead-side edits.