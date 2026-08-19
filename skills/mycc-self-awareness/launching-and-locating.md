# Launching mycc & Locating the mycc Project Directory

## 1. How to launch a mycc instance

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
server (default port 3173, localhost-bound; `--serve 9000` or
`--host 0.0.0.0` override port/bind). It is NOT a "headless peer" mode — it
launches the browser-accessible chat UI. `--auto` is a separate flag that
changes the lead's own prompt loop (PROMPT→WAIT + auto-replies to mail) so
it runs autonomously without a human at the terminal; it is orthogonal to
serve mode. **Neither flag is required for cross-instance mediation**: a
plain `mycc` launched in a directory already registers identity + writes
heartbeats + runs the 5s channel poll, so a mediator's `firstQuery`
auto-delivers with no special flag (see the `mediator` skill).

> **Do NOT launch peers via raw `node bin/mycc.js`** (or any direct spawn
> of the engine entry). The Lead refuses to start outside the Coordinator —
> `main()` in `src/loop/agent-repl.ts` checks `process.send` and exits if
> the Coordinator IPC is absent — so a raw `node` spawn either errors out
> or hangs before identity registration, and the instance never appears in
> `peers()`. Always use the `mycc` command (the Coordinator wrapper in
> `bin/mycc.js`). This matters for the `mediator` skill's cross-instance
> wiring.

## 2. How to find the mycc project directory from a runnable `mycc`

**Invariant:** if `mycc` is runnable on the system, the mycc project
directory is findable via the global install path. The `mycc` shim resolves
to the package's `bin/mycc.js`, whose parent is the package root (the mycc
project directory).

Resolve the `mycc` shim to the project root (bash — adapt the
symlink-follow step to your shell; on Windows PowerShell the equivalent is
chasing `(Get-Command mycc).Source` then `(Get-Item).Target`):

```bash
# `command -v mycc` finds the shim; follow it to bin/mycc.js, then go up one dir.
shim=$(command -v mycc)          # e.g. .../npm/mycc  (a shell shim)
# The shim ultimately points at the package's bin/mycc.js; resolve symlinks:
entry=$(readlink -f "$shim" 2>/dev/null || realpath "$shim")
# bin/mycc.js -> the mycc project/package root is its parent directory.
mycc_root=$(dirname "$(dirname "$entry")")
echo "$mycc_root"
```

Alternative (robust, doesn't depend on shim chasing) — use npm's global
root:

```bash
# npm root -g prints the global node_modules; @pkubangbang/mycc lives there.
pkg_root="$(npm root -g)/@pkubangbang/mycc"
echo "$pkg_root"   # this is the mycc project/package directory
```

Either way: **`mycc` runnable ⇒ mycc project dir findable**. Use this when
you need to read mycc's own source/skills/docs from another working
directory (e.g. a peer instance investigating mycc's architecture).

## See also

- `configuration.md` — env vars and CLI flags for launch.
- `io-surfaces.md` — the two I/O surfaces (CLI TUI vs WebUI) in detail.
- SKILL.md — the glossary overview.