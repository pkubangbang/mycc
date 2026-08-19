# Mail Discipline: Fire-and-Forget, Reply Contracts & Recipient Rules

> Sub-reference of the `mediator` skill. Loaded on demand via `read_file`.
> The entry point is `SKILL.md`.

## Two Mail Channels — `mail_to` (intra-session) vs `mycc-mail` (cross-session)

mycc has TWO mail channels, and the distinction is enforced by the tools:

- **`mail_to` tool** — **intra-session only.** Routes to `lead` or a live
  teammate name within the CURRENT mycc instance. Any slash-bearing name
  (e.g. `<session-id>/lead`) is REJECTED with an error pointing to the
  `mycc-mail` CLI. Use this for lead↔teammate communication inside one
  instance.
- **`mycc-mail` CLI** — **cross-instance / external.** A standalone global
  bin (`scripts/mycc-mail/mycc-mail.js`, on PATH after `npm link`) that
  appends a JSONL line to a REMOTE lead's mailbox. It looks up the target's
  mailbox path from `~/.mycc-store/discovery/identity.json` by session-id.
  Use this from a mediator script, a cronjob, or from inside an agent via
  the `bash` tool when the agent itself needs to reply to a peer.

### How an agent sends cross-instance mail (the reply contract)

An agent (a mycc lead) replies to a peer by running the `mycc-mail` CLI via
the `bash` tool — NOT via `mail_to`:

```
bash command: mycc-mail <peerSessionId> --title "reply: <topic>" --content "<body>"
bash intent:  RUN SYSTEM TO deliver cross-instance mail to peer <peerSessionId>
```

The peer's session-id comes from the `[MAIL]` note's `from` field (it is the
`<session-id>/lead` identity string) or from the `peers` tool. `mycc-mail`
discovers the peer's mailbox path from `identity.json` and appends the mail;
the peer's next COLLECT injects it as a `[MAIL]` note automatically.

> **Why a CLI and not `mail_to`?** `mail_to` runs inside the agent process
> and shares its `ctx` (roster, IPC). Cross-instance delivery has no such
> shared context — the target is a separate process, possibly on a separate
> working directory, possibly not even an agent (a cronjob target). A
> standalone CLI that reads the on-disk `identity.json` registry is the
> clean boundary: the agent invokes it via `bash`, the CLI does the file
> append, and the target lead's existing COLLECT machinery picks it up.

## Bake the Reply Discipline into firstQuery

A `firstQuery` should state the reply contract explicitly so the instance
replies correctly on turn one. Put this in every `firstQuery`:
```
Reply to peer mail using the mycc-mail CLI via the bash tool:
  mycc-mail <peerSessionId> --title "reply: <topic>" --content "<body>"
Do NOT reply by writing prose in the conversation — that stays in your
letterbox and never reaches the peer. Do NOT use mail_to for cross-instance
replies (it rejects slash-bearing names). The peer's session-id is <peerSessionId>.
```

## Waiting for Peer Replies (You Don't Need To Poll)

A common mistake when mediating is to **busy-wait for the peer's reply** —
e.g. a shell loop of `sleep N; cat unread-lead.jsonl` (PowerShell:
`Start-Sleep -Seconds N; Get-Content unread-lead.jsonl`) to "see when the
reply arrives." **This is unnecessary and wrong.** mycc's mail is
**event-driven and pushed into your context automatically**; you do not
pull it.

### The mechanism (verified in source)

- **Appending mail (the sender's side):** the `mycc-mail` CLI appends a
  single JSONL line to the recipient's unread mailbox (`unread-lead.jsonl`)
  — `scripts/mycc-mail/mycc-mail.js` `appendMailToPath` mirrors the format
  in `src/peer/channel.ts:83` (`fs.appendFileSync(mailboxPath, ...)`). The
  line is `{"id","from","title","content","timestamp"}` + newline.
- **Injecting mail (the recipient's side):** on the recipient lead's **next
  COLLECT state**, the unread mailbox is drained and each mail is injected
  into the triologue as a `[MAIL]` note automatically:
  - `src/loop/states/collect.ts:137` — `const mails = ctx.mail.collectMails();`
  - `src/loop/states/collect.ts:147` — `triologue.note('MAIL', mailContent);`
  - The drain is race-safe and truncating: `src/context/shared/mail.ts:133-178`
    `collectMails()` atomically renames `unread-lead.jsonl` → temp, reads it,
    appends to the `readmail-*` backlog, and returns the mails. So mail is
    consumed exactly once — the next COLLECT picks up whatever was appended
    since the last COLLECT.
- Corroborated by `src/context/teammate-worker.ts:185`: mail "lands in the
  lead's triologue as a `[MAIL]` note at the next COLLECT."

### The correct pattern: fire-and-forget

After you wire the channel pair (or after you send a `mycc-mail` to a peer),
**do not poll the mailbox.** Just **yield your turn** — finish your current
tool calls and return to PROMPT (or continue with other work). The peer's
reply will arrive as a `[MAIL]` note in a future round, automatically, the
moment your agent loop next reaches COLLECT. There is nothing for you to read
or wait for.

### Why busy-polling is the wrong mental model

The triologue / agent loop **already has a mail-injection step** (COLLECT step
2). Polling the mailbox with a `sleep` + `cat unread-lead.jsonl` loop
(PowerShell: `Start-Sleep` + `Get-Content`) duplicates that step incorrectly
and breaks in several ways:

- **It blocks your turn** — a `sleep` loop holds the agent in a single
  tool call, preventing the state machine from reaching COLLECT (where mail
  would actually be injected). You can busy-wait forever and never see the
  mail, because the mail only surfaces *at COLLECT*, which your loop is
  blocking from running.
- **It races the COLLECT injection** — if you read `unread-lead.jsonl` you may
  see the line before COLLECT consumes it, but reading it does NOT inject it
  into your context (only `triologue.note('MAIL', ...)` does). You'd see raw
  JSONL in a tool result, not a `[MAIL]` note — and then COLLECT may rename
  the file out from under you (`collectMails` does an atomic rename).
- **It wastes cycles** — the peer may take seconds or minutes; a tight poll
  burns tokens and attention on nothing.

In short: **the agent loop is the mail consumer. Step out of its way.**
Fire the kickoff / `mycc-mail`, then end your turn. The reply comes to you.

## Recipient Rules

- **Cross-instance peer mail** MUST use the `mycc-mail` CLI:
  `mycc-mail <session-id> --title "..." --content "..."` (run via `bash`).
  Discover the target session-id with the `peers` tool or `mycc-mail --list`.
  `mycc-mail` warns (but still delivers) if the target's heartbeat is stale;
  verify the peer is online with `peers()` first to avoid orphaned mail.
- **`mail_to` is intra-session only.** It accepts `lead` or a live teammate
  name (no `/`). Any slash-bearing name (`<session-id>/lead`) is rejected
  with an error pointing to the `mycc-mail` CLI. Mailing a non-existent
  teammate is also rejected up front.
- For **local mail** (lead↔teammate within one instance) use `mail_to` with
  `lead` or a live teammate name.

> **Channel vs. direct peer mail.** A channel's `firstQuery` is a one-shot
> conversation starter delivered to the local mailbox. After that, the two
> instances exchange mail via `mycc-mail <session-id> ...` (run via `bash`),
> which appends directly to the remote mailbox — it does NOT go through the
> channel file. The channel file's job is **discovery + kickoff**; ongoing
> traffic is peer mail. So the `channelId`/`title` mostly matter for the
> initial `firstQuery` framing.