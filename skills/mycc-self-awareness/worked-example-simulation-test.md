# Worked Example: Two-Peer Local Simulation Test

> A concrete, end-to-end example of how several mycc concepts **compose** in
> practice — peers, the peer wire (`--debug-wire`), daemons, WebUI, and
> push-based mail — to validate a cross-instance feature locally without
> touching a real remote machine. Read this when you want to understand how
> the collaboration primitives fit together, or when you want to reproduce a
> similar local integration test yourself.

This example is drawn from a real build (the `filesync` cross-machine file
sync feature): a feature that spans **two separate mycc instances** had to be
proven to work over the peer wire. The unit tests used a fake peer and could
not exercise the real wire, so a **local two-daemon simulation** was run from
the agent loop (not a test runner).

## Why this shape

A feature that lives *across* instances needs more than unit tests. The
gaps only real processes expose: the actual WebSocket wire framing, the
announce handshake, and how one agent wakes another. So the test uses **two
real mycc daemons** — each its own instance (own session + workdir) — wired
together over the peer wire, and asserts on **real files on disk**.

## The topology

```
fsA  mycc --daemon --serve 3181 --debug-wire ...   (own workdir + session)
fsB  mycc --daemon --serve 3182 --debug-wire ...   (own workdir + session)
     ↳ wired A↔B over the peer wire (peer_connect each way)
```

Each flag maps to a mycc concept:
- **`--daemon`** — long-lived headless background process (auto mode on, no
  terminal). The agent loop runs continuously, which the test needs.
- **`--serve <port>`** — starts the WebUI/HTTP server. Used here to reach the
  instance (`/health` to read its session id) and to drive it.
- **`--debug-wire`** — the test-only escape hatch that allows `peer_connect`
  to a **same-machine** peer (normally refused as redundant with discovery
  mail). This is what makes a local two-instance wire possible.

Each daemon is a full mycc instance with its own `.mycc/` in its workdir, so
two instances never collide.

## The steps

1. **Boot both daemons** in detached `tmux` sessions (one each) so they run
   headless and persist across the agent's turns. Read each one's session id
   from its `/health` endpoint.

2. **Wire them together** — daemons are LLM agents, so wake each with
   `mycc-mail <sid> --content "peer_connect <other-host:port> now"`. **Mail is
   the reliable wake channel** for a daemon (its 1s poll drains the mailbox
   and acts on it). A raw WebUI `{type:'input'}` frame does *not* reliably
   register when no browser client is connected. Each agent then runs
   `peer_connect`, establishing the wire.

3. **Assert on real files** — perform the action to test on one instance
   (e.g. drop a file into its working area with a known content marker), let
   the feature sync it, then assert the **exact content** materialized on the
   other instance's disk. The assertion is a real-file outcome, not a mock.

4. **Inspect the frame trace** — features that move data over the wire can
   emit an audit log (e.g. `--debug-filesync` writes a `frames-*.jsonl`). Read
   it to confirm the expected handshake sequence and to assert a **bounded
   frame count** (this is how a runaway request-storm bug was caught).

## What a real-process test catches that unit tests can't

- **Wire-boundary bugs** — e.g. data sent in raw form when the receiver
  expects a framed/encoded packet (the receiver silently drops it). A fake
  peer never round-trips the real encoder/decoder.
- **Amplification / storms** — e.g. a request that re-triggers itself (a
  60k-frame echo loop). Only visible as a frame count on a live socket.
- **Wake semantics** — that mail (not a WebUI frame) is what actually rouses
  a headless daemon.

## Method note (the reusable lesson)

When a live two-process test misbehaves, **don't keep re-reading source and
re-guessing hypotheses**. Instead:
1. **Instrument the live path** (temporary logging at the suspected drop
   point) and read what the running process actually reports.
2. **Read the real trace** (the frame audit log) to see the true handshake
   sequence, rather than inferring it.
3. Produce **ground truth in one run**, then fix the named layer.
4. Afterward, **remove the temp instrumentation** and any scratch files so
   the codebase stays clean.

In the real build this ended a long hypothesis loop in a single run and
pinned the last bug precisely.

## Constraint to respect

Never point a local simulation at a **real remote peer that does not have the
feature** — it would send unknown traffic to a machine that can't handle it.
Use local instances only, and reserve real-machine testing for when the
operator confirms the remote is updated. (This mirrors the locality guard
`--debug-wire` relaxes: same-machine is safe and isolated; cross-machine is a
deliberate, operator-authorized act.)
