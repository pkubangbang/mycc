## Chore 6: The agent-driven wire + compose simulation test

### Background

On 2026-11-09 the peer-wire and `mycc-compose` suites were **deleted** — six
`peer-wire-*.test.ts` files plus their shared `peer-wire-harness.ts`, and
`mycc-compose-core` / `mycc-compose-runtime` (see Chore 5 for the mute-vs-remove
reasoning). That is ~20 s wall / 54 s test time in the default run, spent on
contracts that change perhaps twice a year.

What they covered is **not** covered now:

| Behaviour the deleted suites pinned | Where it is specified |
|---|---|
| Pair-dedupe: one live socket per pair, whichever side dialed it | `docs/peers/remote-peer-protocol.md` §5, §"Pair-dedupe invariant" |
| Survivor-aware reconnect: a live survivor suppresses the redial loop | §5 "Reconnect" |
| Sid migration on re-announce (remote restarted → new sid, same pair) | §5 "Reconnect" |
| Terminal vs non-terminal loop disposal (4000/4001 vs 1006 crash) | §5 "Terminal vs non-terminal loop disposal" |
| Byte-aware oversize guard on the SENDER side | §5 "Dedicated WebSocketServer, dedicated maxPayload" |
| Receiver-side dedupe by mail `id` before `appendMail` | §5 "Mail frame id scheme + receiver dedupe" |
| Convergence census scoped by sid | §5, design-review notes |

The replacement is deliberately **not** another in-process fixture. Six files of
mocked sockets approximated a system whose real failure modes are *timing and
identity*: a redial storm that only appears when backoff meets a dead port, a
dual-duplex pair that only appears when both sides dial at once, a sid migration
that only appears after a real process restart. A fixture can express none of
those without re-implementing the thing under test. So the replacement is one
**agent-driven long-running test**: real `mycc` processes, a real WebSocket pair,
composed from a spec file, driven by agent instructions, judged against observable
state rather than against a mock's call log.

This chore is the recipe. It is manual-and-supervised by design: it boots real
processes, spends real tokens, and mutates `~/.mycc-store/discovery`. Do not turn
it into a committed test — that is Chore 5's rule, and this suite is a superset of
the PTY problem (n processes, n models, real backoff timing).

### What it does and does not prove

**Proves** (each with a distinct observable in §"How to evaluate"):
- the wire establishes, carries mail both ways, and survives a peer restart;
- pair-dedupe and sid migration hold under a real restart;
- `mycc-compose` can materialise, report and tear down a group reproducibly;
- the oversize guard returns an actionable refusal instead of a redial storm.

**Does not prove:** the webui's human-facing behaviour (that is the peer-wire
smoke's old territory and belongs to a browser test), or anything about model
quality. The agents are couriers; their text is evidence of *delivery*, not of
intelligence. Keep prompts terse for exactly this reason.

### Topology

Three peers on one machine, plus a directed channel that is *not* the wire, so a
pass cannot be explained by the wrong transport winning.

```
        compose group "wt"   (spec file, no sessionIds — each boot mints its own)

   ┌──────────┐  wire  ┌──────────┐  wire  ┌──────────┐
   │  wt:alpha│<------>│  wt:beta │<------>│ wt:gamma │
   │ --serve  │  dial  │ --serve  │  dial  │ --serve  │
   │ :3181    │  once  │ :3182    │  once  │ :3183    │
   └────┬─────┘        └────┬─────┘        └──────────┘
        │                   │
        │  channel "ping"   │   (discovery/ file mailbox — the LOCAL path,
        └──────────────────>┘    so both transports are exercised in one run)
```

Why three and not two: two peers give one pair, and a single socket makes
pair-dedupe invisible. Three give three pairs, so "exactly one socket per pair"
and "a restart migrates the sid only for the pairs that peer owns" become
observable. Alpha↔beta is the wire under test; gamma exists to be a bystander, so
a restart of beta must NOT disturb the alpha↔gamma pair.

Why the channel: `mail_to` is local-first — it appends to the discovery channel
file before it ever touches the wire (`docs/peers/remote-peer-protocol.md` §4). A
test that only used channels would pass with the wire completely dead. Alpha→beta
mail is asserted on the **wire**, alpha→beta channel mail on the **file**, and the
evaluator distinguishes them by the receiving peer's report, not by timing.

All three peers run `--serve` (the wire requires an active webui on the acceptor
side), on distinct ports, `--auto` so no prompt waits for a human, and a small
`--token-threshold` so a runaway conversation compacts instead of costing
unboundedly.

### Kick-off

```powershell
$COMPOSE = "node scripts/mycc-compose/mycc-compose.js"
$STOP    = "node scripts/mycc-stop/mycc-stop.js"
$SPEC    = "wire-test-spec.json"      # written in step 1
& $STOP                               # clean baseline: expect "no running peers"
```

**Step 1 — author the spec** (repo root, gitignored; it names real ports):

```json
{
  "group": "wt",
  "peers": [
    { "name": "alpha", "workdir": "D:/dev/mycc",
      "args": "--auto --serve 3181 --skip-healthcheck --token-threshold 30000 --ollama-model glm-5.2:cloud" },
    { "name": "beta",  "workdir": "D:/dev/mycc",
      "args": "--auto --serve 3182 --skip-healthcheck --token-threshold 30000 --ollama-model glm-5.2:cloud" },
    { "name": "gamma", "workdir": "D:/dev/mycc",
      "args": "--auto --serve 3183 --skip-healthcheck --token-threshold 30000 --ollama-model glm-5.2:cloud" }
  ],
  "channels": [
    { "from": "alpha", "to": "beta", "label": "ping",
      "prompt": "You are {{from}}. Send {{to}} the single word READY over the channel, then stop." }
  ]
}
```

Spec rules that bite (from `docs/testing/mycc-compose-live-test-course.md`):
no `sessionId` key anywhere (even `null` is a hard error); no `--name` in `args`
(the launcher injects `--name wt:alpha`); `--auto` or `--daemon` is mandatory.

**Step 2 — validate, then start:**

```powershell
& $COMPOSE check $SPEC     # expect exit 0, all peers "stale", channel pair absent
& $COMPOSE up $SPEC        # expect exit 0, three peers launched
& $COMPOSE status $SPEC --json
```

Record the three `sessionId`s as `$SID_A`, `$SID_B`, `$SID_G`. They must differ.

**Step 3 — wire them.** The peers are running but know nothing of each other; the
wire is opened by an agent using `peer_connect`. Do it from a **fourth**, ordinary
mycc session (the "driver"), not from inside the peers — a peer that wires itself
would be testing its own tool, not the wire.

In the driver session, one instruction per line, waiting for the agent to report
between them:

```
peer_connect("127.0.0.1:3182")
peer_connect("127.0.0.1:3183")
peer_list
mail_to("<SID_B>/lead", "wire probe 1", "Reply with exactly: ACK <your sid>")
```

Then have beta answer over the wire — mail the instruction to beta itself, which
is the round-trip that matters:

```
mail_to("<SID_B>/lead", "instruction", "Use mail_to to send <SID_A>/lead the single word ACK. Then stop.")
```

**Step 4 — the restart leg (this is the regression the deleted suite guarded):**

```powershell
# Kill beta ONLY. Alpha and gamma must stay paired. --group and --name are
# spelled SEPARATELY (a joined "wt:beta" is a usage error, exit 2).
node scripts/mycc-stop/mycc-stop.js --group wt --name beta
& $COMPOSE status $SPEC --json     # beta live:false; alpha+gamma live:true
& $COMPOSE up $SPEC                # relaunch beta; it mints a NEW sid
& $COMPOSE status $SPEC --json
```

The new `$SID_B2` must differ from `$SID_B`. Then re-run the probe from the driver
session against `$SID_B2` — the dialer must have migrated the sid without a new
`peer_connect`.

**Step 5 — the oversize leg.** From the driver:

```
mail_to("<SID_B2>/lead", "oversize probe", "<paste ~5 MB of text>")
```

Expect the refusal message, not a dropped connection:
`the mail is too large for a single wire frame (split it or use a channel mailbox)`.
The cap is `WIRE_MAX_PAYLOAD_BYTES = 4 MiB` measured on the serialized UTF-8 frame
(`src/peer/wire-registry.ts:662`).

**Step 6 — tear down and prove the wire died:**

```powershell
& $COMPOSE down $SPEC
& $COMPOSE status $SPEC --json     # all live:false, channels absent
& $STOP                            # "no running peers"
```

### What to expect — time and tokens

Measured shape, not promises; the numbers are per peer and per model, so treat
them as a budget envelope rather than a benchmark.

| Leg | Wall time | Tokens (chat, all peers + driver) |
|---|---|---|
| `up` + boot to first prompt | 20–40 s per peer, overlapping | ~15–25k per peer (system prompt + project context + tool schema is paid once per turn, and this repo's context is large) |
| `peer_connect` ×2 + `peer_list` | 5–15 s | ~4–8k |
| Wire probe round trip (driver → beta → alpha) | 10–30 s | ~6–12k; each hop is a fresh turn on a fresh peer |
| Channel probe (`ping`) | 5–20 s (5 s channel poll) | ~3–6k |
| Restart leg (`stop` + `up` + status ×2) | 30–60 s | ~2–4k (mostly CLI, one re-probe) |
| Oversize leg | 5 s | ~1–2k (the refusal is a tool result, no model call) |
| `down` + verify | 5–10 s | ~0 |
| **Total** | **~2–4 minutes** wall; ~4–6 min with a cold model | **~50–100k token-hours** across processes, i.e. **~15–30 requests per peer** |

Set `--token-threshold 30000` on every peer so the long legs compact rather than
growing; with the default 100 000 a single sloppy reply chain can cost more than
the whole run. Budget **one** run per change to the wire or compose, and only when
that area was touched — this is not a per-commit suite, and the cost is the reason.

### How to evaluate the result

Judge on **observable state**, in this order. Any FAIL is a stop: fix, re-run from
`down`, do not layer a second run on a dirty store.

| # | Check | Observable | PASS | FAIL signal |
|---|---|---|---|---|
| 1 | Compose materialises the group | `status --json` after `up` | three peers `live:true, matching:true`; three distinct sids; channel `bothFilesPresent:true` | any `live:false` while the process is up; two equal sids |
| 2 | Wire established, one socket per pair | `peer_list` in the driver + alpha's `-v` log | each peer listed once per pair, no duplicate entries; no "dual-duplex" or pair-dedupe warnings | the same peer listed twice, or a log line about two live sockets for one pair |
| 3 | Mail crosses the wire | beta's report: it sent `ACK`; alpha reports receipt of a mail whose sender is `$SID_B/lead` | both directions observed | alpha receives nothing, or the mail arrives with a *local* sender id (it took the file path) |
| 4 | Receiver dedupe | alpha's mailbox for the probe mail | exactly one copy | two copies of the same `id` |
| 5 | **Sid migration after restart** | new `$SID_B2` ≠ `$SID_B`, then a probe to `$SID_B2` | mail arrives; `peer_list` shows the pair under the new sid; **alpha↔gamma undisturbed** | probe fails with "unknown-sid"; or gamma's pair also broke (that is the survivor check inverted) |
| 6 | No redial storm | `-v` logs of alpha during the beta downtime | backoff lines capped at 30 s (`BACKOFF_CAP_MS`), one loop per pair | a flood of retries at < 1 s, or retries for gamma too |
| 7 | Oversize is a refusal, not a close | driver's `mail_to` reply | `too large for a single wire frame`; wire still open afterwards (probe 3 again succeeds) | a 1009 close, "the wire closed while the mail was being sent", or the connection flapping afterwards |
| 8 | Teardown is complete | `status --json` + `mycc-stop` | all `live:false`, channels gone, `no running peers` | a leftover identity entry or channel file (that is Chore 4 territory) |

**Failure taxonomy — name the class before fixing:**

- *Transport* (checks 2, 6, 7): registry, dedupe, backoff, payload. The design doc
  §5 is the spec; a fix here needs a §5 paragraph update.
- *Identity* (checks 1, 5): sid, durable name, migration. `docs/pr/compose-name-identity.md`
  is the reference.
- *Compose* (checks 1, 8): the launcher or the store, not the wire. Compare against
  `docs/testing/mycc-compose-live-test-course.md`.
- *Agent noise* (a peer "refuses" or answers oddly): not a FAIL of the system —
  re-issue the instruction with a terser prompt before concluding a defect.

### Verify the cheap substitutes always run

The default suite keeps the parts assertable without a socket:

```bash
npx vitest run src/tests/peer/ src/tests/tools/peer_list.test.ts
```

If a wire or compose change is made, the manual run above is the only proof that
the pair actually carries mail.

### Rollback

`& $COMPOSE down $SPEC` then `& $STOP`. If a peer survives, remove its identity
entry and channel files per Chore 4 (`04-discovery-reclaim.md`) — do not hand-edit
`identity.json` while a process may still be beating.

### Rules

- **One run per change, not per commit.** The cost table is the argument.
- **Never let the peers be their own judges.** The driver session issues the
  probes; the peers only perform them.
- **Keep the spec out of git.** It names ports and a model; port collisions on a
  shared machine are the most common false failure.
- **Record the run in this file** (date, commit, PASS/FAIL per row, and any FAIL
  class) so the next person knows the wire was last proven at that revision.
