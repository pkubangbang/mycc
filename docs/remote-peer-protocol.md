# Remote Peer Wire Protocol — Design Plan

Status: **IMPLEMENTED** — all phases shipped (acceptor `src/serve/peer-wire.ts`, registry `src/peer/wire-registry.ts`, dialer `src/peer/wire-client.ts`, tools `peer_connect`/`peer_disconnect`/`peer_list`, facade wiring in `src/context/parent-context.ts` + `src/peer/peer.ts`); verified by `src/tests/serve/peer-wire.test.ts` (26 tests) + `src/tests/serve/peer-wire-smoke.test.ts` (live tmux two-instance smoke). Post-implementation DeepSeek peer review (2 rounds, converged APPROVE) drove three fixes reflected throughout this doc: (1) sid-scoped convergence census, (2) byte-aware sender-side oversize guard, (3) terminal loop disposal — see §5.

## 0. Problem & prior art in this repo

Two communication levels exist today:

| Level | Transport | Liveness | Scope |
|---|---|---|---|
| 1. lead ↔ teammates | IPC + session-dir mailbox files | process status | one machine, one instance |
| 2. peers, same machine | `~/.mycc-store/discovery/` files (identity.json + heartbeats + channels) | heartbeat file: beat every 30s, fresh within 90s | shared filesystem |

We are designing **level 3: peers on two machines**. Constraints from discussion:

- A naive `POST /mail` between instances requires **two-way reachability** — peers
  behind NAT/firewalls can't accept inbound connections, so they would be unreachable.
- Only peers with an **active webui** participate in the wire (webui = the server side).
- Cross-machine liveness is determined by **`GET /health`**, not the file heartbeat.
- `identity.json` records **local peers only** — never updated with remote peers.
- Keep the address space uniform so `mail_to` / `mycc-mail` work unchanged:
  the LLM should not care (or know) where a peer lives.
- Rejected earlier drafts: (a) push-then-poll with outbox/cursor + WireGuard-style
  cryptokey routing + flat unified id — too complex; (b) relay service — extra infra.
  The chosen design is a **single dialed WebSocket per peer pair** — one outbound
  connection gives a bidirectional pipe, which is the entire firewall story.

## 1. Architecture: dialer / acceptor over one WS connection

A WebSocket *client* is just an outbound TCP socket held in the lead's Node event
loop (like the existing 30s heartbeat timer or 5s channel poll — `peer.start()`
already proves the pattern needs no server). The dialed socket is
**bidirectional**: mail flows both ways over the connection the dialer opened.
Whoever can reach out, reaches out — a NAT'd instance never needs an inbound port.

```
A (no webui — maybe firewalled)                B (webui serving :3173)
      |--- GET /health ------------------->|   confirm serving mycc
      |--- WS upgrade  ws://B:3173/peer/ws ->|   acceptor (ServeHub)
      |       [ one socket, both hold it ]  |
A→B   |--- {mail} frame ------------------->|   B appends to own mailbox
B→A   |<-- {mail} frame --------------------|   A appends to own mailbox
      |<-- ping/pong keepalive ------------>|
```

### Roles and lifecycles (core invariant)

| Role | Lives in | Requires webui? | Gains |
|---|---|---|---|
| **Dialer** | `PeerManager` (wire-client member in the lead process) | **No** | send **and** receive over the socket it dialed |
| **Acceptor** | `ServeHub` (`/peer/ws` upgrade branch) | **Yes** | being reachable/discoverable |

Refined participation gate: **serving makes you reachable; dialing is free** (while the webui stays alive — see §7 liveness decision).
Only a webui instance can *accept* a connection; any instance (even behind NAT,
even without webui) can establish a fully bidirectional pair by dialing out.

Topology consequences (documented, accepted):
- no-webui + no-webui pair → no wire possible (neither side can accept);
- a no-webui instance is invisible (others can't find it) but works fine if it
  dials first;
- both-NAT'd pair (each behind its own NAT, neither reachable) → impossible in
  v1; a reachable third instance or a future relay would be required.

## 2. Connect workflow (peer_connect tool)

New tool `peer_connect(url)` — the lead calls it when the user says
"connect to a peer at 10.0.1.1:3173":

0. **Probe first, then pre-check** (round-1 finding G5 — the sid needed for
   the registry check is only yielded by the /health probe, so the order is
   probe → check → dial):
   1. `GET http://<host>:<port>/health` — verify a live mycc webui. The
      `/health` response gains a `peer` block returning `{sessionId, daemon}`
      (round-1 finding S2: `role` dropped — unused by the connect flow; no
      workDir — keeps the open endpoint lean). Unhealthy → informative
      error, stop.
   2. **Registry pre-check**: a live wire for this **endpoint** (previously
      dialed) OR for the **sid** the probe just yielded (previously accepted)
      → skip the dial and report "already connected" — sequential duplicate
      dials never create a second socket (pair-dedupe invariant, see §5).
      Endpoint matching only covers dialed wires; sid matching (post-probe)
      covers accepted ones — both sub-checks are needed and both run after
      the probe. **Known incompleteness** (round-2 minor): the sid sub-check
      only sees the peer's CURRENT sid — if the remote restarted since we
      accepted its wire, the pre-check misses and a second dial happens;
      that is acceptable because pair-dedupe layer 2 (§5 convergence) closes
      the duplicate. The pre-check is a fast path, not the invariant.
1.5 **Locality check (REFUSE local / self connects)**: the `/health` peer
   block yields the peer's sessionId. If it equals OUR OWN session id
   (self-connect) OR is present in the local `identity.json` (same discovery
   store → local peer), REFUSE the connect with a clear error. The wire
   exists ONLY for peers not reachable through the local discovery store:
   - a same-store peer already has a strictly better transport (direct
     mailbox append — no webui, no network; heartbeat freshness), and
     `mail_to` routes local-first, so a wire to it would never carry mail:
     dead weight + duplicate planes (double liveness, the peer listed in
     both sections of `peer_list`);
   - a self-connect degenerates pair-dedupe (both sockets share one sid →
     the lexicographic tie-break cannot resolve) and loops mail to self;
   - the boundary is STORE-based, not IP-based: the test is "is this sid in
     my identity.json / is it me", NOT "is the URL localhost". IP checks
     would wrongly forbid legitimate tunnel/alias setups and wrongly allow
     same-store peers via a non-localhost IP. Concretely: a `localhost` /
     `127.0.0.1` URL whose peer sid is NOT in the local identity store is
     ALLOWED — this is the VS Code Remote-SSH / remote-tunnel case, where a
     REMOTE machine's serve port is forwarded to localhost; that remote
     instance is not registered in this machine's identity.json, so the
     sid filter correctly passes it. "Local" in identity.json means
     "process runs on this machine", which is orthogonal to "URL host is
     localhost".
   Escape hatch for the two-instance smoke test: `--debug-wire` (mirrors
   `MYCC_WIRE_ALLOW_LOCAL=1`; test-only; never set in production).
2. Dial WS upgrade at `ws://<host>:<port>/peer/ws`. Because we dial out, this
   works even if we are the firewalled side.
2.5 **Self-dial backstop** (round-1 finding G4): the locality check (step 1.5)
   refuses self-connects at probe time, but announce-time is the
   belt-and-suspenders backstop — if an `announce` arrives carrying a sid
   equal to OUR OWN sid (a race the probe check missed), close the socket
   with `4000` immediately on both ends and surface a "cannot wire to self"
   error from the dial path. Without this, the initiator-sid election rule
   degenerates on a self-pair: min(sid,sid)=sid means BOTH sockets are
   "dialed by the smaller sid" → both survive → the exact dual-duplex
   state the invariant exists to prevent.
3. On open, send an **announce** frame `{sessionId, workDir, role?, daemon?}`;
   the acceptor replies with its own announce. Both sides now hold each other
   in an **in-memory remote registry**: endpoint-keyed
   `Map<endpoint, {sid, socket, meta, epoch}>` with a secondary sid index for
   the facade's route lookup. Registry entries are pruned in the socket's
   `onClose` handler on BOTH sides (accepted and dialed) — no leaked
   WebSocket objects.
   **Info-symmetry reminder (steering, round-3)**: the transport state lives
   in ctx, but the LLM's awareness lives in the conversation — auto-compact
   erases the latter, and on the acceptor side the LLM never had it at all
   (silent accept). So on wire establishment BOTH sides create a **pinned
   todo** (`ctx.todo.createTodo` + `pinTodo`) recording `remote peer <sid>
   at <endpoint> — wire, mail_to("<sid>/lead")`. Pinned + never-done keeps
   it re-injected through nudge cycles across compactions, and keeps it out
   of the ephemeral checklist auto-clear (a non-pinned never-done todo would
   block the checklist from ever clearing). Lifecycle follows the REGISTRY
   ENTRY, not the socket: a transient close with the capped-redial loop
   running keeps it; a terminal close (4000/4001/`peer_disconnect`) marks it
   done with the annotation "disconnected — re-run peer_connect", which
   stops the nagging but leaves the discovery hint visible in /todos. Not
   re-created on re-announce (dedupe by endpoint key). The acceptor reaches
   `ctx.todo` through the same injection pattern as the registry singleton
   (G3 — `src/serve` must not import ctx directly).
   **One registry, one owner** (round-1 finding G3): the registry lives as a
   module-level singleton in `src/peer` (accessed by ServeHub via the same
   injection pattern as `serve-registry.ts` `getServeHub()` — avoids the
   circular import `src/serve → src/peer → ctx`). Both the dialer and the
   acceptor write THE SAME map: an instance that only accepts has its entries
   there, an instance that dials likewise; the pair-dedupe invariant sees one
   view per pair. The registry accessor ships in Phase 2 (the acceptor needs
   it), not Phase 3.
4. `identity.json` is **never touched** — it stays the local-peers registry.
   The remote registry is process-lifetime and separate (endpoint-keyed per
   step 3; the sid field migrates on remote restart).

The accepting side needs no user action — it is already serving webui; it just
accepts the socket. But it is NOT a silent bystander to its own agent: the
inbound announce triggers the same pinned info-symmetry reminder todo
(§2 step 3), so the acceptor's LLM learns it can now `mail_to` the dialer.

### Disconnect workflow (peer_disconnect tool)

Hanging up must be a tool, and must be distinguishable from a network failure —
otherwise the peer that dialed (if it is the other side) sees a plain close
and its reconnect loop re-dials immediately.

- Argument: `url` (and also `sid` — round-1 finding S3: the sid form is
  what the `peer_list` tool displays, so it is what the LLM will naturally
  pass; lookup is sid-first with url fallback). Connect by url, disconnect
  by either; both resolve to the same registry entry.
- Action: send a clean WS close with custom code `4001 (bye)` → remove the
  local registry entry → **dispose** the pair's backoff loop (cancel the
  timer AND delete the `loops` map entry — terminal disposal per §5, so no
  stale redial state clings to the torn-down pair) and bump the pair epoch
  (a mid-flight dial that completes later checks epoch and aborts — no
  resurrection). `4001` tears down the WHOLE pair (all registry entries for
  that peer), not just one socket.
- Remote effect: on close `4001` → remove registry entry → do NOT re-dial
  (terminal, same handling as `4000`). Unilateral by design — either side can
  hang up, no handshake needed. **Asymmetry note**: when the ACCEPTOR sends
  4001, the dialer's loop is terminal too — after a serving-side hang-up,
  the NAT'd dialer CANNOT re-establish until someone runs `peer_connect`
  again on it. The dialer's next `mail_to` error must say
  "wire was disconnected (bye) — re-run peer_connect", not the generic
  offline text, or users will think the peer died.
- **In-flight mail is dropped with the wire, consistent with fail-fast
  semantics (at-most-once; the sending agent or human re-issues — see §4).
- **Reminder lifecycle**: terminal teardown (either side, 4000/4001) marks the
  pair's pinned reminder todo done — annotated "disconnected — re-run
  peer_connect" (§2 step 3). Pinned, so it stays visible in /todos as a
  re-connect hint instead of vanishing with the auto-clear.
- Distinct from `peer.stop()`, which is the process-exit bulk cleanup that
  closes all dialed sockets.

## 3. Local/remote state boundary

The two worlds are separated at the FILE layer; only mail_to crosses:

| State | Scope | Lives in |
|---|---|---|
| peer_list tool, `identity.json`, heartbeat files, channel files | **local peers only** — the wire never reads them for remote routing and never writes them | `~/.mycc-store/discovery/` |
| Remote peers (sid, endpoint, socket, meta) | **in-memory only, in ctx** (the remote registry held by the peer facade) | process lifetime |

- `mail_to("<sessionId>/lead")` is the ONLY shared surface: its facade call
  resolves local-first (discovery files) then remote (ctx registry). Nothing
  else in the local-peer stack learns about remote peers.
- The `peer_list` tool combines two sources at display time: local peers probed
  from the discovery store, plus a **clearly-marked remote section** read
  from the ctx registry — file probing (locals) + in-memory state (remotes).
  Remotes are labeled distinctly (separate section + explicit "remote"
  marker) so the LLM knows which mail_to plane each entry routes through;
  it does NOT merge remotes into identity.json or any discovery file.

## 4. Mail routing (local-first, then remote)

`mail_to("<sessionId>/lead")` keeps its exact current grammar and fail-fast
shape; only facade internals change. The delivery lemma is preserved: a delivery
= locate(sid) → append a JSONL line to `unread-lead.jsonl`. The append is
always performed by whoever can touch the mailbox — here the *receiver's* WS
handler appends to its **own** mailbox on an inbound `mail` frame.

- **Local-first**: `sendPeerMail(sid)` checks `identity.json` + heartbeat
  freshness (today's path, untouched).
- **Then remote**: if not local, look up the remote registry (endpoint-keyed,
  sid-indexed). Found + socket in OPEN state (check before every send;
  queued-but-not-OPEN → return false) → send a `mail` frame. The receiving
  side's handler appends to its own `unread-lead.jsonl` via
  `MailBox.appendMail` → the existing 1s `awaitTeammates` poll rouses
  AWAIT → COLLECT. **Zero agent-loop changes.**
- **Liveness**: local = heartbeat window (90s, unchanged); remote = socket
  state (open + ping/pong every 30s). `isFresh(sid)` becomes route-aware
  (same signature, implemented at the PeerModule facade: local branch →
  identity.json + heartbeat; remote branch → remote registry socket state),
  so mail_to's fail-fast validation carries over unmodified.
- **hasActiveChannel does NOT count remote wires** (round-1 review finding:
  counting them would silently engage auto mode at the prompt.ts:200 gate
  merely because a wire exists — a boundary violation: the local-peer
  stack would be learning about remotes through a behavior side effect.
  Remote mail still rouses AWAIT via the normal hasNewMails path).
- **Offline = fail-fast**: socket closed → `sendPeerMail` returns false →
  mail_to errors "remote peer not connected", mirroring local stale-peer
  behavior. No offline queueing. Note: this is **at-most-once** delivery —
  failure is LOSS; retry is NOT automatic (nothing in mail_to re-sends).
  The sending agent (or human) must re-issue.

## 5. Wire details

- **Frames**: `announce` (identity exchange on open), `mail`
  `{id, from, title, content, timestamp}` (either direction; receiver
  dedupes by `id` — see below). `ack` is **out of scope for v1** (round-1
  finding S1: delivery is already confirmed by observable state — the
  receiver's mailbox append rouses its AWAIT within 1s — and the sender's
  only failure mode is a send throw/socket-closed, which the reconnect loop
  surfaces; an ack layer would add a pending-map, timeouts, and a second
  dedupe surface for zero user-visible benefit). WS-level keepalive:
  the `ws` library auto-RESPONDS to pings but does NOT auto-SEND them —
  we implement a heartbeat timer that pings every 30s and TERMINATES the
  socket after N missed pongs (a half-open TCP stays 'OPEN' long after the
  peer dies; missed-pong terminate is what makes "socket state = liveness"
  reliable).
- **Mail frame id scheme + receiver dedupe** (round-1 finding: existing
  `generateMailId()` is 8 chars ≈ 41 bits — too small; `collectMails`
  does NOT dedupe). Wire mail ids use `<sender-sid>-<monotonic-seq>-<random>`
  (high entropy). The receiver's WS handler keeps an in-memory seen-id Set
  (bounded LRU) and drops duplicates BEFORE `appendMail` — duplicates never
  reach the mailbox.
- **Registry keyed by ENDPOINT, not sid** (round-1 finding: the doc keyed
  the registry by sessionId, yet pre-check/disconnect/re-connect all key by
  the stable endpoint — "endpoint is the stable thing; session-id follows
  it" — so endpoint is the map key and `sid` is a mutable field re-keyed
  from announces). Every socket has a per-pair **epoch token** bumped by
  connect/disconnect; the reconnect loop re-checks epoch before adopting
  a completed dial, so a disconnect mid-flight cannot resurrect the pair.
- **Single mailbox writer**: inbound mail frames go through
  `MailBox.appendMail` (mail.ts) — NOT a hand-rolled writer. The existing
  `appendMailToPath` duplication in channel.ts predates this plan; do not
  add a third writer.
- **Dedicated WebSocketServer, dedicated maxPayload** (round-1 finding G2):
  the existing `wsServer` caps inbound frames at `getMaxUploadMb() * 1024 *
  1024` (serve-hub.ts:290-291, default 50 MB) — a webui upload limit, not a
  peer-mail limit. `/peer/ws` gets its own `WebSocketServer` with its own
  generous-but-finite `maxPayload`, and a documented per-mail size cap:
  an oversize mail frame is REJECTED with a wire-level error back to the
  sender, NOT a 1009 connection close. (A 1009 close would be classified
  as a network error by the dialer — neither 4000 nor 4001 — triggering an
  infinite capped-backoff redial storm for a single undeliverable mail.)
  **Byte-aware sender-side guard (review finding 2)**: the cap is enforced
  on the SENDER side BEFORE sending — `sendWireMail` measures the
  `Buffer.byteLength` of the serialized frame (UTF-8), NOT the string's
  `.length` (character count). A multi-byte payload (CJK/emoji) can pass
  the char-count check while exceeding the byte cap; without the byte-aware
  measure the sender would emit the frame, the receiver's `ws` library would
  1009-close the connection (a network-class close the redial loop misreads
  as transient → infinite redial for one undeliverable mail). The sender-side
  fail-fast returns false WITHOUT sending, so the wire stays up and the
  sending agent learns the mail was too large.
- **Reconnect**: the dialer auto-re-dials with capped **exponential**
  backoff while the process lives. The loop is **pair-keyed and
  survivor-aware** (round-1 blocker B): before any redial it checks "do I
  already hold a live wire for this pair?" — a live survivor suppresses
  the loop regardless of which side dialed it. 4000/4001 terminality is a
  nicety; the survivor check is the correctness mechanism (a crashed peer
  yields close code 1006/abnormal, not 4000). On re-announce, the registry
  entry **updates its sid field** — when the remote restarts and gets a new
  session-id, the pairing migrates automatically. The loop's ONLY end
  conditions are 4000/4001 or `peer_disconnect` (round-1 finding G6) —
  a `peer_connect` to a peer that never comes back means a capped-redial
  loop for the process lifetime by design, and only `peer_disconnect`
  ends it; the doc states this so no implementer invents a silent
  max-attempts rule (dropping the entry would change mail_to's error from
  "not connected, retrying" to "unknown peer" — a worse failure mode for
  the LLM trying to reason about delivery).
  **Terminal vs non-terminal loop disposal (review finding 3)**: two
  distinct operations on the per-pair `loops: Map<endpoint, LoopState>` —
  `cancelLoop(endpoint)` clears the timer and sets `active=false` but
  LEAVES the map entry (used on non-terminal paths: survivor present,
  token-gone, pair-torn-down-while-pending — the entry may be re-armed by
  a later `scheduleRedial`); `disposeLoop(endpoint)` cancels AND DELETES
  the map entry (used on TERMINAL paths: 4001/bye, 4000-with-no-survivor,
  `peer_disconnect`) so no stale attempts/timer state clings to a
  torn-down pair. A reconnect after `disposeLoop` lazily re-creates fresh
  state via `scheduleRedial`. Without the delete, a stale `loops` entry
  would retain redial state for a pair that no longer exists.
- **Registry mutation rules** (round-1 finding G7): last-writer-wins keyed
  by (endpoint,sid), and close-pruning is **socket-identity-guarded** —
  a `close` event may only prune the entry whose stored socket object
  matches the closed socket, never just the map key. Sequence this guards:
  wire S dies; the redial S' arrives and re-announces BEFORE the old S's
  `close` event is processed (close processing can lag an accept); a naive
  key-based prune would delete the FRESH S' entry and regress the registry
  to "offline" until the next frame. The identity comparison makes the
  stale close event a no-op.
- **Edge cases**: simultaneous mutual dials → resolved by the pair-dedupe
  convergence rule below; remote restart with new sid → registry sid field
  re-keyed by announce; mail_to with the old sid fails fast with a clear
  error pointing at `peer_list`; **in-process `restartServe()`** (round-1
  finding G8) → stop() closes every accepted wire (abnormal close → dialer
  redials → re-announce → converges), but the sessionId does NOT change
  (same process) — no re-key, and no implementer should invent a
  sid-change path for it; **announce/close race** → covered by the
  socket-identity-guarded prune above; **acceptor webui auto-shutdown**
  (round-2 BLOCKER-1 consequence) → the acceptor's serve stack shuts down
  30s after its last human even with a live wire; the dialer sees abnormal
  close → redial → connection refused. The dialer's redial-failure error
  must distinguish "acceptor gone (process/webui down)" from a transient
  network blip (e.g. ECONNREFUSED vs ETIMEDOUT/ECONNRESET wording), or
  the sending agent cannot decide whether to keep retrying or surface to
  the user that the peer instance has shut down.
- **Security (v1)**: the shared token on the `/peer/ws` dial is
  **optional** (revised: operators apply security at OSI L3 — firewall /
  TLS reverse proxy / VPN / SSH tunnel — rather than inside mycc; the
  in-app token gate is an OPTIONAL additional layer). Token exchanged
  out-of-band, same value configured on both ends — set via the
  `MYCC_WIRE_TOKEN` env var or the `--wire-token <value>` CLI flag (alias).
  When `MYCC_WIRE_TOKEN` is set on the acceptor, a missing/mismatched token
  destroys the upgrade (HTTP 401); when unset on the acceptor, the
  endpoint is open and the operator is responsible for network-layer
  access control. The dialer sends the token only when it is set.
  **Token transport (review finding 3)**: the token travels as the
  `X-MYCC-Wire-Token` REQUEST HEADER on the WS upgrade, NOT a `?token=`
  query string — a query param would leak the shared secret into
  reverse-proxy access logs, HTTP debugging middleware, observability/
  tracing systems, and request-URL diagnostics, while a header is not
  echoed in request-URL diagnostics and is not logged by default in most
  access-log formats. An
  open `/peer/ws` IS a mailbox-injection surface if exposed
  uncontrolled — that is the operator's decision, not a mycc default
  failure. `/health` stays unauthenticated but only reveals the `peer`
  block `{sessionId, daemon}` (§2 step 1 — `role` dropped per S2; both
  sections now agree). No keypair infra — deliberately out.
- **Dialed socket is kept ref'd** (not `unref`'d): a headless `--auto`/
  daemon instance that has dialed out stays alive as long as the wire pair
  exists. `peer.stop()` (called by signal-handlers.ts:63/87 and
  agent-repl.ts:520 at shutdown, and by daemon-init.ts:68/81 on fatal
  daemon startup errors — pre-wire exits, harmless) closes AND unrefs
  dialed sockets so process-exit semantics are unchanged. Explicit exit
  still closes everything; the remote side prunes its registry on `close`.
  (Freshness-window line refs for the record: HEARTBEAT_INTERVAL_MS=30_000
  at identity.ts:28, FRESHNESS_WINDOW_MS=90_000 at identity.ts:39.)

### Pair-dedupe invariant (the dual-duplex fix)

**At most ONE wire per peer pair, ever.** With two serving peers, A→B and B→A
are both dialable — without this invariant the pair could end up with two
parallel sockets (dual-duplex), which is incoherent state, not a feature.
Three layers enforce it:

1. **Pre-dial check** (kills sequential duplicates): `peer_connect` consults
   the local remote registry first — a live wire for this endpoint means
   "already connected", no second dial happens.
2. **Deterministic convergence** (kills the simultaneous race): if both sides
   dial at the same moment, both checks pass and two sockets briefly exist.
   Each side, AFTER receiving the peer's `announce` (both announces are
   required before the rule can fire; an announce-loss timeout — treat as
   abnormal closure, let the survivor-check sort it out), computes the same
   winner:
   > the socket whose **initiator** (dialer) has the lexicographically
   > smaller sessionId survives; the peer whose sid is larger closes the
   > socket IT initiated, and the other side closes the socket IT accepted.
   Custom close code `4000 (superseded)` marks the loser. No clock, no extra
   frames, symmetric on both sides (same shape as WireGuard's
   simultaneous-open resolution).

   **Sid-scoped convergence census (review finding 1)**: the election groups
   by the **PEER SID every socket announced**, NOT by the endpoint key. A
   simultaneous mutual dial's two sockets may be keyed under DIFFERENT
   endpoint strings — the dialer keys by the URL string it typed
   ("127.0.0.1:3195"), the acceptor by the endpoint the peer ANNOUNCED
   ("192.168.1.20:3195" — a legitimate tunnel/alias split) — so an
   endpoint-scoped "both sockets of this pair announced" flag would silently
   no-op on the dual-duplex. The registry therefore keeps a secondary
   `socketsBySid: Map<sid, WireSocketInfo[]>` census; `convergePairBySid(sid)`
   groups across pair entries by peer sid, elects the winner (min
   initiatorSid), and closes every OTHER live socket announcing that sid
   with 4000. Pruning of the census happens in `pruneSocket`/`teardownPair`
   on the sockets' close events — convergence only closes sockets; their
   close handlers drive the entry cleanup (socket-identity-guarded, §5
   mutation rules).
3. **Receiver-side dedupe** by mail `id` (seen-id Set, above) covers the
   convergence window.

Close-code registry: `4000 (superseded)` and `4001 (bye)` are both TERMINAL
for the reconnect loop — no re-dial. Only network errors / abnormal closure
trigger capped-exponential redial — and even then only when no live survivor
exists for the pair (survivor check, above).

Directional symmetry remains a feature — whoever needs the link dials it
(the NAT'd side dials out); with pair-dedupe, that symmetry can no longer
produce a confused state.

## 6. Out of scope (v1, extension points noted in doc)

- Cross-machine **channels** (a `/peer/channel` handshake materializing the
  sibling channel file on the remote instance).
- Remote briefs in the `peer_list` listing (v1.1 piggyback on ping frames).
- Persisting the endpoint list for daemon auto-redial at boot
  (v1.1 `~/.mycc-store/wire/peers.json`).
- Relay/multi-hop routing for both-NAT'd pairs.

## 7. Files & phases

| Phase | File | Change |
|---|---|---|
| 1 — this deliverable | `docs/remote-peer-protocol.md` (this file) | Spec per this plan |
| 2 — acceptor | `src/serve/peer-wire.ts` (new) + `src/serve/serve-hub.ts` (small diff) | `/peer/ws` branch in the existing `upgradeHandler` (same pattern as `/ws`, registered in `start()` so `restartServe()` re-arms); **token verification on the upgrade is OPTIONAL** (revised: when `MYCC_WIRE_TOKEN` / `--wire-token` is configured the acceptor enforces it; when unset the upgrade is accepted openly — security at OSI L3, operator's responsibility); **acceptor isolation from webui lifecycle (round-1 finding G1, CRITICAL)**: peer sockets go in a SEPARATE `peerSockets` registry — the `/peer/ws` branch must NOT call `clients.add()` nor `disconnectTimer.cancel()` (onWsConnection does both today, serve-hub.ts:571-572), and its close path must NOT re-arm the disconnect timer — REJECTED alternative (would couple webui lifetime to a tenant): otherwise (a) one live peer wire pins `clients.size > 0` forever and the serve stack never auto-shuts-down after the last human leaves, or (b) a peer hangup becomes the event that tears down the webui 30s later. **Liveness decision (round-2 BLOCKER-1, resolved)**: a live peer wire does NOT sustain the serve stack — webui lifetime stays HUMAN-driven, unchanged. A serving instance whose last human leaves auto-shuts-down 30s later even with a live accepted wire: the wire drops with abnormal close, the dialer redials, and (acceptor process gone) the redial fails fast. This keeps the DisconnectTimer semantics untouched (no new liveness coupling) and is the honest reading of "webui = the human surface; the wire is a tenant, not a lifeline". Consequence for the topology promise: "serving makes you reachable" holds only while at least one human keeps the webui alive — an interactive (non-daemon) serving instance must not expect its wire to outlive its humans (a `--daemon` serving instance's stack is persistent by design — `shouldDaemon()` makes DisconnectTimer.start() a no-op, serve-disconnect-timer.ts:50 wired at serve-hub.ts:104 — so its webui and accepted wire DO outlive its humans); writes to the shared registry singleton (§2 step 3); inbound `mail` → seen-id dedupe → `MailBox.appendMail`; dedicated `WebSocketServer` + own maxPayload + oversize-mail rejection (§5); `/health` gains `peer` block; on inbound announce → shared-registry write + pinned info-symmetry reminder todo (§2 step 3, via the same G3 injection — `src/serve` must not import ctx directly). **Review fix**: convergence is sid-scoped via the registry's `socketsBySid` census (§5, review finding 1) — the acceptor's `recordAnnounce` registers each accepted socket under the peer sid it announced so `convergePairBySid` can elect across mismatched endpoint keys |
| 2 — dialer + tool | `src/peer/wire-client.ts` (new), `src/tools/peer_connect.ts` (new), `src/tools/peer_disconnect.ts` (new) | WS client (the `ws` package already in deps — no new deps), health probe + registry pre-check (endpoint + post-probe sid, §2 step 0) + locality check (§2 step 1.5) + announce-time self-sid backstop (§2 step 2.5), dial + announce + pair-keyed survivor-aware reconnect loop with exponential backoff and epoch guard, missed-pong terminate, OPEN-check before send, onClose prune (socket-identity-guarded); `peer_connect` + `peer_disconnect` tools registered in `builtInTools` (`src/context/shared/registry.ts`); `peer_connect` success writes the pinned info-symmetry reminder todo (§2 step 3). **Review fixes**: byte-aware sender-side oversize guard in `sendWireMail` (§5, review finding 2); `disposeLoop` for terminal close paths (§5, review finding 3) |
| 3 — facade | `src/peer/peer.ts`, `src/types.ts` | `sendPeerMail`/`isFresh` local-then-remote; **`isFresh` route-awareness implemented at the PeerModule facade (peer.ts), not only in identity.ts** — it currently delegates only to `IdentityManager.isFresh` (peer.ts:26-28), so remote sids would fail the mail_to fail-fast gate; `NoopPeerModule.isFresh` stays false; remote-registry singleton lives HERE (§2 step 3, written by Phase-2 acceptor via injection); `peer.stop()` closes AND unrefs dialed sockets (signal-handlers.ts:63/87 and agent-repl.ts:520 already call it); hasActiveChannel does NOT count remote sockets (see §4 leak note) |
| 3 — display | `src/tools/peers.ts` → rename tool to **`peer_list`** (steering: align with the `peer_connect`/`peer_disconnect` family pattern; new file `src/tools/peer_list.ts`, registered under the new name in `builtInTools`) | Two clearly-labeled sections: **local** peers (discovery-store probe) + **remote** peers (ctx registry) — sessionId, endpoint, connected, with an explicit "remote" marker so the LLM knows which mail_to plane each entry routes through (§3) |
| 4 — tests | `src/tests/serve/peer-wire.test.ts` + two-instance smoke test | Connect/announce, mail both directions incl. NAT'd-direction case, sid-change on restart, fail-fast when disconnected, pair-dedupe: sequential duplicate dial rejected + simultaneous mutual dial converges to ONE socket (initiator-sid rule, 4000 on the loser, announce-loss timeout), peer_disconnect: 4001 bye is terminal on both sides + whole-pair teardown + epoch guard (no resurrection by mid-flight dial), locality check (self-connect and same-store connect refused; escape hatch env for smoke test), missed-pong terminate, duplicate mail id dropped by seen-set, at-most-once loss documented; **round-1 additions**: (a) DisconnectTimer isolation — last human closes webui while a peer wire is live → serve AUTO-SHUTS-DOWN anyway (peer wires do NOT sustain the stack, §7 liveness decision) → accepted wire drops with abnormal close → dialer redials and fails fast with the acceptor-gone error; and conversely: last peer wire dropping must NOT tear down a webui with humans still on it; (b) oversize mail frame → rejected with error, connection stays alive (NOT a 1009-redial-storm); (c) self-dial rejected at probe AND at announce (backstop); (d) restartServe() with live peer wires → redial converges, sids unchanged; (e) dedupe pre-check catches a duplicate dial for a wire this instance ACCEPTED (sid-after-probe path); (f) duplicate mail id delivered on BOTH sockets of the convergence window is dropped exactly once by the seen-set. **Smoke-test scope note (round-2 minor)**: the two-instance smoke test runs on ONE machine sharing `~/.mycc-store/discovery/identity.json`, so with `MYCC_WIRE_ALLOW_LOCAL=1` it validates the TRANSPORT only, not the locality boundary — the locality-refusal path needs a unit test with an injected fake identity.json; **(g) info-symmetry reminder (steering)**: wire establishment creates the pinned todo on BOTH sides (sid + endpoint visible in printTodoList), terminal close (4000/4001) marks it done with the re-connect hint, a transient close with the redial loop running does NOT touch it, and re-announce does not duplicate it. **Review-fix regressions (DeepSeek peer review, round 1)**: (h) sid-scoped convergence fires across MISMATCHED endpoint keys (a mutual dial's two sockets keyed "127.0.0.1:3195" vs "192.168.1.20:3195" still elect one winner and close the loser 4000); (i) the oversize guard measures UTF-8 BYTES not chars (a CJK payload under the cap in characters but over in bytes is refused BEFORE sending, no 1009); (j) terminal disconnect disposes the redial loop state (the `loops` map entry is GONE after 4001, so a reconnect lazily re-creates fresh state and a second disconnect is clean) |

### Design-review notes

- **Scope**: dropping the push/poll/outbox ladder (earlier draft) deletes the
  entire Phase-2 complexity of that proposal. Trade: a live connection per peer
  pair (trivial at this scale) and no offline storage — accepted for uniformity
  with local stale-peer semantics.
- **Correlation**: `serve-hub.ts` already routes upgrades by URL (`/ws`), so
  `/peer/ws` is a small additive diff inside `start()`; `NoopPeerModule` and
  children stay untouched (remote mail lands in the lead mailbox);
  `src/tools/mail_to.ts` needs **no code change** — only facade internals move.
  `scripts/mycc-mail` stays file-only (local peers) by design.
- **Docs**: README feature list + MYCC.md key-concepts entry after implementation.