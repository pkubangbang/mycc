# Remotes — design decision

How `mycc-compose` declares and delivers **remote** peer connections: a local
peer that should dial one or more mycc instances running on *other* machines
(or other store roots) over the WebSocket peer-wire.

Status: implemented. Code anchors are cited inline (`file:line`); this document
is the normative rationale the code comments point at.

## Scope

`mycc-compose` already materializes **local** peers and the channels that wire
them together. A *remote* is different: compose cannot spawn it, cannot mint its
session id, and cannot write its channel files. All compose can do is tell a
local peer "you should dial URL X". Everything after that hand-off — the actual
`peer_connect`, sid discovery, and mailing — is driven at runtime by that peer's
own lead.

## Decision 1 — transport: mycc-mail mailbox append

**A peer's declared remotes are delivered to that peer by appending a mail to
its own mailbox via the `mycc-mail` CLI** (`scripts/mycc-mail/mycc-mail.js`).

Alternatives considered and rejected:

- *(a) A new bespoke carrier* (compose writes a `remotes/<sid>.json` file the
  peer polls). Rejected: introduces a second, parallel delivery mechanism with
  its own freshness/`unref` hazards, when the mailbox path already exists,
  already survives restarts, and already reaches exactly one live consumer.
- *(c) file-based `remotes/<sid>.json` read at boot* (the OLD option-(c) this
  doc supersedes). Rejected: boot-time-only delivery cannot carry a *changed*
  remote list to an already-running peer, and it duplicates state that the
  mailbox already owns.

The mailbox is the single, canonical, per-session delivery channel; remotes are
just another mail. The **lead's** mailbox path is computed at startup by
`ParentContext` as `path.resolve(getSessionDir(sid), 'unread-lead.jsonl')`
(`src/context/parent-context.ts`), where `getSessionDir(sid) =
path.join(MYCC_DIR, 'sessions', sid)` and `MYCC_DIR = '.mycc'`
(`src/config.ts`). Because `MYCC_DIR` is **relative**, `path.resolve` anchors it
on the peer process's **CWD** — which `mycc-compose` sets to the peer's declared
`workdir`. So the lead's mailbox is, in practice:

```
<workdir>/.mycc/sessions/<sid>/unread-lead.jsonl
```

e.g. `C:/Proj/mycc/.mycc/sessions/<sid>/unread-lead.jsonl`.

Delivery must target the exact path the peer reads. `mycc-mail` does **not**
recompute that path; it reads the `mailbox` field written into
`~/.mycc-store/discovery/identity.json` (a *claim* by whichever process last
wrote the entry) and appends there.

> **Fixed defect (2026-09-30):** `mycc-compose`'s `repairIdentity`
> (`scripts/mycc-compose/lib/peers.ts`) reconstituted a missing identity entry
> with a **hard-coded user-store mailbox**
> `os.homedir()/.mycc-store/sessions/<sid>/unread-lead.jsonl` — which is NOT the
> path the lead reads (`<workdir>/.mycc/sessions/<sid>/...`). When the repair
> pass ran, it overwrote a peer's correct mailbox with this wrong one, and
> `mycc-mail` then delivered to a file the peer never read. The repair value is
> now computed the same way the lead computes it — `path.resolve(peer.workdir,
> '.mycc', 'sessions', sid, 'unread-lead.jsonl')` — from the peer's `workdir`,
> not `os.homedir()`. (Regression guard: the two self-registered leads' mailbox
> fields are the reference — `<workdir>/.mycc/sessions/<sid>/unread-lead.jsonl`.)

Implementation: `remotesMailContent` composes the instruction
(`scripts/mycc-compose/lib/cmd-up.ts`); `deliverRemotes` spawns
`mycc-mail.js <sid> --title remotes --content <list> --from mycc-compose
--require-online` and reads its exit code.

## Decision 2 — liveness-before-send (fail-closed)

**Delivery is gated on the peer being provably live.** `mycc-mail` is invoked
with `--require-online`, which refuses to append (exit non-zero) unless **all**
of: the heartbeat is fresh, the recorded pid is alive, and a pid is recorded at
all. A mail appended to a dead peer's mailbox would sit unread forever and lend
a false sense of delivery; refusing is the honest outcome.

The gate lives in `scripts/mycc-mail/mycc-mail.js`
(`readHeartbeatPid` / `isPidAlive` / `isPeerRunning`); the send path dies with a
"liveness gate" error on refusal. Note the deliberate divergence: the gate
**refuses when no pid is recorded**, whereas `scripts/mycc-compose/lib/discovery.ts`
treats a missing pid as merely "not fresh". The standalone mailer is stricter
because it is about to *write*.

Compose calls `deliverRemotes` **after** the liveness-wait and `repairIdentity`
steps, so freshly-started peers pass the gate. If a peer is somehow not live,
compose prints a fail-loud row and **continues** — one peer's undelivered
remotes never abort the whole `up`.

## Decision 3 — declarative spec, runtime dial set

The spec stays **declarative**:

```jsonc
{
  "peers": [
    { "name": "A", "workdir": "C:/Proj/mycc", "args": "--auto",
      "remotes": ["http://127.0.0.1:3193"] }
  ]
}
```

`peers[].remotes?: string[]` is the only authored surface. The **live dial set
is owned by the peer's lead at runtime** (it calls `peer_connect` per URL) and
is **never persisted** by compose. Compose's job ends at handing the list to the
right mailbox; it does not model connections, cannot observe them, and does not
try.

### Validation invariants (`normalizeRemotes`, `validateSpec`)

Per URL / per peer:

- `remotes` must be an array of non-empty strings; absent/`[]` ⇒ no remotes.
- Each entry parses with an `http`/`https` scheme and a **non-empty authored
  host**. A bare `host:port` (no scheme) is accepted by prepending `http://`
  *for the check only*; the stored value keeps the author's form.
- A non-http scheme authored on the value (`ws://`, `ftp://`, …) is rejected
  **before** the `http://` prepend — otherwise `ws://h:1` would become
  `http://ws://h:1`, parse host `ws`, and pass while the author asked for `ws`.
- No duplicate URLs within one peer's list (compared via `remoteUrlKey`).
- **No self-dial**: a loopback host (`localhost`/`127.0.0.1`/`::1`) whose port
  equals *this* peer's explicit `--serve <port>`. Only an explicit numeric
  `--serve` is a reliable signal (a bare `--serve` leaves the port unknown). A
  non-loopback self-dial (the peer's own LAN IP) is not catchable here — the
  wire client's same-store sid filter (`wire-client.ts`) is the backstop.

Cross-peer:

- **Mutual-dial rejection** (`spec.ts:325`): a remote URL key may appear in **at
  most one** peer's list. If the same URL is declared by two peers, that is the
  practical mutual-dial signature for a 2-node spec — both sides would dial the
  same endpoint and the wire's pair-dedupe convergence would have to resolve it
  at runtime instead of the spec refusing it up front. (A richer "A dials B's
  URL and B dials A's URL" check needs each peer's own serve endpoint as
  identity, which the spec does not reliably carry; same-URL-across-peers is the
  sound catch-all.)

## Direction / dedupe

`remotes` is **one-sided**: it means "this peer dials URL Y", never "these two
peers dial each other". The one-sided form is what makes both the self-dial
check (Decision 3) and the cross-peer mutual-dial rule expressible at all: with
a declared dialer and a declared target, the spec can refuse `dialer == target`
and refuse `two dialers, one target`. The runtime consequence is intended:
`mycc-compose up` starts only the dialer side; the remote is someone else's
process, reached over the wire, not composed here.

## `up`-only, not `sync`

`deliverRemotes` runs only on `up` (`allowStop === true`), **not** on `sync`.
`sync` is the cron reconciliation path; re-appending the remotes mail on every
tick would flood the peer's mailbox with duplicate `[MAIL]` notes. `up` is the
initial bring-up — the one place a freshly-started peer needs the hand-off. A
peer skipped (already live + matching) on a later `up` simply receives a second
copy; that is harmless (the lead dedupes by processing the first), and it is how
a spec author pushes a *changed* remote list by re-running `up`.

## Why the instruction forbids ending on a question

The delivered mail is imperative and ends with a stop clause, not a question
(`remotesMailContent`). An `--auto` peer does not drain its mailbox while
parked at a question, so a mail that asks "shall I dial?" can stall the peer
forever. The instruction therefore says: dial each URL, report, stop — no
questions. This is the stall-immune shape.

## Evidence (sim)

Verified on a 3-peer sim (`A` dialer with `remotes`, `B` channel peer, `C`
standalone remote target):

- **G1** — daemon-wrapper launch: no blank terminal popup (4 new hidden
  `conhost`s, zero with a visible main window) AND peers survive the launcher
  (A/B/C all `live` past one heartbeat window after the launcher exits).
- **G3** — remotes delivery: `up` prints `A: remotes delivered (1 URL)`; A's
  mailbox (`<workdir>/.mycc/sessions/<sid>/unread-lead.jsonl`) gains a
  `title=remotes` line carrying the imperative no-question instruction.
- **G5** — the dial: A drains the remotes mail, then `peer_connect`s
  `http://127.0.0.1:3193`; A reports `direction: dialed, status: connected`, and
  C's acceptor side confirms port 3193 `LISTENING` with an `ESTABLISHED`
  inbound connection. The wire is up on both ends.

## See also

- [`remote-peer-protocol.md`](remote-peer-protocol.md) — the wire itself:
  dialer/acceptor roles, pair-dedupe, optional wire token, liveness.
- `scripts/mycc-compose/lib/spec.ts` (`normalizeRemotes`, `getRemotes`,
  `remoteUrlKey`), `scripts/mycc-compose/lib/cmd-up.ts` (`deliverRemotes`),
  `scripts/mycc-mail/mycc-mail.js` (`--require-online` gate).
