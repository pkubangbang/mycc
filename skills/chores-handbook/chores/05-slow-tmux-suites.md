## Chore 5: Do NOT write automated tests for slow, PTY-driven boot suites

### Background

Some contracts can only be observed by driving a **real** interactive boot: a
real tmux session, a real `mycc` process behind the tsx ESM loader, real
keystrokes into a real TTY, and a deliberately *broken* environment (a dead
provider endpoint, a closed port, a missing model). The `--serve` +
"Retry health check?" freeze (fixed in `d78db44`) is the canonical example:
the bug lived in the ordering of `runHealthCheck()` vs `activateServe()` in
`src/loop/agent-repl.ts` plus the Coordinator's serve-mode stdin filter in
`src/index.ts`, and it was **only** reproducible end-to-end over a PTY.

A test for it was written, proved red/green, then **deliberately removed**.
This chore records that decision so nobody re-adds it.

### Why the test was removed (owner's decision, 2026-10-30)

1. **Too slow for what it buys.** One tmux session + one full `mycc` boot cost
   ~26 s green; with the bug present it was ~75 s (each assertion waits out a
   timeout before failing). That is 1–3 s per assertion against a contract
   that changes perhaps twice a year — the textbook definition of a suite to
   mute, and muting a test that only exists to catch one regression means it
   is no longer protecting anything by default.
2. **Environment-unstable by construction.** It depends on tmux being
   installed *and* a reachable tmux server (the binary alone is not enough —
   `tmux -V` succeeds on a headless box with no server), on a globally linked
   `mycc`, on a free port, on a dead port staying dead, and on the
   `mycc`-side Enter throttle (text and Enter typed back-to-back are
   rejected). Every one of those is a flake source that reads as a
   product failure.
3. **The red half is not cheap either.** Proving the test guards the bug
   requires checking out the pre-fix tree (`git checkout <fix>~1 -- <files>`),
   running a 75 s live boot, then restoring — an operation nobody will
   repeat casually, so the guard silently decays.
4. **It duplicates a manual procedure that is already written down.** The
   reproduction is 6 lines of tmux (below). Keeping it as a documented chore
   means it is executed exactly when the area is touched, by an agent that can
   read the failure text, instead of on every `pnpm test` for every unrelated
   change.

### What to do instead — reproduce by hand when you touch this area

```bash
# 1. Point the provider at a port nothing listens on (getOllamaHost() reads
#    only process.env.OLLAMA_HOST, so this cannot be overridden by .mycc/.env),
#    then boot with --serve. Use a throwaway port.
tmux new-session -s hc -d -x 140 -y 45
tmux send-keys -t hc "export OLLAMA_HOST=http://127.0.0.1:3199"
tmux send-keys -t hc Enter
tmux send-keys -t hc "mycc --serve 3197"
tmux send-keys -t hc Enter

# 2. Expect the failure banner + "Retry health check? [Y/n] >" and NO
#    "Web UI started" line — the hub must not exist while the provider is dead.
tmux capture-pane -t hc -p -S -100

# 3. Type y (text, pause ~2 s, then Enter — the Enter throttle rejects
#    text+Enter typed back-to-back). A working build prints
#    "Retrying health check..." within a second or two.
tmux send-keys -t hc "y"; sleep 2; tmux send-keys -t hc Enter
tmux capture-pane -t hc -p -S -100

# 4. Type n: expect "Exiting at user request." then cleanup.
tmux send-keys -t hc "n"; sleep 2; tmux send-keys -t hc Enter
tmux kill-session -t hc
```

**Pass criteria:** the prompt is answerable from the terminal, `y` re-runs the
check, `n` exits, and "Web UI started" never appears while the provider is
unreachable. **Fail signature:** the prompt stays on screen and typing does
nothing (keys swallowed by the serve-mode stdin filter) — that is the freeze.

Also re-check the healthy path once: with a working provider and `--serve`,
"Web UI started" must appear, and stdin must then be filtered (keys dropped,
process alive) — that is the invariant the fix intentionally keeps.

### Rules

- **Never commit a tmux/PTY boot test for a startup-ordering contract.** If
  you believe one is needed, raise it with the owner first; the default answer
  is a chore in this handbook.
- **Do not add it to a "slow" bucket as a compromise.** Muting it
  (`mutedSlowSuite()`) makes it run only under `RUN_SLOW=1`/CI, which is
  exactly where a flaky 75 s PTY boot does the most damage — CI runs would
  go red on tmux-server quirks, not on product regressions.
- **Keep unit-level coverage where it is cheap.** Anything that can be
  asserted without a TTY (config helpers such as `shouldServe()`,
  `getServePort()`, `shouldSkipHealthCheck()`; the `activateServe()` failure
  path) belongs in `src/tests/serve/` or `src/tests/config/` as a normal
  test. The distinction is *cheap and deterministic* vs *PTY boot*. Chore 2
  covers suites that are merely skipped, which is a different mechanism.
- **Record the decision next to the code it protects.** `src/loop/agent-repl.ts`
  already carries the load-bearing comment explaining why serve activation is
  gated on the health check — that comment, not a test, is the regression
  guard. Keep it accurate when you touch the ordering.

### Verify (cheap, always-run substitutes)

```bash
npx tsc --noEmit -p src/tests/tsconfig.json     # ordering changes still typecheck
npx vitest run src/tests/serve/serve-start-failure.test.ts src/tests/serve/serve-registry-onready.test.ts
```

Neither proves the PTY behaviour; they prove the serve layer still starts and
fails cleanly. The PTY walk above is the only proof of the prompt contract.
