# Mail Discipline: Fire-and-Forget, Reply Contracts & Recipient Rules

> Sub-reference of the `mediator` skill. Loaded on demand via `read_file`.
> The entry point is `SKILL.md`.

## Bake the Reply Discipline into firstQuery

The system already nudges instances (via the todo/peer-channels nudge) to
reply via `mail_to(name="<peerSessionId>/lead", ...)`. But a firstQuery should
also state the contract explicitly so the instance replies correctly on turn
one, before any nudge fires. Put this in every `firstQuery`:
```
Reply to peer mail using mail_to with the peer identity:
  mail_to(name="<peerSessionId>/lead", title="...", content="...")
Do NOT reply by writing prose in the conversation — that stays in your
letterbox and never reaches the peer. The peer's session-id is <peerSessionId>.
```

## Waiting for Peer Replies (You Don't Need To Poll)

A common mistake when mediating is to **busy-wait for the peer's reply** —
e.g. a shell loop of `sleep N; cat unread-lead.jsonl` (PowerShell:
`Start-Sleep -Seconds N; Get-Content unread-lead.jsonl`) to "see when the
reply arrives." **This is unnecessary and wrong.** mycc's mail is
**event-driven and pushed into your context automatically**; you do not
pull it.

### The mechanism (verified in source)

- **Appending mail (the sender's side):** when a peer (or you) calls
  `mail_to(name="<session-id>/lead", ...)`, or when a channel's `firstQuery`
  is delivered on join, a single JSONL line is appended to the recipient's
  unread mailbox (`unread-lead.jsonl`) — `src/peer/channel.ts:83`
  (`fs.appendFileSync(mailboxPath, ...)`) via `appendMailToPath`. The
  `mail_to` peer-routing path is `sendPeerMail` (`src/peer/channel.ts:280-294`).
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

After you wire the channel pair (or after you send a `mail_to` to a peer),
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
Fire the kickoff / `mail_to`, then end your turn. The reply comes to you.

## Recipient Rules (mail_to FAILS FAST)

mail_to now FAILS FAST: it rejects any recipient that isn't `lead`, a valid
`<session-id>/lead` with an ONLINE peer (`isFresh`), or a live teammate in the
roster.

- **Cross-instance peer mail MUST use `name="<session-id>/lead"`** (with the
  `/lead` suffix) and the peer must be online — verify with `peers()` first.
- **A bare session-id (no `/lead`) is rejected up front** with an error naming
  the unrecognized recipient — it no longer silently routes to a nonexistent
  teammate and returns a misleading `OK`.
- Mailing a **stale/offline** peer or a **non-existent teammate** is rejected
  up front with an error naming the unrecognized recipient.
- For **local mail** use `lead` or a live teammate name (no `/`).

> **Channel vs. direct peer mail.** A channel's `firstQuery` is a one-shot
> conversation starter delivered to the local mailbox. After that, the two
> instances exchange mail via `mail_to(name="<session-id>/lead", ...)`, which
> appends directly to the remote mailbox (freshness-gated) — it does NOT go
> through the channel file. The channel file's job is **discovery + kickoff**;
> ongoing traffic is peer mail. So the `channelId`/`title` mostly matter for
> the initial `firstQuery` framing.