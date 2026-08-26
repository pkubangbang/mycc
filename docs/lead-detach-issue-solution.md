# Lead Detach Issue & Solution

## Problem History

### Issue 1 — Daemon Lead Silent Exit (Windows-only)

When mycc runs with `--daemon`, the Coordinator spawns the Lead as a detached
background process and exits. On Windows, if the Lead is spawned **without**
`detached: true`, the Lead shares the Coordinator's console process group.
When the Coordinator exits, Windows sends `CTRL_CLOSE_EVENT` to the entire
console group, killing the Lead within seconds — a **silent exit**: no
uncaughtException/unhandledRejection (OS kill, not JS), and the verbose log
just stops after daemon init with no error.

**Fix (commit 43c1580):** `spawnTsx` was given `detached: true` in
`startDaemonLead()`. On Windows, `detached: true` maps to libuv's
`UV_PROCESS_DETACHED` → Win32 `DETACHED_PROCESS` creation flag. This puts the
Lead in its own process group, immune to the Coordinator's `CTRL_CLOSE_EVENT`.

**Unix is unaffected:** `child.unref()` + `stdio: 'ignore'` is sufficient —
the child gets reparented to init and survives. `detached: true` on Unix is
for process-group separation (preventing SIGINT propagation), not console
survival.

### Issue 2 — Console Window Flashing (Windows-only, regression from Issue 1 fix)

After adding `detached: true`, the daemon Lead started flashing ~30 `cmd.exe`
console windows during its run.

**Root cause:** `DETACHED_PROCESS` gives the Lead **no console at all**. When
the Lead calls `execSync('rg ...')` (which defaults to `shell: true` → spawns
`cmd.exe`), `cmd.exe` finds no inherited console and **self-allocates a new
visible one** — this is the flash. Each `execSync`/`spawn` call with
`shell: true` triggers a new `cmd.exe` window.

`windowsHide: true` on `spawnTsx` maps to `CREATE_NO_WINDOW`, but
`DETACHED_PROCESS` takes precedence (no console = nothing to hide). This is
Node.js issue [#21825](https://github.com/nodejs/node/issues/21825):
`windowsHide` is broken with `detached: true` for console applications. The
issue is still open as of 2024.

**Key insight from Node.js issue #21825 (simonbuchan's comment):**
> `CreateProcess()` will *not* show a new console window with `DETACHED_PROCESS`
> regardless of `CREATE_NO_WINDOW`, even for other console apps like node.exe,
> *except* for `cmd.exe`. `cmd.exe` checks if it has a console and creates and
> attaches a new console window if it doesn't.

**Unix is unaffected:** Console windows are a Windows concept. `windowsHide`
is a no-op on Unix, and `detached: true` creates a process group, not a
console.

### Why `--hide-console-windows` Doesn't Work

Node.js PR [#39712](https://github.com/nodejs/node/pull/39712) (landed v16.8.0)
added a `hide_console_windows` environment flag that sets `CREATE_NO_WINDOW`
globally for all child processes. However, it is an **embedder-only runtime
flag** — not accessible as a CLI flag in standard Node.js builds. Confirmed:
`node --hide-console-windows` returns "bad option".

## Solution: Native Go Wrapper (Windows-only)

### Architecture

```
Coordinator (node.exe, has terminal console)
  → spawn(mycc-daemon.exe, detached:true, stdio:'ignore')  [DETACHED_PROCESS — no console, no flash]
    → Go wrapper calls CreateProcessW(CREATE_NEW_CONSOLE + STARTF_USESHOWWINDOW + SW_HIDE)
      → spawns Lead (node.exe + tsx loader)  [has a HIDDEN console]
        → Lead's execSync('rg ...') → cmd.exe sees hidden console → no new allocation → NO FLASH
```

### Why This Works (BEFORE / AFTER)

- **BEFORE:** Lead has NO console (`DETACHED_PROCESS`). Every `cmd.exe` child
  self-allocates a visible console → ~30 flashes.
- **AFTER:** Lead has a HIDDEN console (`CREATE_NEW_CONSOLE + SW_HIDE` via
  native Win32 API). Every `cmd.exe` child inherits the hidden console → zero
  flashes. Future `execSync` calls are automatically fixed — no whack-a-mole
  patching individual `execSync`/`spawn` sites.

### Why Go and Not a Node.js Wrapper

A Node.js wrapper spawned with `detached: true` would itself have no console
(`DETACHED_PROCESS`), and spawning the Lead with `windowsHide: true` (without
`detached`) would work in theory — but Node.js's spawn behavior with
`detached: true` + `windowsHide: true` is the unstable combination that
caused issue #21825 in the first place. The Go wrapper calls
`CreateProcessW` directly, bypassing Node.js's libuv entirely. This is the
reliable, documented Win32 mechanism.

### Win32 API Details

The Go wrapper uses `CreateProcessW` with:

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `dwCreationFlags` | `CREATE_NEW_CONSOLE` (0x00000010) | Gives the Lead its own console |
| `si.dwFlags` | `STARTF_USESHOWWINDOW` (0x00000001) | Enables `wShowWindow` |
| `si.wShowWindow` | `SW_HIDE` (0) | Hides the console window |
| `bInheritHandles` | `FALSE` | stdio is 'ignore' for daemon, no handles to inherit |
| `lpEnvironment` | `NULL` | Inherit parent's environment |
| `lpCurrentDirectory` | `NULL` | Inherit parent's working directory |

`CREATE_NEW_CONSOLE` puts the Lead in its own console process group, so it
survives the wrapper's exit (same survival mechanism as `DETACHED_PROCESS`,
but with a hidden console instead of no console).

## Implementation Plan

### Section 1 — Go Wrapper Binary (`src/native/daemon-wrapper/main.go`)

A tiny Go program (~60 lines) that receives:
- `argv[1]` = node.exe path (`process.execPath`)
- `argv[2]` = tsx ESM loader path
- `argv[3]` = script path (`src/lead.ts`)
- `argv[4:]` = forwarded CLI args (`--daemon`, `--skip-healthcheck`, etc.)

It builds the command line as `node.exe --import <loader> <script> <args...>`,
calls `CreateProcessW` with the flags above, and exits immediately.

**Build:** `cd src/native/daemon-wrapper && go build -o ../../bin/mycc-daemon.exe`

**Distribution:** The pre-built `mycc-daemon.exe` is committed to the repo
and included in the npm package via the `files` field in `package.json`. Users
installing from npm get the binary — no Go toolchain needed.

**Prerequisite:** Install Go (`winget install GoLang.Go`) — dev-only, not a
user dependency.

### Section 2 — Modify `startDaemonLead()` in `src/index.ts`

Replace the direct `spawnTsx` call with spawning the Go wrapper binary on
Windows. On non-Windows, keep the existing `spawnTsx` approach.

```typescript
function startDaemonLead(): void {
  const tsxScript = resolve(PROJECT_ROOT, 'src', 'lead.ts');
  const forwardedArgs = process.argv.slice(2);
  const env = { ...process.env };
  env.COLUMNS = process.env.COLUMNS || '120';
  env.MYCC_COORDINATOR_PID = String(process.pid);

  const useWrapper = process.platform === 'win32'
    && existsSync(resolve(PROJECT_ROOT, 'bin', 'mycc-daemon.exe'));

  let child: ChildProcess;
  if (useWrapper) {
    // Native Go wrapper: CreateProcessW with CREATE_NEW_CONSOLE + SW_HIDE
    const wrapperPath = resolve(PROJECT_ROOT, 'bin', 'mycc-daemon.exe');
    const loaderPath = getTsxLoaderPath();  // exported from tsx-run.ts
    child = spawn(wrapperPath, [
      process.execPath, loaderPath, tsxScript, ...forwardedArgs,
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],  // no IPC — see Section 3
      env,
      detached: true,
    });
  } else {
    // Fallback: existing spawnTsx approach (Unix, or missing binary)
    child = spawnTsx({
      script: tsxScript,
      args: forwardedArgs,
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env,
      detached: true,
    });
  }

  child.unref();
  // ... rest unchanged (verbose logging, grace period, process.exit(0))
}
```

### Section 3 — Relax IPC Guard for Daemon Mode

The Lead's `agent-repl.ts:54` guard `if (!process.send)` blocks startup
without Node.js IPC. The Go wrapper can't do Node.js IPC. Since the daemon
Lead's IPC is fire-and-forget (Coordinator exits immediately, all messages
are harmlessly dropped), we relax the guard for daemon mode.

**`src/loop/agent-repl.ts` line 54:**
```typescript
// BEFORE:
if (!process.send) {
  console.error(chalk.red('Error: Lead process must be started via Coordinator'));
  process.exit(1);
}

// AFTER:
if (!process.send && !shouldDaemon()) {
  console.error(chalk.red('Error: Lead process must be started via Coordinator'));
  process.exit(1);
}
```

**Fix unguarded `process.send!()` calls** (would crash with `undefined` when
no IPC):

| File | Line | Current | Fixed |
|------|------|---------|-------|
| `agent-repl.ts` | 333 | `process.send({ type: 'ready' })` | `process.send?.({ type: 'ready' })` |
| `agent-repl.ts` | 456 | `process.send({ type: 'exit' })` | `process.send?.({ type: 'exit' })` |
| `daemon-init.ts` | 69 | `process.send!({ type: 'exit' })` | `process.send?.({ type: 'exit' })` |
| `daemon-init.ts` | 82 | `process.send!({ type: 'exit' })` | `process.send?.({ type: 'exit' })` |
| `signal-handlers.ts` | 64 | `process.send!({ type: 'exit' })` | `process.send?.({ type: 'exit' })` |

All other `process.send` calls in the codebase are already guarded with
`if (process.send)` — no changes needed.

### Section 4 — Remove `windowsHide: true` from `spawnTsx`

Per the user's instruction, remove the `windowsHide: true` line from
`spawnTsx()` in `src/utils/tsx-run.ts` (line ~228). It's redundant:
`DETACHED_PROCESS` (from `detached: true`) already means no console, and
without `detached: true` the child inherits the parent's console (which is
the terminal — no flashing). The `windowsHide` was a false fix that never
propagated to grandchildren.

Also remove the JSDoc comment about `windowsHide` on lines ~221-226.

### Section 5 — Export `getTsxLoaderPath()` from `tsx-run.ts`

Currently private; export it so `index.ts` can pass the loader path to the Go
wrapper.

### Section 6 — Add Binary to `package.json` `files` Field

Add `"bin/mycc-daemon.exe"` to the `files` array in `package.json` so it's
included in the npm package.

## Summary of Files to Change

| File | Change |
|------|--------|
| `src/native/daemon-wrapper/main.go` | **NEW** — Go wrapper binary source |
| `bin/mycc-daemon.exe` | **NEW** — Compiled Go binary (committed) |
| `src/index.ts` | Modify `startDaemonLead()` to use Go wrapper on Windows |
| `src/utils/tsx-run.ts` | Export `getTsxLoaderPath()`; remove `windowsHide: true` |
| `src/loop/agent-repl.ts` | Relax IPC guard for daemon mode; `process.send?.()` |
| `src/loop/daemon-init.ts` | `process.send!()` → `process.send?.()` (2 sites) |
| `src/loop/signal-handlers.ts` | `process.send!()` → `process.send?.()` (1 site) |
| `package.json` | Add `bin/mycc-daemon.exe` to `files` field |

## Assumptions

1. Go toolchain will be installed (`winget install GoLang.Go`) — dev-only,
   not a user dependency.
2. The pre-built `mycc-daemon.exe` is committed to the repo and included in
   the npm package.
3. The fix is Windows-only; Unix is unaffected (uses process groups, not
   consoles).
4. The daemon Lead's IPC is fire-and-forget — no IPC relay needed through
   the Go wrapper.

## Comparison with agent-afk

The `agent-afk` project (at `C:\Proj\agent-afk`) is another Node.js-based CLI
agent that faces the same spawn/detach challenges. Key findings:

### How agent-afk avoids the flash (the core difference)

agent-afk's grep tool (`src/agent/tools/handlers/grep.ts`) spawns ripgrep
**directly** via `spawn(rgPath, args)` — **no `shell: true`, no `cmd.exe`**.
This is the fundamental difference:

```typescript
// agent-afk: spawn rg binary directly — no shell, no cmd.exe, no flash
const proc = spawn(rgPath, args, effectiveCwd !== undefined ? { cwd: effectiveCwd } : {});
```

```typescript
// mycc: execSync through a shell — spawns cmd.exe which self-allocates a console
const cmd = `rg -n --no-heading --color never ${includeFlag} ${excludeFlag} ${shellQuote(pattern)} ${shellQuote(dir)} 2>&1`;
const stdout = execSync(cmd, { encoding: 'utf-8', timeout: 15000, maxBuffer: 500 * 1024 });
```

**The flash is caused by `shell: true` (which `execSync` defaults to), not by
`detached: true` alone.** When `cmd.exe` is spawned without an inherited
console (because the parent has `DETACHED_PROCESS`), it self-allocates a new
visible console. Spawning the binary directly with `shell: false` avoids
`cmd.exe` entirely — no console allocation, no flash.

### agent-afk's daemon spawn

agent-afk's Telegram bot daemon (`src/telegram/manager.ts`) spawns with:
```typescript
child = spawn(process.execPath, [entrypoint], {
  detached: true,
  stdio: ['ignore', out, err],  // log to files, not 'ignore'
  env: process.env,
});
```

Notably:
- **No `windowsHide`** — not used anywhere in the codebase
- **No native wrapper** — pure Node.js `spawn`
- **`stdio` to file FDs** (not 'ignore') — output goes to log files
- **Settle window** — waits 1.5s, then checks if PID is still alive

The daemon spawns `node.exe` directly (not through a shell), so there's no
`cmd.exe` to flash. The daemon's own `execSync`/`spawn` calls (if any) would
still flash on Windows if they use `shell: true`, but agent-afk appears to be
macOS/Linux-focused (uses `ps`, `/proc`, `launchd`) and doesn't mitigate
Windows console flashing.

### agent-afk's kill-process-group

```typescript
// Windows: execFileSync (not execSync) — but still no windowsHide
execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
  stdio: 'ignore',
  timeout: 5_000,
});
```

Uses `execFileSync` (not `execSync`) which defaults to `shell: false` — so
`taskkill.exe` is spawned directly without `cmd.exe`. This would **not flash**
even on Windows, because `execFileSync` with `shell: false` doesn't go through
`cmd.exe`.

### Key lesson for mycc

The root cause is more precisely: **`execSync` defaults to `shell: true` on
Windows, which spawns `cmd.exe`. When the parent process has no console
(`DETACHED_PROCESS`), `cmd.exe` self-allocates a visible console.**

Two complementary fixes emerge:
1. **Refactor `execSync` calls to `spawn`/`execFileSync` with `shell: false`**
   where possible (like agent-afk does for grep) — eliminates `cmd.exe`
   entirely for those calls.
2. **Use the Go wrapper** for the daemon Lead itself — gives the Lead a hidden
   console so even remaining `shell: true` calls (that genuinely need a shell)
   don't flash.

The Go wrapper is still needed because some `execSync` calls in mycc genuinely
require a shell (e.g., PowerShell `Select-String` fallback in grep-search.ts,
`git rev-parse` in config.ts). Refactoring all of them to `shell: false` would
be a larger effort and some (PowerShell) can't avoid a shell. The Go wrapper
fixes them all at once by giving the Lead a hidden console to inherit.

## References

- Node.js issue [#21825](https://github.com/nodejs/node/issues/21825) —
  `windowsHide` not working with `detached: true`
- Node.js PR [#39712](https://github.com/nodejs/node/pull/39712) —
  `hide_console_windows` embedder flag (landed v16.8.0)
- Win32 `CreateProcessW` docs —
  [Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- Win32 `STARTUPINFO` docs (STARTF_USESHOWWINDOW, SW_HIDE) —
  [Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfoa)
- Pitfall wiki hash `3d626311` — daemon Lead silent exit (detached:true fix)