# mycc-compose — spec schema reference

The spec is a single JSON object. All paths are absolute.

## Identity model: names, not session ids

A spec identifies peers by a durable **name** only. A peer's *session id* is
minted FRESH by the peer itself on every boot (`randomUUID()` in
`writeFreshSessionFiles`) and is NEVER authored in, or written back to, the
spec. So a spec file is byte-identical before and after every `mycc-compose up`
— there is no minting, no `sessionId` field, and no write-back.

Identity splits into three independent axes, none of which is the session id:

| Axis | Carried by | Stable across restarts? |
|---|---|---|
| **WHO** | `--name <group>:<peer>` (launcher-injected from `peers[].name`) | YES — the durable handle |
| **CONFIG** | `peers[].args` (validated) | YES (authored) |
| **WHERE** | `peers[].workdir` | YES (authored) |

`mycc-compose` resolves "the currently-running instance of peer X" by scanning
`identity.json` for an entry whose **name** matches AND whose workdir matches,
then requiring it to be RUNNING (fresh heartbeat AND alive recorded pid). The
name is what survives the per-run session-id churn; the resolved sid merely
LOCATES the heartbeat. Name uniqueness is enforced case-insensitively at both
`validateSpec` and register time.

Consequences:

- A spec NEVER carries a `sessionId` (authoring one is a hard validation error).
- Cleanup, status, and delivery all attribute peers BY NAME, so they are
  correct across relaunches even though every boot mints a new sid.
- `--from <sessionId>` is the ONLY context-carrying relaunch — it derives a NEW
  session from an old one (the LLM re-understands the old transcript). Session
  directories are per-run archives; a session id is never reused.

## Top level

```json
{ "group": "pr26", "peers": [ ... ], "channels": [ ... ] }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `group` | string | yes | Non-empty label. Channel-title prefix: `<group>-<label>`. |
| `peers` | array | yes | Non-empty. Members of the group. |
| `channels` | array | yes | May be `[]` (a peer-only group with no links). |

## `peers[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Unique (case-insensitive) label; the key referenced by `channels[].from` / `.to`. Injected as `--name <group>:<peer>` by the launcher. |
| `workdir` | string | yes | **Absolute** path; the peer is launched with this as cwd. Part of the WHERE axis. |
| `args` | string | yes | **Single whitespace-split string** of CLI flags. The model rides here (there is no `model` field). MUST contain `--auto` or `--daemon`. Part of the CONFIG axis. |
| `renew` | `"always"` \| `"onMismatch"` | no | Default `onMismatch`. See below. |
| `remotes` | string[] | no | URLs of **remote** mycc instances this peer should dial once up (cross-machine peer wire). Each is a `host:port` endpoint — an explicit numeric port is required; an `http(s)://` prefix and a trailing `/` are accepted but the scheme is ignored (the endpoint identity is `host:port` alone, so `http://h:3191` and `https://h:3191` are the SAME endpoint, as are a bare `h:3191`). `ws://`/`wss://` and every other scheme are REJECTED. Paths/query/fragment are rejected. See below. |

> There is **no `sessionId` field**. Declaring one (even `null`) is rejected by
> `validateSpec`: peer identity is `--name`, resolved at runtime.

### `remotes` semantics

`remotes` is the **one-sided** dial declaration for the cross-machine peer wire
(a NAT'd/firewalled peer dials OUT to a reachable serve URL; the dial gives a
bidirectional pipe, so only ONE side declares it). Rules enforced by
`validateSpec` before any mutation:

- Each entry is a non-empty string; it must parse as a `host:port` endpoint
  with an **explicit numeric port** (`http://host` with no port is rejected —
  the runtime `parseWireTarget` needs `host:port` and would silently fail to
  connect).
- `http`/`https` are the only schemes accepted on an authored value; any other
  scheme (e.g. `ws://`, `ftp://`) is rejected. A bare `host:port` (no scheme)
  is accepted.
- No **duplicate** URL within one peer's list (compared by endpoint key).
- No **self-dial**: a loopback host (`localhost`/`127.0.0.1`/`::1`) whose port
  equals THIS peer's explicit `--serve <port>` is rejected (declare the dialer
  on the peer that cannot accept inbound).
- **Cross-peer mutual-dial** is rejected: the SAME endpoint key may appear in
  at most ONE peer's `remotes` list (two peers dialing one endpoint is the
  practical mutual-dial signature for a 2-node spec).

`--name` is launcher-managed; declaring it in `args` is stripped. See
`docs/peers/remotes-design-decision.md` for the direction/dedupe decision.

### `renew` semantics

| Value | During `up` / `sync` |
|---|---|
| `always` | Always stop (if running) and start fresh. |
| `onMismatch` *(default)* | Start only when no *running* peer matches; otherwise leave it running. |

**`match` = same `workdir` AND canonical `args` equal AND the process is
running** (fresh heartbeat AND a live pid), resolved BY NAME. There is no sid
in the comparison — the name is the identity and the runtime sid is ignored.

To renew a peer's context between runs, relaunch with `--from <sessionId>`
carried in `peers[].args`.

## `channels[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | string | yes | A declared `peers[].name`. Directed. |
| `to` | string | yes | A declared `peers[].name`; must differ from `from`. The tool completes the mirror pair. |
| `label` | string | yes | Unique. Becomes the channel **`channelId`** and the filename suffix. Must be safe as a filename *component*: `/`, `\`, `..`, control characters, and the Windows-reserved set `: * ? " < > |` are **rejected** (an unsanitized label escapes the channels directory). Uniqueness is compared case-folded and NFC-normalized, matching the case-insensitive filesystem the files land on. |
| `prompt` | string | yes | `firstQuery` template. Supports `{{from}}`, `{{to}}`, `{{peer}}`, `{{label}}`. |

### Derived naming

- channel **title** = `<group>-<label>`
- channel **filename** = `<ownerSid>-<label>.json` (the owner sid is resolved at
  runtime; the file also carries the DATA-ONLY ownership names below)
- `channelId` = `label` alone

Each channel file additionally records the durable ownership NAMES —
`ownerName` and `peerName` (each `<group>:<peer>`) — written by
`mycc-compose` at materialization time. The runtime (`ChannelManager`) neither
reads nor writes them; they exist so compose can attribute a file to a topology
peer BY NAME for cleanup, without reading any spec sid.

### Cleanup semantics (down)

`mycc-compose down` removes the channel files a spec OWNS, judged by NAME, with
two rules:

- **R1 (name conjunction).** A channel file is OURS iff its `channelId` is one
  of the spec's labels AND its `ownerName` OR `peerName` is in the spec's full
  `<group>:<peer>` name-set. Such a file is deleted.
- **R2 (orphan-only legacy sweep).** A pre-v3 file carries NO ownership names
  (it predates them). Such a file is deleted ONLY when BOTH of its embedded
  session ids are provably DEAD (the `isPeerRunning`-level predicate: not a
  fresh beat with a live pid). If EITHER embedded sid is still live — or cannot
  be established — the file is KEPT and reported: a half-match is NOT deletable
  evidence, it is investigation material. Ambiguity always resolves to keep.

A file whose names are present but none are in the spec's name-set is FOREIGN
and is never touched.

### The reply contract

Each side's `firstQuery` is the template with `{{...}}` substituted, then the
reciprocal reply contract appended **unless the prompt already contains a
`mail_to(` instruction**:

```
[Reply contract] Reply to your peer by calling
mail_to(name="<peerSid>/lead", title="<label>:<subject>", content="<message>").
Do NOT reply with prose — only mail_to reaches the peer.
```

(`<peerSid>` here is the peer's runtime session id discovered at send time — an
addressing token, NOT a spec field.)

## Reload is forbidden on compose peers

A peer launched by `mycc-compose` carries `--name`. Both layers of `/reload`
refuse such an instance: the slash handler returns early, and `reloadLead()`
declines a replayed `--name` argv BEFORE the old Lead is torn down. Reloading
would restart the instance with a fresh sid and orphan its channel files, so it
is disabled here. To renew a compose peer, re-run `mycc-compose up <spec>`.

## Worked examples

### 1. Peer-review pair (A ↔ B)

```json
{
  "group": "review",
  "peers": [
    { "name": "author", "workdir": "/repo/main",
      "args": "--auto --skip-healthcheck --ollama-model glm-5:cloud" },
    { "name": "critic", "workdir": "/repo/main",
      "args": "--auto --skip-healthcheck --ollama-model glm-5:cloud" }
  ],
  "channels": [
    { "from": "author", "to": "critic", "label": "review",
      "prompt": "You are the reviewer. Peer is {{to}}." }
  ]
}
```
`critic` never gets a channel back to `author` unless you add a second entry
`{ "from": "critic", "to": "author", "label": "review-reply" }` — channels are
**directed**; the tool mirrors a given entry into a file pair but does not
auto-create the reverse link's own pair.

### 2. Pipeline (A → B → C)

```json
{
  "group": "pipe",
  "peers": [
    { "name": "fetch",  "workdir": "/repo/a", "args": "--auto --ollama-model glm-5:cloud" },
    { "name": "build",  "workdir": "/repo/b", "args": "--auto --ollama-model glm-5:cloud" },
    { "name": "deploy", "workdir": "/repo/c", "args": "--auto --ollama-model glm-5:cloud" }
  ],
  "channels": [
    { "from": "fetch", "to": "build",  "label": "handoff-1", "prompt": "Send artifacts to {{to}}." },
    { "from": "build", "to": "deploy", "label": "handoff-2", "prompt": "Send build to {{to}}." }
  ]
}
```

### 3. Fan-out (A → B, A → C)

```json
{
  "group": "fan",
  "peers": [
    { "name": "lead", "workdir": "/repo/main", "args": "--auto --ollama-model glm-5:cloud" },
    { "name": "w1",   "workdir": "/repo/w1",   "args": "--auto --ollama-model glm-5:cloud" },
    { "name": "w2",   "workdir": "/repo/w2",   "args": "--auto --ollama-model glm-5:cloud" }
  ],
  "channels": [
    { "from": "lead", "to": "w1", "label": "task-w1", "prompt": "Take task from {{from}}." },
    { "from": "lead", "to": "w2", "label": "task-w2", "prompt": "Take task from {{from}}." }
  ]
}
```

## Validation rules (all enforced before any mutation)

- `group` non-empty; `peers` non-empty; `channels` an array.
- `peers[].name` non-empty and unique (case-insensitive).
- `peers[].workdir` non-empty and **absolute**.
- `peers[].args` is a string and contains `--auto` or `--daemon`.
- `peers[].sessionId` MUST be ABSENT (a present key, even `null`, is rejected).
- `peers[].renew` is `always` or `onMismatch`.
- `channels[].from` / `.to` name declared peers and differ.
- `channels[].label` non-empty and unique across channels.
- `channels[].prompt` is a string (may be empty).

## Migration for existing specs

Delete every `peers[].sessionId` key. Nothing else changes for users: the
launcher now injects `--name <group>:<peer>` in place of `--session-id`, peers
mint their own sids on boot, and channel cleanup/status attribute by name. An
un-migrated store with pre-v3 (nameless) channel files is still cleaned up by
the R2 orphan-only sweep.
