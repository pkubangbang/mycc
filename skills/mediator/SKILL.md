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
keywords: [mediator, "multi window", "multi instance", peer, discovery, channel, "cross-instance", workflow, orchestrate, identity, heartbeat, session-id, mail_to, IPC]
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

## Sanity Checklist Before Declaring the Workflow Wired

- [ ] Both target instances are **online** (verified with `peers()` or a fresh
      heartbeat in `~/.mycc-store/discovery/heartbeat/<sid>.json`).
- [ ] **Both** channel files of the pair exist, each with the correct
      `ownerSessionId` and `peerSessionId`.
- [ ] `joined` and `firstQuerySent` are `false` in both files.
- [ ] Each `firstQuery` states the instance's role, its peer's session-id, and
      the `mail_to(name="<peer>/lead", ...)` reply contract.
- [ ] The `channelId` is identical across the pair; the files differ only in
      `ownerSessionId`/`peerSessionId` (mirrored) and per-instance `firstQuery`.
- [ ] Within ~5s, each instance's COLLECT state injects its `[MAIL]` firstQuery
      and begins its role. (If not, the instance may not be running or its poll
      is stalled — check the heartbeat.)

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

## Summary

1. A mediator wires **separate mycc instances** (not child teammates) by
   writing **channel file pairs**; the instances' existing peer-discovery +
   mail machinery does the rest.
2. **Discover** online instances + session-ids with the `peers` tool.
3. **Author two channel files** (one per participant), mirrored, with
   `joined:false`/`firstQuerySent:false` and a per-instance `firstQuery`.
4. Each `firstQuery` defines the instance's **role**, its **peer's session-id**,
   and the **`mail_to(name="<peer>/lead", ...)` reply contract**.
5. After kickoff, instances communicate **peer-to-peer via `mail_to`**
   (freshness-gated direct mailbox append) — the mediator does not relay.
6. Use the **coordination** skill for in-process lead+teammate teams; use THIS
   skill only for multi-instance orchestration from the outside.