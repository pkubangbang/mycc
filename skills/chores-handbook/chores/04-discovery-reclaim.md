## Chore 4: Reclaim Stale Discovery State (channel files + heartbeats)

### Background

`mycc-compose down` deletes **only** the channel files it can attribute to its
own name-identified peers, by exact filename (`<resolved-sid>-<label>.json`).
It never sweeps `~/.mycc-store/discovery/channels/`. That is deliberate: a
same-label collision must never let `down` delete a sibling topology group's
live files. The cost is that the **previous generation's files are never
reclaimed** — not even across `down`. Every `renew:always` restart leaves one
more permanent orphan (audit finding **AC-2**, confirmed by two independent
auditors).

Heartbeat files accumulate the same way. `~/.mycc-store/discovery/heartbeat/`
holds one file per session id ever seen, and each carries the peer's last few
**briefs**. Nothing prunes them; the `peer_list` tool merely *hides* entries
older than 1 hour, it does not delete them.

**The owner's decision (2026-10-20): keep `down` conservative — do NOT make it
sweep.** Reclamation is a manual chore instead, because it is low-frequency
and irreversible.

### Why Manual, Not Automated

1. **Deletion is irreversible and unattributable.** A channel file records who
   owns it, but "is anyone still using this?" cannot be answered from the file:
   a peer that is merely *sleeping* (laptop closed, daemon paused for a day)
   looks identical to a dead one to any age-based rule.
2. **Heartbeat files are the only surviving history of a finished peer.** The
   `briefs` array is what `peer_list` shows for that instance. Deleting the
   file deletes that record.
3. **The right window is a judgement call.** 7 days? 30? It depends on how long
   your daemons sleep. Hard-coding a default would eventually delete something
   alive.

### Prerequisites

- Know your discovery dir. It defaults to `~/.mycc-store/discovery` and is
  overridable with `MYCC_DISCOVERY_DIR` (the same variable the compose lib and
  the tests honour).
- Make sure the instances you care about are RUNNING (so their heartbeats are
  fresh and they are automatically excluded — see the liveness rule below).

### Liveness rule (do not weaken it)

A session id is **kept** if ANY of these hold; it is a candidate only when none
do:

| Guard | Why |
|---|---|
| present in `identity.json` | it is a registered instance — the authoritative registry |
| latest heartbeat newer than **1 hour** | live now (same cutoff as `peer_list`) |
| carries a `tombstone` | a stop was requested and the peer has not yet observed it — deleting the file would lose the stop request |
| latest heartbeat within your chosen `--days` window | stale-but-young; a sleeping daemon resumes here |

### Step 1 — Inspect (read-only, always safe)

```powershell
node scripts/mycc-compose/compose-cleanup-audit.js            # human table
node scripts/mycc-compose/compose-cleanup-audit.js --json     # machine-readable
node scripts/mycc-compose/compose-cleanup-audit.js --days 30  # a more conservative window
```

The script deletes **nothing**. It prints, per file, the verdict
(`KEEP` / `CANDIDATE` / `UNKNOWN`) and the reason, plus how many briefs a
heartbeat deletion would destroy.

Read the output. Two things to look for specifically:

- **`UNKNOWN`** — a filename that does not match `<sid>-<label>.json`, or a
  heartbeat file with no timestamps. Investigate by hand; do not bulk-delete.
- **`[newer sibling exists]`** — this is the AC-2 signature: an old generation
  of a label that has a live generation. These are the safest deletions.

### Step 2 — Back up the whole discovery dir

```powershell
$src = Join-Path $HOME '.mycc-store/discovery'
$dst = Join-Path $HOME ('.mycc-store/discovery-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item $src $dst -Recurse
"backup at $dst"
```

Do not skip this. It is the rollback (Step 5) and costs kilobytes.

### Step 3 — Delete the CANDIDATEs only

Filter on the script's verdict, not on your own glob:

```powershell
$src = Join-Path $HOME '.mycc-store/discovery'
$report = node scripts/mycc-compose/compose-cleanup-audit.js --json | ConvertFrom-Json

$report.channels  | Where-Object verdict -eq 'CANDIDATE' |
  ForEach-Object { Remove-Item (Join-Path $src ('channels/'  + $_.file)) -Force -WhatIf }
$report.heartbeats | Where-Object verdict -eq 'CANDIDATE' |
  ForEach-Object { Remove-Item (Join-Path $src ('heartbeat/' + $_.file)) -Force -WhatIf }
```

`-WhatIf` prints what would be deleted without deleting. **Review that list
against Step 1's output, then re-run the same two commands without `-WhatIf`.**

> **已验证（2026-10-20）**：在真实 store 上跑这两段 `-WhatIf`，分别列出 21 个 channel 与 69 个 heartbeat 候选，且跑完后磁盘上的文件数**不变**（22 → 22，105 → 105）。
> 注意 `-WhatIf` 会把提示写到 **stderr**，所以 `... | Measure-Object` 数到的会是 `0` —— 那是正常的，用眼睛看列出的路径即可，不要据此判断"选了 0 个"。

> Never delete `identity.json`, and never delete a file the script reports as
> `KEEP`. If you find yourself typing a wildcard (`rm *.json`, `Remove-Item *`),
> stop — that is exactly the failure mode this chore exists to avoid.

### Step 4 — Verify

```powershell
node scripts/mycc-compose/compose-cleanup-audit.js
node scripts/mycc-compose/mycc-compose.js status <your-topology.json> --json
```

- The audit script should now report `0` candidates (or fewer, never more).
- `status --json` must be unchanged for every **live** group — if a live
  group's `attribution` flipped from `present` to `absent`, you deleted
  something in use: go to Step 5 immediately.

### Step 5 — Rollback

Move the backup back:

```powershell
Remove-Item (Join-Path $HOME '.mycc-store/discovery') -Recurse -Force
Copy-Item (Join-Path $HOME '.mycc-store/discovery-backup-<timestamp>') (Join-Path $HOME '.mycc-store/discovery') -Recurse
```

### Do NOT do this as part of a code change

Reclamation must not be smuggled into `cmd-down.ts` "while we're here". AC-2
stays open on purpose: making `down` sweep would silently reintroduce the
sibling-group deletion that AC-5 fixed. If it is ever automated, it belongs in
a separate, explicitly-invoked command with this exact liveness rule.

