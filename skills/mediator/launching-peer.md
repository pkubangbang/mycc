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

> **Do NOT spawn the Lead entry directly** — neither `node bin/mycc.js` nor
> `node --import tsx/esm src/lead.ts` (or any other direct spawn of `src/lead.ts`
> / the engine entry with non-TTY stdio). The Lead refuses to start outside the
> Coordinator — `main()` in `src/loop/agent-repl.ts` checks `process.send` and
> exits if the Coordinator IPC is absent — so a direct spawn **errors out with**
> `Error: Lead process must be started via Coordinator (mycc command)` (or hangs
> before identity registration), and the instance never appears in `peers()`.
>
> **The exact form that failed in the field** (PR #19 peer-restart episode): the
> agent tried to relaunch peers with
> `node --import tsx ... src/lead.ts --auto`, which trips the guard above. The
> `bin/mycc.js` path is a red herring — `src/lead.ts` is **not** a supported
> entrypoint at all; the coordinator runs `src/index.ts`, which itself sets up
> the parent/child IPC envelope `lead.ts` expects. If you find yourself typing
> `src/lead.ts` (or `--import tsx`), you are on the wrong path — stop and use the
> `mycc` command below.
>
> **Launch peers via the `mycc` command (the Coordinator wrapper) — always.**
> Copy-paste recipes for the cases you will actually hit:
>
> ```bash
> mycc                                   # interactive peer (human at its terminal)
> mycc --auto --skip-healthcheck         # unattended peer (no human; agent-driven)
> mycc --daemon [skill]                  # headless daemon (optionally auto-load a service skill)
> mycc --serve <port>                    # WebUI peer (browser chat; NOT headless mediation)
> mycc --auto --skip-healthcheck --ollama-model <model>   # pin the peer's model
> ```
>
> (`--serve` is for the WebUI, not for headless mediation.)

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
2. **Cannot spawn the Lead entry directly.** Neither `node bin/mycc.js`
   nor `node --import tsx ... src/lead.ts` works — the Lead refuses to start
   outside the Coordinator (no `process.send` → `main()` exits with
   `Error: Lead process must be started via Coordinator (mycc command)`).
   So you must launch the `mycc` *command* (the Coordinator wrapper), not
   the engine entry directly.

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
execute the requested checks/work, and `mail_to` the reply back to you — no
human intervention at the peer's terminal.

**When to use this pattern:**
- You are a mycc agent acting as mediator/broker and need a transient peer to
  verify something (e.g. "can another instance see a built-in skill?") or to
  do a piece of work in another workDir.
- You want process isolation (separate LLM context/session) but do not want to
  occupy an interactive terminal for the peer.

## Launching a Headless Peer that LOADS AN EXISTING SESSION (`--from`)

The `bg_create` recipe above launches a peer with a **fresh, empty** session.
When the user instead asks you to "**create a peer to load session `<id>`**"
(or "spin up a peer from my earlier session", "continue session `<id>` in a
new instance"), the peer must START FROM that session's context rather than
from nothing. The flag for that is **`--from <session-id>`**:

```
bg_create(command="cd C:/Proj/mycc; mycc --auto --skip-healthcheck --from <session-id>")
```

Key facts about `--from` (this is the part the mediator must not get wrong):

- **`--from <id>` is the launcher-level `/load`.** It branches a **BRAND-NEW**
  session (new id, new empty triologue): the LLM re-reads the source session's
  files read-only, regenerates a context summary + DOSQ, and CONTINUES in the
  new session. The source session is **sealed** — never written to again.
  Loading the same source twice yields DIFFERENT new sessions (re-understanding
  is non-deterministic), so the **peer's session-id will NOT be `<id>`** — it
  is a fresh uuid shown in the peer's startup banner. Capture it from
  `peers()` after the peer is online.
- **`--auto` is REQUIRED** for `--from` on a `bg_create` peer, for the same
  reason as the fresh case: with no human, the DOSQ review would otherwise
  block. Under `--auto` the peer **skips the DOSQ review** and seeds a standby
  first query ("summarize the previous session, then stand by"), then runs its
  loop autonomously.
- **`--from` and `--session-id` are mutually exclusive.** `--from` always
  branches a NEW id, so pinning one at the same time is contradictory and is
  rejected at startup. (Only `mycc-compose` uses `--session-id`; it injects
  `--session-id`, so **compose cannot carry a `--from`** — a mediator that
  needs `--from` uses plain `mycc` via `bg_create`, NOT `mycc-compose up`.)
- **Run it from the SOURCE session's project directory.** `--from` verifies
  `process.cwd()` equals the source session's `project_dir` and exits if they
  differ. So the `cd` in the `bg_create` command must be that project dir
  (e.g. `cd C:/Proj/mycc` for a session created there).
- **`--serve --from` also boots headless** (no DOSQ prompt): `--serve` runs the
  same headless boot path as `--auto`/`--daemon` and skips the interactive
  review, so a served peer launched with `--from` does not hang either.

**Full recipe — peer that loads an existing session:**

```
bg_create(command="cd C:/Proj/mycc; mycc --auto --skip-healthcheck --from c588c8c")
```

Then, exactly as in the fresh case:
1. `peers()` → confirm the peer's **new** session-id appears with a fresh
   heartbeat (its id is NOT the `--from` argument — it is the branched uuid).
2. Author the channel file pair (`channel-files.md`) using that new id.
3. The 5s poll delivers the peer's `firstQuery` to its mailbox; being in
   `--auto`, it acts on it and mails back.

> **Do NOT use `mycc-compose` here.** `mycc-compose` pins a session id
> (`--session-id`) to relaunch a peer under the SAME identity — that is a
> *fresh* session with a reused id, NOT a `--from` restore. If the task is
> "load/continue an existing session in a peer", it is `--from`, and the tool
> is `bg_create` + the `mycc` command.

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