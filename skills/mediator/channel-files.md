# Channel Files: Schema, Authoring & Connection Modes

> Sub-reference of the `mediator` skill. Loaded on demand via `read_file`.
> The entry point is `SKILL.md`.

## Channel File Schema (`ChannelFile`)

A channel is a **pair** of files with the same `channelId` suffix, one per
participant. The mediator creates BOTH files. When a lead boots (or on its
5s channel poll), it auto-joins any channel file bearing its own session-id
prefix, and — if the file has a `firstQuery` — **delivers that firstQuery to its
OWN mailbox** as the conversation starter. This is how a mediator "kicks off"
an instance into a workflow without telling it anything interactively.

```json
{
  "channelId": "feature-x",
  "ownerSessionId": "a3c83bbd-...",
  "peerSessionId": "b7f2c1e0-...",
  "title": "Build feature X together",
  "firstQuery": "You are the backend instance. The frontend instance will mail you API requirements via this channel. Reply to mail using the mycc-mail CLI via the bash tool: mycc-mail b7f2c1e0-... --title \"reply: <topic>\" --content \"<body>\". Do NOT write prose replies, and do NOT use mail_to for cross-instance replies.",
  "joined": false,
  "firstQuerySent": false,
  "createdAt": 1786079578000
}
```
File path: `~/.mycc-store/discovery/channels/<ownerSessionId>-<channelId>.json`

You create **two** such files (one per participant), differing only in
`ownerSessionId` (each points to itself) and `peerSessionId` (each points to
the other). The `channelId`, `title`, and `firstQuery` are shared (or
per-instance in Mode 2 — see below).

## Two Ways to Connect

### Mode 1 — Outside mediator (third party wires A and B)
You are neither A nor B. You author **both** channel files of the pair from
the outside, then step away. Pick a `channelId` (e.g. `feature-x`) and write
two files:

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

Within ~5 seconds each lead's channel poll will auto-join its file and deliver
the `firstQuery` to its own mailbox — both instances begin their roles with
zero interactive input.

### Mode 2 — You are one endpoint (self + peer)
You (the current instance) want to connect to a peer instance directly. The
split of `firstQuery` is asymmetric and intentional:

- **The peer's channel file** carries **your message to the peer** — the
  kickoff/instruction you want the peer to act on. When the peer's 5s poll
  auto-joins its file, this `firstQuery` is delivered to the **peer's** mailbox,
  starting the peer's role.
- **Your own channel file** carries a **self-kickoff** — a generated message
  telling you whom you connected to and to reply via `mycc-mail`. When your own
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
  "firstQuery": "<YOUR instruction to the peer — its role + the mycc-mail <selfSession> --title \"...\" --content \"...\" reply contract (run via bash)>",
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
  "firstQuery": "Connected to peer <peerSession> on channel feature-x (topic: \"feature-x\"). Reply to this peer via the mycc-mail CLI run through the bash tool: mycc-mail <peerSession> --title \"feature-x:<subject>\" --content \"<body>\". Do NOT reply by writing prose in the conversation, and do NOT use mail_to (it is intra-session only).",
  "joined": false,
  "firstQuerySent": false,
  "createdAt": <Date.now()>
}
```

Within ~5s your own poll joins your file (delivering the self-kickoff to your
mailbox) and the peer's poll joins its file (delivering your instruction to the
peer's mailbox). From there, both sides reply peer-to-peer via `mycc-mail`
(run through the `bash` tool).

> **Why a self-kickoff?** Without it, joining your own channel file delivers
> nothing to your mailbox, so your instance sits idle waiting for the peer to
> speak first. The self-kickoff primes your loop with the peer's identity and
> the reply contract, so you can act immediately (e.g. send the first real
> `mycc-mail` to the peer). The peer, meanwhile, gets its role from *your*
> message on the peer's file.

Use Mode 2 when you want to **reach out to a peer from your own running
instance** without an external mediator — e.g. ad-hoc collaboration, asking a
peer in another workdir to review your change, or starting a two-instance
pipeline where you are the first stage.

## Channel File Authoring Details

- **`joined` and `firstQuerySent` MUST be `false`** when the mediator creates
  the files. The lead sets them to `true` itself on join. If you pre-set them,
  the instance skips its own join and the firstQuery is never delivered.
- **Reading the file back and finding `joined`/`firstQuerySent` already `true`
  is NOT an error — it is the success signal.** The 5s channel poll can fire
  *within seconds* of you writing the file, auto-join it, flip both flags to
  `true`, and deliver the `firstQuery` to the owner's mailbox. So a read-back
  that shows `true` means the poll already picked the file up — the wiring
  worked, the instances have begun their roles. Do NOT treat this as "I wrote
  the wrong booleans" or "the file got corrupted"; the only thing that would
  be wrong is if YOU authored the file with `true` (the poll would then skip
  the join). To disambiguate: you wrote `false` (use a structured file-write
  tool so you know the exact bytes) → a later read shows `true` → the poll did
  it → success. Distinguish "what I authored" from "what the poll mutated."
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
  prefer letting the instances use the `mycc-mail` CLI (which reads the
  mailbox path from `identity.json`) rather than hand-appending.

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
Reply to mail using mycc-mail <sessionB> --title "reply: <topic>" --content "<body>" (via bash). Do NOT write prose.'

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