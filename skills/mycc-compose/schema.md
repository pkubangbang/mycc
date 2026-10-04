# mycc-compose — spec schema reference

The spec is a single JSON object. All paths are absolute. Labels (`group`,
`peers[].name`) are for humans and channel naming only — they never enter a
session id.

## Top level

```json
{ "group": "pr26", "peers": [ ... ], "channels": [ ... ] }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `group` | string | yes | Non-empty label. Channel-title prefix: `<group>-<label>`. Never part of a sid. |
| `peers` | array | yes | Non-empty. Members of the group. |
| `channels` | array | yes | May be `[]` (a peer-only group with no links). |

## `peers[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Unique label; the key referenced by `channels[].from` / `.to`. Never part of a sid. |
| `workdir` | string | yes | **Absolute** path; the peer is launched with this as cwd. |
| `args` | string | yes | **Single whitespace-split string** of CLI flags. The model rides here (there is no `model` field). MUST contain `--auto` or `--daemon`. |
| `sessionId` | string \| null | no (defaults to `null`) | `null` means "mint one": the tool creates a UUID and **writes it back in place**, so after the first `up` the field is populated. A UUID pins the id for resume. |
| `renew` | `"always"` \| `"onMismatch"` | no | Default `onMismatch`. See below. |
| `remotes` | string[] | no | URLs of **remote** mycc instances this peer should dial once up (cross-machine peer wire). Each is a `host:port` endpoint — an explicit numeric port is required; an `http(s)://` prefix and a trailing `/` are accepted but the scheme is ignored (the endpoint identity is `host:port` alone, so `http://h:3191` and `https://h:3191` are the SAME endpoint, as are a bare `h:3191`). `ws://`/`wss://` and every other scheme are REJECTED. Paths/query/fragment are rejected. See below. |

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

`--session-id` is launcher-managed; declaring it in `args` is rejected. See
`docs/remotes-design-decision.md` for the direction/dedupe decision.

### `renew` semantics

| Value | During `up` / `sync` |
|---|---|
| `always` | Always stop (if running) and start fresh. |
| `onMismatch` *(default)* | Start only when no *running* peer matches; otherwise leave it running. |

**`match` = same `sessionId` AND same `workdir` AND canonical `args` equal AND
the process is running** (fresh heartbeat AND a live pid). `--session-id` is
launcher-managed and ignored in the comparison, so a pinned peer still
matches a spec that omits it.

## `channels[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | string | yes | A declared `peers[].name`. Directed. |
| `to` | string | yes | A declared `peers[].name`; must differ from `from`. The tool completes the mirror pair. |
| `label` | string | yes | Unique. Becomes the channel **`channelId`** and the filename suffix. Must be safe as a filename *component*: `/`, `\`, `..`, control characters, and the Windows-reserved set `: * ? " < > |` are **rejected** (an unsanitized label escapes the channels directory). Uniqueness is compared case-folded and NFC-normalized, matching the case-insensitive filesystem the files land on. |
| `prompt` | string | yes | `firstQuery` template. Supports `{{from}}`, `{{to}}`, `{{peer}}`, `{{label}}`. |

### Derived naming

- channel **title** = `<group>-<label>`
- channel **filename** = `<uuid>-<label>.json` (conforms to
  `<sessionId>-<channelId>`)
- `channelId` = `label` alone

### The reply contract

Each side's `firstQuery` is the template with `{{...}}` substituted, then the
reciprocal reply contract appended **unless the prompt already contains a
`mail_to(` instruction**:

```
[Reply contract] Reply to your peer by calling
mail_to(name="<peerSid>/lead", title="<label>:<subject>", content="<message>").
Do NOT reply with prose — only mail_to reaches the peer.
```

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
- `peers[].name` non-empty and unique.
- `peers[].workdir` non-empty and **absolute**.
- `peers[].args` is a string and contains `--auto` or `--daemon`.
- `peers[].sessionId` is `null` or a UUID.
- `peers[].renew` is `always` or `onMismatch`.
- `channels[].from` / `.to` name declared peers and differ.
- `channels[].label` non-empty and unique across channels.
- `channels[].prompt` is a string (may be empty).
