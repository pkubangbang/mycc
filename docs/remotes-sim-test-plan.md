# Remotes — simulation test plan (augmented)

A concrete, runnable test plan for the `mycc-compose` **remotes** feature
(declarative `peers[].remotes` delivered over the peer-wire) and the
**daemon-wrapper** peer launch. It is the empirical companion to
[`remotes-design-decision.md`](remotes-design-decision.md).

Status: **G0–G5 PASSED; G6 (up→down→up lifecycle) IN PROGRESS — found bug #2.**

---

## 1. Purpose

Verify, end-to-end and from the repo (not from agent prose), that:

1. a topology of peers launches without blank popups and **survives** the
   launcher (`bin/mycc-daemon.exe`, Go, `CREATE_NEW_CONSOLE + SW_HIDE`);
2. a peer's declared `remotes` are **delivered** to the peer's own mailbox;
3. the peer **dials** the remote and the wire comes **up on both sides**;
4. the topology **reconciles idempotently** across `up → down → up` (no
   spurious mutation, no orphaned processes, no stale channel/identity residue).

## 2. Environment

- Repo: `C:\Proj\mycc` · branch `feat/mycc-compose-peer-topology`.
- Store: the **user store** `~/.mycc-store` (`C:/Users/student/.mycc-store`):
  `discovery/identity.json`, `discovery/heartbeat/<sid>.json`,
  `discovery/channels/<sid>-<label>.json`.
- **Mailboxes are NOT in the user store** — the lead reads/writes
  `<workdir>/.mycc/sessions/<sid>/unread-lead.jsonl` (the project store). This
  distinction is the root of bug #2 (see §7).
- Spec: `.mycc/sim/sim-a.json`. CLI: `node scripts/mycc-compose/mycc-compose.js <cmd> <file>`.

## 3. Topology under test (`.mycc/sim/sim-a.json`)

| Peer | args | sid | role |
|------|------|-----|------|
| A | `--auto --skip-healthcheck --debug-wire` | `09316dbc-…-6be85f389a52` | **dialer** (has `remotes`) |
| B | `--auto --skip-healthcheck` | `9995b7ac-…-9b85ea20` | channel peer |
| C | `--auto --skip-healthcheck --serve 3193` | `3c1dcbdb-…-6be85f389a52`→`3c1dcbdb-…-5b348b` | **remote target** (acceptor) |

- Channel: `A → B`, label `link`.
- `remotes` on **A only**: `["http://127.0.0.1:3193"]`.
- `--debug-wire` lets A dial a same-store peer (bypasses the same-store sid
  filter); C serves the `/peer/ws` endpoint on 3193.

## 4. Gates

### G0 — `check` (no mutation)
`mycc-compose check .mycc/sim/sim-a.json` → validates the spec, reports
match/stale; performs **no** mutation. Expect EXIT=0.

### G1 — launch: no popup + survival
`mycc-compose up`. Then, **after the launcher exits**:
- **survival**: `status` shows A/B/C `live`, and they remain live past one
  heartbeat window (~35 s later).
- **no popup**: snapshot `conhost` PIDs before/after and assert **no conhost has
  a visible main window** (`Get-Process conhost | ? MainWindowHandle -ne 0`).
  New *hidden* conhosts (one per peer) are expected — that is the whole point of
  `CREATE_NEW_CONSOLE + SW_HIDE`.

### G3 — remotes delivery
After `up`, expect a row `- A: remotes delivered (1 URL)` and **no** remotes row
for B/C. Then confirm the mail **landed in A's lead mailbox**:
`<workdir>/.mycc/sessions/<A-sid>/unread-lead.jsonl` gains a `title=remotes`
line carrying the imperative no-question instruction.

### G5 — the dial
Wait for A (`--auto`) to drain the remotes mail, then `peer_connect`. Confirm:
- **A side**: triologue shows `Dialed: http://127.0.0.1:3193`,
  `direction: dialed`, `status: connected`; `peer_list` shows `1/1 remote`.
- **C side** (independent): port `3193` `LISTENING` with an **`ESTABLISHED`**
  inbound connection.

### G6 — `up → down → up` lifecycle (idempotence) **(augmented)**
Run three steps on the live topology and assert the **observable delta** of each
step equals exactly what its intent promises:

1. **up** — peers already `live + match` → expect all `skip`, channels
   `written (pair)`, and **no identity mutation**.
2. **down** — expect `removed N channel file(s)`; peers **stay live**
   (no `--stop`); `status` shows `Channels: link: incomplete`.
3. **up** — expect channels restored (`link: intact`), peers `skip`, remotes
   re-delivered (by design for `up`), and **no identity mutation**.

**Idempotence assertion:** step 1 and step 3 must NOT change any peer's
identity entry (`startedAt`, `args`, `mailbox`, `pid`). A reconcile that mutates
a healthy, already-matching topology is non-idempotent and is a defect.

## 5. Method (evidence discipline)

- Verify from the **repo**, not from agent prose: read `identity.json`,
  `heartbeat/*.json`, `status` output, mailbox files, and OS connection state.
- Capture **raw** outputs (exit codes, full stdout, file contents) per gate.
- Snapshot before/after identity entries so any mutation is provable by diff.
- Never kill the coordinator/lead PIDs (e.g. the running leads); only the sim
  peers A/B/C.

## 6. Results so far

| Gate | Result | Evidence |
|------|--------|----------|
| G0 | PASS | spec valid, no mutation |
| G1 | PASS | A/B/C live past heartbeat window; 4 hidden conhosts, 0 visible |
| G3 | PASS | `A: remotes delivered (1 URL)`; `title=remotes` in A's project mailbox |
| G5 | PASS | A: `dialed/connected`; C: 3193 LISTENING + ESTABLISHED inbound |
| G6 | **PASS (after bug #2 fix)** | repeated `up` reports no `reconstituted` line; `startedAt` constant across up→down→up — see §7 |

Channel teardown/restore works: `down` removed 2 channel files → `incomplete`;
`up` restored them → `intact`.

## 7. Bugs found

### Bug #1 (FIXED) — wrong mailbox store in `repairIdentity`
`peers.ts` `repairIdentity` hard-coded the mailbox as
`os.homedir()/.mycc-store/sessions/<sid>/unread-lead.jsonl` (user store), but
the lead reads `<workdir>/.mycc/sessions/<sid>/unread-lead.jsonl` (project
store). Delivery via `mycc-mail` (which trusts `identity.json`) then appended to
a file the peer never reads → the remotes mail was silently lost.
**Fix:** `path.resolve(peer.workdir, '.mycc', 'sessions', sid,
'unread-lead.jsonl')` (mirrors `parent-context.ts:61`). Verified: A drained the
mail after the fix.

### Bug #2 (FIXED) — `repairIdentity` fired spuriously and clobbered live entries
**Symptom:** every `up` printed `identity repair pass: reconstituted 3 entries`
even when all peers were `live + match` and their entries already existed.

**Proof:** A's `startedAt` was rewritten on `up` from `1790760216535`
(17:23:36) → `1790761026649` (17:37:06) → `1790761086649` (17:38:06 ≈ the second
`up` run), i.e. it drifted on **every** `up`. B and C likewise. So live entries
were overwritten each time a reconcile ran.

**Non-destructive checks during the cycle (all good):** no `conhost` with a
visible main window (no popup); A/B/C kept the **same pids** (22468 / 11784 /
21260) across `down`+`up` (down without `--stop` correctly left them alive, and
`up` did not restart them).

**Root cause:** `repairIdentity` built `pending` for **every** fresh+live peer
(not only those with a *missing* entry), then unconditionally overwrote:
`for (const [sid, entry] of pending) map[sid] = entry;` and counted every present
sid as `repaired++`. Its own contract says it should only reconstitute peers
**with NO identity entry**, and "never clobber".

**Impact:** non-idempotent `up`; a healthy re-run mutated shared identity state
(and the misleading `reconstituted N` line masked it). `startedAt` drift also
corrupts any logic keyed on process age.

**Fix:** read the identity map once up front and **skip any peer whose sid is
already present** (`if (peer.sessionId in presentMap) continue;`) — so `pending`
holds only genuinely-absent sids; a present entry is never overwritten, and the
count reflects only real inserts.

**Verified:** `up` × 2 → no `reconstituted` line, A's `startedAt` unchanged;
full up→down→up → `startedAt` constant (`1790761086649`) across all three steps,
channels removed then restored (`incomplete` → `intact`).

**Residual (for code review):** `presentMap` is read once *before* the retry
loop, but L604 still does `map[sid] = entry` unconditionally for whatever stayed
in `pending`. A peer that registers *after* that single read but before the write
is still enqueued and overwritten — the original clobber, just narrower. The
retry loop's own re-read does not re-filter `pending` against `map`. Consider
re-checking `if (sid in map) continue/skip` inside the loop so the same-sid
read→write race is closed too.

## 8. Open questions / next gates

- G6 fix verification: after fixing bug #2, re-run `up → up` and assert the
  second `up` reports **0** repaired and no `startedAt` change.
- G7 (planned): `down --stop` → assert all peers terminate and heartbeat/stale
  identity is cleaned; then `up` re-launches cleanly (no held-sid refusal).
- G8 (planned): crash a peer (kill -9) → `up` → assert repair re-registers it
  correctly (the case `repairIdentity` is actually *for*).
