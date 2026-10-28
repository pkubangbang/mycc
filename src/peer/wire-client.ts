/**
 * wire-client.ts — remote peer wire DIALER (level-3, cross-machine).
 *
 * The dialer half of the protocol (docs/peers/remote-peer-protocol.md). It
 * lives in src/peer, not src/serve, so an instance with no webui at all can
 * still dial OUT.
 *
 * INVARIANTS (the ones worth knowing before editing):
 *  - Same-store/self refusal is keyed on the peer's SID, never the URL host —
 *    a remote machine tunneled to localhost must still be dialable.
 *  - The acceptor's announce reply is the identity evidence; the /health probe
 *    is only a pre-check (a restart between probe and dial yields a new sid).
 *  - Every dial captures the pair epoch at start and re-checks it on open, so a
 *    torn-down pair never resurrects.
 *  - The redial loop is survivor-aware and has NO max-attempts rule: only 4000,
 *    4001 or peer_disconnect end it. Dropping the pending entry earlier would
 *    turn "not connected, retrying" into "unknown peer".
 *  - The `ws` library answers pings but never sends them; the dialer pings and
 *    terminates after 2 missed pongs ("socket state = liveness" is otherwise a
 *    lie for half-open TCP).
 *  - A close that never produced a recorded pair must still SETTLE the dial —
 *    otherwise connectPeer hangs forever on a 401 or a refused connection.
 *  - Todos are created by recordAnnounce on both sides; nothing here does.
 *
 * Ref semantics: a dialed socket is kept REF'd — a headless --auto/daemon
 * instance that has dialed out stays alive while the pair exists.
 * stopWireClient() closes AND unrefs every dialed socket so process-exit
 * semantics are unchanged.
 */

import { WebSocket } from 'ws';
import * as http from 'http';
import * as https from 'https';
import {
  recordAnnounce,
  convergePairBySid,
  pruneSocket,
  teardownPair,
  findByEndpoint,
  findBySid,
  endpointOfSid,
  endpointsForSid,
  hasLiveWireForEndpoint,
  ensurePendingPair,
  getEpoch,
  seenMailIdRegister,
  getWireHooks,
  sendFrame,
  WIRE_CLOSE_SUPERSEDED,
  WIRE_CLOSE_BYE,
  WIRE_CLOSE_UNAUTHORIZED,
  type AnnounceFrame,
  type MailFrame,
  type WireFrame,
} from './wire-registry.js';
import { readIdentityMap } from './identity.js';
import { isWireDebugLocal } from '../config.js';

/** Ping cadence + missed-pong tolerance (mirror of the acceptor's).
 *  Overridable via setPingIntervalForTest for the missed-pong suite — vitest
 *  fake timers cannot adopt the interval created during a REAL-timer
 *  handshake, so the liveness test shortens the cadence instead. */
const PING_INTERVAL_MS = 30_000;
let pingIntervalMs = PING_INTERVAL_MS;
const MISSED_PONG_LIMIT = 2;

/** Test seam: shorten the ping cadence (missed-pong terminate test). */
export function setPingIntervalForTest(ms: number): void {
  pingIntervalMs = Math.max(20, ms);
}

/** Capped exponential backoff (plan §5): start 1s, double per attempt, cap 30s. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

/** WS handshake timeout — a dead host fails the first dial in 10s, not 75s. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** How long the connect tool waits for the acceptor's announce reply once
 *  the socket is open. On timeout the socket is closed (the redial loop
 *  stays armed) and the tool reports the handshake failure. */
const ANNOUNCE_REPLY_TIMEOUT_MS = 15_000;

/** Health probe timeout. */
const PROBE_TIMEOUT_MS = 5_000;

/** Per-socket liveness state for DIALED sockets (ping/missed-pong tracking). */
const liveness = new Map<WebSocket, { misses: number }>();

/** Sockets that completed the announce exchange (established). */
const established = new WeakSet<WebSocket>();

/** Endpoint key each DIALED socket was opened for. Needed because an upgrade
 *  refused during the handshake produced no pair entry and was pruned from the
 *  registry before the close event — the failed dial must still stop THAT
 *  endpoint's redial loop, not all of them (row peer-004). */
const socketEndpoints = new WeakMap<WebSocket, string>();

/** HTTP status of a REFUSED upgrade per socket (the `ws` client reports every
 *  unaccepted handshake as close 1006, so the status line is the only evidence
 *  of a token refusal — row peer-004). */
const refusalStatus = new WeakMap<WebSocket, number>();

/** Pair-keyed reconnect loop state. */
interface LoopState {
  timer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  active: boolean;
}
const loops = new Map<string, LoopState>();

let pingTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function verbose(message: string, data?: unknown): void {
  try {
    getWireHooks()?.verbose('wire', message, data);
  } catch { /* never break the wire on a logging error */ }
}

/** Our announce frame (plan §2 step 3) — mirrors the acceptor's reply shape. */
function ourAnnounce(): AnnounceFrame {
  const hooks = getWireHooks()!;
  return {
    type: 'announce',
    sessionId: hooks.getSessionId(),
    workDir: hooks.getWorkDir(),
    ...(hooks.getRole() ? { role: hooks.getRole() } : {}),
    ...(hooks.getDaemon() ? { daemon: true } : {}),
    ...(hooks.getServingEndpoint() ? { endpoint: hooks.getServingEndpoint()! } : {}),
  };
}

/**
 * Parse a peer_connect target into its endpoint key + probe/dial URLs.
 * Accepts "host:port", "http(s)://host:port", "ws(s)://host:port".
 * The ENDPOINT KEY is "host:port" — "endpoint is the stable thing; the
 * session-id follows it" (plan §5) — and it is the address WE dialed, from
 * OUR perspective (a tunnel/alias URL still keys by what we typed).
 */
export function parseWireTarget(rawUrl: string): {
  endpoint: string;
  probeUrl: string;
  dialBase: string;
} | null {
  let host: string;
  let secure = false;
  let hadScheme = false;

  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const schemeMatch = trimmed.match(/^(wss|https|ws|http):\/\/(.+)$/i);
  if (schemeMatch) {
    hadScheme = true;
    secure = schemeMatch[1].toLowerCase() === 'wss' || schemeMatch[1].toLowerCase() === 'https';
    host = schemeMatch[2];
  } else {
    host = trimmed;
  }
  // No port → unusable target ("host:port" is the endpoint key).
  if (host.includes('/')) return null;

  const lastColon = host.lastIndexOf(':');
  if (lastColon === -1) return null; // no port
  const maybePort = host.slice(lastColon + 1);
  if (!/^\d+$/.test(maybePort) || maybePort === '') return null;
  const port = maybePort;
  const hostNoPort = host.slice(0, lastColon);
  // IPv6 literals "[::1]:3191" keep the brackets in the host part.
  if (!hostNoPort || hostNoPort === ']') return null;

  if (!hadScheme) {
    // Bare "host:port" — plain http/ws (TLS via reverse proxy is documented
    // as the production path, not default-guessed here).
    secure = false;
  }

  const endpoint = `${hostNoPort}:${port}`;
  const scheme = secure ? 'https' : 'http';
  const wsScheme = secure ? 'wss' : 'ws';
  return {
    endpoint,
    probeUrl: `${scheme}://${endpoint}/health`,
    dialBase: `${wsScheme}://${endpoint}/peer/ws`,
  };
}

/** GET /health and parse the JSON body. Rejects on error/non-200/timeout. */
export function probeHealth(probeUrl: string): Promise<{ peer?: { sessionId: string | null; daemon: boolean } }> {
  return new Promise((resolve, reject) => {
    const lib = probeUrl.startsWith('https') ? https : http;
    const req = lib.get(probeUrl, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode ?? '???'}`));
        return;
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as { peer?: { sessionId: string | null; daemon: boolean } });
        } catch (err) {
          reject(new Error(`malformed /health JSON: ${(err as Error).message}`));
        }
      });
      res.on('error', (err: Error) => reject(err));
    });
    req.on('error', (err: Error) => reject(err));
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy(new Error(`probe timeout after ${PROBE_TIMEOUT_MS}ms`));
    });
  });
}

// ── Reconnect loop ─────────────────────────────────────────────────────────

function cancelLoop(endpoint: string): void {
  const loop = loops.get(endpoint);
  if (loop?.timer) {
    clearTimeout(loop.timer);
    loop.timer = null;
  }
  if (loop) loop.active = false;
}

/** Terminal loop disposal (review finding 3): cancel AND drop the loop
 *  state entirely — a redial after this is a fresh scheduleRedial lazily
 *  re-creating the entry. Used on the 4001/bye and no-survivor 4000 paths
 *  where the pair is torn down for good. */
function disposeLoop(endpoint: string): void {
  cancelLoop(endpoint);
  loops.delete(endpoint);
}

/** Arm (or keep armed) the redial loop for an endpoint, scheduling the next
 *  capped-exponential attempt. No silent max-attempts rule (plan §5). */
function scheduleRedial(endpoint: string, dialBase: string): void {
  const loop = loops.get(endpoint) ?? { timer: null, attempts: 0, active: true };
  loops.set(endpoint, loop);
  if (loop.timer) return; // already scheduled
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** loop.attempts, BACKOFF_CAP_MS);
  loop.attempts = Math.min(loop.attempts + 1, 30); // cap the EXPONENT, not the loop
  loop.active = true;
  verbose(`redial armed for ${endpoint} in ${delay}ms (attempt ${loop.attempts})`);
  loop.timer = setTimeout(() => {
    loop.timer = null;
    void attemptRedial(endpoint, dialBase);
  }, delay);
  loop.timer.unref?.();
}

async function attemptRedial(endpoint: string, dialBase: string): Promise<void> {
  // Survivor check FIRST (plan §5): a live wire for this pair suppresses
  // the redial regardless of which side dialed the surviving socket.
  if (hasLiveWireForEndpoint(endpoint)) {
    verbose(`redial suppressed for ${endpoint}: live survivor present`);
    const loop = loops.get(endpoint);
    if (loop) { loop.attempts = 0; loop.active = false; }
    return;
  }
  // Note: MYCC_WIRE_TOKEN is OPTIONAL — its absence no longer cancels the
  // redial (an open endpoint is a legitimate configuration; security is the
  // operator's responsibility at OSI L3). A 401 close from an acceptor that
  // DOES enforce a token still surfaces via describeCloseCode and, being a
  // non-terminal non-4000/4001 code, arms another redial — but that is the
  // honest "wrong token" signal, not a missing-token cancellation.
  const pair = findByEndpoint(endpoint);
  if (!pair) {
    // The pair was torn down (peer_disconnect) while a redial was pending.
    cancelLoop(endpoint);
    return;
  }
  const epoch0 = getEpoch(endpoint);
  dialSocket(endpoint, dialBase, epoch0, { isRedial: true });
}

// ── Dial ───────────────────────────────────────────────────────────────────

interface DialCallbacks {
  isRedial?: boolean;
  /** Fires once when the acceptor's announce reply is recorded. */
  onEstablished?: (sid: string) => void;
  /** Fires when the socket dies before establishment. */
  onFailed?: (reason: string) => void;
}

/**
 * Dial one wire socket for an endpoint and wire up its full lifecycle:
 * announce exchange, registry record, convergence, close handling, and the
 * survivor-aware redial scheduling. Shared by the tool's first dial and the
 * reconnect loop's redials.
 */
function dialSocket(endpoint: string, dialBase: string, epoch0: number, cb: DialCallbacks): WebSocket {
  // Token is OPTIONAL (plan §5 Security): when MYCC_WIRE_TOKEN is set on
  // this dialer, send it as a REQUEST HEADER (X-MYCC-Wire-Token) so an
  // acceptor that also configured a token can verify it. When unset, dial
  // with no token header — the acceptor treats a missing token as "open"
  // when it too has no token configured (security delegated to OSI L3 by
  // the operator).
  //
  // Header, NOT query string (review finding 3, MEDIUM): a ?token= query
  // param becomes part of the HTTP/WebSocket request URL and can leak into
  // reverse-proxy access logs, HTTP debugging middleware, observability/
  // tracing systems, and error messages. A shared secret in the URL is a
  // leakage vector a header avoids (headers are not logged by default in
  // most access-log formats and are not echoed in request-URL diagnostics).
  const token = process.env.MYCC_WIRE_TOKEN;
  const headers: Record<string, string> = token ? { 'X-MYCC-Wire-Token': token } : {};
  const url = dialBase; // token travels via header, never the query string
  const ws = new WebSocket(url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS, headers });
  socketEndpoints.set(ws, endpoint);

  let replyTimer: ReturnType<typeof setTimeout> | null = null;
  let failed = false;

  const fail = (reason: string): void => {
    if (failed) return;
    failed = true;
    cb.onFailed?.(reason);
  };

  ws.on('open', () => {
    // Epoch guard (plan §5): the pair was torn down while this dial was in
    // flight (teardownPair bumped the epoch). Abandon — no resurrection.
    if (getEpoch(endpoint) !== epoch0) {
      verbose(`dial to ${endpoint} aborted: epoch changed mid-flight`);
      try { ws.close(1000, 'epoch changed'); } catch { /* closing */ }
      fail('pair torn down mid-dial (epoch changed)');
      return;
    }
    liveness.set(ws, { misses: 0 });
    startPingTimer();
    if (!sendFrame(ws, ourAnnounce())) {
      fail('socket closed while sending announce');
      return;
    }
    // Announce-reply deadline — an acceptor that never answers leaves the
    // socket half-established; tear it down and let the loop retry.
    replyTimer = setTimeout(() => {
      verbose(`announce reply timeout for ${endpoint}`);
      try { ws.close(1000, 'announce timeout'); } catch { /* closing */ }
      fail('no announce reply within 15s');
    }, ANNOUNCE_REPLY_TIMEOUT_MS);
    replyTimer.unref?.();
  });

  ws.on('message', (data) => {
    if (ws.readyState !== ws.OPEN) return;
    let frame: WireFrame;
    try {
      frame = JSON.parse(data.toString()) as WireFrame;
    } catch {
      verbose(`dropping malformed wire frame from ${endpoint}`);
      return;
    }
    if (frame.type === 'announce') {
      onAnnounceReply(ws, frame, endpoint, clearReplyTimer, cb);
      return;
    }
    if (frame.type === 'mail') {
      onInboundMail(frame);
      return;
    }
    verbose(`dropping unknown wire frame type from ${endpoint}`);
  });

  ws.on('pong', () => {
    const state = liveness.get(ws);
    if (state) state.misses = 0;
  });

  ws.on('error', (err: Error) => {
    verbose(`wire socket error for ${endpoint}: ${err.message}`);
    // close follows; handled there.
  });

  /** Clear the announce-reply timer; returns true when one was pending. */
  const clearReplyTimer = (): boolean => {
    if (replyTimer) { clearTimeout(replyTimer); replyTimer = null; return true; }
    return false;
  };

  ws.on('unexpected-response', (req: import('http').ClientRequest, res: import('http').IncomingMessage) => {
    // A refused HTTP upgrade never becomes a WebSocket, so the close event
    // cannot say WHY (the `ws` client reports 1006 for every unaccepted
    // handshake). Capture the status line here — the only place the dialer
    // learns "the remote enforced a different wire token" (row peer-004:
    // a token mismatch used to look like a network drop).
    //
    // terminate() is MANDATORY, not hygiene: attaching this listener makes `ws`
    // treat the response as handled and skip its internal `abortHandshake`,
    // which is the only emitter of `close` for a refused upgrade. Without it
    // nothing settles — connectPeer's promise hangs forever and the TCP handle
    // leaks (verified: no close even past handshakeTimeout).
    refusalStatus.set(ws, res.statusCode ?? 0);
    try { ws.terminate(); } catch { /* closing */ }
    if (!req.destroyed) req.destroy();
  });

  ws.on('close', (code: number) => {
    clearReplyTimer();
    liveness.delete(ws);
    const wasEstablished = established.has(ws);
    const prunedPair = pruneSocket(ws);
    // The handshake status outranks the close code: an unaccepted upgrade
    // always closes as 1006, which would render as "connection reset".
    const refusedCode = refusalStatus.get(ws);
    refusalStatus.delete(ws);
    const effectiveCode = refusedCode && refusedCode >= 400 ? refusedCode : code;
    if (effectiveCode === WIRE_CLOSE_UNAUTHORIZED) {
      // A refused upgrade stays broken until the operator fixes the token, so
      // it is TERMINAL for the endpoint: settle the dial AND stop the redial,
      // keeping the one actionable line visible instead of burying it under an
      // endless retry storm (row peer-004).
      fail(describeCloseCode(effectiveCode));
      const endpoint = prunedPair?.endpoint ?? socketEndpoints.get(ws);
      if (endpoint) {
        cancelLoop(endpoint);
        getWireHooks()?.briefPeerWireRefusal?.(`the remote refused our token (${endpoint})`);
        verbose(`redial for ${endpoint} paused: wire token refused`);
      }
      return;
    }
    if (!prunedPair) {
      // Unrecorded socket (the dial closed before an announce): there is no
      // pair to decide on — but the DIAL still has to settle, otherwise
      // connectPeer's promise hangs forever on ECONNREFUSED.
      if (!wasEstablished) fail(describeCloseCode(code));
      return;
    }

    const pairEndpoint = prunedPair.endpoint;

    if (!wasEstablished) {
      fail(describeCloseCode(code));
    }

    if (code === WIRE_CLOSE_BYE) {
      // Explicit hang-up (peer_disconnect on the remote side): terminal for
      // the WHOLE pair — no redial (plan §2 disconnect).
      teardownPair(pairEndpoint);
      disposeLoop(pairEndpoint);
      verbose(`wire to ${pairEndpoint} closed: bye (4001) — terminal`);
      return;
    }
    if (code === WIRE_CLOSE_SUPERSEDED) {
      // Survivor-aware terminality (plan §5 convergence): a 4000 that pruned
      // only the CONVERGENCE LOSER while the pair still holds a live sibling
      // (simultaneous mutual dial just resolved) must NOT tear the pair down
      // and must NOT redial — the survivor carries the pair.
      if (hasLiveWireForEndpoint(pairEndpoint)) {
        cancelLoop(pairEndpoint);
        verbose(`convergence loser closed for ${pairEndpoint}: live survivor carries the pair`);
        return;
      }
      teardownPair(pairEndpoint);
      disposeLoop(pairEndpoint);
      verbose(`wire to ${pairEndpoint} superseded (4000) with no survivor — terminal`);
      return;
    }
    // Abnormal/network close (1006 etc.) — the ONLY redial trigger (plan §5).
    // Survivor check first; otherwise arm the capped-exponential loop. The
    // pending pair entry (empty sockets, sid preserved) stays so mail_to
    // reports "not connected, retrying" rather than "unknown peer".
    //
    // Scheme retention (review finding 2, HIGH): the redial MUST reuse the
    // ORIGINAL dialBase that parseWireTarget derived (ws:// OR wss://). The
    // closed-over `dialBase` — not a reconstruction from the bare endpoint
    // key — is the single source of truth. A `host:port` key cannot recover
    // the scheme, so a reconnect to a wss:// (TLS-only) deployment would
    // silently fall back to ws:// and fail forever (the initial dial
    // succeeded, so the bug only surfaces on failure recovery).
    if (hasLiveWireForEndpoint(pairEndpoint)) {
      cancelLoop(pairEndpoint);
      verbose(`socket to ${pairEndpoint} died; live survivor carries the pair`);
      return;
    }
    // Retarget: a pair entry that reappeared under the peer's ANNOUNCED
    // endpoint means the peer came back on a different key (restart behind a
    // DHCP change / re-established tunnel). Redialing only the typed endpoint
    // would fail forever while the peer is reachable under the new address.
    const announced = (findByEndpoint(pairEndpoint)?.sid
      ? endpointsForSid(findByEndpoint(pairEndpoint)!.sid)
      : []
    ).filter((ep) => ep !== pairEndpoint && hasLiveWireForEndpoint(ep));
    if (announced.length > 0) {
      cancelLoop(pairEndpoint);
      verbose(`redial for ${pairEndpoint} cancelled: peer reachable at ${announced[0]}`);
      return;
    }
    // The wire is DOWN and we are about to retry (row peer-004). Tell the user
    // once, and flip the pinned reminder to "reconnecting" — otherwise the only
    // trace of an established peer going away is a verbose line while the
    // persistent banner keeps claiming it is wired. The banner is re-pointed at
    // "connected" by recordAnnounce when the peer returns.
    const downSid = findByEndpoint(pairEndpoint)?.sid;
    if (downSid) {
      getWireHooks()?.recordRemotePeerTodo({ sid: downSid, endpoint: pairEndpoint, done: false, reconnecting: true });
    }
    verbose(`wire to ${pairEndpoint} dropped — reconnecting`);
    scheduleRedial(pairEndpoint, dialBase);
  });

  return ws;
}

/** Announce reply handling: self-dial backstop, registry record, convergence. */
function onAnnounceReply(
  ws: WebSocket,
  frame: AnnounceFrame,
  endpoint: string,
  clearReplyTimer: () => boolean,
  cb: DialCallbacks,
): void {
  const hooks = getWireHooks();
  if (!hooks) return;
  const selfSid = hooks.getSessionId();

  // Self-dial backstop (plan §2 step 2.5): the probe-time locality check can
  // miss a race (proxy hairpin); an announce reply carrying OUR OWN sid is a
  // self-connect — close 4000 on both ends, surface the error.
  if (frame.sessionId === selfSid) {
    verbose('self-dial backstop fired on announce reply: closing 4000');
    try { ws.close(WIRE_CLOSE_SUPERSEDED, 'cannot wire to self'); } catch { /* closing */ }
    return;
  }

  recordAnnounce({
    endpoint,
    dialed: true, // WE dialed this socket
    socket: ws,
    sid: frame.sessionId,
    initiatorSid: selfSid, // the dialer's sid — the convergence election input
    meta: { workDir: frame.workDir, role: frame.role, daemon: frame.daemon },
  });

  clearReplyTimer();

  // Pair-dedupe convergence (plan §5 layer 2; review finding: sid-scoped).
  // A simultaneous mutual dial gives us TWO sockets to the same peer sid —
  // possibly keyed under DIFFERENT endpoint strings (the URL we typed vs
  // the endpoint the peer announced) — so the grouping is by sid, not by
  // endpoint entry. Close OUR loser with 4000; the remote side runs the
  // same rule and reaches the same winner. No-ops at one socket.
  convergePairBySid(frame.sessionId);

  if (!established.has(ws)) {
    established.add(ws);
    const loop = loops.get(endpoint);
    if (loop) { loop.attempts = 0; loop.active = false; } // fresh success resets backoff
    cb.onEstablished?.(frame.sessionId);
  }
}

/** Inbound mail on a DIALED socket — same dedupe + single-writer rule as the
 *  acceptor's onMail (plan §5): seen-id LRU FIRST, then appendLocalMail. */
function onInboundMail(frame: MailFrame): void {
  const hooks = getWireHooks();
  if (!hooks) return;
  if (!frame.id || !frame.from) {
    verbose('dropping inbound mail frame without id/from');
    return;
  }
  if (!seenMailIdRegister(frame.id)) {
    verbose(`duplicate wire mail dropped: ${frame.id}`);
    return;
  }
  hooks.appendLocalMail(frame.from, frame.title, frame.content);
}

/** Keepalive sender for dialed sockets (plan §5): ping every 30s, terminate
 *  after MISSED_PONG_LIMIT missed pongs — a half-open TCP must not linger
 *  as a zombie registry entry. */
function startPingTimer(): void {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const ws of liveness.keys()) {
      if (ws.readyState !== ws.OPEN) continue;
      const state = liveness.get(ws);
      if (!state) continue;
      state.misses++;
      if (state.misses > MISSED_PONG_LIMIT) {
        verbose('terminating dialed socket: missed-pong limit reached');
        try { ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, pingIntervalMs);
  pingTimer.unref?.();
}

/** Human-readable close-code description for tool error messages. */
function describeCloseCode(code: number): string {
  if (code === 4000) return 'superseded (4000) — pair torn down mid-dial';
  if (code === 4001) return 'remote hung up (bye 4001) — wire was disconnected, re-run peer_connect';
  if (code === WIRE_CLOSE_UNAUTHORIZED) return 'unauthorized — the remote enforces a wire token (MYCC_WIRE_TOKEN) that this side did not send or sent differently. Set the SAME value on both instances, or unset it on both to run the wire open (security then delegated to OSI L3). The redial loop is stopped for this endpoint: fix the token, then re-run peer_connect.';
  if (code === 1006) return 'abnormal close (connection reset / refused / host down)';
  return `close code ${code}`;
}

// ── Public API (tools + peer.stop) ─────────────────────────────────────────

/**
 * peer_connect: probe → locality/pre-checks → dial → announce. Resolves with
 * a user-facing result string. On first-dial failure the capped-redial loop
 * stays ARMED (plan §5: only peer_disconnect or 4000/4001 ends it) — the
 * message says so, and the pending pair entry keeps mail_to's "not
 * connected, retrying" semantics alive.
 */
export async function connectPeer(rawUrl: string): Promise<string> {
  const hooks = getWireHooks();
  if (!hooks) {
    return 'Error: the peer wire is not initialized in this process (child/teammate contexts have no wire — run peer_connect from the lead).';
  }

  const target = parseWireTarget(rawUrl);
  if (!target) {
    return 'Error: could not parse the target URL. Pass the peer\'s serve base as "host:port", "http://host:port", or "ws://host:port" (no path).';
  }
  const { endpoint, probeUrl, dialBase } = target;

  // Step 1 — health probe.
  let health: Awaited<ReturnType<typeof probeHealth>>;
  try {
    health = await probeHealth(probeUrl);
  } catch (err) {
    return `Error: cannot reach ${probeUrl}: ${(err as Error).message}. Is the remote instance serving its webui (mycc /serve or daemon mode)?`;
  }
  const peerSid = health.peer?.sessionId ?? null;
  if (!peerSid) {
    return `Error: ${endpoint} answered /health but exposed no peer block — the remote instance does not run the peer wire (upgrade mycc on the remote, or its serve stack is not fully started).`;
  }
  const peerDaemon = health.peer?.daemon === true;

  // Step 1.5 — self-connect backstop + same-store sid filter.
  // The check is STORE-based (sid in identity.json), NOT URL-based: a peer
  // whose sid is registered in the LOCAL discovery store runs on THIS
  // machine and is already reachable via discovery mail + channel files, so
  // a wire to it is redundant. This is orthogonal to the URL's host being
  // 127.0.0.1/localhost: VS Code Remote-SSH / remote tunnels forward a
  // REMOTE machine's serve port to localhost, but that remote instance's
  // sid is NOT in this machine's identity.json — so it correctly passes
  // this filter and the wire is allowed. Any URL host is connectable; only
  // same-store sids are refused (and self, always). Escape hatch:
  // --debug-wire (mirrors MYCC_WIRE_ALLOW_LOCAL; same-machine smoke test
  // only).
  const selfSid = hooks.getSessionId();
  if (peerSid === selfSid) {
    return `Error: refusing to wire to self — ${endpoint} is THIS instance (${selfSid}).`;
  }
  const allowLocal = isWireDebugLocal();
  if (!allowLocal && peerSid in readIdentityMap()) {
    return `Error: refusing same-store wire — peer ${peerSid} is a LOCAL instance (registered in identity.json, running on this machine). Local peers are already reachable: mail_to("${peerSid}/lead") or channel files. Set --debug-wire (or MYCC_WIRE_ALLOW_LOCAL=1) to override (test-only).`;
  }

  // Step 2 — registry pre-check (pair-dedupe layer 1).
  if (hasLiveWireForEndpoint(endpoint)) {
    const entry = findByEndpoint(endpoint)!;
    return `Already connected to ${entry.sid || peerSid} at ${endpoint} (live wire) — use mail_to("${entry.sid || peerSid}/lead") to talk to it, or peer_disconnect first.`;
  }
  const bySid = findBySid(peerSid);
  if (bySid && hasLiveWireForEndpoint(bySid.endpoint)) {
    return `Already connected to ${peerSid} at ${bySid.endpoint} (live wire) — use mail_to("${peerSid}/lead") to talk to it, or peer_disconnect first.`;
  }

  // Token is OPTIONAL (plan §5 Security): no pre-dial gate here. When
  // MYCC_WIRE_TOKEN is set on this dialer, dialSocket sends it as the
  // X-MYCC-Wire-Token request header; when unset, the dial proceeds with no
  // token header and the acceptor treats a missing token as "open" when it
  // too has none configured. A 401 from an acceptor that DOES enforce a
  // token surfaces via the dial failure path (describeCloseCode). Security
  // is the operator's responsibility at OSI L3 (firewall / TLS reverse
  // proxy / VPN / SSH tunnel); mycc does not impose an in-app auth gate by
  // default.

  // Step 3 — dial. Pending pair entry FIRST (plan §5): the placeholder keeps
  // the facade's "not connected, retrying" semantics during the handshake
  // and across redials; only peer_disconnect (or terminal close handling)
  // may drop it. Epoch captured AFTER the entry exists (ensurePair bumped
  // it at creation) so a mid-dial teardown is detectable.
  ensurePendingPair(endpoint, peerSid);
  const epoch0 = getEpoch(endpoint);

  const outcome = await new Promise<{ ok: true; sid: string } | { ok: false; error: string }>((resolve) => {
    dialSocket(endpoint, dialBase, epoch0, {
      onEstablished: (sid) => resolve({ ok: true, sid }),
      onFailed: (error) => resolve({ ok: false, error }),
    });
    // No explicit timeout here: handshakeTimeout bounds the connect; the
    // announce-reply deadline bounds the exchange. The promise always
    // settles via close/open handlers.
  });

  if (!outcome.ok) {
    // The redial loop may be armed by the close handler — but NOT for a refused
    // handshake (401): that branch is terminal and stops the loop, so promising
    // "retrying" there would contradict the message the caller just read.
    const loopNote = /unauthorized/.test(outcome.error)
      ? 'The redial loop is stopped for this endpoint — fix the token, then re-run peer_connect.'
      : 'The redial loop is armed (capped exponential backoff, ~30s max) — mail_to will report "retrying" until it connects; use peer_disconnect to cancel.';
    return `Error: wire to ${endpoint} not established: ${outcome.error} ${loopNote}`;
  }

  const daemonNote = peerDaemon ? '' : '\nNote: the remote webui is NOT daemon-backed — it auto-shuts-down ~30s after its last human leaves; the wire will drop and this side will keep retrying.';
  return `Wire established to ${outcome.sid} at ${endpoint}. You can now mail_to("${outcome.sid}/lead") — the remote instance can reach you the same way. A pinned reminder todo records the peer.${daemonNote}`;
}

/**
 * peer_disconnect: terminal hang-up. The API stays endpoint-addressed (the
 * caller passes a sid OR a url — mirroring peer_connect), but the terminal
 * operation is LOGICALLY PEER-SCOPED: it tears down the WHOLE pair, every
 * endpoint key that currently holds the resolved peer sid. This matters
 * during a simultaneous mutual dial's convergence window, when one peer sid
 * transiently spans TWO endpoint keys (the dialed URL vs the peer's
 * announced endpoint); visiting only the endpoint `sidIndex` points at would
 * leave the sibling socket live (review round-2 finding 1, BLOCKER). The
 * registry's `endpointsForSid(sid)` derives the full endpoint set from the
 * `socketsBySid` census, so this function is unaware of the internal
 * endpoint multiplicity.
 *
 * For each endpoint holding the sid: sends close 4001 (bye) on every live
 * socket, disposes the redial loop, and tears down the pair entry (bumps the
 * epoch so a mid-flight dial aborts). The remote side's 4001 handling is
 * terminal for its loop too.
 */
export async function disconnectPeer(urlOrSid: string): Promise<string> {
  const arg = urlOrSid.trim();

  // Sid-first resolution (round-1 finding S3), url fallback.
  let endpoint = endpointOfSid(arg);
  let via = 'sessionId';
  if (endpoint === undefined) {
    const target = parseWireTarget(arg);
    if (target) {
      endpoint = target.endpoint;
      via = 'url';
    }
  }
  if (endpoint === undefined) {
    return `Error: no remote peer matches "${arg}" (neither a connected sessionId nor a dialed url). Run peer_list to see remote peers.`;
  }

  const entry = findByEndpoint(endpoint);
  if (!entry) {
    return `Error: no wire pair for ${endpoint} — already disconnected? (peer_list shows connected remotes.)`;
  }

  const sid = entry.sid || '(unknown sid)';

  // WHOLE-PAIR teardown (review round-2 finding 1): collect EVERY endpoint
  // key holding this peer sid — not just the one `sidIndex` resolved above.
  // During a convergence window the sid may span two endpoint keys; a
  // single-endpoint teardown would leave the sibling socket live. The set
  // always includes the resolved endpoint (it holds the sid), so the
  // common single-endpoint case is unchanged.
  const endpoints = endpointsForSid(sid);
  if (endpoints.length === 0) {
    // Defensive: the entry existed but the census has no sockets for the sid
    // (e.g. a pending pair with no announced socket yet). Fall back to the
    // resolved endpoint so the disconnect still tears down what we found.
    endpoints.push(endpoint);
  }

  let sentBye = 0;
  let tornDown = 0;
  for (const ep of endpoints) {
    const pair = findByEndpoint(ep);
    if (!pair) continue; // already gone (a prior iteration's teardown may have re-pointed/cleared it)
    // Bye on every live socket of THIS endpoint's pair (4001 tears down the
    // WHOLE pair — plan §2 disconnect, including a simultaneous-dial
    // window's sibling).
    for (const s of [...pair.sockets]) {
      if (s.socket.readyState === s.socket.OPEN) {
        try {
          s.socket.close(WIRE_CLOSE_BYE, 'bye');
          sentBye++;
        } catch { /* closing */ }
      }
    }
    // Local teardown: removes the entry, bumps the epoch (mid-flight dial
    // aborts on its completion check), marks the reminder todo done.
    disposeLoop(ep); // terminal: cancel + drop the loop state (review finding 3)
    teardownPair(ep);
    tornDown++;
  }

  const epList = endpoints.length <= 1
    ? endpoint
    : `${endpoints.length} endpoints (${endpoints.join(', ')})`;
  return `Wire to ${sid} at ${epList} hung up (resolved by ${via}, bye sent on ${sentBye} socket${sentBye === 1 ? '' : 's'}, ${tornDown} pair${tornDown === 1 ? '' : 's'} torn down). The redial loop is cancelled — re-run peer_connect to reconnect.`;
}

/**
 * peer.stop() path (plan §5): close AND unref every dialed socket so
 * process-exit semantics are unchanged (the ref'd wire would otherwise keep
 * a headless instance alive). Cancels all redial timers. The remote side
 * prunes its registry in its own close handling.
 */
export function stopWireClient(): void {
  for (const endpoint of [...loops.keys()]) {
    cancelLoop(endpoint);
    loops.delete(endpoint);
  }
  for (const ws of [...liveness.keys()]) {
    try { ws.close(); } catch { /* already closing */ }
    try { ws.terminate(); } catch { /* ignore */ }
    // Unref the underlying socket so a ref'd wire cannot keep a shutting-
    // down process alive (the ws WebSocket wrapper exposes the raw socket;
    // unref'ing it releases the event-loop handle, plan §5 exit semantics).
    try { (ws as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.(); } catch { /* ignore */ }
  }
  liveness.clear();
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/** Test hook: reset dialer state between tests. */
export function resetWireClient(): void {
  stopWireClient();
  loops.clear();
  pingIntervalMs = PING_INTERVAL_MS;
}
