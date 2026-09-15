/**
 * wire-registry.ts - Remote peer wire registry (level-3, cross-machine)
 *
 * Module-level singleton holding every REMOTE peer this instance knows about,
 * whether dialed by us (outbound WS client, src/peer/wire-client.ts) or
 * accepted by our serve stack (inbound WS on /peer/ws, src/serve/peer-wire.ts).
 * Process-lifetime, in-memory only — the plan (docs/remote-peer-protocol.md
 * §3) forbids persisting remotes into ~/.mycc-store/discovery: the wire
 * exists ONLY for peers not reachable through the local discovery store, so
 * remotes live in ctx, not in files.
 *
 * Ownership (plan §2 step 3, "one registry, one owner"):
 *   - The registry lives here in `src/peer` as a singleton — the SAME map
 *     written by both the dialer and the acceptor (via the WireHooks
 *     injection). `src/serve` touches the wire plane ONLY through this
 *     module, avoiding the circular import src/serve → src/peer → ctx
 *     (round-1 finding G3).
 *
 * Keying (plan §5): pair entries are keyed by ENDPOINT — "endpoint is the
 * stable thing; session-id follows it" — with `sid` as a MUTABLE field
 * re-keyed from announces (a remote restart yields a new sid; the pairing
 * migrates automatically on re-announce). The endpoint key is:
 *   - the serving address we DIALED, for dialer-side entries ("host:port");
 *   - the peer's ANNOUNCED serving endpoint for accepted entries; or
 *     "sid:<sid>" when a NAT'd/non-serving dialer announces no endpoint.
 * A secondary sid index serves the facade route lookup (sendPeerMail/
 * isFresh resolve by sid) and peer_disconnect's sid-first resolution.
 *
 * Convergence window (plan §5, pair-dedupe layer 2): a pair entry normally
 * holds ONE socket; during a simultaneous mutual dial it transiently holds
 * TWO. Each side, after both announces are received, computes the same
 * winner (the socket whose initiator has the lexicographically smaller sid)
 * and closes ITS loser socket with 4000 (superseded). The entry converges
 * back to one socket.
 *
 * Registry mutation rules (plan §5, round-1 finding G7): last-writer-wins
 * per endpoint; close-pruning is SOCKET-IDENTITY-GUARDED — a close event may
 * only prune the socket info whose stored socket object matches the closed
 * socket, never just the map key. This guards the announce/close race: wire
 * S dies; the redial S' arrives and re-announces BEFORE old S's close event
 * is processed; a naive key-based prune would delete the FRESH S' entry.
 *
 * Info-symmetry reminder (plan §2 step 3, steering round-3): on wire
 * establishment BOTH sides record a PINNED todo (via WireHooks) so the LLM's
 * awareness of the remote survives auto-compaction. Lifecycle follows the
 * PAIR ENTRY, not the socket: terminal teardown (4000/4001/peer_disconnect)
 * marks the todo done; a transient close with the redial loop running keeps
 * it. Deduped by endpoint.
 */

import type { WebSocket } from 'ws';

/** Wire-level close codes (plan §5 close-code registry).
 *  Both are TERMINAL for the reconnect loop — no re-dial. */
export const WIRE_CLOSE_SUPERSEDED = 4000;
export const WIRE_CLOSE_BYE = 4001;

/** Per-socket info inside a pair entry. `initiatorSid` is the sid of whoever
 *  DIALED this socket (my sid for my dialed socket; the peer's announced sid
 *  for a socket I accepted) — the convergence winner rule compares these. */
export interface WireSocketInfo {
  socket: WebSocket;
  /** Peer session id as announced ON this socket. */
  sid: string;
  /** Sid of the instance that DIALED this socket. */
  initiatorSid: string;
  /** True when the peer's announce has been received on this socket. */
  announceReceived: boolean;
  /** Peer announce metadata — display only. */
  meta: { workDir?: string; role?: string; daemon?: boolean };
}

/** A remote peer pair. Normally one socket; transiently two during a
 *  simultaneous mutual dial (convergence window, plan §5). */
export interface RemotePairEntry {
  /** Stable pair key: dialed/announced serving endpoint, or "sid:<sid>". */
  endpoint: string;
  /** True when WE dialed this endpoint (the reconnect loop owns it). */
  dialed: boolean;
  /** Most-recent peer sid announced on any live socket of the pair. */
  sid: string;
  /** The pair's sockets — 1 normally, 2 in the convergence window. */
  sockets: WireSocketInfo[];
  /** Per-pair epoch token (bumped by connect/teardown). The reconnect loop
   *  re-checks epoch before adopting a completed dial so a disconnect
   *  mid-flight cannot resurrect the pair (plan §5). */
  epoch: number;
}

/**
 * Hooks the wire plane needs from the agent context — injected once by
 * ParentContext at startup (setWireHooks). Kept as an interface so
 * src/serve/peer-wire.ts consumes them without importing ctx (G3).
 */
export interface WireHooks {
  /** This instance's own session id (announce + self-dial backstop). */
  getSessionId(): string;
  /** This instance's workDir (carried in our announce frame). */
  getWorkDir(): string;
  /** Daemon flag for our announce frame. */
  getDaemon(): boolean;
  /** Optional role label for our announce frame. */
  getRole(): string | undefined;
  /** OUR serving endpoint "host:port" when the webui is running, else null
   *  (a NAT'd/non-serving instance announces no endpoint). */
  getServingEndpoint(): string | null;
  /**
   * Create (or refresh) the pinned info-symmetry reminder todo for a remote
   * peer. `done=true` marks the terminal "disconnected — re-run
   * peer_connect" state. Implemented by ParentContext against ctx.todo;
   * dedupes by endpoint (note key). Never throws.
   */
  recordRemotePeerTodo(entry: { sid: string; endpoint: string; done: boolean }): void;
  /** Append an inbound mail frame's payload to OUR OWN mailbox — the single
   *  mailbox writer (MailBox.appendMail), never a hand-rolled writer (§5). */
  appendLocalMail(from: string, title: string, content: string): void;
  /** Verbose log routed to agentIO (the wire plane owns no console). */
  verbose(tool: string, message: string, data?: unknown): void;
}

// ── Singleton state ────────────────────────────────────────────────────────

const pairs = new Map<string, RemotePairEntry>();
/** Secondary index: peer sid → endpoint key (most-recent announce wins). */
const sidIndex = new Map<string, string>();
/**
 * Sid-scoped socket census for convergence (review finding: endpoint-key
 * mismatch). A simultaneous mutual dial may key its two sockets DIFFERENTLY
 * (the dialer keys by the URL string it typed; the acceptor by the peer's
 * ANNOUNCED endpoint — "127.0.0.1:3195" vs "192.168.1.20:3195" is a
 * legitimate tunnel/alias split, plan §2 step 1.5), so endpoint-scoped
 * bothAnnounced can silently no-op. Convergence therefore groups by the
 * PEER SID every socket announced, across pair entries: one live socket per
 * sid is the invariant; a second socket announcing the same sid is OUR half
 * of a dual-duplex, wherever it was keyed.
 */
const socketsBySid = new Map<string, WireSocketInfo[]>();
/** Per-pair epoch counters — survive entry prune so a LATE dial completion
 *  checks against the LATEST epoch and aborts (no resurrection). */
const epochByEndpoint = new Map<string, number>();

let hooks: WireHooks | null = null;

export function setWireHooks(h: WireHooks): void {
  hooks = h;
}

export function getWireHooks(): WireHooks | null {
  return hooks;
}

// ── Mail frame id scheme (plan §5) ─────────────────────────────────────────

/**
 * High-entropy wire mail id: `<sender-sid>-<monotonic-seq>-<random>`.
 * MailBox's generateId() is 8 chars ≈ 41 bits — too small for wire dedupe
 * (a collision would silently drop a legitimate mail as a "duplicate");
 * the sender-scoped monotonic sequence plus a random suffix makes an
 * accidental collision practically impossible.
 */
const seqBySid = new Map<string, number>();
export function generateWireMailId(senderSid: string): string {
  const seq = (seqBySid.get(senderSid) ?? 0) + 1;
  seqBySid.set(senderSid, seq);
  return `${senderSid}-${seq}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Seen-id dedupe (receiver side, plan §5) ────────────────────────────────

/**
 * Bounded LRU of mail frame ids this instance has already delivered.
 * collectMails does NOT dedupe, and a convergence-window mail may arrive on
 * BOTH sockets of a pair — the receiver drops duplicates BEFORE
 * appendLocalMail so duplicates never reach the mailbox.
 */
const SEEN_ID_CAP = 4096;
const seenMailIds = new Set<string>();
const seenMailIdsOrder: string[] = [];

/** Returns true when the id was NEW (and is now recorded); false = duplicate. */
export function seenMailIdRegister(id: string): boolean {
  if (seenMailIds.has(id)) return false;
  seenMailIds.add(id);
  seenMailIdsOrder.push(id);
  if (seenMailIdsOrder.length > SEEN_ID_CAP) {
    const evict = seenMailIdsOrder.shift();
    if (evict !== undefined) seenMailIds.delete(evict);
  }
  return true;
}

/** Test hook: clear the seen-id LRU. */
export function resetSeenMailIds(): void {
  seenMailIds.clear();
  seenMailIdsOrder.length = 0;
}

// ── Epoch ──────────────────────────────────────────────────────────────────

/** Bump (and return) the epoch for an endpoint. */
export function bumpEpoch(endpoint: string): number {
  const next = (epochByEndpoint.get(endpoint) ?? 0) + 1;
  epochByEndpoint.set(endpoint, next);
  return next;
}

/** Read the current epoch for an endpoint (0 when never touched). */
export function getEpoch(endpoint: string): number {
  return epochByEndpoint.get(endpoint) ?? 0;
}

// ── Registry operations ─────────────────────────────────────────────────────

/** Find (or lazily create) the pair entry for an endpoint key. */
function ensurePair(endpoint: string, dialed: boolean): RemotePairEntry {
  let entry = pairs.get(endpoint);
  if (!entry) {
    entry = { endpoint, dialed, sid: '', sockets: [], epoch: bumpEpoch(endpoint) };
    pairs.set(endpoint, entry);
  }
  // A pair we previously only accepted can later be dialed by us too (or
  // vice versa during a mutual dial); keep the dialer flag honest.
  if (dialed) entry.dialed = true;
  return entry;
}

/**
 * Record a socket's announce against a pair (upsert; last-writer-wins per
 * (endpoint, socket)). Re-keys the sid index when the remote restarted with
 * a new sid (the mutable-sid migration, plan §5). Fires the info-symmetry
 * reminder (done=false) via hooks — both dialer and acceptor call this.
 *
 * @returns the socket info stored, plus whether BOTH sockets of the pair
 * have now received announces (the convergence rule may fire, plan §5).
 */
export function recordAnnounce(params: {
  endpoint: string;
  dialed: boolean;
  socket: WebSocket;
  sid: string;
  initiatorSid: string;
  meta: { workDir?: string; role?: string; daemon?: boolean };
}): { stored: WireSocketInfo; bothAnnounced: boolean } {
  const { endpoint, dialed, socket, sid, initiatorSid, meta } = params;
  const entry = ensurePair(endpoint, dialed);

  // Sid re-key: drop the previous index mapping when the peer restarted
  // with a new sid. Old-sid lookups then fail fast (mail_to error points at
  // peer_list, plan §5 edge cases).
  if (entry.sid && entry.sid !== sid) sidIndex.delete(entry.sid);
  entry.sid = sid;
  sidIndex.set(sid, endpoint);

  let info = entry.sockets.find((s) => s.socket === socket);
  if (info) {
    info.sid = sid;
    info.initiatorSid = initiatorSid;
    info.meta = meta;
    info.announceReceived = true;
  } else {
    info = { socket, sid, initiatorSid, meta, announceReceived: true };
    entry.sockets.push(info);
  }

  // Sid census (convergence grouping, review finding): register this socket
  // under the PEER SID it announced, across pair entries. Deduped by socket
  // identity — a re-announce refreshes, never duplicates.
  let census = socketsBySid.get(sid);
  if (!census) {
    census = [];
    socketsBySid.set(sid, census);
  }
  if (!census.some((s) => s.socket === socket)) census.push(info);

  // Info-symmetry reminder (steering round-3): record on establishment —
  // hooks dedupe by endpoint, so a re-announce refreshes rather than dups.
  if (hooks) {
    try {
      hooks.recordRemotePeerTodo({ sid, endpoint, done: false });
    } catch { /* reminder is best-effort — never break the wire */ }
  }

  const bothAnnounced = entry.sockets.length === 2 && entry.sockets.every((s) => s.announceReceived);
  return { stored: info, bothAnnounced };
}

/**
 * Pair-dedupe convergence (plan §5 layer 2; review finding: sid-scoped).
 * Computes the winner — the socket whose initiator has the lexicographically
 * smaller sessionId — and closes OUR loser socket(s) with 4000 (superseded).
 * Symmetric: both sides run the same computation over their own sockets and
 * reach the same winner.
 *
 * Grouping is by PEER SID (socketsBySid), NOT by endpoint key: a mutual
 * dial's two sockets may be keyed differently (dialed URL string vs
 * announced endpoint), so the endpoint-scoped bothAnnounced flag can miss
 * the dual-duplex. The sid group spans pair entries; every socket we hold
 * for the peer's sid (except the winner) is closed. Pruning of the census
 * happens in pruneSocket/teardownPair — this function only closes sockets;
 * their close events drive the actual entry cleanup.
 *
 * @param sid the PEER sid whose sockets must converge (from the announce).
 * @returns the LOSER socket info this side closed, or null when we already
 * hold only the winner (converged).
 */
export function convergePairBySid(sid: string): WireSocketInfo[] | null {
  const group = socketsBySid.get(sid) ?? [];
  if (group.length < 2) return null;
  // Winner: socket initiated by the smaller sid. Ties are impossible (a
  // self-pair is refused by the announce-time backstop before this runs).
  let winner = group[0];
  for (const s of group) {
    if (s.initiatorSid < winner.initiatorSid) winner = s;
  }
  const losers = group.filter((s) => s !== winner && s.socket.readyState === s.socket.OPEN);
  for (const loser of losers) {
    try { loser.socket.close(WIRE_CLOSE_SUPERSEDED, 'superseded'); } catch { /* closing */ }
  }
  if (losers.length > 0 && hooks) {
    try {
      hooks.verbose('wire', `dual-duplex converged for peer ${sid}: kept initiator ${winner.initiatorSid}`);
    } catch { /* ignore */ }
  }
  return losers.length > 0 ? losers : null;
}

/**
 * Socket-identity-guarded prune (plan §5, finding G7). Removes the CLOSED
 * socket's info from its pair — a stale close for a superseded/replaced
 * socket is a no-op so a fresh redial's entry survives.
 *
 * @returns the pair entry (possibly now empty) so the caller can decide
 * teardown semantics, or null when the socket was never registered.
 */
export function pruneSocket(socket: WebSocket): RemotePairEntry | null {
  for (const entry of pairs.values()) {
    const before = entry.sockets.length;
    entry.sockets = entry.sockets.filter((s) => s.socket !== socket);
    if (entry.sockets.length !== before) {
      // Keep the sid census honest (convergence grouping).
      for (const [sid, group] of socketsBySid) {
        const filtered = group.filter((s) => s.socket !== socket);
        if (filtered.length === 0) socketsBySid.delete(sid);
        else if (filtered.length !== group.length) socketsBySid.set(sid, filtered);
      }
      return entry;
    }
  }
  return null;
}

/**
 * Terminal teardown of a whole pair (peer_disconnect, or close 4000/4001
 * observed): prunes the entry regardless of socket identity (the pair is
 * gone by declaration, not observation), marks the reminder todo done, and
 * bumps the epoch so a mid-flight dial aborts on completion.
 *
 * @returns the torn-down entry, or null when no entry exists.
 */
export function teardownPair(endpoint: string): RemotePairEntry | null {
  const entry = pairs.get(endpoint);
  bumpEpoch(endpoint);
  if (!entry) return null;
  pairs.delete(endpoint);
  // Sid-index ownership + survivor re-point (review finding 1, CRITICAL):
  // one peer sid can transiently span MULTIPLE endpoint keys (a simultaneous
  // mutual dial: the socket we dialed is keyed by the URL we typed; the
  // socket we accepted by the peer's announced endpoint). `sidIndex[sid]`
  // holds the MOST-RECENT announce's endpoint — which may be the endpoint
  // being torn down right now, OR a DIFFERENT (surviving) endpoint. Two
  // cases must both end with `sidIndex[sid]` pointing at a LIVE pair entry
  // for that sid (if any), never dangling and never orphaning a survivor:
  //   (a) sidIndex[sid] === this endpoint (the common case — most-recent
  //       announce was on the socket being torn down): drop this mapping,
  //       then re-point at any OTHER pair entry still holding the same sid
  //       (the convergence survivor keyed under a different endpoint).
  //   (b) sidIndex[sid] !== this endpoint (a later announce re-pointed the
  //       index at a survivor): leave it untouched — this teardown must not
  //       corrupt the survivor's index.
  // The invariant: SID = logical peer identity, endpoint = connection
  // locator — cleanup must never assume the sid index belongs to the
  // endpoint being torn down, and must keep it honest when a survivor
  // remains. Without the re-point, findBySid() returns null for a LIVE
  // wire after the loser's teardown → sendWireMail fails.
  if (entry.sid) {
    if (sidIndex.get(entry.sid) === endpoint) {
      sidIndex.delete(entry.sid);
      // Re-point at a surviving pair entry holding the same sid, if any
      // (the convergence survivor keyed under a different endpoint). The
      // socketsBySid census is the authoritative "who still holds this sid"
      // view — re-derive the index from it rather than scanning all pairs.
      const survivors = socketsBySid.get(entry.sid);
      if (survivors && survivors.length > 0) {
        // Find the pair entry that still contains one of the surviving
        // sockets and re-point the sid index at its endpoint key.
        for (const s of survivors) {
          for (const p of pairs.values()) {
            if (p.sockets.includes(s)) {
              sidIndex.set(entry.sid, p.endpoint);
              break;
            }
          }
        }
      }
    }
  }
  // Drop the torn-down pair's sockets from the sid census (convergence
  // grouping) — the pair is gone by declaration, not observation.
  if (entry.sid) {
    const group = socketsBySid.get(entry.sid);
    if (group) {
      const remaining = group.filter((s) => !entry.sockets.includes(s));
      if (remaining.length === 0) socketsBySid.delete(entry.sid);
      else socketsBySid.set(entry.sid, remaining);
    }
  }
  if (hooks) {
    try {
      hooks.recordRemotePeerTodo({ sid: entry.sid, endpoint: entry.endpoint, done: true });
    } catch { /* best-effort */ }
  }
  return entry;
}

/** Look up a live pair by endpoint. */
export function findByEndpoint(endpoint: string): RemotePairEntry | null {
  return pairs.get(endpoint) ?? null;
}

/** Look up a live pair by peer sid (facade route + disconnect resolution). */
export function findBySid(sid: string): RemotePairEntry | null {
  const endpoint = sidIndex.get(sid);
  if (endpoint === undefined) return null;
  return pairs.get(endpoint) ?? null;
}

/** Resolve an endpoint key from a sid (disconnect's url-fallback order). */
export function endpointOfSid(sid: string): string | undefined {
  return sidIndex.get(sid);
}

/**
 * Resolve EVERY endpoint key whose pair entry currently holds the given peer
 * sid — the WHOLE logical peer, not just the endpoint `sidIndex` happens to
 * point at. Used by `peer_disconnect`'s whole-pair teardown (review round-2
 * finding 1, BLOCKER): during a simultaneous mutual dial's convergence
 * window one peer sid can transiently span TWO endpoint keys (the dialed URL
 * vs the peer's announced endpoint), and `sidIndex[sid]` holds only the
 * MOST-RECENT announce's endpoint. A terminal disconnect that visits only
 * that one endpoint would leave the sibling socket live — violating the
 * documented "whole pair, including a simultaneous-dial window's sibling"
 * promise. The `socketsBySid` census is the authoritative "who still holds
 * this sid" view, so the endpoint set is derived from it (each surviving
 * socket's owning pair entry contributes its endpoint key), not from
 * `sidIndex`. The API stays endpoint-addressed (the caller passes one
 * endpoint/sid); the registry handles the multiplicity internally.
 *
 * @returns a deduped array of endpoint keys (empty when no pair holds the
 * sid). Stable order is not guaranteed.
 */
export function endpointsForSid(sid: string): string[] {
  const sockets = socketsBySid.get(sid);
  if (!sockets || sockets.length === 0) return [];
  const endpoints = new Set<string>();
  for (const s of sockets) {
    for (const p of pairs.values()) {
      if (p.sockets.includes(s)) endpoints.add(p.endpoint);
    }
  }
  return [...endpoints];
}

/** All pairs with at least one live socket (peer_list remote section). */
export function listRemotePeers(): RemotePairEntry[] {
  return [...pairs.values()].filter((e) => e.sockets.length > 0);
}

/** The live wire socket for a pair (first live socket), or null. */
export function liveSocketOf(entry: RemotePairEntry): WebSocket | null {
  const s = entry.sockets.find((x) => x.socket.readyState === x.socket.OPEN);
  return s ? s.socket : null;
}

/**
 * Survivor check (plan §5 reconnect loop): true when we already hold a live
 * wire for this pair — suppresses the redial regardless of which side dialed
 * the surviving socket.
 */
export function hasLiveWireForEndpoint(endpoint: string): boolean {
  const entry = pairs.get(endpoint);
  return !!entry && liveSocketOf(entry) !== null;
}

/** Close every wire socket (dialed AND accepted) — the peer.stop() path.
 *  Sockets close abnormally (default 1005-ish/1006) so remote dialers
 *  redial; local entries are pruned by each socket's close handling. */
export function closeAllWireSockets(): void {
  for (const entry of pairs.values()) {
    for (const s of [...entry.sockets]) {
      try { s.socket.close(); } catch { /* already closing */ }
      try { s.socket.terminate(); } catch { /* ignore */ }
    }
  }
}

/** Dedicated maxPayload for peer mail frames — decoupled from the webui
 *  upload limit (getMaxUploadMb, default 50MB). Peer mail is agent-to-agent
 *  text; 4MB per frame is generous while bounding the blast radius (plan §5,
 *  round-1 finding G2). Lives HERE (not in the acceptor) because the SENDER
 *  side needs it too: sendWireMail pre-checks the frame size and fails fast
 *  WITHOUT sending — the `ws` library would otherwise accept the frame and
 *  1009-close the connection on the receiving side (a network-class close
 *  that the redial loop would treat as a transient failure). The sender-side
 *  cap is what makes "oversize rejected at the wire, not a 1009 storm" real.
 */
export const WIRE_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Test hook: clear the registry between tests. */
export function resetWireRegistry(): void {
  pairs.clear();
  sidIndex.clear();
  socketsBySid.clear();
  epochByEndpoint.clear();
}

// ── Shared wire frames (plan §5) ───────────────────────────────────────────
//
// Frame types live HERE — the shared wire-plane module in src/peer — because
// BOTH sides (acceptor: src/serve/peer-wire.ts, dialer: src/peer/wire-client.ts)
// parse and send them, and the peer facade (peer.ts) needs the mail send path
// WITHOUT importing anything from src/serve (the G3 boundary runs one way:
// src/serve must not import ctx; src/peer staying self-contained keeps the
// facade's remote branch dependency-free of the serve stack).

/** Identity exchange on open (both directions; acceptor replies with its own). */
export interface AnnounceFrame {
  type: 'announce';
  sessionId: string;
  workDir?: string;
  role?: string;
  daemon?: boolean;
  /** Announcer's serving endpoint "host:port" when it runs a webui. */
  endpoint?: string;
}

/** Agent-to-agent mail (either direction; receiver dedupes by id). */
export interface MailFrame {
  type: 'mail';
  id: string;
  from: string;
  title: string;
  content: string;
  timestamp: number;
}

export type WireFrame = AnnounceFrame | MailFrame;

/** Wire frame sender helper (JSON + closed-socket guard). */
export function sendFrame(ws: WebSocket, frame: WireFrame): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a PENDING pair entry exists (dialed side, before the first announce
 * arrives): the dialer creates the placeholder so the facade's route lookup
 * finds the peer during the connect handshake and while the capped-redial
 * loop retries — mail_to then reports "not connected, retrying" instead of
 * "unknown peer" (plan §5 reconnect: the entry is the retrying signal, and
 * only peer_disconnect may drop it). No sockets yet; no reminder todo yet
 * (the todo fires on establishment — recordAnnounce).
 */
export function ensurePendingPair(endpoint: string, sid: string): RemotePairEntry {
  const entry = ensurePair(endpoint, true);
  if (sid && entry.sid !== sid) {
    if (entry.sid) sidIndex.delete(entry.sid);
    entry.sid = sid;
    sidIndex.set(sid, endpoint);
  }
  return entry;
}

/**
 * Send a mail frame over a live wire socket (the facade's remote send path,
 * peer.ts sendPeerMail → here). Resolves the pair by sid, checks OPEN before
 * every send (queued-but-not-OPEN → false, plan §4), and stamps a high-entropy
 * wire mail id (generateWireMailId — MailBox.generateId's 8 chars are too
 * small for wire dedupe). Works for BOTH socket directions: the pair entry
 * holds dialed and accepted sockets alike.
 */
export function sendWireMail(targetSid: string, title: string, content: string): boolean {
  const hooks = getWireHooks();
  if (!hooks) return false;
  const entry = findBySid(targetSid);
  if (!entry) return false;
  const socket = entry.sockets.find((s) => s.socket.readyState === s.socket.OPEN)?.socket;
  if (!socket) return false;
  // Construct the ACTUAL frame first (review finding 5: the prior guard
  // measured a PARTIAL frame — {content, title, targetSid} — plus a +256
  // magic constant, an approximation of the real {type, id, from, title,
  // content, timestamp} wire frame). Measuring the serialized REAL frame
  // gives a hard invariant — bytes(frame sent) <= maxPayload — rather than
  // bytes(partial frame) + magic constant <= maxPayload. The id and
  // timestamp are generated here so the measured bytes are the bytes that go
  // on the wire (no field is added after the check).
  const frame: MailFrame = {
    type: 'mail',
    id: generateWireMailId(hooks.getSessionId()),
    from: `${hooks.getSessionId()}/lead`,
    title,
    content,
    timestamp: Date.now(),
  };
  // Sender-side size cap (plan §5, finding G2; review finding: BYTE-aware).
  // Fail fast WITHOUT sending when the frame would exceed the dedicated
  // server's maxPayload. Content length in CHARACTERS under-counts a
  // multi-byte payload (CJK/emoji) — the serialized frame can exceed the
  // cap while the char count passes, and the REMOTE side would 1009-close
  // the connection — a network-class close the redial loop would misread
  // as a transient failure and re-dial forever for one undeliverable
  // mail. Measure the SERIALIZED frame's UTF-8 byte length instead.
  const frameBytes = Buffer.byteLength(JSON.stringify(frame), 'utf-8');
  if (frameBytes > WIRE_MAX_PAYLOAD_BYTES) {
    hooks.verbose('wire', `refusing to send oversize mail frame (${frameBytes} bytes > ${WIRE_MAX_PAYLOAD_BYTES} cap)`);
    return false;
  }
  return sendFrame(socket, frame);
}