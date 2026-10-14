# mycc-compose: identify peers by durable name, not by session id

*A self-contained description of the compose peer-identity fix. No knowledge of
prior discussion is needed.*

## Summary

`mycc-compose` used to identify each peer by a **session id** it minted and
pinned into the spec (`--session-id <uuid>`, written back in place). That
conflated two different things — a peer's *durable identity* and its
*per-run session id* — and produced several silent data-loss paths. This change
makes the **durable name** (`--name <group>:<peer>`) the identity, lets each
peer mint its **own** session id on every boot, and resolves the live id from
`identity.json` **by name** when something needs it. The spec no longer carries
a session id at all.

The design principle: **deletion and attribution require positive proof.**
Identity is proven by the durable name (survives restarts); a session id proves
nothing because it changes every run.

## 1. The four data-loss vectors this fixes

1. **Identity conflation.** The pinned sid was BOTH the durable handle AND the
   per-run session key. Because a restarted peer was supposed to come back
   "under the same sid", code trusted a locally-minted sid to be the peer's
   real one — but a launched peer mints its **own** `randomUUID()` on boot
   (`writeFreshSessionFiles`). A launcher-minted sid could therefore NEVER equal
   the peer's real sid: the launcher held a **phantom** it acted on.
2. **Silent sid re-join on relaunch.** Because "same peer" meant "same sid", a
   relaunch that produced a *different* sid was treated as a *different* peer —
   or worse, a stale sid re-joined the wrong running instance's channels,
   splitting brain across two live instances.
3. **Name collision / mis-attribution.** With identity keyed on a value the
   spec had to store, cleanup matched files by a value that churned per run, so
   a channel file could be attributed to (and deleted for) the wrong peer.
4. **Silent flag loss across respawns.** The minting/write-back machinery and
   the `--session-id` pin interacted with relaunch so that authored flags could
   be dropped across a respawn, and the spec file itself was mutated by a
   management command.

All four trace to one root cause: **using a per-run value as a durable
identity.** The fix removes the per-run value from the identity entirely.

## 2. The identity model: WHO / CONFIG / WHERE

Identity splits into three independent axes, none of which is the session id:

| Axis | Carried by | Stable across restarts? |
|---|---|---|
| **WHO** | `--name <group>:<peer>` (launcher-injected from `peers[].name`) | YES — the durable handle |
| **CONFIG** | `peers[].args` (validated) | YES (authored) |
| **WHERE** | `peers[].workdir` | YES (authored) |

- **WHO** is the name. It is unique case-insensitively (enforced at both
  `validateSpec` and register time) and is injected by the launcher as
  `--name <group>:<peer>` — the **argv is the single source**, with no env
  mirror.
- **CONFIG** is the authored args, validated before any mutation.
- **WHERE** is the workdir; two groups may share a leaf name, so a name match is
  qualified by a workdir match.

"Match" (for `renew`) is therefore: same **workdir** AND canonical **args**
equal AND the process is **running** (fresh heartbeat AND alive recorded pid) —
resolved BY NAME. The runtime sid is never part of the comparison.

## 3. Removal inventory

- **`--session-id` — removed.** `src/config.ts` now hard-exits on it; a peer
  gets its identity from `--name` (`getPeerName()`).
- **Spec-authored sid — removed.** `validateSpec` REJECTS a `peers[].sessionId`
  key (even `null`).
- **Launcher minting + spec write-back — removed.** `cmd-up` no longer calls
  `randomUUID()` or `updateSpecFile`; the launch list is simply ALL peers, and
  the spec file is byte-identical after every `up`.
- **Lease machinery — removed.** The session-lease pinning that backed the sid
  model is deleted (`src/peer/identity.ts`, `src/session/index.ts`,
  `src/peer/peer.ts` slimmed).
- **Spec tolerance — removed.** No "sessionId defaults to null / mint one"
  behavior remains.

## 4. R1 + R2 channel-file cleanup

`mycc-compose down` removes the channel files a spec OWNS, judged by NAME:

- **R1 (name conjunction).** A file is OURS iff its `channelId` is one of the
  spec's labels AND its `ownerName` OR `peerName` is in the spec's
  `<group>:<peer>` name-set. Deleted.
- **R2 (orphan-only legacy sweep).** A pre-v3 file carries NO ownership names.
  It is deleted ONLY when BOTH embedded session ids are provably DEAD (the
  `isPeerRunning`-level predicate — not bare heartbeat freshness). If either
  embedded sid is live, or cannot be established, the file is KEPT and
  reported: **a half-match is not deletable evidence, it is investigation
  material.** Ambiguity always resolves to keep.

Channel files now record the durable `ownerName`/`peerName` (DATA-ONLY; the
runtime `ChannelManager` neither reads nor writes them, it merely preserves them
across the read-modify-write round-trip). `status` reports each channel's
`attribution` as `by-name` (R1), `legacy` (sid fallback for pre-v3 files), or
`absent`, and stays byte-deterministic for `--json`.

## 5. `/reload` guard (two layers)

A compose peer is launched with `--name`, so reloading it would restart the
instance under a **fresh** sid and **orphan its channel files**. Both layers of
`/reload` refuse it:

1. **Slash handler** (`src/slashes/reload.ts`): `hasNameFlag()` — a single
   shared predicate that takes a pre-sliced launch-token list (default
   `process.argv.slice(2)`) — returns early with a message pointing at
   `mycc-compose up`.
2. **`reloadLead()`** (`src/index.ts`): delegates to the SAME `hasNameFlag()`
   over the replayed argv (already pre-sliced) and refuses **at the very top of
   the function, before the old Lead is torn down** — a later placement would
   orphan the topology. One implementation, one test seam (the double-slice
   regression is pinned so an explicit pre-sliced list is never re-sliced).

## 6. Name surfaced in existing tools

- `peer_list` (the tool) now renders `name=` beside `session=` for local peers
  (omitted when absent).
- `mycc-compose status` resolves each peer's live sid by name and reports it; its
  `--json` carries both `name` and the resolved `sessionId`.

## 7. Test matrix + gates

- **New / repointed suites:** `mycc-compose-peers` (name-resolution + launch
  differ-gate), `mycc-compose-up-pipeline` (no spec write-back; name-only
  launch resolves), `mycc-compose-channels` (ownerName/peerName on disk;
  `ownedChannelFiles` R1+R2 + `attributeChannelFile` verdict tree + `normName`
  folding), `mycc-compose-down` (name-keyed cleanup; stale by-name file removed
  by name; live foreign same-label survives), `mycc-compose-status` (3-way
  attribution by-name/legacy/absent + byte-determinism), `mycc-compose-shim-parse`
  (argv `--name`, not `--session-id`), `slashes/reload-name-guard`
  (`hasNameFlag` over a pre-sliced list + the double-slice regression), plus
  session/peer/lease suites de-`sessionId`'d (incl. never-beat and
  fresh-beat-but-dead-pid twin cases).
- **Gates:** `npm run typecheck:all` → exit 0; full `vitest run` → 203 files,
  3005 passed / 22 skipped / 0 failed.

## 8. Migration note for existing specs

**Delete every `peers[].sessionId` key** — a present key is now a hard error.
Nothing else is user-visible: the launcher injects `--name <group>:<peer>`
instead of `--session-id`, peers mint their own sids on boot, and channel
cleanup/status attribute by name. An un-migrated store with pre-v3 (nameless)
channel files is still cleaned up by the R2 orphan-only sweep. To carry context
across runs, use `--from <sessionId>` in `peers[].args` — the ONLY
context-carrying relaunch (a session id is never reused; session dirs are
per-run archives).
