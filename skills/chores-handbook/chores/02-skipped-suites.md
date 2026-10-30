## Chore 2: Run the "skipped" topical test suites

### Background

A few suites in `src/tests/` are gated behind `describe.skip` / `it.skip`
because they **spawn real child processes** or otherwise depend on the
environment (a terminal opener, a live pid, a real `host:port` endpoint). They
are kept — not deleted — so coverage is preserved; they are skipped only so the
default `pnpm test` (aka `vitest run`) stays fast and deterministic on every
platform. When you touch the code they cover, you MUST run them explicitly.

Currently skipped / environment-dependent (verify with `grep` before relying on
this list — it drifts):

- `src/tests/mycc-compose-shim-parse.test.ts` — both describes wrapped in
  `describe.skip` (OS-gated; spawns the launcher shim).
- `src/tests/mycc-compose-peers.test.ts` — the `stopPeer:`/`launchPeer:`
  describes spawn processes. (The launch-timeout case is a live `it()` again —
  it uses `opts.timeoutMs` to stay ~1s.)
- `src/tests/mycc-compose-down.test.ts` — 3 process-spawning cases (`it.skip`).
- `src/tests/mycc-compose-up-pipeline.test.ts` — spawning cases (`it.skip`).
- `src/tests/serve/peer-wire-smoke.test.ts` — pre-existing (NOT part of the
  compose PR); smoke-level.

### How to find them

```powershell
# every skip site (file:line + the reason comment usually follows)
Select-String -Path src/tests/**/*.test.ts -Pattern 'describe\.skip|it\.skip'
```

```bash
grep -rn --include='*.test.ts' -E 'describe\.skip|it\.skip' src/tests
```

### How to run ONLY the skipped tests

vitest can't "run only skipped" directly (a skip is never executed), so run the
**files** that contain the skips and temporarily un-skip the cases you need, OR
run the whole file — the skipped cases stay skipped and the live cases run:

```powershell
# Run each file that harbours skipped cases (fast; skipped cases remain skipped)
npx vitest run src/tests/mycc-compose-shim-parse.test.ts src/tests/mycc-compose-peers.test.ts src/tests/mycc-compose-down.test.ts src/tests/mycc-compose-up-pipeline.test.ts
```

To actually EXERCISE a skipped case, flip `it.skip`/`describe.skip` → `it`/
`describe` locally (or `describe.skipIf(false)`), run the file, then flip it
back. Keep the un-skip LOCAL — do not commit it.

### Two hard rules for these suites

1. **Run them through the `bash` tool, redirecting output to a file** — e.g.
   `npx vitest run <files> > .mycc/tmp-test.txt 2>&1`. A foreground bash call
   is capped at **60s** and these suites spawn processes; piping vitest output
   through `Select-String`/`Select-Object` can hang the wrapper to the cap even
   when tests finish in seconds (leaked child handles). Redirect to a file and
   read the file. For the FULL suite use a background task (`bg_create`).
   > The repo's `test-after-edit` commit hook registers only a test run invoked
   > via the `bash` tool — a `bg_create` run is invisible to it and will leave
   > `git_commit` blocked. If the hook blocks you, run at least one (even
   > trimmed) `bash`-tool vitest run before committing.

2. **Never delete a skipped case to make CI green.** The convention is
   skip-not-delete: the coverage stays, the cost is deferred. Delete only
   genuinely obsolete cases, and only with the owner's sign-off.

### Why not just un-skip them all permanently

They spawn real processes and touch real OS surfaces (terminal openers, pid
liveness, sockets). On a headless/CI box those are flaky, and on a dev box they
add tens of seconds per run. Skipping keeps the default suite portable; the
manual run above is the deliberate opt-in when the covered code changes.

