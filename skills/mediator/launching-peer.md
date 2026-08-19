# Launching a Headless Peer for Mediation

> Sub-reference of the `mediator` skill. Loaded on demand via `read_file`.
> The entry point is `SKILL.md`.

When you need to bring up a **second** mycc instance purely to wire it into a
cross-instance workflow (no human at its terminal), just launch it the normal
way from its working directory:

```bash
cd /c/Proj/other-workdir   # or: cd C:\Proj\other-workdir  (adapt to your shell)
mycc
```

That is all. A plain `mycc` registers identity, writes heartbeats, and runs
the 5s channel poll **regardless of mode** — `--serve` and `--auto` are NOT
required for channel creation. The peer's `firstQuery` is delivered to its
mailbox by the channel poll, not by any special flag.

> **Do NOT launch a peer via raw `node bin/mycc.js`** (or any direct spawn of
> the engine entry with non-TTY stdio). The Lead refuses to start outside the
> Coordinator — `main()` in `src/loop/agent-repl.ts` checks `process.send` and
> exits if the Coordinator IPC is absent — so a raw `node` spawn either errors
> out or hangs before identity registration, and the instance never appears
> in `peers()`. Always use the `mycc` command (the Coordinator wrapper) for
> peers. (`--serve` is for the WebUI, not for headless mediation.)

## Order of operations when wiring a headless peer

1. Launch the peer in its working directory: `mycc`.
2. **Verify it is online** before authoring anything:
   ```text
   peers()
   ```
   Confirm the peer's `session-id` appears and its heartbeat is **fresh**.
   Do NOT proceed to step 3 until you see it online — mail to a stale peer
   is silently dropped (freshness gate), and a peer that never registered
   will never join its channel file.
3. **Only then** author the channel file pair (see `channel-files.md`) using
   the verified session-ids.
4. Within ~5s the peer's channel poll auto-joins its file and delivers the
   `firstQuery` to its mailbox; both instances begin their roles.

> **`--auto` is not needed** for channel creation: the `firstQuery` is
> delivered by the channel poll, not by auto-prompting. `--auto` only changes
> the lead's own prompt loop (PROMPT→WAIT + auto-replies); it does not affect
> identity/heartbeat/channel-poll. Use it only if you want the peer to run
> its agent loop autonomously without a human at the terminal — but for the
> wiring itself, plain `mycc` suffices.

## Launching a Headless Peer from INSIDE a mycc Agent (bg_create + --auto)

The section above assumes a **human operator** types `mycc` in another
terminal. But when the mediator is **itself a mycc agent** (you are running
inside a mycc lead and want to bring up a peer programmatically, with no
human at the peer's terminal), you face two constraints:

1. **No interactive terminal for the peer.** The peer must run unattended —
   nobody will type at its `agent >>` prompt. So it must be launched in
   `--auto` mode, which replaces the PROMPT stage with WAIT and auto-replies
   `question()`. Then the channel's `firstQuery` (delivered to its mailbox by
   the 5s poll) becomes its first unit of work, and its agent loop executes
   that work and mails the reply back — all autonomously.
2. **Cannot use raw `node bin/mycc.js`.** The Lead refuses to start outside
   the Coordinator (no `process.send` → `main()` exits). So you must launch
   the `mycc` *command* (the Coordinator wrapper), not the engine entry
   directly.

The solution: use the agent's background-command tool to run the `mycc`
command in the peer's working directory with `--auto` (and `--skip-healthcheck`
for a faster start). In mycc this is `bg_create`:

```
bg_create(command="cd C:/Proj/other-workdir; mycc --auto --skip-healthcheck")
```

Then **verify it is online** before authoring channel files:

```
peers()
```

Confirm the new peer's `session-id` appears with a fresh heartbeat. Only then
author the channel file pair (see `channel-files.md`) and let the 5s poll
deliver the `firstQuery` to the peer's mailbox. Because the peer is in
`--auto`, its loop will pick up the `[MAIL]` firstQuery at its next COLLECT,
execute the requested checks/work, and mail the reply back to you via the
`mycc-mail` CLI (run through `bash`) — no human intervention at the peer's
terminal.

**When to use this pattern:**
- You are a mycc agent acting as mediator/broker and need a transient peer to
  verify something (e.g. "can another instance see a built-in skill?") or to
  do a piece of work in another workDir.
- You want process isolation (separate LLM context/session) but do not want to
  occupy an interactive terminal for the peer.

**Lifecycle:** a `bg_create`-launched peer is a background process you own.
When the verification/work is done, tear it down with `bg_remove(pid)` (the
pid is returned by `bg_create`). Do not leave it running indefinitely — it
holds a node process and an LLM session.

> **Why `--auto` is essential here (unlike the human-operator case):** with a
> human at the terminal, plain `mycc` is fine — the human reads the firstQuery
> and types the response. With no human, plain `mycc` would sit at its PROMPT
> forever after the firstQuery lands in its mailbox (it would never reach
> COLLECT to inject the mail, because PROMPT waits for stdin). `--auto`
> unblocks that by auto-advancing the prompt loop, so the `[MAIL]` firstQuery
> is consumed and acted upon. This is the one mediation scenario where
> `--auto` is required, not optional.