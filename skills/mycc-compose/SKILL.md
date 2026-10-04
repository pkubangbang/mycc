---
name: mycc-compose
description: >
  Bring up, resume, and manage a GROUP of separate mycc instances from a
  declarative JSON spec — use this when the user asks to "bring up a peer
  group", "launch several mycc instances that talk to each other", "set up a
  reproducible multi-instance team", "resume/restart my peer topology", or
  "wire N mycc instances declaratively". `mycc-compose` is the deterministic,
  no-LLM CLI that materializes the spec: it mints or reuses each peer's
  session id, launches/renews the processes detached, writes BOTH channel
  files per link, and reports status. Re-running `sync` is the resume path
  (cron / `--daemon <skill>` + `service_cron`). This is the AUTOMATION
  counterpart to the `mediator` skill (which describes the same procedure by
  hand): use `mycc-compose` when the group must be reproducible and resumable,
  and the `mediator` skill for one-off/ad-hoc wiring. Do NOT use this for the
  lead/teammate child-process team inside ONE instance — that is the
  `coordination` skill.
keywords: ["mycc-compose", "peer topology", "peer group", "declarative peers", "compose spec", "launch peer group", "resume topology", "restart peers", "multi-instance", "cross-instance", "channel files", "firstQuery", "session-id pin", "--session-id", renew, onMismatch, sync, up, down, status, check, cron resume, service_cron, mediator"]
---

# mycc-compose: Declarative Peer Groups

> **This is a progressive-disclosure skill.** This entry file holds the mental
> model and the decision points. Read the sections you need below, and
> `read_file` the referenced files when you reach the corresponding step.
>
> Sibling references in this skill:
> - `schema.md` — the full spec field reference, the derived-naming rules, and
>   worked examples (peer-review pair, pipeline, fan-out).
> - `script.md` — the `mycc-compose` subcommands, exit codes, and the cron
>   wiring for `sync` (the resume path).

## What it is

`mycc-compose` is a **zero-dependency CLI** (a `bin` next to `mycc`,
`mycc-mail`, `mdcalc`) that reads a **JSON topology spec** describing a group
of mycc peers and materializes it deterministically. No LLM is in the loop —
the script is the entire mechanism, so the group is **reproducible** and
**resumable**.

```json
{
  "group": "pr26",
  "peers": [
    { "name": "leader",   "workdir": "C:/Proj/mycc",
      "args": "--auto --skip-healthcheck --ollama-model glm-5:cloud",
      "sessionId": null, "renew": "onMismatch" },
    { "name": "reviewer", "workdir": "C:/Proj/mycc",
      "args": "--auto --skip-healthcheck --ollama-model deepseek-v4.1-flash:cloud",
      "sessionId": null, "renew": "onMismatch" }
  ],
  "channels": [
    { "from": "leader", "to": "reviewer", "label": "review",
      "prompt": "Peer is {{to}}. Reply via mail_to(name=\"{{to}}/lead\"). No prose replies." }
  ]
}
```

## When to use it

Use `mycc-compose` when the user wants **separate mycc instances** (not child
teammates) to form a group that must **survive a restart**:

- Multiple instances in **different workdirs** (different repos/worktrees).
- **Process isolation** between agents (separate sessions/contexts).
- The group must be **reproducible from a file** and **resumable** by re-running
  a command (cron / daemon), not re-explained in chat.

Do NOT use it when a single instance can do the work, or when the "agents" can
be child teammates of one lead → use the `coordination` skill. For a one-off,
ad-hoc wiring where reproducibility does not matter, the `mediator` skill is
enough.

## The four moving parts

1. **Session-id pinning.** Each peer is launched with `--session-id <uuid>`, so
   a restarted peer comes back under the **same** session id and re-joins its
   channel files (keyed `<sessionId>-<channelId>.json`). A `sessionId: null`
   peer is minted a UUID on first `up` and **written back into the spec in
   place** — the spec is the durable record.
2. **`renew` policy.** `onMismatch` (default): start only when no *running*
   peer matches (same sid + workdir + args + alive). `always`: stop then start
   every time. A "running" peer means **fresh heartbeat AND a live pid** —
   a just-killed peer is not counted (its stale heartbeat must not block a
   restart).
3. **Channel pairs.** One link `A→B` materializes TWO files
   (`<sidA>-<label>.json`, `<sidB>-<label>.json`) with `channelId = label`,
   `title = <group>-<label>`, cross-filled `peerSessionId`, `joined:false` /
   `firstQuerySent:false`. The reply contract is appended automatically if the
   prompt lacks one. The peers' 5s poll auto-joins and delivers `firstQuery`.
4. **Detached launch.** Peers are spawned as `node <bin/mycc.js> --session-id
   <sid> <args…>` with `detached:true, stdio:'ignore'` — never the npm shim
   with a shell (which foregrounds the child on Windows).

## The reply discipline (bake it into `prompt`)

Instances talk **peer-to-peer via `mail_to`**, never prose. Each `prompt`
becomes the peer's `firstQuery`; state the peer's role, its peer's id, and the
reply contract:

```
Reply via mail_to(name="{{to}}/lead", title="{{label}}:<subject>"). Do NOT
reply with prose — only mail_to reaches the peer.
```

Templates support `{{from}}`, `{{to}}`, `{{peer}}`, `{{label}}`. If you omit a
`mail_to(` instruction, the script appends a default reply contract for you.

## Subcommands (quick reference)

| Command | Behavior |
|---|---|
| `mycc-compose check <file>` | Validate the spec; report match / mismatch / stale. **No mutation.** |
| `mycc-compose up <file>` | Full pipeline: mint sids, launch/renew peers, repair identity, write channels. |
| `mycc-compose sync <file>` | Idempotent reconcile — `up` minus destructive stops. **The cron target.** |
| `mycc-compose down <file> [--stop]` | Remove the channel pairs; with `--stop`, terminate the peers (verifies pid is alive + is a mycc process). |
| `mycc-compose status <file> [--json]` | Deterministic report: peers `{name,sessionId,live,matching,lastBrief}` + channels `{label,bothFilesPresent}`. |

Exit codes: `0` OK, `1` runtime/validation error, `2` usage error.
Full details, including cron wiring, in `script.md`.

## Hard rules (from the design)

- `peers[].args` **must** include `--auto` or `--daemon` — without it,
  `cleanupEmptySessions()` can garbage-collect the re-pinned session dir.
- Labels (`group`, `peers[].name`) **never** enter a session id — ids stay pure
  UUIDs. Channel title = `<group>-<label>`; filename suffix = `<label>`.
- **Validate everything before mutating anything** — `up` aborts before any
  mutation on a bad spec.
- Never hand-edit the channel booleans: the peers' poll re-persists in-memory
  state and clobbers edits.

## Related

- `docs/peer-topology.md` — the full design/plan (schema, pipeline, constraints).
- `mediator` skill — the manual procedure this tool automates.
- `coordination` skill — for the in-process lead + child-teammate team.
