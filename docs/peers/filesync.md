# filesync — Shared Folders Synced Across Wire Peers

Status: **DESIGN** (approved; implementation phases 1–4 tracked in issue #1).

`filesync` is an **enhancement over the peer wire protocol** (see
`remote-peer-protocol.md`) that makes *cross-machine file sharing* viable:
the wire's promise — "the LLM does not care where a peer lives" — extends
from mail to **folders**. Two or more peers binding the same share id see
**one folder**; ordinary local file ops (`cp`, `rm`, `write_file`,
`edit_file`, …) on either side converge on all of them.

- **peer ≠ remote**: a *peer* is any mycc instance the wire connects
  (local same-machine or cross-machine); *remote* means cross-machine
  specifically. filesync is transport-agnostic — it works over a local-peer
  wire and a remote wire identically.
- All swarm members are **read-write**. There are no read-only secrets and
  no per-file consent rounds: **possession of the share id is membership**.

---

## 1. Share & identity

- **Bind:** `mycc --share <id>` (repeatable) or env `MYCC_SHARES=<id>[,<id>…]`
  or `/share <id>` at runtime. The share id is a **capability secret** — keep
  it out of process listings with `MYCC_SHARES` (a `--share` value lands in
  `identity.json` args).
- **Root (sealed):** `<workdir>/.mycc/filesync/<id>/` — created at bind. This
  is the ONLY filesystem surface filesync ever reads or writes (state lives
  in the sibling `.sync/` area, §5).
- **Membership / auto-pairing:** a share's members are every wired peer whose
  `announce` frame carries the same id (§3). Pairing a *machine* is still
  `peer_connect` (one dialed WS per pair, the wire's firewall story is
  unchanged); pairing a *folder* is the matching id. There is no per-share
  connect step and no accept round.
- `/share <id> --unbind` stops syncing (the folder and its files stay).
- `/share --list` shows each share: partners (from `announce.shares`), state
  (syncing / idle), pending conflicts, in-flight pieces.

Multiple `--share` flags = multiple independent swarms/folders; membership
may differ per share.

## 2. Sync model

- **Content-defined chunks** (FastCDC-style rolling boundaries, avg
  256 KiB) with a sha256 per chunk ("piece"). Pieces are stored in the
  **piece store** `<workdir>/.mycc/filesync/.sync/<id>/pieces/<sha256>`:
  the store is simultaneously the resume cursor and the dedupe cache —
  only pieces absent from the store are ever requested, and unchanged
  pieces of an edited file cost zero bytes.
- **Index (per share):** file entries `{relPath, gen, size, pieceListHash}`,
  `pieceListHash` = sha256 of the file's ordered piece-hash list. Indexes are
  **O(files)** — piece lists are fetched lazily (§3, `sync-req{want:"pieces"}`).
  Plus two side lists:
  - **tombstones** (deletes): `{relPath, gen, by}`;
  - **conflict log**: `{relPath, keptGen, loserSid, loserTs}` (§4).
- **Version rule:** `gen = (mtime, sid)` — last-writer-wins by
  `(mtime, then sid tiebreak)`. A losing local edit is **never destroyed**:
  preserved as `<name>.conflict-<sid>-<ts>` (§4).
- **Truth vs latency:** periodic index gossip (≈30 s) + on-change gossip is
  the correctness mechanism; the filesystem watcher (debounced 300 ms) only
  lowers latency and self-heals missed events. Convergence after partition,
  restart, or crash is pure gossip-diff — nothing lives only in memory.
- **Apply is atomic:** pieces verified (sha256 each) → write temp file →
  `rename` (EXDEV: copy + fsync + rename) → recorded `mtime` preserved.
  Hash-equal versions never conflict. Symlinks are skipped (reported in
  `/share --list`); directories are implicit in file entries.

## 3. Transport — frames over the existing WS

Two frame classes on the same socket, demuxed by WS frame type:

| Frame | WS | Payload | Purpose |
|---|---|---|---|
| `announce` | text | `+ shares: string[]` | membership gossip at connect |
| `sync-index` | text | `{t:"index", share, entries[], tombstones[], conflicts[]}` (paged) | join / change / periodic reconcile |
| `sync-req` | text | `{t:"req", share, pieceHashes[]}` or `{t:"req", share, file, want:"pieces"}` | fetch missing pieces / lazy piece list **from this partner** |
| `sync-data` | **binary** | `[0x04][32B sha256][2B shareLen][share][raw piece]` | piece payload (raw bytes; no base64) |
| `sync-del` | text | `{t:"del", share, relPath, gen}` | tombstone propagation |

Control frames are JSON text frames (as `mail`/`announce` today); data
frames are binary with a 35-byte + shareLen header. Chunk sizing (avg
256 KiB) + header stays far under `WIRE_MAX_PAYLOAD_BYTES`; the byte-aware
sender guard (`sendWireMail` pattern) is the floor.

- **Pairwise only — there is no relay and no routing.** Every frame goes over
  the wire to that partner. Multi-hop delivery is **emergent
  store-and-forward**: a partner stores received pieces as its own folder
  content and serves them later — the two hops need not overlap in time
  (A→C now, C→B whenever). If A and B are both wired to C and all three carry
  the share, A's file reaches B through C's folder with zero forwarding code.
  `sync-req` asks **this partner** for pieces its index says it holds ("any
  holder" = any wired partner that advertised them).
- **Flow control:** request window **K=8** per partner per share (refilled as
  `sync-data` arrives); the send pump pauses at `ws.bufferedAmount`
  high-water **4 MiB** (bounds mail/keepalive delay to ≈ one chunk);
  per-piece deadline **30 s** → re-request still-missing hashes, preferring
  another partner. Sequential piece order (earliest complete file). One
  in-flight request per piece per partner (duplicates coalesce).
- **Reliability:** TCP gives ordered reliable delivery — per-packet acks,
  retransmits and sequence numbers are **not implemented** (deleted as
  transport-inherited). The transport-independent rules that remain: (1)
  piece sha256 verified on receipt (integrity + idempotency: existing piece
  = no-op write), (2) request deadlines (a peer can stall/die mid-stream),
  (3) the piece store as persistent retry state across reconnects.
- **Unsolicited pieces are dropped** (request-set membership check) in v1.
- **Version skew:** a peer that ignores `sync-*` frames (old build) → no
  `sync-index` reply within 10 s → clear error "peer has no sync support",
  no retry storm. (Do NOT exercise this against instances running old code
  in production — e.g. the remote at 10.0.1.1:3173 as of this writing.)
- Optional `MYCC_SYNC_RATE_KBPS` token bucket on the data pump;
  `MYCC_MAX_SYNC_MB` per file, default 500 (byte-aware, sender-side).

## 4. Conflict resolution & mycc awareness

**Detection & preservation.** When an incoming version displaces a local
version with *different content*, the loser is never destroyed: it is
preserved as `<name>.conflict-<sid>-<ts>`, and a **conflict-log entry**
`{relPath, keptGen, loserSid, loserTs}` joins the index (travels with it, so
every member learns of the conflict). Clock skew in `gen=(mtime,sid)`
therefore produces conflict *noise*, never silent loss (documented
limitation).

**Surface to the chat — resolution is content.** On seeing a NEW conflict-log
entry, each member's engine mails **its own lead mailbox** (single-writer
`MailBox.appendMail`, seen-set dedupe by entry key):

```
[sync-conflict] docs/report.pdf (share abcdef01)
  local (you, 21:03) vs 5bd7bff8…/lead (21:07) — theirs kept (LWW);
  your version preserved as docs/report.pdf.conflict-<you>-2103.
  Resolve in chat: compare the two files, then rm the conflict copy
  (accept theirs) or edit/overwrite the kept file (merge/keep yours) —
  the resolution is a normal file change and syncs like any other.
```

The mail rouses AWAIT→COLLECT (existing 1 s poll). The lead's LLM compares
the two files (`read_file`), optionally asks the user, and resolves with
**ordinary file ops**. There is no resolution protocol: deleting the conflict
copy tombstones it and the conflict-log entry expires on the next reconcile;
overwriting the kept file is a new `gen`. Both sides get mail (wording
differs: "yours kept / theirs preserved" vs "theirs kept / yours preserved").

**mycc awareness (durable, compaction-proof).**

1. **Pinned share todo** at bind: `share <id> — .mycc/filesync/<id>/ synced
   folder; resolve [sync-conflict] mail when it arrives` — pinned +
   never-done (the wire's info-symmetry pattern), so it survives
   auto-compact; marked done on `--unbind`.
2. **`peer_list`** shows each peer's `shares:` from `announce` (display-only,
   like `workDir`) — which folders overlap with whom.
3. **`/share --list`** on demand (partners, conflicts, in-flight).
4. Sync generates **only** conflict mail — no per-file arrival spam.

## 5. Security & confinement

- **Secret possession = read-write membership** (all members read-write).
  `MYCC_WIRE_TOKEN` gates the wire connection; the share id gates the folder.
  Both must pass; neither substitutes the other.
- **Sealed root:** the wire only ever carries `relPath`. `..`/absolute/
  symlink relPaths are rejected at parse **and** re-checked after resolve
  under the share root (belt + suspenders). Nothing outside
  `.mycc/filesync/<id>/` is read or written. There is no per-op path
  permission model and no absolute-path mounts — the sandbox is structural.
- **State & exposure:** `.mycc/filesync/.sync/<id>/` holds `pieces/`,
  optional derived dirty state, and `--debug-filesync` logs (§7). It is
  excluded from the share and **outside `.mycc/public/`** (the webui serves
  that statically) — received files are never web-exposed by placement.

## 6. Phases & tests

| Phase | Deliverable |
|---|---|
| 1 | this spec + `remote-peer-protocol.md` §6 update |
| 2 | `src/peer/filesync/` — chunker + piece store, index/tombstones/conflict log, watcher + 30 s gossip, fetch engine; frame diffs (`wire-client.ts`, `wire-registry.ts`, `serve/peer-wire.ts`) |
| 3 | config (`--share`/`MYCC_SHARES`/`--debug-filesync`: `config.ts`, `arg-canonical.ts`, `help.ts`, README), `announce.shares`, `/share` slash, conflict→mail + pinned share todo, `peer_list` shares display |
| 4 | tests |

**Unit:** chunker determinism + piece verify · index diff (new/changed/
deleted/dedupe-skip) · relPath confinement (`..`, absolute, symlink escape) ·
piece-store re-request after kill (only missing hashes requested) · LWW
tiebreak · conflict: loser preserved + log entry + mail both sides + seen-set
dedupe · resolution-by-file-ops converges (rm conflict copy → entries expire;
overwrite → new gen) · tombstone vs newer-edit resurrection · pinned todo
lifecycle · frame encode/decode (binary + text) · `--debug-filesync` frame
transcript contents.

**Integration — LOCAL ONLY** (two/three instances via `bg_create` daemon +
webui, wired with `--debug-wire` + `peer_connect`, `MYCC_WIRE_ALLOW_LOCAL`;
assert on **real files** — content, mtime, `.conflict-*` copies, tombstoned
deletes — and on frame sequences from the `--debug-filesync` audit log):
(a) pair: `cp`/`rm`/edit converge · (b) triangle A—C—B with A,B not wired to
each other: a file in A's folder reaches B through C's folder across disjoint
sessions (assert B receives `sync-data` from C, never from A) · (c) concurrent
edit → conflict copies + mail both sides → resolution by file ops →
convergence · (d) kill mid-transfer → next gossip completes from missing
pieces (assert zero `sync-req` for pieces already in the store) · (e)
partition + rejoin with divergent edits → exactly one conflict, no loss ·
(f) version-skew error text (against a stub, never a live old instance).

**Constraint (do not violate):** instances running OLD code — notably the
remote peer `dc827afe…` at 10.0.1.1:3173 — are unaware of filesync and must
NOT be used for any filesync traffic or tests until the user confirms they
are updated. All testing is local (`--debug-wire`).

## 7. Observability — `--debug-filesync`

- **Flag/env:** `--debug-filesync` / `MYCC_DEBUG_FILESYNC=true` (family of
  `--debug-tp`, `--debug-ansi`; documented in the README debug-flags table).
- **What:** every `sync-*` frame in both directions, one JSONL line per
  frame — binary data frames logged as **metadata + piece sha256 + byte
  count** (not raw payload); control frames logged whole (`gen`, cursor,
  `err` fields where present):
  ```jsonl
  {"ts":"…","dir":"tx","peer":"5bd7bff8…","frame":"sync-data","share":"abcdef01","piece":"9f2c…","bytes":262144,"seq":17}
  {"ts":"…","dir":"rx","peer":"5bd7bff8…","frame":"sync-index","share":"abcdef01","entries":12,"tombstones":1,"conflicts":0}
  ```
- **Where:** per share, `.mycc/filesync/.sync/<id>/frames-<session-ts>.jsonl`
  — append-only, opened at bind, flushed per line. Default off (zero cost).
- **Use:** the log is a total-order transcript of the protocol per socket
  (TCP-ordered), so correctness questions become greps ("was the tombstone
  sent before the index?", "did we request a piece we already had?"). Tests
  assert frame sequences from it (§6). One logging tap at the frame
  dispatch chokepoint (tx/rx) shared by the audit log and test assertions.

## Fixed knobs (change-on-request)

FastCDC avg 256 KiB · request window K=8 · send high-water 4 MiB · piece
deadline 30 s · gossip 30 s · watch debounce 300 ms · `gen=(mtime,sid)` LWW
+ `.conflict-<sid>-<ts>` preservation · conflict-log entries expire when the
conflict copy is deleted · conflict-only mail · pinned share todo per bind ·
sequential piece order · `MYCC_MAX_SYNC_MB=500` · `MYCC_SYNC_RATE_KBPS`
optional · symlinks skipped · state in `.mycc/filesync/.sync/<id>/` · all
members read-write (no RO secrets).
