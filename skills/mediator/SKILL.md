---
name: mediator
description: >
  Use when the task is to compose MULTIPLE SEPARATE mycc instances (different
  processes, possibly different working directories) into a workflow — NOT
  the lead/teammate child-process team (that is the "coordination" skill).
  A mediator is an outside orchestrator: it is NOT itself a mycc agent but a
  process/script/operator that wires instances together by writing channel
  files, seeding first queries, and routing mail. Covers the cross-instance
  peer-discovery model (identity.json + heartbeats + channels), how to
  discover online instances with the peers tool, how to author channel
  files to connect two instances, the firstQuery seeding mechanism, and
  the reply discipline (instances reply via mail_to with the peer identity
  "<session-id>/lead", NOT by writing prose). Use when the user asks to
  "connect two mycc instances", "make these two agents talk", "set up a
  multi-instance pipeline/workflow", or "act as a mediator".
keywords: ["cross-instance", "multi-instance", "channel files", "channel file pair", firstQuery, "wire instances", "connect mycc instances", "two mycc instances", "peer discovery", mediator, "mail_to peer", "session-id routing", "headless peer", identity, heartbeat]
---

# Mediator: Composing Multiple mycc Instances into a Workflow

## Overview

This skill describes how to act as a **mediator** — an outside orchestrator that
wires **multiple separate mycc instances** into a coordinated workflow. It is the
cross-instance counterpart to the `coordination` skill (which orchestrates the
lead + child-process teammates inside ONE instance).

```
coordination skill  →  ONE mycc instance, lead + teammates (child processes)
mediator skill      →  MANY mycc instances, each its own process, wired together
```

A mediator is NOT a mycc agent. It is whatever writes the channel files and
routes the first messages: a shell script, a human operator, or one of the
instances acting as a broker for the others. The key insight: **instances never
need to be modified to join a workflow** — you connect them purely by creating
files on disk (channel files) and letting the existing peer-discovery + mail
machinery do the rest.

## When to Use This Skill

Use a mediator when you need **separate mycc instances** (not child teammates)
to collaborate:
- The instances run in **different working directories** (different repos, or
  different worktrees of the same repo).
- You want **process isolation** between agents (separate LLM contexts, separate
  sessions, independent ESC/interrupt behavior).
- You are orchestrating from the **outside** (a script/operator) rather than
  from within one agent's loop.

Do NOT use this skill when:
- A single instance can do the work → just do it.
- The "agents" can be child teammates of one lead → use the `coordination`
  skill (in-process team mode). Child teammates share the lead's session and
  are far cheaper to coordinate than cross-instance channels.

## The Cross-Instance Model (How It Actually Works)

Three on-disk mechanisms under `~/.mycc-store/discovery/` make cross-instance
messaging possible. You do not implement these — they already run inside every
mycc lead. You only need to **author channel files** (mechanism 3) and the rest
is automatic.

### 1. Identity Registry — `identity.json`
Every mycc lead registers itself at startup in
`~/.mycc-store/discovery/identity.json`, a session-keyed map:
```json
{
  "a3c83bbd-...": { "sessionId": "a3c83bbd-...", "workDir": "C:\\Proj\\mycc",
                    "mailbox": "C:\\Proj\\mycc\\.mycc\\sessions\\a3c83bbd-...\\unread-lead.jsonl",
                    "startedAt": 1786079578000 }
}
```
The `mailbox` path is the lead's **unread mail JSONL file** — the inbox. Any
line appended here is picked up by the lead's COLLECT state on its next loop
and injected as a `[MAIL]` note.

### 2. Heartbeats — `heartbeat/<session-id>.json`
Each lead writes a rolling heartbeat (last 3 timestamps, every 30s). An
instance is considered **fresh (online)** iff its latest heartbeat is newer
than the local oldest heartbeat. Mail to a stale peer is silently dropped
(the freshness gate). So: **only wire up instances that are actually running.**

### 3. Channel Files — `channels/<session-id>-<channel-id>.json`  ← THE MEDIATOR WRITES THESE
A channel is a **pair** of files with the same `channelId` suffix, one per
participant. The mediator creates BOTH files. When a lead boots (or on its
5s channel poll), it auto-joins any channel file bearing its own session-id
prefix, and — if the file has a `firstQuery` — **delivers that firstQuery to its
OWN mailbox** as the conversation starter. This is how a mediator "kicks off"
an instance into a workflow without telling it anything interactively.

**Channel file schema (`ChannelFile`):**
```json
{
  "channelId": "feature-x",
  "ownerSessionId": "a3c83bbd-...",
  "peerSessionId": "b7f2c1e0-...",
  "title": "Build feature X together",
  "firstQuery": "You are the backend instance. The frontend instance will mail you API requirements via this channel. Reply to mail using mail_to(name=\"b7f2c1e0-.../lead\", ...). Do NOT write prose replies.",
  "joined": false,
  "firstQuerySent": false,
  "createdAt": 1786079578000
}
```
File path: `~/.mycc-store/discovery/channels/<ownerSessionId>-<channelId>.json`

You create **two** such files (one per participant), differing only in
`ownerSessionId` (each points to itself) and `peerSessionId` (each points to
the other). The `channelId`, `title`, and `firstQuery` are shared.

## The Mediator Workflow

### Step 1 — Discover online instances
Use the `peers` tool (lead-only) to list online mycc instances and their
session-ids:
```
peers()
```
Output gives each instance's `session-id` and `workDir`. Note the session-ids
of the instances you want to connect. (If you are a human operator, you can
also read `~/.mycc-store/discovery/identity.json` directly.)

### Step 2 — Create the channel file pair
For two instances A (`sessionA`) and B (`sessionB`), pick a `channelId`
(e.g. `feature-x`) and write two files:

File 1: `~/.mycc-store/discovery/channels/<sessionA>-feature-x.json`
```json
{
  "channelId": "feature-x",
  "ownerSessionId": "<sessionA>",
  "peerSessionId": "<sessionB>",
  "title": "Build feature X together",
  "firstQuery": "<the message that starts instance A's role in the workflow>",
  "joined": false,
  "firstQuerySent": false,
  "createdAt": <Date.now()>
}
```
File 2: `~/.mycc-store/discovery/channels/<sessionB>-feature-x.json`
```json
{
  "channelId": "feature-x",
  "ownerSessionId": "<sessionB>",
  "peerSessionId": "<sessionA>",
  "title": "Build feature X together",
  "firstQuery": "<the message that starts instance B's role in the workflow>",
  "joined": false,
  "firstQuerySent": false,
  "createdAt": <Date.now()>
}
```

That is the entire wiring. Within ~5 seconds each lead's channel poll will
auto-join its file and deliver the `firstQuery` to its own mailbox — both
instances now begin their roles with zero interactive input.

### Step 3 — Bake the reply discipline into firstQuery
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

### Step 4 — Let them talk; monitor from the outside
Once wired, the instances mail each other directly via `mail_to` with the
`<session-id>/lead` identity (the peer routing path, not the channel API — see
below). The mediator does NOT relay messages; it only set up the channel. To
monitor, read the session transcript files in each instance's
`.mycc/sessions/<session-id>/triologue-lead-*.jsonl`, or use `peers()` to check
who is still online.

> **Channel vs. direct peer mail.** A channel's `firstQuery` is a one-shot
> conversation starter delivered to the local mailbox. After that, the two
> instances exchange mail via `mail_to(name="<session-id>/lead", ...)`, which
> appends directly to the remote mailbox (freshness-gated) — it does NOT go
> through the channel file. The channel file's job is **discovery + kickoff**;
> ongoing traffic is peer mail. So the `channelId`/`title` mostly matter for
> the initial `firstQuery` framing.

## Two Ways to Connect

The mediator model above assumes a **pure outside orchestrator** that wires up
two *other* instances. There is a second, equally valid mode: **you yourself
are one end of the channel.** The current mycc instance (the one you are
talking to) is one participant, and a *peer* instance is the other.

### Mode 1 — Outside mediator (third party wires A and B)
You are neither A nor B. You author **both** channel files of the pair from
the outside, then step away. This is the workflow described in "The Mediator
Workflow" above and applies when a script/operator composes instances it does
not belong to.

### Mode 2 — You are one endpoint (self + peer)
You (the current instance) want to connect to a peer instance directly. Here
you author the channel files from inside your own session — but the split of
`firstQuery` is asymmetric and intentional:

- **The peer's channel file** carries **your message to the peer** — the
  kickoff/instruction you want the peer to act on. When the peer's 5s poll
  auto-joins its file, this `firstQuery` is delivered to the **peer's** mailbox,
  starting the peer's role.
- **Your own channel file** carries a **self-kickoff** — a generated message
  telling you whom you connected to and to reply via `mail_to`. When your own
  poll auto-joins your file, this `firstQuery` is delivered to **your** mailbox,
  starting your side.

Both files share the same `channelId` and `title`; they differ only in
`ownerSessionId`/`peerSessionId` (mirrored) and in `firstQuery` (peer's file =
your instruction to the peer; your file = the self-kickoff). The key point:
**`firstQuery` is always delivered to the mailbox of the file's *owner***, so
put the peer's instruction on the peer's file and your self-kickoff on yours.

Concretely, to connect yourself (`<selfSession>`) to a peer (`<peerSession>`)
on topic `feature-x`:

File 1 (the peer's file — carries your instruction to the peer):
`~/.mycc-store/discovery/channels/<peerSession>-feature-x.json`
```json
{
  "channelId": "feature-x",
  "ownerSessionId": "<peerSession>",
  "peerSessionId": "<selfSession>",
  "title": "feature-x",
  "firstQuery": "<YOUR instruction to the peer — its role + the mail_to(<selfSession>/lead, ...) reply contract>",
  "joined": false,
  "firstQuerySent": false,
  "createdAt": <Date.now()>
}
```

File 2 (your own file — carries your self-kickoff):
`~/.mycc-store/discovery/channels/<selfSession>-feature-x.json`
```json
{
  "channelId": "feature-x",
  "ownerSessionId": "<selfSession>",
  "peerSessionId": "<peerSession>",
  "title": "feature-x",
  "firstQuery": "Connected to peer <peerSession> on channel feature-x (topic: \"feature-x\"). Reply to this peer via mail_to(name=\"<peerSession>/lead\", title=\"feature-x:<subject>\", content=\"...\"). Do NOT reply by writing prose in the conversation.",
  "joined": false,
  "firstQuerySent": false,
  "createdAt": <Date.now()>
}
```

Within ~5s your own poll joins your file (delivering the self-kickoff to your
mailbox) and the peer's poll joins its file (delivering your instruction to the
peer's mailbox). From there, both sides reply peer-to-peer via `mail_to`.

> **Why a self-kickoff?** Without it, joining your own channel file delivers
> nothing to your mailbox, so your instance sits idle waiting for the peer to
> speak first. The self-kickoff primes your loop with the peer's identity and
> the reply contract, so you can act immediately (e.g. send the first real
> `mail_to` to the peer). The peer, meanwhile, gets its role from *your*
> message on the peer's file.

Use Mode 2 when you want to **reach out to a peer from your own running
instance** without an external mediator — e.g. ad-hoc collaboration, asking a
peer in another workdir to review your change, or starting a two-instance
pipeline where you are the first stage.

## Workflow Patterns (Cross-Instance)

These mirror the `coordination` skill's patterns but at instance granularity.
The mediator's lever is the **firstQuery** each instance receives — that
message defines the instance's role, its peer, and the reply contract.

### Pipeline (A → B → C)
Three instances in sequence. The mediator creates two channel pairs:
- Pair `stage1`: A (owner) ↔ B (peer). A's firstQuery = "produce the design
  artifact; when done, mail it to B via mail_to(name=\"<sessionB>/lead\", ...)."
- Pair `stage2`: B (owner) ↔ C (peer). B's firstQuery = "wait for the design
  from A; implement it; when done, mail the code to C via
  mail_to(name=\"<sessionC>/lead\", ...)."
- Pair `stage3`: C (owner) ↔ A (peer). C's firstQuery = "wait for the code
  from B; test it; mail the test report back to A."
Each instance knows only its upstream/downstream peer; the mediator encoded
the chain via the channel pairings.

### Peer Review (A ↔ B)
Two instances review each other's work:
- Pair `review`: A ↔ B. A's firstQuery = "draft the change; mail it to B for
  review; apply B's feedback; mail the final to B." B's firstQuery = "wait for
  A's draft; critique it; mail the critique to A; when A mails the final,
  approve it."
Both instances share one channel pair; each firstQuery assigns the review role.

### Fan-out (A → B, A → C)
One broker instance coordinates several workers — but note the broker is now a
mycc instance, not an outside mediator. The outside mediator creates:
- Pair `broker-b`: A ↔ B. A's firstQuery = "you are the broker; send task X to
  B and task Y to C; collect results." (C is reachable from A via a second pair.)
- Pair `broker-c`: A ↔ C.
The broker instance A uses `mail_to` to both B and C and waits for replies. This
is the cross-instance analogue of Divide-and-Conquer.

## Channel File Authoring Details

- **`joined` and `firstQuerySent` MUST be `false`** when the mediator creates
  the files. The lead sets them to `true` itself on join. If you pre-set them,
  the instance skips its own join and the firstQuery is never delivered.
- **`peerSessionId` must point to the OTHER instance** (the one this file's
  owner will talk to). If left `null`, the 5s poll will try to discover it from a
  sibling file with the same `channelId` suffix — so as long as you create both
  files of the pair, even `peerSessionId: null` works, but setting it explicitly
  is more reliable.
- **The two files of a pair share the same `channelId`** but live under
  different `ownerSessionId` prefixes. The discovery poll matches siblings by
  the `channelId` suffix after the `<session-id>-` prefix.
- **Write atomically** (temp file + rename) to avoid a half-written file being
  picked up by the poll mid-write. In bash/Node: write to `<file>.tmp` then
  rename to `<file>`.
- **Use absolute mailbox paths** if you ever append mail manually; but
  prefer letting the instances use `mail_to` (which reads the mailbox path from
  `identity.json`) rather than hand-appending.

## Launching a Headless Peer for Mediation

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

**Order of operations when wiring a headless peer:**

1. Launch the peer in its working directory: `mycc`.
2. **Verify it is online** before authoring anything:
   ```text
   peers()
   ```
   Confirm the peer's `session-id` appears and its heartbeat is **fresh**.
   Do NOT proceed to step 3 until you see it online — mail to a stale peer
   is silently dropped (freshness gate), and a peer that never registered
   will never join its channel file.
3. **Only then** author the channel file pair (see "The Mediator Workflow"
   and "Two Ways to Connect") using the verified session-ids.
4. Within ~5s the peer's channel poll auto-joins its file and delivers the
   `firstQuery` to its mailbox; both instances begin their roles.

> **`--auto` is not needed** for channel creation: the `firstQuery` is
> delivered by the channel poll, not by auto-prompting. `--auto` only changes
> the lead's own prompt loop (PROMPT→WAIT + auto-replies); it does not affect
> identity/heartbeat/channel-poll. Use it only if you want the peer to run
> its agent loop autonomously without a human at the terminal — but for the
> wiring itself, plain `mycc` suffices.

## Authoring Channel Files Reliably (Hand-Rolled JSON Is a Trap)

The JSON templates above assume "write a file." Hand-rolling the JSON in any
shell is a **trap**: multi-line `firstQuery` strings are easy to mis-escape,
and the wrong encoding/write flag prepends a BOM that corrupts the JSON for
strict parsers (e.g. PowerShell 5.1's `Set-Content -Encoding UTF8` prepends a
UTF-8 BOM `EF BB BF`; bash `>` is fine but you must still get the escaping
right). This is the real blocker when wiring peers from a shell.

**Preferred: use a structured file-write tool** (`write_file` / `edit_file`)
where one is available. It handles UTF-8 (no BOM) and all escaping/atomic
write for you — bypassing shell JSON serialization entirely. If you are
a mycc agent, this is always the right choice.

**When a shell script is unavoidable**, here is the verified pattern in bash
(let the JSON contain REAL newlines in `firstQuery`; a JSON-aware writer like
`jq` escapes them to `\n` for you — do NOT pre-escape as literal `"\n"`, that
double-escapes to `\\n`):

```bash
chanDir="$HOME/.mycc-store/discovery/channels"
mkdir -p "$chanDir"

# Build the channel file with jq. REAL newlines in firstQuery are fine —
# jq escapes them to \n in the output. Do NOT pre-escape as literal "\n".
firstQuery='You are the backend instance.
The frontend instance will mail you API requirements via this channel.
Reply to mail using mail_to(name="<sessionB>/lead", ...). Do NOT write prose.'

tmp=$(mktemp)
jq -n \
  --arg channelId      'feature-x' \
  --arg ownerSessionId '<sessionA>' \
  --arg peerSessionId  '<sessionB>' \
  --arg title          'Build feature X' \
  --arg firstQuery     "$firstQuery" \
  --argjson joined         false \
  --argjson firstQuerySent false \
  --argjson createdAt      "$(date +%s)000" \
  '{channelId:$channelId, ownerSessionId:$ownerSessionId, peerSessionId:$peerSessionId,
    title:$title, firstQuery:$firstQuery, joined:$joined, firstQuerySent:$firstQuerySent,
    createdAt:$createdAt}' > "$tmp"

# Atomic move into place (no half-written file picked up by the 5s poll).
mv "$tmp" "$chanDir/<sessionA>-feature-x.json"

# --- VERIFY: read back and validate before declaring it wired ---
f="$chanDir/<sessionA>-feature-x.json"
jq -e '.joined == false and .firstQuerySent == false' "$f" >/dev/null \
  && echo "OK: $f written + verified" \
  || { echo "FAIL: joined/firstQuerySent must be false" >&2; exit 1; }
```

Key points:
- Use a JSON-aware tool (`jq` in bash; the PowerShell/`ConvertTo-Json`
  equivalent on Windows) so multi-line `firstQuery` with real newlines is
  serialized correctly. You do **not** need to pre-escape newlines yourself.
- Write **UTF-8 with NO BOM**. In bash `>` / `mv` from a temp file is clean; if
  you are on PowerShell, use `[IO.File]::WriteAllText($path, $json,
  [Text.UTF8Encoding]::new($false))` and **never** `Set-Content -Encoding
  UTF8` (it prepends a BOM on Windows PowerShell 5.1). Adapt the write step
  to your detected shell — the structure (build JSON with a real tool →
  write atomically → read back and validate) is the same.
- The `joined`/`firstQuerySent` values are JSON `false` (lowercase) — exactly
  what the lead's channel poll expects.
- **Write atomically** (temp file + `mv`/rename) so a half-written file is
  never picked up by the 5s poll mid-write.
- Write the **peer's** file the same way, with `ownerSessionId`/`peerSessionId`
  mirrored and the peer's `firstQuery`. Then run the VERIFY block on both.

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

## Sanity Checklist Before Declaring the Workflow Wired

- [ ] Peer instance launched via the `mycc` command (not raw `node
      bin/mycc.js`), verified online via `peers()` before writing channel
      files. (`--serve`/`--auto` are not required — identity + heartbeat +
      channel poll run regardless of mode.)
- [ ] Both target instances are **online** (verified with `peers()` or a fresh
      heartbeat in `~/.mycc-store/discovery/heartbeat/<sid>.json`).
- [ ] **Both** channel files of the pair exist, each with the correct
      `ownerSessionId` and `peerSessionId`.
- [ ] Each channel file was **read back and validated** with a JSON-aware
      reader (e.g. `jq -e '.joined == false and .firstQuerySent == false' "$f"`
      in bash) — it parses, and `joined`/`firstQuerySent` are exactly `false`
      (not `true`, not missing). This catches the hand-rolled-JSON trap
      (mis-escaped newlines, a BOM, wrong booleans) before the poll ever runs.
- [ ] `joined` and `firstQuerySent` are `false` in both files.
- [ ] Each `firstQuery` states the instance's role, its peer's session-id, and
      the `mail_to(name="<peer>/lead", ...)` reply contract.
- [ ] The `channelId` is identical across the pair; the files differ only in
      `ownerSessionId`/`peerSessionId` (mirrored) and per-instance `firstQuery`.
- [ ] Within ~5s, each instance's COLLECT state injects its `[MAIL]` firstQuery
      and begins its role. (If not, the instance may not be running or its poll
      is stalled — check the heartbeat.)
- [ ] Peer mail_to uses `name="<session-id>/lead"` (not a bare session-id) and
      the peer is online (`peers()` shows it fresh) — mail_to now FAILS FAST:
      it rejects any recipient that isn't `lead`, a valid `<session-id>/lead`
      with an ONLINE peer, or a live teammate in the roster, instead of
      silently dropping the mail. A bare session-id (no `/lead`) is rejected
      up front with an error naming the unrecognized recipient.

## Pitfalls

- **Wiring a stale instance** — mail to a fresh-offline peer is silently dropped
  (freshness gate). Always verify online status with `peers()` first.
- **Pre-setting `joined:true`** — the instance will skip join and never receive
  its `firstQuery`. Leave it `false`.
- **Forgetting the second file of the pair** — a single channel file with no
  sibling leaves `peerSessionId` undiscovered; the instance joins but cannot
  route replies. Create BOTH files.
- **Expecting the mediator to relay** — after kickoff the instances talk
  peer-to-peer via `mail_to`. The mediator's job is wiring + firstQuery, not
  message brokering.
- **Confusing this with team mode** — if the "agents" can be child teammates of
  one lead, do NOT use cross-instance mediation; use the `coordination` skill
  (cheaper, shared session, no channel files).
- **Reply-by-prose** — without the reply contract in the `firstQuery`, an
  instance may answer mail by writing in its conversation (the letterbox) and
  the peer never receives it. The todo/peer-channels nudge mitigates this, but
  baking the contract into the firstQuery is the reliable fix.
- **Hand-rolled JSON in any shell** — hand-writing the channel JSON is a trap
  in every shell: mis-escaped multi-line `firstQuery`, wrong booleans, or an
  accidental BOM (e.g. PowerShell 5.1 `Set-Content -Encoding UTF8` prepends a
  UTF-8 BOM that breaks strict parsers; bash `>` is BOM-free but still needs
  correct escaping). Use a file-write tool, or a JSON-aware writer + atomic
  move + read-back validate (the bash pattern above uses `jq` + `mktemp` +
  `mv`; adapt the write step to your detected shell — the structure is
  identical). Never hand-concatenate the JSON string.
- **Bare session-id / unknown recipient in mail_to** — mail_to now FAILS
  FAST: it rejects any recipient that isn't `lead`, a valid
  `<session-id>/lead` with an ONLINE peer (`isFresh`), or a live teammate in
  the roster. Using `mail_to(name="<session-id>", ...)` WITHOUT the `/lead`
  suffix, or mailing a stale/offline peer or a non-existent teammate, is
  rejected up front with an error naming the unrecognized recipient — it no
  longer silently routes to a nonexistent teammate and returns a misleading
  `OK`. Cross-instance peer mail MUST use `name="<session-id>/lead"` and the
  peer must be online (verify with `peers()` first); for local mail use `lead`
  or a live teammate name (no `/`).

## Summary

1. A mediator wires **separate mycc instances** (not child teammates) by
   writing **channel file pairs**; the instances' existing peer-discovery +
   mail machinery does the rest.
2. **Two connection modes**: (a) **outside mediator** — a third party authors
   both files for two other instances; (b) **you are one endpoint** — you
   author the pair from your own session, with the peer's file carrying your
   instruction to the peer and your own file carrying a self-kickoff.
3. **Discover** online instances + session-ids with the `peers` tool.
4. **Author two channel files** (one per participant), mirrored, with
   `joined:false`/`firstQuerySent:false` and a per-instance `firstQuery`.
5. Each `firstQuery` defines the instance's **role**, its **peer's session-id**,
   and the **`mail_to(name="<peer>/lead", ...)` reply contract**. A file's
   `firstQuery` is delivered to that file **owner's** mailbox — so in Mode 2,
   put the peer's instruction on the peer's file and your self-kickoff on yours.
6. After kickoff, instances communicate **peer-to-peer via `mail_to`**
   (freshness-gated direct mailbox append) — the mediator does not relay.
7. Use the **coordination** skill for in-process lead+teammate teams; use THIS
   skill only for multi-instance orchestration.