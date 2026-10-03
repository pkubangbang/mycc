# Peer Launch on Windows — why the launcher looks the way it is

> Scope: the launch mechanics of `mycc-compose` peers, implemented in
> `scripts/mycc-compose/lib/peers-lifecycle.ts` (see `docs/peer-topology.md`
> for the surrounding design). This page holds the *mechanisms*; the code
> holds only the *intentions* that point here.
>
> All three fixes were proven on Windows 11 (Windows Terminal as the default
> host): the peer suite runs 13/13 three rounds in a row, and a window
> watcher (top-level window class + title enumeration every 250ms) observed
> **zero** window creations while detached peers launched, where the pre-fix
> code popped visible `CASCADIA_HOSTING_WINDOW_CLASS` consoles.

## 1. The four failures the screenshot showed (`start up script is not correct`)

| Symptom in the launched window | Root cause | Fix |
|---|---|---|
| `Set-Location: PathNotFound` → `CommandNotFound` | the peer `workdir` did not exist, and the script `cd`'d before anything created it; every later command then ran in the wrong directory | the launch script **creates the workdir first** (`New-Item -Force` / `mkdir -p`) and a failed `New-Item` aborts instead of silently `cd`-ing elsewhere |
| `CommandNotFound` / `0x80070002` for `mycc` | the terminal's own shell does **not** inherit this process's `PATH` | the launcher is resolved to an **absolute** path before use (§2) |
| `0x80070002` with the script visibly split mid-line | a raw `powershell -NoExit -Command <script>` is re-tokenized by terminal chains (notably `wt.exe` splits on the `;` inside the script even though it is one argv element) | the script travels as `-EncodedCommand` BASE64 UTF-16LE — no `;`, quotes, or spaces left to mangle (the same pattern `/fork` proved) |
| a peer that should be headless still pops a console window | detached spawn mechanics (§3) | npm shim → real argv, spawned directly |

## 2. Launcher resolution — absolute, in three steps

A terminal window starts in a fresh shell whose `PATH` is not the compose
CLI's `PATH`, so a bare `mycc` dies with `ENOENT`/`0x80070002`. The launcher
must therefore be an absolute, directly-invocable path, probed in this order:

1. `$MYCC_ROOT/bin/mycc{.cmd,.exe}` (`.exe`/`.cmd` on Windows, bare on POSIX)
2. `<repo>/bin/…` relative to the module — **three** levels up from
   `scripts/mycc-compose/lib` (two stops at `scripts/bin`, which never exists;
   the old bug silently preferred a stale npm-linked PATH shim)
3. the `mycc` shim on `PATH`, probed as an absolute path per directory

Nothing resolved ⇒ fall back to the bare `mycc` name (best effort).

Quoting: the launch command is passed with the PowerShell call operator
(`& '<abs launcher>' '--session-id' '<sid>' …`, `'` doubled inside tokens) so
space-bearing paths/args stay one token; POSIX uses `'a'\''b'` escaping.

`.cmd`/`.bat` shims in the **terminal** path stay wrapped in `cmd /c` —
libuv refuses to exec a batch file with `shell:false` (`EINVAL`), and that
path *wants* a real console anyway.

## 3. The detached-console pitfall — why `windowsHide` is not enough

The core fact, from Node.js
[issue #21825](https://github.com/nodejs/node/issues/21825) and probed live on
Win11 (see also `docs/lead-detach-issue-solution.md`, the same mechanism one
level up in the daemon Lead):

> With `DETACHED_PROCESS` (what `detached: true` means on Windows) the child
> gets **no console**. `node.exe` is happy console-less, but `cmd.exe` is
> not: cmd checks whether it has a console and **allocates a fresh one** if
> not. Windows then hands that new console to the default terminal host,
> which shows it — visible `CASCADIA_HOSTING_WINDOW_CLASS` window. Neither
> `windowsHide: true` (CREATE_NO_WINDOW) nor the parent's options can cancel
> a console a *grandchild* allocates for itself.

So `spawn('cmd', ['/c', 'mycc.cmd', …], { detached: true, windowsHide: true })`
— the natural way to run an npm shim — flashes a console exactly when the
peer must be headless (`--daemon`, windowless fallback, test seam): the
`cmd /c` interpreter exits immediately, its node child allocates a console,
and the window pops.

**Fix:** don't go through the interpreter. `parseCmdShim` in
`peers-lifecycle.ts` reads the npm cmd-shim (a generated batch file) and
extracts the argv it *would* execute:

- npm shim shape: `SET "_prog=%dp0%\node.exe"` inside `IF EXIST` (with
  `SET "_prog=node"` as the ELSE), the exec buried behind
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\node_modules\@pkubangbang\mycc\bin\mycc.js" %*`
- plain shim shape: `@echo off` + `"<abs node.exe>" "<abs entry.js>" %*`

The parser (deliberately narrow — anything unrecognized returns `null` and
the caller keeps the old `cmd /c` + `windowsHide` fallback, degrading to at
worst a transient flash, never a broken launch):

1. collect `SET "_prog=…"` values (the `%_prog%` indirection),
2. walk the file **bottom-up** — the effective command is the last
   `%*`-consuming line,
3. take the last `&`-separated segment that both consumes `%*` and quotes a
   `<something>.js`,
4. read the two quoted tokens as `prog` + `target`; expand `%dp0%`/`%~dp0`
   to the shim's directory; a named-but-absent bundled `node.exe` degrades
   to PATH `node` (npm's own IF-EXIST/ELSE semantics); the entry script must
   exist on disk.

`spawnDetached` then spawns `{prog} {target} <args…>` directly with
`detached: true, stdio: 'ignore', shell: false, windowsHide: true` and
unref'd — identical observable argv to `cmd /c shim args…`, but node never
allocates a console, so nothing pops. This is the same lesson
`docs/lead-detach-issue-solution.md` learned for the daemon Lead (spawn the
real binary, avoid inserting an interpreter), applied at the shim layer.

Split policy summary:

| Path | interpreter | window |
|---|---|---|
| default (visible terminal) | `cmd /c` allowed for `.cmd` shims | one visible terminal, wanted — **fail-fast if the opener cannot run** |
| `--daemon`, test seam | forbidden; parse the shim instead | none, ever |
| unparsable shim in a detached path | `cmd /c` fallback kept | possible transient flash (accepted) |

Design rule: **observability over availability** in the default branch —
`openTerminal` throwing (no terminal emulator found, spawn failure) rejects
the launch with the opener's diagnostic (what was probed, why it failed).
There is deliberately **no silent windowless fallback**: a fallback would
hide the opener's cause behind a blank console joiner.

## 4. Test seam shape

`LaunchPeerOpts.spawnImpl` is a hand-narrowed function type
`(command, args, SpawnOptions) => ChildProcess`, not `typeof spawn`: the
builtin's overloads form a union no loosely-typed test double can satisfy,
which broke typecheck when the seam was first introduced. The seam sits
*above* the daemon/terminal split so a headless test drives the beat poll in
either mode; it routes through `spawnDetached` so tests inherit the exact
production spawn shape.

## References

- `docs/lead-detach-issue-solution.md` — same console-allocation mechanism
  (Node issue #21825) for the daemon Lead; Go-wrapper context
- `docs/peer-topology.md` — peer group design, `up` pipeline, workdir guard
- `src/utils/open-terminal.ts` — the terminal opener shared with `/fork`