# mycc-compose — live test course (end-to-end lifecycle)

*Design by peer instance session `c5f82a19-c876-48fe-895d-07f7be527801`
(glm-5.2:cloud), confirmed by the lead of session
`570d6593-388a-4494-a6f8-782701df76a9`. Status: **EXECUTED — all 6 stages
PASS on 2026-10-14** (see "Execution record" at the end).*

A runnable, verifiable exercise of the `mycc-compose` lifecycle on this machine:
2 peers, 1 directed channel, a full **up → workload → down → re-up → down**
cycle. Every stage lists the **exact command(s)**, the **expected observable**
that proves it worked, and the **failure signal** that indicates a bug.

Workdir is `C:/Proj/mycc` for both peers (same repo, different durable names —
legal: identity is the NAME axis, not the workdir). Model is pinned to
`glm-5.2:cloud`.

> `<SPEC>` = `test-course-spec.json`, authored at the repo root in Stage 1.
> `<STORE>` = `~/.mycc-store/discovery` (holds `identity.json`, `heartbeat/`,
> `channels/`). Commands are PowerShell.

---

## Prelude — shell variables + clean baseline

Set up once before Stage 1:

```powershell
$COMPOSE = "node scripts/mycc-compose/mycc-compose.js"
$STOP    = "node scripts/mycc-stop/mycc-stop.js"
$STORE   = "$HOME/.mycc-store/discovery"
$SPEC    = "test-course-spec.json"
```

Baseline check (proves a clean start — no leftover peers from a prior run):

```powershell
& $STOP        # bare list form; expect "no running peers"
```

- **Expected:** bare `mycc-stop` lists nothing.
- **Failure signal:** a live `tc:alpha`/`tc:beta` already exists → a prior run did
  not clean up; run Stage 6 first.

---

## Stage 1 — Topology authoring

Write `test-course-spec.json` at the repo root:

```json
{
  "group": "tc",
  "peers": [
    { "name": "alpha", "workdir": "C:/Proj/mycc",
      "args": "--auto --skip-healthcheck --ollama-model glm-5.2:cloud" },
    { "name": "beta",  "workdir": "C:/Proj/mycc",
      "args": "--auto --skip-healthcheck --ollama-model glm-5.2:cloud" }
  ],
  "channels": [
    { "from": "alpha", "to": "beta", "label": "ping",
      "prompt": "You are {{from}} in channel {{label}}. Send a one-line hello to {{to}} and confirm the mail path works." }
  ]
}
```

Schema notes:
- **No `sessionId` field anywhere** — a present key (even `null`) is a hard
  validation error; each peer mints its own sid per boot.
- `--name` is **not** in `args` — the launcher injects `--name tc:alpha` /
  `--name tc:beta` from `peers[].name`.
- `args` MUST contain `--auto` or `--daemon`; the model rides in `args` (there is
  no `model` field).
- `label` `"ping"` is filename-safe and unique; `channelId = "ping"`.
- `prompt` uses `{{from}}/{{to}}/{{label}}`; the reply contract is auto-appended
  (the prompt has no `mail_to(` instruction).

- **Command:** `& $COMPOSE check $SPEC`
- **Expected:** validation passes; `alpha` + `beta` reported `stale` (not
  running); channel `ping` file-pair absent. Exit 0.
- **Failure signal:** exit 1 (malformed spec) or exit 2 (usage).

---

## Stage 2 — Initial startup (`up`)

- **Command:** `& $COMPOSE up $SPEC`
- **Expected:** exit 0; report says both peers launched + channel pair
  materialized.

**Verify — three independent observables:**

(a) Peers live, resolved by name, with fresh sids:

```powershell
& $COMPOSE status $SPEC --json
```

Expect `group:"tc"`; `peers` = `[{name:"alpha", sessionId:<uuid1>, live:true,
matching:true}, {name:"beta", sessionId:<uuid2>, live:true, matching:true}]`;
`channels` = `[{label:"ping", bothFilesPresent:true, attribution:"by-name"}]`.
**Note the two sids** (`SID_ALPHA`, `SID_BETA`) — they must **differ**.

(b) `identity.json` has both entries keyed by sid, with durable names:

```powershell
Get-Content "$STORE/identity.json"
```

Expect two keys (`SID_ALPHA`, `SID_BETA`); each entry has
`name="tc:alpha"` / `name="tc:beta"`, `workDir` = the repo path, a numeric
`pid`, and `startedAt`.

(c) Channel file pair exists, one per participant, suffixed by label:

```powershell
Get-ChildItem "$STORE/channels" -Filter "*ping*"
```

Expect exactly TWO files: `<SID_ALPHA>-ping.json` and `<SID_BETA>-ping.json`.
Each carries `channelId:"ping"`, `title:"tc-ping"`, `ownerName`/`peerName`
(mirrored), `joined:false`, `firstQuerySent:false`, and a `firstQuery` with the
substituted prompt + auto-appended reply contract.

- **Failure signals:** `live:false` (launch timeout); `bothFilesPresent:false`
  (materialization failed); `attribution:"absent"|"legacy"` (not found by name —
  should be `by-name`); identity entry lacks `name` (launched without `--name`);
  only ONE channel file (mirror not written).

---

## Stage 3 — First workload (message over the channel)

The channel's `firstQuery` is auto-delivered to each peer's mailbox on its first
channel poll (5s). `alpha`'s prompt tells it to send a one-line hello to `beta`.
This stage **proves the peers actually talk**.

- **Command (wait ~30s for the poll + an LLM turn, then observe):**

```powershell
Start-Sleep 30
& $COMPOSE status $SPEC --json
```

- **Expected:** `lastBrief` on `beta` (and possibly `alpha`) is now non-null —
  the peers processed their firstQuery and replied via `mail_to`.
- **Stronger verification:** the receiving peer's session dir
  (`.mycc/sessions/<SID_BETA>/`) should contain a `[MAIL]` note from `alpha` and
  an assistant turn that called `mail_to(name="<SID_ALPHA>/lead", ...)` — the
  concrete proof the channel carried a message **both ways**.
- **Failure signals:** `lastBrief` stays null on both after 60s (firstQuery not
  delivered, or the LLM did not run); a `[MAIL]` note appears but no reply
  `mail_to` (reply contract not honored — prose instead); wrong/stale target sid
  (channel cross-fill incorrect).

---

## Stage 4 — Down

- **Command:** `& $COMPOSE down $SPEC`
- **Expected:** exit 0 (all stopped); report lists each peer's verdict
  (`stopped` / `already-stopped`) and the removed channel files.

**Verify — three observables:**

(a) Peers gone:

```powershell
& $STOP        # bare list → expect "no running peers"
& $COMPOSE status $SPEC --json   # peers live:false / sid stale; channels bothFilesPresent:false
```

(b) Channel files removed (R1 by-name):

```powershell
Get-ChildItem "$STORE/channels" -Filter "*ping*"   # expect NO files
```

R1 deletes them because `channelId="ping"` is in the spec labels AND
`ownerName`/`peerName` (`tc:alpha`/`tc:beta`) are in the spec name-set.

(c) `identity.json` entries culled **for successfully-stopped peers**:

```powershell
Get-Content "$STORE/identity.json"
```

Expect the two entries (`SID_ALPHA`/`SID_BETA`) GONE. Note: culling is
evidence-gated — a peer whose stop was **refused** keeps its entry (death
unproven), so on the happy path both are removed.

**Exit-code semantics:**
- exit **0** = all peers stopped (`stopped` / `already-stopped`; and
  `refused-not-found` counts as "nothing to stop").
- exit **1** = a stop was REFUSED (`refused-*` / `still-up`) — never silent
  success.

- **Failure signals:** exit 1 on the happy path (investigate the verdict; do not
  re-up); channel files remain (R1 attribution failed); identity entries remain
  (cull blocked by a refusal); bare `mycc-stop` still lists a peer while `down`
  exited 0 (**BUG**: refusal treated as success).

---

## Stage 5 — Re-up (same names, fresh sids)

- **Command:** `& $COMPOSE up $SPEC`
- **Expected:** exit 0; both peers back. CRITICAL: their sids are **NEW**
  (different from `SID_ALPHA`/`SID_BETA`) — identity is the durable name, not the
  sid.

**Verify:**

```powershell
& $COMPOSE status $SPEC --json   # capture SID_ALPHA2, SID_BETA2
& $COMPOSE check $SPEC           # expect both `match`
```

- Names stay `alpha`/`beta`; `live:true`, `matching:true`.
- `SID_ALPHA2 != SID_ALPHA` AND `SID_BETA2 != SID_BETA` — the core
  identity-vs-sid invariant.

Channel re-materialization:

```powershell
Get-ChildItem "$STORE/channels" -Filter "*ping*"
```

Expect TWO files again, now `<SID_ALPHA2>-ping.json` / `<SID_BETA2>-ping.json`
(new sid prefixes, SAME label). The old Stage-2 files must **not** reappear.

Restarted-peer re-join: after ~30s, `status --json` shows `lastBrief` non-null
again — the restarted peer re-joined, received its firstQuery, and ran.

- **Failure signals:** a sid matches the Stage-2 sid (sid reuse — BUG); channel
  files carry the OLD sid prefix; `live:false`; `bothFilesPresent:false`.

---

## Stage 6 — Final tear-down

- **Command:** `& $COMPOSE down $SPEC`
- **Expected:** exit 0; same observables as Stage 4, with the Stage-5 sids.

**Final confirmation — no live peers, no owned channel files:**

```powershell
& $STOP                                             # (a) expect "no running peers"
Get-ChildItem "$STORE/channels" -Filter "*ping*"    # (b) expect no files
Get-Content "$STORE/identity.json"                  # (c) no name tc:alpha / tc:beta
& $COMPOSE status $SPEC --json                      # (d) peers live:false; channels absent
```

- **Failure signals:** bare `mycc-stop` lists any `tc:*` peer (a peer survived
  `down` — **BUG**); any `*ping*` file remains (R1 failed on the second down);
  exit 1 (a refusal on teardown).

---

## Summary — the invariant each stage proves

| Stage | Invariant |
|---|---|
| 1 | Spec is valid; NO `sessionId`; `--name` is launcher-injected, not authored. |
| 2 | `up` launches by name, resolves fresh sids, writes identity entries **with names**, materializes a channel pair (both files, `by-name`). |
| 3 | The channel actually carries a message (firstQuery → mailbox → LLM → `mail_to` reply) — peers talk. |
| 4 | `down` stops by name, removes channel files by-name (R1), culls stopped peers' identity entries; exit 0 = all stopped, 1 = a refusal (never silent success). |
| 5 | Re-up brings peers back under SAME names with NEW sids; channels re-materialize under new sid prefixes; old files do not reappear. |
| 6 | Final `down` leaves zero live peers (bare `mycc-stop` confirms) and zero owned channel files. |

## Optional edge probes (not in the happy path)

- **Refusal ⇒ exit 1:** manually kill one peer's pid before `down` so a recycled
  pid owns the number → expect `refused-recycled-pid` → exit 1 (proves a refusal
  is not success). *(Exercises the `still-up`/refusal branch flagged by the code
  review as under-tested.)*
- **Poll clobber:** hand-edit a channel file's `joined:true` before `down` → the
  5s poll clobbers it (documented pitfall); `down` still removes it by name.
- **Reverse link:** add `{ "from": "beta", "to": "alpha", "label": "pong" }` to
  exercise the opposite direction (channels are directed; the tool does not
  auto-create the reverse).
- **Two worktrees:** point `beta` at a second worktree to exercise
  workdir-qualified matching (the happy path uses one shared workdir).

---

## Execution record — 2026-10-14

Run by the lead of session `570d6593-388a-4494-a6f8-782701df76a9`, against the
live store on this machine, with two **unrelated** peers (`570d6593`,
`c5f82a19`) already running in the same workdir — the course group `tc` was
chosen so teardown could not touch them. **All six stages PASSED.**

| Stage | Command | Observed | Verdict |
|---|---|---|---|
| 1 | `mycc-compose check test-course-spec.json` | `Spec OK (group "tc", 2 peers, 1 channels)`; both `stale`, channel `incomplete`; exit 0 | ✅ PASS |
| 2 | `mycc-compose up` | both `live:true, matching:true`; sids `80446dc2…`/`dd02bc41…` (distinct); `identity.json` has `tc:alpha`/`tc:beta`; exactly 2 `<sid>-ping.json` files, `by-name`; exit 0 | ✅ PASS |
| 3 | `status --json` after ~35s | `alpha.lastBrief`: *"Ping channel confirmed working bidirectionally. Sent hello to beta, received hello-from-beta, and replied with an ack."* — a two-way round-trip | ✅ PASS |
| 4 | `mycc-compose down` | `alpha: stopped`, `beta: stopped`; culled 2 entries; removed 2 channel files; exit 0; the two pre-existing peers untouched | ✅ PASS |
| 5 | `mycc-compose up` again | `alpha: start`, `beta: start`; **fresh** sids `3714d719…`/`743ec56a…` (≠ stage 2); channels re-materialized under the new prefixes; both peers re-joined (both `lastBrief` non-null; `beta` names `alpha`'s new peer sid); exit 0 | ✅ PASS |
| 6 | `mycc-compose down` (final) | both stopped; 2 culled; 2 removed; exit 0; bare `mycc-stop` shows **no** `tc:*` peers; no `*ping*` files; no `tc:*` identity entries; pre-existing peers intact | ✅ PASS |

### Notes from the run

- **Spec never mutated:** `test-course-spec.json` was byte-identical before and
  after every `up` (no `sessionId` write-back) — hash `88c2fd85…`.
- **`beta: skip (live + match)` on the second `up` (stage 2):** the first `up`
  invocation hit a 60s foreground timeout and was killed **after** it had already
  launched both peers (heartbeat files created 16:48:01–04); the re-run correctly
  found them live+matching and skipped. This is a benign re-run, **not** an
  up-logic bug — no pre-baseline `tc:*` entry existed (baseline was clean).
- **Isolation held:** the pre-existing peers `570d6593` and `c5f82a19` were
  present in `mycc-stop` (bare) before and after the whole course, proving the
  `tc` group's `down` (R1 by-name) never matched them.
- **Peer-observed quirk (not a channel defect):** both course peers independently
  reported that the platform's `[Channel: …] channel-init` reply target
  `"system"` is **not a routable `mail_to` recipient**. They correctly skipped it
  and reached the real peer instead. Worth noting as a UX papercut in the
  channel-init note, not a compose bug.

