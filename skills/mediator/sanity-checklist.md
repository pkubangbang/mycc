# Sanity Checklist & Pitfalls

> Sub-reference of the `mediator` skill. Loaded on demand via `read_file`.
> The entry point is `SKILL.md`.

## Sanity Checklist Before Declaring the Workflow Wired

- [ ] Peer instance launched via the `mycc` command (not raw
      `node bin/mycc.js`), verified online via `peers()` before writing channel
      files. (`--serve`/`--auto` are not required — identity + heartbeat +
      channel poll run regardless of mode. See `launching-peer.md`.)
- [ ] Both target instances are **online** (verified with `peers()` or a fresh
      heartbeat in `~/.mycc-store/discovery/heartbeat/<sid>.json`).
- [ ] **Both** channel files of the pair exist, each with the correct
      `ownerSessionId` and `peerSessionId`.
- [ ] Each channel file was **read back and validated** with a JSON-aware
      reader (e.g. `jq -e '.joined == false and .firstQuerySent == false' "$f"`
      in bash) — it parses, and `joined`/`firstQuerySent` are exactly `false`
      (not `true`, not missing). This catches the hand-rolled-JSON trap
      (mis-escaped newlines, a BOM, wrong booleans) before the poll ever runs.
      **Caveat:** read back *immediately* after the atomic write. The 5s poll
      can join the file in the interim and flip `joined`/`firstQuerySent` to
      `true` — if your read-back shows `true`, that is the poll having already
      joined (success), NOT a write error. The way to tell: you authored
      `false` with a structured file-write tool (you know the exact bytes), so
      a later `true` must be the poll's mutation. Re-read the file content /
      structure (channelId, ownerSessionId, peerSessionId, firstQuery) to
      confirm it is otherwise intact; if it is, the wiring succeeded.
- [ ] Each `firstQuery` states the instance's role, its peer's session-id, and
      the `mail_to(name="<peer>/lead", ...)` reply contract.
- [ ] The `channelId` is identical across the pair; the files differ only in
      `ownerSessionId`/`peerSessionId` (mirrored) and per-instance `firstQuery`.
- [ ] Within ~5s, each instance's COLLECT state injects its `[MAIL]` firstQuery
      and begins its role. (If not, the instance may not be running or its poll
      is stalled — check the heartbeat.)
- [ ] Peer mail_to uses `name="<session-id>/lead"` (not a bare session-id) and
      the peer is online (`peers()` shows it fresh). See `mail-discipline.md`
      for the fail-fast recipient rules.

## Pitfalls

- **Wiring a stale instance** — mail to a fresh-offline peer is silently dropped
  (freshness gate). Always verify online status with `peers()` first.
- **Pre-setting `joined:true`** — the instance will skip join and never receive
  its `firstQuery`. Leave it `false`.
- **Reading `joined`/`firstQuerySent == true` right after writing and panicking**
  — that is the 5s poll having already joined (success), not a write error. You
  authored `false`; the poll mutated it to `true`. See the caveat in the
  checklist above and in `channel-files.md`.
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
  baking the contract into the firstQuery is the reliable fix. See
  `mail-discipline.md`.
- **Hand-rolled JSON in any shell** — hand-writing the channel JSON is a trap
  in every shell: mis-escaped multi-line `firstQuery`, wrong booleans, or an
  accidental BOM (e.g. PowerShell 5.1 `Set-Content -Encoding UTF8` prepends a
  UTF-8 BOM that breaks strict parsers; bash `>` is BOM-free but still needs
  correct escaping). Use a file-write tool, or a JSON-aware writer + atomic
  move + read-back validate. Never hand-concatenate the JSON string. See
  `channel-files.md`.
- **Bare session-id / unknown recipient in mail_to** — mail_to now FAILS
  FAST: it rejects any recipient that isn't `lead`, a valid
  `<session-id>/lead` with an ONLINE peer (`isFresh`), or a live teammate in
  the roster. Using `mail_to(name="<session-id>", ...)` WITHOUT the `/lead`
  suffix, or mailing a stale/offline peer or a non-existent teammate, is
  rejected up front with an error naming the unrecognized recipient. Cross-
  instance peer mail MUST use `name="<session-id>/lead"` and the peer must be
  online; for local mail use `lead` or a live teammate name (no `/`). See
  `mail-discipline.md`.