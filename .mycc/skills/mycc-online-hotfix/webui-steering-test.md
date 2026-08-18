# E2E Testing the /serve Web UI with agent-browser

Companion to `SKILL.md`. This is the **exact, repeatable process** for
end-to-end testing the mycc Web UI (`/serve`) against a live server, using
the `agent-browser` CLI to drive a real headless Chrome and the
`window.__myccDebug` test seam to inject deterministic server messages.

Use this whenever a frontend change touches message routing, the steering
queue, interactive cards, or any state transition in
`src/web/src/message-dispatch.ts` — i.e. anything the node-based Vitest
suite covers *logically* but you also want verified through the real Vue
render + WebSocket path.

---

## Why this workflow (not a script, not hand_over)

- **Not a script**: you *drive* `agent-browser` step-by-step via the bash
  tool, observing each `eval` / `snapshot` / `click` result before the next.
  This keeps the agent in the loop and catches render bugs a scripted run
  would silently pass.
- **Not hand_over**: hand_over opens a popup that interrupts the user.
  The whole point of this skill is non-interruptive verification.
- **No real LLM needed**: `--serve` only needs Express + Vite + WS. Boot
  mycc with `--skip-healthcheck --serve` and the Web UI comes up without
  any model call. The debug seam lets you inject synthetic server messages
  instead of driving a real agent turn.

---

## Prerequisites

1. `agent-browser` installed globally (`npm i -g agent-browser && agent-browser install`).
   Verify: `agent-browser --version`.
2. The mycc repo with its web UI (`src/web/`).
3. tmux available (`psmux` on Windows, `tmux` elsewhere).

---

## Step 1 — Boot /serve in a detached tmux session

```bash
# Create a detached session (non-blocking)
tmux new-session -s mycc-serve -d -x 180 -y 50

# Start mycc in serve mode inside it (no healthcheck, no LLM needed)
tmux send-keys -t mycc-serve "cd C:/Proj/mycc; pnpm start --skip-healthcheck --serve 3173 2>&1 | Tee-Object -FilePath serve-boot.log" Enter
```

Wait ~15-20s for first boot (Vite cold start + skill indexing), then
capture the pane and look for the line:

```
🌐 Web UI started at http://localhost:3173
```

```bash
Start-Sleep -Seconds 18
tmux capture-pane -t mycc-serve -p -S -120
```

> Default port is 3173 (`src/slashes/serve.ts`). Pass any free port:
> `--serve 9000`.

---

## Step 2 — Open the page in agent-browser

```bash
agent-browser close --all          # clean slate (ignore errors if none)
agent-browser open http://localhost:3173
```

**Pitfall — first `open` is slow.** The first launch downloads/starts the
Chrome daemon and can exceed a 30-40s bash timeout. If the bash tool times
out, the daemon is *still* coming up — just retry a quick command:

```bash
agent-browser get url              # should print http://localhost:3173/
```

Give it a couple seconds after the timeout before retrying.

---

## Step 3 — Confirm the debug seam is live

```bash
agent-browser eval "typeof window.__myccDebug"
# expect: "object"
```

The seam (`src/web/src/debug.ts`) is registered only under
`import.meta.env.DEV` (which Vite dev mode satisfies). It exposes:

| Method | Effect |
|--------|--------|
| `enable()` / `disable()` | flip `state.debugMode` (shows DebugPanel) |
| `reset()` | clear steeringBuffer / pendingSteeringReview / flags |
| `inject(msg)` | route one synthetic `ChatMessage` through `applyServerMessage` — the **same** dispatch path as the real WS handler |
| `injectSequence(msgs)` | inject many, yielding between each |
| `snapshot()` | read a `DebugSnapshot` of the reactive state |

Because `inject` calls `applyServerMessage` (the single chokepoint), an
injected message exercises the exact same state-transition logic as a live
WS event — no drift. This is what makes the E2E meaningful: it tests the
real dispatch + real Vue reactivity, not a parallel implementation.

---

## Step 4 — Inject a scenario and snapshot state

Batch the setup + both snapshots in one `eval` (deterministic, stateful on
the same seam):

```bash
agent-browser eval "(() => {
  const d = window.__myccDebug;
  d.enable(); d.reset();
  d.inject({type:'steer-echo', content:'note A', steerId:1});
  d.inject({type:'steer-echo', content:'note B', steerId:2});
  const afterEcho = d.snapshot();
  d.inject({type:'prompt', content:''});
  const afterPrompt = d.snapshot();
  return JSON.stringify({afterEcho, afterPrompt});
})()"
```

Expected:
- `afterEcho`: `steeringBuffer` = [1,2], `pendingSteeringReview` = [].
- `afterPrompt`: notes moved to `pendingSteeringReview` = [1,2], buffer
  empty, `isWaiting` = true.

---

## Step 5 — Verify the component actually rendered

State is necessary but not sufficient — confirm the DOM shows the card:

```bash
agent-browser get text "body"
```

For the steering review card you should see the "继续…" prompt, each note
with a `×` chip, and the 发送为查询 / 全部丢弃 buttons.

For interactive-element refs (needed before clicking):

```bash
agent-browser snapshot -i
```

Output gives `@eN` refs:

```
- button "发送为查询" [ref=e7]
- button "全部丢弃"   [ref=e8]
- button "×"          [ref=e5]
```

> **Refs invalidate on every state change.** After any click that mutates
> the DOM, re-`snapshot -i` before the next click.

---

## Step 6 — Capture outgoing WebSocket frames

To verify the *boomerang* API end-to-end, hook `WebSocket.prototype.send`
so each outgoing frame is recorded, then drive the UI and read the
captures back:

```bash
# Install the capture hook
agent-browser eval "(() => {
  window.__capturedSends = [];
  const orig = WebSocket.prototype.send;
  WebSocket.prototype.send = function(d){
    try { window.__capturedSends.push(d); } catch(e){}
    return orig.apply(this, arguments);
  };
  return 'ws send hooked';
})()"
```

---

## Step 7 — Drive the UI and assert on the frame

### Quoting pitfall (PowerShell)

`@e7` passed *unquoted* through pwsh gets mis-parsed and `agent-browser`
receives no selector (`Missing arguments for: click`). **Always quote refs
in the click command:**

```bash
agent-browser click "@e7"     # CORRECT
agent-browser click @e7       # WRONG (pwsh eats the @ref)
```

### Send-as-query

```bash
agent-browser click "@e7"                      # 发送为查询
Start-Sleep -Seconds 1
agent-browser eval "JSON.stringify(window.__capturedSends)"
```

Expect: `[{"type":"steer-resolve","sendIds":[1,2]}]` — the positive
boomerang: declare which ids to SEND; the rest are implicitly discarded.
The backend drains the whole queue atomically on this one message.

### Discard-all

Re-inject first (refs/state are stale), re-snapshot, then:

```bash
agent-browser click "@e8"                      # 全部丢弃
agent-browser eval "JSON.stringify(window.__capturedSends)"
```

Expect: `[{"type":"steer-resolve","sendIds":[]}]` — empty selection =
drain without submitting.

### Per-note × (local unselect)

```bash
agent-browser click "@e5"                      # × on one note (others remain)
agent-browser eval "JSON.stringify(window.__capturedSends)"
```

Expect: **no** `steer-resolve` frame (only unrelated traffic). Per-note `×`
is a *local* unselect from `pendingSteeringReview`; the authoritative
queue drain fires on the commit actions (send / discard-all / last-note
unselect). This is by design — sending a resolve per × would drain the
backend queue prematurely.

### Last-note unselect (auto-resolve)

After discarding down to one note, clicking its `×` empties
`pendingSteeringReview` and auto-fires `resolveSteering([])`:

```bash
agent-browser click "@e5"                      # the last remaining ×
agent-browser eval "JSON.stringify({sends: window.__capturedSends, snap: window.__myccDebug.snapshot()})"
```

Expect: `[{"type":"steer-resolve","sendIds":[]}]` and an empty
`pendingSteeringReview`.

---

## Step 8 — Verify state after each action

```bash
agent-browser eval "JSON.stringify(window.__myccDebug.snapshot())"
```

After any resolve, both `steeringBuffer` and `pendingSteeringReview`
should be empty (the card hides). `isWaiting` may stay true if the prompt
was synthetic — the real backend would send the next prompt/running
transition; that's expected and not a bug.

---

## Step 9 — Clean up

```bash
agent-browser close --all
tmux send-keys -t mycc-serve Escape       # break out of serve mode
Start-Sleep -Seconds 2
tmux send-keys -t mycc-serve "exit" Enter
Start-Sleep -Seconds 2
tmux kill-session -t mycc-serve
Remove-Item serve-boot.log -Force -ErrorAction SilentlyContinue
```

---

## The verified boomerang matrix

| UI action | WS frame emitted | State after |
|-----------|------------------|-------------|
| 发送为查询 (all notes) | `steer-resolve [1,2]` | card cleared |
| 全部丢弃 | `steer-resolve []` | card cleared |
| × (note, others remain) | none (local unselect) | that note removed from card |
| × (last note) | `steer-resolve []` (auto) | card cleared |

This is the contract the unit tests in `src/tests/web/message-dispatch.test.ts`
and `src/tests/serve/steering-queue.test.ts` assert *logically*; this E2E
asserts it through the real Vue render + real `chatApi.resolveSteering` →
`ws.send` path.

---

## When to use this vs. the Vitest suite

- **Vitest (node, fast, CI)**: covers `applyServerMessage` state
  transitions and `steering-queue.ts` boomerang semantics
  deterministically. Run first, on every change.
- **This E2E (browser, slow, manual)**: covers the layer Vitest can't —
  that the Vue *components* actually render the card, that `@click`
  handlers wire to `chatApi.resolveSteering`, and that the real
  `WebSocket.send` carries the expected `steer-resolve` frame. Run when
  the component wiring or `chatApi` changes, or before shipping a
  steering/card feature.

---

## Troubleshooting

- **`agent-browser open` times out on first call**: the Chrome daemon is
  still starting. Retry `agent-browser get url` after a few seconds.
- **`Missing arguments for: click`**: you passed `@e7` unquoted through
  pwsh. Quote it: `click "@e7"`.
- **Click hits the wrong element**: refs changed since your last
  snapshot. Re-run `snapshot -i` and use the fresh ref.
- **`typeof window.__myccDebug` is `"undefined"`**: the page is not in
  Vite dev mode (the seam is DEV-only). You must hit the live `/serve`
  URL, not a built/static bundle.
- **No `steer-resolve` frame after ×**: expected — per-note × is
  local-only. Only send/discard-all/last-unselect emit the frame.