---
name: mediator
description: >
  Use when the task is to compose MULTIPLE SEPARATE mycc instances (different
  processes, possibly different working directories) into a workflow — NOT
  the lead/teammate child-process team (that is the "coordination" skill).
  A mediator is an outside orchestrator: it is NOT itself a mycc agent but
  a process/script/operator that wires instances together by writing channel
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

> **This is a progressive-disclosure skill.** This entry file holds the
> mental model and the decision points; the detailed references are split
> into sibling files in this folder. Read the sections you need below, and
> `read_file` the referenced files when you reach the corresponding step.
>
> Sibling references in this skill:
> - `channel-files.md` — Channel file schema, both connection modes
>   (outside mediator / self+peer) with full JSON examples, authoring
>   details, and the hand-rolled-JSON trap + reliable authoring patterns.
> - `workflow-patterns.md` — Pipeline, Peer Review, and Fan-out
>   cross-instance patterns.
> - `launching-peer.md` — How to bring up a headless peer (`mycc`, not
>   raw `node`), the order-of-operations checklist, and why `--auto`/
>   `--serve` are not required for wiring.
> - `mail-discipline.md` — The fire-and-forget reply model (no mailbox
>   polling), the reply contract to bake into firstQuery, and the mail_to
>   fail-fast recipient rules.
> - `sanity-checklist.md` — Pre-declare-wired checklist and the full
>   pitfalls list.

## Overview

This skill describes how to act as a **mediator** — an outside orchestrator
that wires **multiple separate mycc instances** into a coordinated workflow.
It is the cross-instance counterpart to the `coordination` skill (which
orchestrates the lead + child-process teammates inside ONE instance).

```
coordination skill  →  ONE mycc instance, lead + teammates (child processes)
mediator skill      →  MANY mycc instances, each its own process, wired together
```

A mediator is NOT a mycc agent. It is whatever writes the channel files and
routes the first messages: a shell script, a human operator, or one of the
instances acting as a broker for the others. The key insight: **instances
never need to be modified to join a workflow** — you connect them purely by
creating files on disk (channel files) and letting the existing
peer-discovery + mail machinery do the rest.

## When to Use This Skill

Use a mediator when you need **separate mycc instances** (not child
teammates) to collaborate:
- The instances run in **different working directories** (different repos,
  or different worktrees of the same repo).
- You want **process isolation** between agents (separate LLM contexts,
  separate sessions, independent ESC/interrupt behavior).
- You are orchestrating from the **outside** (a script/operator) rather
  than from within one agent's loop.

Do NOT use this skill when:
- A single instance can do the work → just do it.
- The "agents" can be child teammates of one lead → use the `coordination`
  skill (in-process team mode). Child teammates share the lead's session
  and are far cheaper to coordinate than cross-instance channels.

## The Cross-Instance Model (How It Actually Works)

Three on-disk mechanisms under `~/.mycc-store/discovery/` make
cross-instance messaging possible. You do not implement these — they
already run inside every mycc lead. You only need to **author channel
files** (mechanism 3) and the rest is automatic.

### 1. Identity Registry — `identity.json`
Every mycc lead registers itself at startup in
`~/.mycc-store/discovery/identity.json`, a session-keyed map of
`{ sessionId, workDir, mailbox, startedAt }`. The `mailbox` path is the
lead's **unread mail JSONL file** — the inbox. Any line appended here is
picked up by the lead's COLLECT state on its next loop and injected as a
`[MAIL]` note.

### 2. Heartbeats — `heartbeat/<session-id>.json`
Each lead writes a rolling heartbeat (last 3 timestamps, every 30s). An
instance is considered **fresh (online)** iff its latest heartbeat is
newer than the local oldest heartbeat. Mail to a stale peer is silently
dropped (the freshness gate). So: **only wire up instances that are
actually running.**

### 3. Channel Files — `channels/<session-id>-<channel-id>.json`  ← THE MEDIATOR WRITES THESE
A channel is a **pair** of files with the same `channelId` suffix, one per
participant. The mediator creates BOTH files. When a lead boots (or on its
5s channel poll), it auto-joins any channel file bearing its own
session-id prefix, and — if the file has a `firstQuery` — **delivers that
firstQuery to its OWN mailbox** as the conversation starter. This is how a
mediator "kicks off" an instance into a workflow without telling it
anything interactively.

> **The full schema, both connection modes, authoring details, and the
> hand-rolled-JSON trap are in `channel-files.md`.
> Read it before authoring any channel file.**

## The Mediator Workflow (compact)

1. **Discover online instances** — use the `peers` tool (lead-only) to
   list online mycc instances and their session-ids. Note the session-ids
   of the instances you want to connect.
2. **Create the channel file pair** — pick a `channelId`, write two
   mirrored files (one per participant) with `joined:false` /
   `firstQuerySent:false` and a per-instance `firstQuery`. See
   `channel-files.md` for the exact JSON and the
   reliable authoring pattern (prefer a structured file-write tool over
   hand-rolled shell JSON).
3. **Bake the reply discipline into firstQuery** — each `firstQuery`
   must state the instance's role, its peer's session-id, and the
   `mail_to(name="<peerSessionId>/lead", ...)` reply contract. See
   `mail-discipline.md`.
4. **Let them talk; monitor from the outside** — after kickoff the
   instances mail each other directly via `mail_to` with the
   `<session-id>/lead` identity. The mediator does NOT relay messages.
   See `mail-discipline.md` for why you must NOT
   busy-poll the mailbox (fire-and-forget; replies arrive as `[MAIL]`
   notes automatically at the next COLLECT).

## Two Ways to Connect (at a glance)

- **Mode 1 — Outside mediator**: a third party authors BOTH channel files
  for two other instances, then steps away.
- **Mode 2 — You are one endpoint**: you author the pair from your own
  session; the peer's file carries your instruction to the peer, your own
  file carries a self-kickoff.

The full per-mode JSON examples and the asymmetric firstQuery split are in
`channel-files.md`.

## Workflow Patterns

Pipeline (A→B→C), Peer Review (A↔B), and Fan-out (A→B, A→C) are documented
in `workflow-patterns.md`.

## Launching a Headless Peer

Bring up a second instance with a plain `mycc` from its working directory
(NOT raw `node bin/mycc.js` — the Lead refuses to start outside the
Coordinator). `--serve`/`--auto` are NOT required for channel creation.
See `launching-peer.md` for the order-of-operations
checklist.

## Sanity Checklist & Pitfalls

Before declaring the workflow wired, run through
`sanity-checklist.md`. The common traps: wiring a
stale instance, pre-setting `joined:true`, forgetting the second file of
the pair, expecting the mediator to relay, reply-by-prose, hand-rolled
JSON, and bare session-id / unknown recipient in mail_to.

## Summary

1. A mediator wires **separate mycc instances** (not child teammates) by
   writing **channel file pairs**; the instances' existing peer-discovery
   + mail machinery does the rest.
2. **Two connection modes**: (a) outside mediator — a third party authors
   both files; (b) you are one endpoint — peer's file carries your
   instruction, your file carries a self-kickoff. (See
   `channel-files.md`.)
3. **Discover** online instances + session-ids with the `peers` tool.
4. **Author two channel files** (one per participant), mirrored, with
   `joined:false`/`firstQuerySent:false` and a per-instance `firstQuery`.
5. Each `firstQuery` defines the instance's **role**, its **peer's
   session-id**, and the **`mail_to(name="<peer>/lead", ...)` reply
   contract**. (See `mail-discipline.md`.)
6. After kickoff, instances communicate **peer-to-peer via `mail_to`**
   (freshness-gated direct mailbox append) — the mediator does not relay.
7. Use the **coordination** skill for in-process lead+teammate teams; use
   THIS skill only for multi-instance orchestration.