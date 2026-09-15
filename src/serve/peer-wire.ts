/**
 * peer-wire.ts - Remote peer wire ACCEPTOR for the serve stack (/peer/ws)
 *
 * Implements the acceptor half of the level-3 remote peer wire protocol
 * (docs/remote-peer-protocol.md §1, §5). A serving instance's ServeHub
 * exposes a SECOND WebSocket route — `/peer/ws` — distinct from the human
 * webui route `/ws`. Peer wires are TENANTS of the serve stack, not clients:
 *
 *   - peer sockets go into the SHARED wire registry (src/peer/wire-registry.ts)
 *     via the G3 injection, NOT into ServeHub's `clients` ClientRegistry;
 *   - the /peer/ws branch must NOT call `clients.add()` nor
 *     `disconnectTimer.cancel()` (onWsConnection does both today,
 *     serve-hub.ts:571-572), and its close path must NOT re-arm the
 *     disconnect timer — REJECTED alternative (would couple webui lifetime
 *     to a tenant): otherwise (a) one live peer wire pins clients.size > 0
 *     forever and the serve stack never auto-shuts-down after the last human
 *     leaves, or (b) a peer hangup becomes the event that tears down the
 *     webui 30s later (round-1 finding G1, CRITICAL).
 *
 * Token verification is OPTIONAL (plan §5 Security): the token is a shared
 * secret exchanged out-of-band (env `MYCC_WIRE_TOKEN`, same value on both
 * ends), supplied by the dialer as a query parameter on the WS upgrade. When
 * MYCC_WIRE_TOKEN is configured on the acceptor, a missing/mismatched token
 * destroys the underlying TCP socket immediately. When it is NOT configured,
 * the upgrade is accepted with no token check — security is the operator's
 * responsibility at OSI L3 (firewall / TLS reverse proxy / VPN / SSH tunnel);
 * mycc does not impose an in-app auth gate by default.
 *
 * Frame protocol (plan §5):
 *   - announce  {type:'announce', sessionId, workDir?, role?, daemon?, endpoint?}
 *               identity exchange on open — the acceptor replies with its own
 *               announce. An announce whose sessionId equals OUR OWN sid is a
 *               self-dial backstop violation → close 4000 on both ends
 *               (plan §2 step 2.5).
 *   - mail      {type:'mail', id, from, title, content, timestamp}
 *               either direction; receiver dedupes by id (seen-id LRU) then
 *               appends to its own mailbox via hooks.appendLocalMail — the
 *               single mailbox writer, MailBox.appendMail (§5).
 *   - An oversize frame is REJECTED by the WebSocketServer's maxPayload with
 *     a wire-level error — the dedicated server has its own generous-but-
 *     finite cap, decoupled from the webui upload limit (round-1 finding
 *     G2). A 1009 connection close would be classified as a network error
 *     by the dialer (neither 4000 nor 4001) and trigger an infinite
 *     capped-backoff redial storm for a single undeliverable mail — hence
 *     maxPayload is deliberately conservative for this server.
 *
 * Simultaneous mutual dials: when both sides of a pair dial at the same
 * moment, this acceptor may briefly hold TWO sockets for the same pair —
 * the convergence rule (initiator-sid election, plan §5) resolves it by
 * closing the loser with 4000 after both announces arrive. The dialer-side
 * (wire-client.ts) runs the same computation over its own two sockets.
 */

import type { WebSocket, WebSocketServer } from 'ws';
import { WebSocketServer as WssCtor } from 'ws';
import {
  recordAnnounce,
  convergePairBySid,
  pruneSocket,
  teardownPair,
  liveSocketOf,
  seenMailIdRegister,
  getWireHooks,
  sendFrame,
  WIRE_CLOSE_SUPERSEDED,
  WIRE_CLOSE_BYE,
  type AnnounceFrame,
  type MailFrame,
  type WireFrame,
} from '../peer/wire-registry.js';
import { isWireDebugLocal } from '../config.js';

/** Dedicated maxPayload for peer mail frames — decoupled from the webui
 *  upload limit (getMaxUploadMb, default 50MB). Peer mail is agent-to-agent
 *  text; 4MB per frame is generous while bounding the 1009-storm blast
 *  radius (plan §5, round-1 finding G2). */
export const PEER_WIRE_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Interval for our side's ping keepalive (the `ws` library auto-RESPONDS
 *  to pings but does NOT auto-SEND them — we implement the sender; plan §5).
 *  Missed-pong terminate lives in the dialer; the acceptor merely answers
 *  pings (library default) and pings the peer at the same cadence so dead
 *  peers are detected from the serving side too. */
const PING_INTERVAL_MS = 30_000;
const MISSED_PONG_LIMIT = 2;

/** Wire frame types + send helpers are SHARED with the dialer and the peer
 *  facade — they live in wire-registry.ts (the src/peer wire-plane module).
 *  Re-exported here so acceptor-internal code and tests can keep importing
 *  from this module. */
export type { AnnounceFrame, MailFrame, WireFrame } from '../peer/wire-registry.js';
export { sendFrame, sendWireMail } from '../peer/wire-registry.js';

/**
 * PeerWireAcceptor - owns the /peer/ws WebSocketServer and its sockets.
 *
 * Lifetime is tied to the serve stack: created by ServeHub.start() (the
 * upgradeHandler routes /peer/ws upgrades here), destroyed by ServeHub.stop()
 * / restartServe() — stop() closes every accepted wire (abnormal close →
 * dialer redials → re-announce → converges; plan §5, finding G8).
 */
export class PeerWireAcceptor {
  private wsServer: WebSocketServer | null = null;
  /** Per-socket liveness state (ping cadence + missed-pong count). */
  private liveness = new Map<WebSocket, { misses: number }>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Build the dedicated WebSocketServer for /peer/ws. Call once per
   *  ServeHub.start(); hand the server to the hub's upgradeHandler. */
  createServer(): WebSocketServer {
    if (this.wsServer) return this.wsServer;
    this.wsServer = new WssCtor({ noServer: true, maxPayload: PEER_WIRE_MAX_PAYLOAD_BYTES });
    this.wsServer.on('connection', (ws: WebSocket) => this.onConnection(ws));
    this.startPingTimer();
    return this.wsServer;
  }

  /** The current dedicated server (null when the stack is down). */
  get server(): WebSocketServer | null {
    return this.wsServer;
  }

  /**
   * Handle an upgrade request to /peer/ws. Called by ServeHub's
   * upgradeHandler when req.url starts with /peer/ws.
   *
   * Token verification (OPTIONAL, plan §5 Security): the dialer passes
   * ?token=<shared-secret>. The token is a shared secret exchanged
   * out-of-band (env `MYCC_WIRE_TOKEN`). It is OPTIONAL:
   *   - If MYCC_WIRE_TOKEN is NOT configured on this acceptor → the upgrade
   *     is accepted with NO token check (open). Security is the operator's
   *     responsibility at OSI L3 (firewall / TLS reverse proxy / VPN / SSH
   *     tunnel) — mycc does not impose an in-app auth gate by default.
   *   - If MYCC_WIRE_TOKEN IS configured → a missing or mismatched token
   *     destroys the underlying TCP socket (HTTP 401 first when possible).
   *     Operators who want the in-app gate set the same value on both ends.
   */
  handleUpgrade(req: import('http').IncomingMessage, socket: import('stream').Duplex, head: Buffer): void {
    const expected = process.env.MYCC_WIRE_TOKEN;
    if (expected) {
      // Token configured → enforce it (the optional in-app auth gate).
      const url = new URL(req.url ?? '/peer/ws', 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token || token !== expected) {
        this.refuseUpgrade(socket, 'unauthorized (bad or missing wire token)');
        return;
      }
    }
    // No token configured → open upgrade (security at OSI L3, operator's
    // responsibility). Or token matched → proceed.
    if (!this.wsServer) {
      this.refuseUpgrade(socket, 'wire server not running');
      return;
    }
    this.wsServer.handleUpgrade(req, socket, head, (ws) => {
      this.wsServer!.emit('connection', ws, req);
    });
  }

  /** Write a 401 + destroy — an unauthorized upgrade never becomes a WS. */
  private refuseUpgrade(socket: import('stream').Duplex, reason: string): void {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } catch { /* ignore */ }
    socket.destroy();
    getWireHooks()?.verbose('wire', `peer wire upgrade refused: ${reason}`);
  }

  /** Whether the local escape hatch allows same-store/self wire connects
   *  (--debug-wire / MYCC_WIRE_ALLOW_LOCAL — test-only; plan §2 step 1.5). */
  static allowLocal(): boolean {
    return isWireDebugLocal();
  }

  /** A new accepted peer socket. Isolated from the webui lifecycle (G1):
   *  NO clients.add(), NO disconnectTimer.cancel() — the registry write and
   *  the reminder todo happen on ANNOUNCE (the first identity evidence),
   *  not on bare connect. */
  private onConnection(ws: WebSocket): void {
    this.liveness.set(ws, { misses: 0 });
    ws.on('message', (data) => this.onMessage(ws, data.toString()));
    ws.on('close', (code) => this.onClose(ws, code));
    ws.on('pong', () => {
      const state = this.liveness.get(ws);
      if (state) state.misses = 0;
    });
    ws.on('error', () => { /* close will follow; prune handled there */ });
  }

  private onMessage(ws: WebSocket, raw: string): void {
    const hooks = getWireHooks();
    let frame: WireFrame;
    try {
      frame = JSON.parse(raw) as WireFrame;
    } catch {
      hooks?.verbose('wire', 'dropping malformed wire frame');
      return;
    }

    if (frame.type === 'announce') {
      this.onAnnounce(ws, frame);
      return;
    }
    if (frame.type === 'mail') {
      this.onMail(ws, frame);
      return;
    }
    hooks?.verbose('wire', `dropping unknown wire frame type: ${(frame as { type?: string }).type}`);
  }

  /**
   * Announce handling: registry upsert (via the shared registry singleton,
   * G3 injection), self-dial backstop, then our own announce reply, then
   * pair-dedupe convergence when this completes a simultaneous mutual dial.
   */
  private onAnnounce(ws: WebSocket, frame: AnnounceFrame): void {
    const hooks = getWireHooks();
    if (!hooks) return; // hooks unwired (tests without full ctx) — drop
    const selfSid = hooks.getSessionId();

    // Self-dial backstop (plan §2 step 2.5): an announce carrying OUR OWN
    // sid is a self-connect the probe-time locality check missed (race).
    // Close 4000 on both ends and surface a "cannot wire to self" error.
    if (frame.sessionId === selfSid) {
      try { ws.close(WIRE_CLOSE_SUPERSEDED, 'cannot wire to self'); } catch { /* closing */ }
      hooks.verbose('wire', 'self-dial backstop fired: refused announce with own sid');
      return;
    }

    // Registry upsert — the accepted socket's endpoint key is the peer's
    // announced serving endpoint, or a sid-scoped key when the dialer runs
    // no webui (NAT'd headless instance).
    const endpoint = frame.endpoint ?? `sid:${frame.sessionId}`;
    recordAnnounce({
      endpoint,
      dialed: false, // we ACCEPTED this socket
      socket: ws,
      sid: frame.sessionId,
      // For an accepted socket the dialer is the remote initiator.
      initiatorSid: frame.sessionId,
      meta: { workDir: frame.workDir, role: frame.role, daemon: frame.daemon },
    });

    // Reply with OUR announce (the acceptor's side of the identity
    // exchange, plan §2 step 3) — the dialer learns our sid from it.
    const reply: AnnounceFrame = {
      type: 'announce',
      sessionId: selfSid,
      workDir: hooks.getWorkDir(),
      ...(hooks.getRole() ? { role: hooks.getRole() } : {}),
      ...(hooks.getDaemon() ? { daemon: true } : {}),
      endpoint: hooks.getServingEndpoint() ?? undefined,
    };
    sendFrame(ws, reply);

    // Pair-dedupe convergence (plan §5 layer 2; review finding: sid-scoped):
    // when we hold more than one socket to the SAME peer sid (a simultaneous
    // mutual dial — the two sockets may even be keyed under different
    // endpoint strings, dialed URL vs announced endpoint), close our loser
    // with 4000. The dialer side runs the same rule over its own sockets —
    // symmetric, same winner on both ends. convergePairBySid no-ops when
    // this sid has only one socket.
    convergePairBySid(frame.sessionId);
  }

  /**
   * Inbound mail frame: seen-id dedupe FIRST (duplicates never reach the
   * mailbox, plan §5), then append via hooks.appendLocalMail — the single
   * mailbox writer (MailBox.appendMail), which rouses the existing 1s
   * awaitTeammates poll → AWAIT → COLLECT. Zero agent-loop changes (§4).
   */
  private onMail(_ws: WebSocket, frame: MailFrame): void {
    const hooks = getWireHooks();
    if (!hooks) return;
    if (!frame.id || !frame.from) {
      hooks.verbose('wire', 'dropping mail frame without id/from');
      return;
    }
    if (!seenMailIdRegister(frame.id)) {
      hooks.verbose('wire', `duplicate wire mail dropped: ${frame.id}`);
      return;
    }
    hooks.appendLocalMail(frame.from, frame.title, frame.content);
  }

  /**
   * Accepted-socket close. Prunes the socket from its pair
   * (socket-identity-guarded — a stale close for a replaced socket is a
   * no-op). Terminal codes (4000/4001) tear the WHOLE pair down (no
   * re-dial; the dialer's loop sees the same terminality). Abnormal close
   * leaves the pair entry to the dialer-side reconnect loop: we merely
   * prune the dead socket.
   *
   * Deliberately does NOT touch the webui disconnect timer (G1): a peer
   * hangup must never re-arm the 30s webui auto-shutdown.
   */
  private onClose(ws: WebSocket, code: number): void {
    this.liveness.delete(ws);
    const prunedPair = pruneSocket(ws);
    if (!prunedPair) return;
    // Survivor-aware terminality (plan §5 convergence): a 4000 that pruned
    // only the CONVERGENCE LOSER while the pair still holds a live sibling
    // (simultaneous mutual dial just resolved) must NOT tear the pair down —
    // the survivor carries the pair. Only when NO live socket remains is the
    // close terminal for the pair. 4001 (bye) is an explicit hang-up and
    // tears down the WHOLE pair regardless of survivors.
    if (code === WIRE_CLOSE_SUPERSEDED) {
      if (liveSocketOf(prunedPair) === null) teardownPair(prunedPair.endpoint);
      return;
    }
    if (code === WIRE_CLOSE_BYE) {
      teardownPair(prunedPair.endpoint);
      return;
    }
    // Abnormal/network close: if the pair has no live socket left, drop the
    // entry (the remote's dialer owns any redial; our acceptor never dials).
    if (prunedPair.sockets.length === 0) {
      teardownPair(prunedPair.endpoint);
    }
  }

  /** Ping keepalive for accepted sockets — the serving side's half of the
   *  missed-pong terminate (plan §5): the `ws` library auto-responds to
   *  pings; a peer that stops responding is terminated so a half-open
   *  socket cannot linger as a zombie registry entry. */
  private startPingTimer(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      for (const ws of this.liveness.keys()) {
        if (ws.readyState !== ws.OPEN) continue;
        const state = this.liveness.get(ws);
        if (!state) continue;
        state.misses++;
        if (state.misses > MISSED_PONG_LIMIT) {
          try { ws.terminate(); } catch { /* ignore */ }
          continue;
        }
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  /**
   * Tear the acceptor down (ServeHub.stop / restartServe). Closes every
   * accepted socket (abnormal close → dialer redials → re-announce →
   * converges, plan §5 finding G8). Idempotent.
   */
  stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const ws of this.liveness.keys()) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
    this.liveness.clear();
    if (this.wsServer) {
      try { this.wsServer.close(); } catch { /* ignore */ }
      this.wsServer = null;
    }
  }

  /** Test seam: accept a socket WITHOUT the upgrade handshake. */
  acceptForTest(ws: WebSocket): void {
    this.onConnection(ws);
  }
}

/**
 * Module-level acceptor singleton — the ServeHub reaches it without owning
 * its lifetime details; created lazily so a non-serving instance never
 * allocates it.
 */
let acceptor: PeerWireAcceptor | null = null;

export function getPeerWireAcceptor(): PeerWireAcceptor {
  if (!acceptor) acceptor = new PeerWireAcceptor();
  return acceptor;
}

/** Test hook: drop the singleton so a fresh one can be created. */
export function resetPeerWireAcceptor(): void {
  acceptor?.stop();
  acceptor = null;
}

/**
 * Send a mail frame over a live wire socket — MOVED to wire-registry.ts
 * (sendWireMail) so the peer facade (src/peer) does not depend on src/serve;
 * re-exported above. The acceptor-side onMail path still dedupes inbound
 * frames and appends via hooks.appendLocalMail — unchanged.
 */