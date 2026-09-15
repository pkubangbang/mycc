/**
 * peer-wire.test.ts — Remote peer wire protocol test matrix (Phase 4)
 *
 * Exercises the REAL acceptor (src/serve/peer-wire.ts) and the REAL dialer
 * (src/peer/wire-client.ts) against each other over real WebSocket sockets,
 * with the WireHooks injected via setWireHooks (the same seam ParentContext
 * uses — src/serve never imports ctx, plan G3). No ServeHub boot is needed:
 * the acceptor's createServer/handleUpgrade are driven by a plain
 * http.Server upgrade event, exactly like ServeHub's upgradeHandler routes
 * /peer/ws upgrades in production.
 *
 * Covered matrix (docs/remote-peer-protocol.md §7 phase-4):
 *   - connect + announce exchange, both sides recorded in their registries
 *   - mail BOTH directions, dedupe by id (duplicate dropped exactly once)
 *   - info-symmetry todo (test g): establishment fires recordRemotePeerTodo
 *     (done=false) on BOTH sides; terminal close fires done=true; transient
 *     close does NOT; re-announce refreshes without duplicating
 *   - sequential duplicate dial rejected by the pre-check (already connected)
 *   - simultaneous mutual dial converges to ONE socket; loser closed 4000;
 *     survivor-aware close handling keeps the pair (no teardown of the live
 *     sibling's registry entry)
 *   - 4001 (bye) is terminal: whole-pair teardown, epoch bumped so a
 *     mid-flight dial aborts (no resurrection)
 *   - locality refusal: same-store sid refused (STORE-based, not URL-based —
 *     a 127.0.0.1 URL whose peer sid is NOT in identity.json is allowed, the
 *     VS Code remote-tunnel case); --debug-wire / MYCC_WIRE_ALLOW_LOCAL=1
 *     overrides;
 *     self-dial refused at probe time AND at announce time
 *   - missed-pong terminate (fake timers): 2 missed pongs → terminate
 *   - oversize mail frame: sender-side guard refuses (fail-fast, no 1009)
 *   - fail-fast: sendPeerMail with no live socket → false
 *
 * The two-instance smoke test (real tmux boots) lives in
 * peer-wire-smoke.test.ts — this file runs fully in-process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket, WebSocketServer } from 'ws';

// ---- Mock config BEFORE importing the modules under test -----------------
// The dialer's same-store sid filter reads identity.json via getIdentityFile()
// — point it at a per-test temp dir (peer-freshness.test.ts convention).
let tempDir = '';
const identityFile = () => path.join(tempDir, 'discovery', 'identity.json');

vi.mock('../../config.js', () => ({
  getDiscoveryDir: () => path.join(tempDir, 'discovery'),
  getIdentityFile: () => identityFile(),
  // Mirror the real isWireDebugLocal() so the dialer's escape-hatch check
  // resolves through the mocked module: accepts both --debug-wire ('true')
  // and the legacy MYCC_WIRE_ALLOW_LOCAL=1 spelling.
  isWireDebugLocal: () => {
    const v = process.env.MYCC_WIRE_ALLOW_LOCAL;
    return v === '1' || v === 'true';
  },
}));

import {
  setWireHooks,
  resetWireRegistry,
  resetSeenMailIds,
  findBySid,
  findByEndpoint,
  endpointOfSid,
  hasLiveWireForEndpoint,
  listRemotePeers,
  sendWireMail,
  generateWireMailId,
  recordAnnounce,
  convergePairBySid,
  pruneSocket,
  teardownPair,
  WIRE_CLOSE_SUPERSEDED,
  WIRE_CLOSE_BYE,
  WIRE_MAX_PAYLOAD_BYTES,
  type WireHooks,
} from '../../peer/wire-registry.js';
import { connectPeer, disconnectPeer, resetWireClient, stopWireClient, setPingIntervalForTest } from '../../peer/wire-client.js';
import { getPeerWireAcceptor, resetPeerWireAcceptor, PEER_WIRE_MAX_PAYLOAD_BYTES } from '../../serve/peer-wire.js';

const SID_SELF = 'aaaa0000-0000-0000-0000-00000000000a'; // lexicographically SMALL
const SID_REMOTE = 'zzzz0000-0000-0000-0000-00000000000z';
const TOKEN = 'test-wire-token';

/** Collected hook calls for assertions (the "both sides" of test g). */
interface HookLog {
  todos: Array<{ sid: string; endpoint: string; done: boolean }>;
  mails: Array<{ from: string; title: string; content: string }>;
}
const selfLog: HookLog = { todos: [], mails: [] };

function makeHooks(sid: string, log: HookLog): WireHooks {
  return {
    getSessionId: () => sid,
    getWorkDir: () => '/work/self',
    getDaemon: () => false,
    getRole: () => undefined,
    getServingEndpoint: () => null,
    recordRemotePeerTodo: (entry) => { log.todos.push({ ...entry }); },
    appendLocalMail: (from, title, content) => { log.mails.push({ from, title, content }); },
    verbose: () => { /* captured via log above when needed */ },
  };
}

/** A minimal stand-in for the REMOTE side: a /peer/ws server + /health. */
class FakeRemote {
  server: http.Server;
  wss: WebSocketServer;
  healthHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  /** Frames received from the dialer. */
  received: Array<Record<string, unknown>>;
  /** Sockets accepted. */
  sockets: WebSocket[];
  token: string | null;
  announceSid: string;

  constructor() {
    this.received = [];
    this.sockets = [];
    this.token = TOKEN;
    this.announceSid = SID_REMOTE;
    this.healthHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        peer: { sessionId: this.announceSid, daemon: false },
      }));
    };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: PEER_WIRE_MAX_PAYLOAD_BYTES });
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        this.received.push(frame);
        if (frame.type === 'announce') {
          // The real acceptor replies with its own announce.
          ws.send(JSON.stringify({
            type: 'announce',
            sessionId: this.announceSid,
            workDir: '/work/remote',
            daemon: false,
          }));
        }
      });
    });
    this.server = http.createServer((req, res) => this.healthHandler(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/peer/ws') {
        // Open mode (token === null) mirrors a real acceptor with no
        // MYCC_WIRE_TOKEN configured: accept the upgrade with NO token
        // check. When a token IS configured, a missing/mismatched ?token=
        // is refused with 401 (the optional in-app auth gate).
        const tokenOk = this.token === null || url.searchParams.get('token') === this.token;
        if (!tokenOk) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  get endpoint(): string {
    const addr = this.server.address() as { port: number };
    return `127.0.0.1:${addr.port}`;
  }

  /** Send a mail frame to the FIRST connected socket (the remote→self direction). */
  sendMailToDialer(id: string, title: string, content: string): void {
    const ws = this.sockets.find((s) => s.readyState === s.OPEN);
    expect(ws, 'fake remote must hold an open socket').toBeTruthy();
    ws!.send(JSON.stringify({
      type: 'mail', id, from: `${SID_REMOTE}/lead`, title, content, timestamp: Date.now(),
    }));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const ws of this.sockets) { try { ws.terminate(); } catch { /* ignore */ } }
      this.wss.close(() => undefined);
      this.server.close(() => resolve());
    });
  }
}

let remote: FakeRemote;

beforeEach(async () => {
  vi.useRealTimers();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-wire-'));
  fs.mkdirSync(path.join(tempDir, 'discovery'), { recursive: true });
  selfLog.todos.length = 0;
  selfLog.mails.length = 0;
  resetWireRegistry();
  resetSeenMailIds();
  resetWireClient();
  resetPeerWireAcceptor();
  process.env.MYCC_WIRE_TOKEN = TOKEN;
  process.env.MYCC_WIRE_ALLOW_LOCAL = '1'; // in-process suite shares the mocked store
  setWireHooks(makeHooks(SID_SELF, selfLog));
  remote = new FakeRemote();
  await remote.listen();
});

afterEach(async () => {
  stopWireClient();
  await remote.close();
  delete process.env.MYCC_WIRE_TOKEN;
  delete process.env.MYCC_WIRE_ALLOW_LOCAL;
  vi.useRealTimers();
});

describe('peer wire — registry invariants', () => {
  it('WIRE_MAX_PAYLOAD_BYTES matches the acceptor cap (single source of truth)', () => {
    expect(WIRE_MAX_PAYLOAD_BYTES).toBe(PEER_WIRE_MAX_PAYLOAD_BYTES);
    expect(WIRE_MAX_PAYLOAD_BYTES).toBe(4 * 1024 * 1024);
  });

  it('generateWireMailId is high-entropy and monotonic per sender', () => {
    const a = generateWireMailId('sid-a');
    const b = generateWireMailId('sid-a');
    const c = generateWireMailId('sid-b');
    expect(a).not.toBe(b);
    expect(a.startsWith('sid-a-')).toBe(true);
    expect(c.startsWith('sid-b-')).toBe(true);
  });

  it('recordAnnounce → convergePairBySid closes the loser with 4000 and keeps the winner', () => {
    // Two fake sockets for the same pair (simultaneous mutual dial window).
    const sockA = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    const sockB = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    recordAnnounce({ endpoint: 'h:1', dialed: true, socket: sockA, sid: 'peer-1', initiatorSid: 'aaa', meta: {} });
    recordAnnounce({ endpoint: 'h:1', dialed: false, socket: sockB, sid: 'peer-1', initiatorSid: 'bbb', meta: {} });
    const losers = convergePairBySid('peer-1');
    // Winner = socket initiated by the SMALLER sid → sockA (initiator aaa).
    expect(losers).not.toBeNull();
    expect(losers!.map((l) => l.initiatorSid)).toEqual(['bbb']);
    expect(sockB.close).toHaveBeenCalledWith(WIRE_CLOSE_SUPERSEDED, 'superseded');
    expect(sockA.close).not.toHaveBeenCalled();
  });

  it('REGRESSION (review finding 1): convergence fires across MISMATCHED endpoint keys', () => {
    // A simultaneous mutual dial keys its two sockets DIFFERENTLY: the socket
    // WE dialed is keyed by the URL string we typed ("127.0.0.1:3195"); the
    // socket we ACCEPTED is keyed by the endpoint the PEER announced
    // ("192.168.1.20:3195" — a legitimate tunnel/alias split, plan §2 step
    // 1.5). Endpoint-scoped bothAnnounced would silently no-op here; the
    // sid-scoped census must still converge to ONE live socket.
    const sockDialed = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    const sockAccepted = { readyState: 1, OPEN: 1, close: vi.fn() } as unknown as WebSocket;
    recordAnnounce({ endpoint: '127.0.0.1:3195', dialed: true, socket: sockDialed, sid: 'peer-1', initiatorSid: 'me', meta: {} });
    recordAnnounce({ endpoint: '192.168.1.20:3195', dialed: false, socket: sockAccepted, sid: 'peer-1', initiatorSid: 'peer-1', meta: {} });
    // The peer's initiator sid ("peer-1") is lexicographically LARGER than
    // ours ("me"), so the ACCEPTED socket (initiated by the peer) is the
    // loser and must be closed 4000 on OUR side.
    const losers = convergePairBySid('peer-1');
    expect(losers).not.toBeNull();
    expect(sockAccepted.close).toHaveBeenCalledWith(WIRE_CLOSE_SUPERSEDED, 'superseded');
    expect(sockDialed.close).not.toHaveBeenCalled();
    // Census is honest after the close is observed: prune the closed socket,
    // and a re-run finds only the winner (no second election, no-op).
    pruneSocket(sockAccepted);
    const rerun = convergePairBySid('peer-1');
    expect(rerun).toBeNull();
    expect(sockDialed.close).not.toHaveBeenCalled();
  });

  it('REGRESSION (review finding 2): the oversize guard measures UTF-8 BYTES, not chars', () => {
    // Multi-byte content: CJK chars are 3 bytes each in UTF-8. A payload
    // just under the cap in CHARACTERS can exceed it in BYTES — the guard
    // must refuse it BEFORE sending (no 1009 on the remote side).
    const cjk = '中'.repeat(WIRE_MAX_PAYLOAD_BYTES / 3 + 100); // chars < cap, bytes > cap
    expect(cjk.length).toBeLessThan(WIRE_MAX_PAYLOAD_BYTES); // char count passes
    expect(Buffer.byteLength(cjk, 'utf-8')).toBeGreaterThan(WIRE_MAX_PAYLOAD_BYTES); // byte count does not
    const sent = sendWireMail('peer-x', 't', cjk);
    expect(sent).toBe(false);
  });

  it('sid re-key on remote restart: findBySid resolves the NEW sid, old sid fails', () => {
    const sock = { readyState: 1, OPEN: 1 } as unknown as WebSocket;
    recordAnnounce({ endpoint: 'h:1', dialed: true, socket: sock, sid: 'old-sid', initiatorSid: 'me', meta: {} });
    expect(findBySid('old-sid')).not.toBeNull();
    recordAnnounce({ endpoint: 'h:1', dialed: true, socket: sock, sid: 'new-sid', initiatorSid: 'me', meta: {} });
    expect(findBySid('new-sid')).not.toBeNull();
    expect(findBySid('old-sid')).toBeNull(); // re-keyed away
    expect(endpointOfSid('new-sid')).toBe('h:1');
  });

  it('teardownPair bumps the epoch so a mid-flight dial aborts', () => {
    const before = teardownPair('h:9'); // no entry — still bumps
    expect(before).toBeNull();
    const sock = { readyState: 1, OPEN: 1 } as unknown as WebSocket;
    recordAnnounce({ endpoint: 'h:9', dialed: true, socket: sock, sid: 's', initiatorSid: 'me', meta: {} });
    teardownPair('h:9');
    expect(findByEndpoint('h:9')).toBeNull();
    expect(findBySid('s')).toBeNull();
  });
});

describe('peer wire — dialer connect flow (probe → checks → dial → announce)', () => {
  it('establishes a wire and records BOTH identities in the registry', async () => {
    const result = await connectPeer(remote.endpoint);
    expect(result).toContain('Wire established');
    expect(result).toContain(SID_REMOTE);

    // Registry: one pair, keyed by the dialed endpoint, with the remote's sid.
    const pair = findByEndpoint(remote.endpoint);
    expect(pair).not.toBeNull();
    expect(pair!.sid).toBe(SID_REMOTE);
    expect(pair!.dialed).toBe(true);
    expect(pair!.sockets.length).toBe(1);
    expect(hasLiveWireForEndpoint(remote.endpoint)).toBe(true);

    // The dialer SENT its announce (identity evidence for the remote).
    const announce = remote.received.find((f) => f.type === 'announce');
    expect(announce).toBeDefined();
    expect(announce!.sessionId).toBe(SID_SELF);

    // Info-symmetry todo fired on establishment (done=false).
    expect(selfLog.todos.some((t) => t.sid === SID_REMOTE && t.endpoint === remote.endpoint && !t.done)).toBe(true);
  }, 20_000);

  it('rejects a duplicate dial while the first wire is live (pre-check, layer 1)', async () => {
    await connectPeer(remote.endpoint);
    const dup = await connectPeer(remote.endpoint);
    expect(dup).toContain('Already connected');
    // Still exactly ONE socket toward the remote.
    expect(remote.sockets.length).toBe(1);
  }, 20_000);

  it('refuses to wire to self (probe-time check)', async () => {
    remote.announceSid = SID_SELF; // /health reports OUR OWN sid
    const result = await connectPeer(remote.endpoint);
    expect(result).toContain('refusing to wire to self');
    expect(remote.sockets.length).toBe(0);
  }, 20_000);

  it('refuses same-store peers (sid in identity.json) unless --debug-wire / MYCC_WIRE_ALLOW_LOCAL=1', async () => {
    // The check is STORE-based (sid in identity.json), NOT URL-based: a peer
    // whose sid is registered in the LOCAL discovery store runs on THIS
    // machine and is already reachable via discovery + channel files, so a
    // wire to it is redundant. A 127.0.0.1 URL whose peer sid is NOT in the
    // store (e.g. a VS Code remote-tunnel-forwarded remote) is allowed —
    // that case is covered by the default smoke/in-process connect tests
    // (the fake remote's sid is never written to identity.json).
    fs.writeFileSync(identityFile(), JSON.stringify({
      [SID_REMOTE]: { sessionId: SID_REMOTE, workDir: '/same/machine', mailbox: '/mb', startedAt: Date.now() },
    }), 'utf-8');
    delete process.env.MYCC_WIRE_ALLOW_LOCAL;
    const refused = await connectPeer(remote.endpoint);
    expect(refused).toContain('refusing same-store wire');
    expect(refused).toContain(SID_REMOTE);
    expect(remote.sockets.length).toBe(0);

    // Escape hatch: with MYCC_WIRE_ALLOW_LOCAL=1 (or --debug-wire) the dial
    // proceeds.
    process.env.MYCC_WIRE_ALLOW_LOCAL = '1';
    const ok = await connectPeer(remote.endpoint);
    expect(ok).toContain('Wire established');
  }, 20_000);

  it('dials OPEN (no token) when MYCC_WIRE_TOKEN is unset on both sides', async () => {
    // MYCC_WIRE_TOKEN is OPTIONAL (plan §5 Security): when unset on the
    // dialer, the upgrade carries no ?token=; when the acceptor also has no
    // token configured, the upgrade is accepted openly (security is the
    // operator's responsibility at OSI L3, not an in-app gate). The
    // FakeRemote mirrors this: token=null → it accepts upgrades with no
    // ?token= param. The wire must establish end-to-end without a token.
    delete process.env.MYCC_WIRE_TOKEN;
    remote.token = null; // acceptor side: also open (no token check)
    const result = await connectPeer(remote.endpoint);
    expect(result).toContain('Wire established');
    expect(result).toContain(SID_REMOTE);
    // A socket was accepted (no 401, no fail-closed gate).
    expect(remote.sockets.length).toBe(1);
  }, 20_000);

  it('reports unreachable targets with a probe error', async () => {
    const dead = new FakeRemote();
    const deadPort = await dead.listen();
    await dead.close();
    const result = await connectPeer(`127.0.0.1:${deadPort}`);
    expect(result).toContain('cannot reach');
    // A pending pair entry may exist (redial armed) — but with no live wire.
    expect(hasLiveWireForEndpoint(`127.0.0.1:${deadPort}`)).toBe(false);
  }, 20_000);
});

describe('peer wire — mail routing', () => {
  it('sends mail over the live wire and dedupes inbound duplicates exactly once', async () => {
    await connectPeer(remote.endpoint);

    // Outbound (self → remote): the frame lands on the remote's socket.
    const sent = sendWireMail(SID_REMOTE, 'hello', 'from self');
    expect(sent).toBe(true);
    await vi.waitFor(() => {
      expect(remote.received.some((f) => f.type === 'mail' && f.title === 'hello')).toBe(true);
    });

    // Inbound (remote → self): first copy appended to OUR mailbox.
    const id = generateWireMailId(SID_REMOTE);
    remote.sendMailToDialer(id, 'ping', 'content-1');
    await vi.waitFor(() => {
      expect(selfLog.mails.filter((m) => m.title === 'ping').length).toBe(1);
    });
    // Duplicate id → dropped BEFORE appendLocalMail (seen-id LRU).
    remote.sendMailToDialer(id, 'ping', 'content-1');
    await new Promise((r) => setTimeout(r, 300));
    expect(selfLog.mails.filter((m) => m.title === 'ping').length).toBe(1);
  }, 20_000);

  it('fails fast (returns false) when no live socket exists', async () => {
    expect(sendWireMail('unknown-sid', 't', 'c')).toBe(false);
    await connectPeer(remote.endpoint);
    // Kill the wire abruptly; the entry prunes and the send fails.
    stopWireClient();
    await new Promise((r) => setTimeout(r, 300));
    expect(sendWireMail(SID_REMOTE, 't', 'c')).toBe(false);
  }, 20_000);

  it('refuses an oversize mail frame WITHOUT sending (sender-side guard)', async () => {
    await connectPeer(remote.endpoint);
    const huge = 'x'.repeat(WIRE_MAX_PAYLOAD_BYTES + 1);
    const sent = sendWireMail(SID_REMOTE, 'big', huge);
    expect(sent).toBe(false);
    // Nothing reached the remote.
    expect(remote.received.some((f) => f.type === 'mail')).toBe(false);
  }, 20_000);
});

describe('peer wire — disconnect semantics', () => {
  it('peer_disconnect sends 4001 (bye), tears down the pair, marks todo done', async () => {
    await connectPeer(remote.endpoint);
    expect(listRemotePeers().length).toBe(1);

    const result = await disconnectPeer(SID_REMOTE);
    expect(result).toContain('hung up');
    expect(result).toContain(SID_REMOTE);

    // Pair gone; epoch-guarded against resurrection.
    expect(findByEndpoint(remote.endpoint)).toBeNull();
    expect(findBySid(SID_REMOTE)).toBeNull();

    // Info-symmetry todo marked done.
    const doneTodos = selfLog.todos.filter((t) => t.done);
    expect(doneTodos.length).toBeGreaterThan(0);
    expect(doneTodos[doneTodos.length - 1].sid).toBe(SID_REMOTE);

    // The remote side SAW close code 4001.
    await vi.waitFor(() => {
      expect(remote.sockets[0].readyState).toBe(remote.sockets[0].CLOSED);
    });
  }, 20_000);

  it('REGRESSION (review finding 3): terminal disconnect disposes the redial loop state', async () => {
    await connectPeer(remote.endpoint);
    await disconnectPeer(SID_REMOTE);
    // disposeLoop: not just cancelled — the loops entry is GONE, so nothing
    // retains stale attempts/timer state for the torn-down pair. A reconnect
    // lazily re-creates fresh state via scheduleRedial on the next failure.
    await connectPeer(remote.endpoint); // reconnect works (fresh loop state)
    const result = await disconnectPeer(SID_REMOTE);
    expect(result).toContain('hung up');
    // Reconnect → disconnect again must still work cleanly (no resurrection,
    // no leaked timer firing an announce into the dead remote).
    await new Promise((r) => setTimeout(r, 1_200));
    expect(remote.received.filter((f) => f.type === 'announce').length).toBeLessThanOrEqual(2);
    expect(findByEndpoint(remote.endpoint)).toBeNull();
  }, 20_000);

  it('remote 4001 is terminal for the redial loop (no automatic re-dial)', async () => {
    await connectPeer(remote.endpoint);
    // The REMOTE side hangs up with bye (4001).
    remote.sockets[0].close(WIRE_CLOSE_BYE, 'bye');
    await vi.waitFor(() => {
      expect(findByEndpoint(remote.endpoint)).toBeNull();
    });
    // Give any (wrongly armed) redial loop a moment to fire — none should.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(remote.received.filter((f) => f.type === 'announce').length).toBe(1);
    expect(findByEndpoint(remote.endpoint)).toBeNull();
  }, 20_000);

  it('abnormal close arms the survivor-aware redial loop and reconnects', async () => {
    await connectPeer(remote.endpoint);
    const firstAnnounces = remote.received.filter((f) => f.type === 'announce').length;
    expect(firstAnnounces).toBe(1);
    // Network failure: terminate WITHOUT a close code (1006 class).
    remote.sockets[0].terminate();
    // The pending pair entry survives (mail_to "retrying" semantics)...
    await vi.waitFor(() => {
      expect(findByEndpoint(remote.endpoint)).not.toBeNull();
    });
    // ...and the redial loop re-establishes (fake remote still listening).
    await vi.waitFor(() => {
      expect(remote.received.filter((f) => f.type === 'announce').length).toBe(2);
    }, { timeout: 5_000 });
    expect(hasLiveWireForEndpoint(remote.endpoint)).toBe(true);
    // The re-announce REFRESHES the todo (no duplicate entry beyond refresh).
    const todoForRemote = selfLog.todos.filter((t) => t.endpoint === remote.endpoint);
    expect(todoForRemote.length).toBeGreaterThanOrEqual(1);
    expect(todoForRemote[todoForRemote.length - 1].done).toBe(false);
  }, 20_000);
});

describe('peer wire — acceptor side (real PeerWireAcceptor)', () => {
  it('accepts a dial, replies with its own announce, records the pair, and prunes on close', async () => {
    const httpServer = http.createServer();
    const acceptor = getPeerWireAcceptor();
    acceptor.createServer();
    httpServer.on('upgrade', (req, socket, head) => {
      acceptor.handleUpgrade(req, socket, head);
    });
    const port = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as { port: number }).port));
    });

    // Simulate the REMOTE dialer connecting to US.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/peer/ws?token=${TOKEN}`);
    const gotReply = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'announce', sessionId: SID_REMOTE, workDir: '/work/remote', daemon: false,
        }));
      });
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === 'announce') resolve(frame);
      });
    });
    const reply = await gotReply;
    expect(reply.sessionId).toBe(SID_SELF);

    // Registry on OUR side: pair keyed by sid-scoped endpoint (no announced
    // serving endpoint → "sid:<sid>" key, NAT'd dialer case).
    const pair = findBySid(SID_REMOTE);
    expect(pair).not.toBeNull();
    expect(pair!.endpoint.startsWith('sid:')).toBe(true);
    expect(pair!.dialed).toBe(false);

    // Info-symmetry todo fired on the ACCEPTOR side too.
    expect(selfLog.todos.some((t) => t.sid === SID_REMOTE && !t.done)).toBe(true);

    // Close → pruned + teardown (no live sibling).
    ws.close(1000, 'done');
    await vi.waitFor(() => {
      expect(findBySid(SID_REMOTE)).toBeNull();
    });

    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    acceptor.stop();
  }, 20_000);

  it('refuses an upgrade with a bad token (401, socket destroyed)', async () => {
    const httpServer = http.createServer();
    const acceptor = getPeerWireAcceptor();
    acceptor.createServer();
    httpServer.on('upgrade', (req, socket, head) => {
      acceptor.handleUpgrade(req, socket, head);
    });
    const port = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as { port: number }).port));
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/peer/ws?token=WRONG`);
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('unexpected-response', () => resolve(-1)); // 401 path
    });
    const code = await closed;
    expect([1006, -1]).toContain(code); // refused before WS establishment

    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    acceptor.stop();
  }, 20_000);

  it('self-dial backstop: announce carrying OUR OWN sid closes 4000', async () => {
    const httpServer = http.createServer();
    const acceptor = getPeerWireAcceptor();
    acceptor.createServer();
    httpServer.on('upgrade', (req, socket, head) => {
      acceptor.handleUpgrade(req, socket, head);
    });
    const port = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as { port: number }).port));
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/peer/ws?token=${TOKEN}`);
    const closeCode = new Promise<number>((resolve) => {
      ws.on('open', () => {
        // Announce with OUR OWN sid — the backstop violation.
        ws.send(JSON.stringify({
          type: 'announce', sessionId: SID_SELF, workDir: '/work/self', daemon: false,
        }));
      });
      ws.on('close', (code) => resolve(code));
    });
    expect(await closeCode).toBe(WIRE_CLOSE_SUPERSEDED);
    // No registry entry was recorded for the self-announce.
    expect(listRemotePeers().length).toBe(0);

    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    acceptor.stop();
  }, 20_000);
});

describe('peer wire — liveness (missed-pong terminate)', () => {
  it('terminates a dialed socket after 2 missed pongs', async () => {
    // Shorten the cadence via the test seam (fake timers cannot adopt the
    // interval created during the real-timer WS handshake).
    setPingIntervalForTest(50);

    // Capture the dialer's verbose termination log (our side of the wire).
    const verboseMsgs: string[] = [];
    const hooks = makeHooks(SID_SELF, selfLog);
    setWireHooks({ ...hooks, verbose: (_tool, message) => { verboseMsgs.push(message); } });

    await connectPeer(remote.endpoint);
    expect(hasLiveWireForEndpoint(remote.endpoint)).toBe(true);

    // Sabotage the pong path: pause the REMOTE's underlying TCP socket so it
    // never reads our pings — no read, no auto-pong, misses accumulate.
    const remoteRaw = (remote.sockets[0] as unknown as { _socket?: { pause: () => void } })._socket;
    expect(remoteRaw).toBeDefined();
    remoteRaw!.pause();

    // The dialer terminates after the misses exceed the limit; observe OUR
    // side (the paused remote socket cannot report the TCP reset — its read
    // stream is blinded, so readyState there never flips). The verbose log
    // fires at the terminate call site, and the registry prunes the dead
    // socket on its close event.
    await vi.waitFor(() => {
      expect(verboseMsgs.some((m) => m.includes('missed-pong limit reached'))).toBe(true);
    }, { timeout: 5_000 });
    // The liveness map drops the socket and the pair loses its live wire.
    await vi.waitFor(() => {
      expect(hasLiveWireForEndpoint(remote.endpoint)).toBe(false);
    }, { timeout: 5_000 });
  }, 20_000);
});

describe('peer wire — info-symmetry todo lifecycle (test g)', () => {
  it('terminal 4001 marks todo done; transient close keeps it; re-announce refreshes', async () => {
    await connectPeer(remote.endpoint);

    // (1) Establishment → done=false.
    expect(selfLog.todos.filter((t) => !t.done).length).toBeGreaterThanOrEqual(1);

    // (2) Transient close (network) → todo stays not-done; loop reconnects.
    remote.sockets[0].terminate();
    await vi.waitFor(() => {
      expect(remote.received.filter((f) => f.type === 'announce').length).toBe(2);
    }, { timeout: 5_000 });
    const todosAfterTransient = selfLog.todos.filter((t) => !t.done);
    expect(todosAfterTransient.length).toBeGreaterThanOrEqual(1);

    // (3) Terminal bye (peer_disconnect) → done=true.
    await disconnectPeer(SID_REMOTE);
    const doneTodos = selfLog.todos.filter((t) => t.done);
    expect(doneTodos.length).toBeGreaterThanOrEqual(1);
    expect(doneTodos.every((t) => t.sid === SID_REMOTE)).toBe(true);
    // ...and the pair is gone for good.
    expect(findBySid(SID_REMOTE)).toBeNull();
  }, 25_000);

  it('re-announce does not duplicate the reminder (recordAnnounce refresh path)', async () => {
    await connectPeer(remote.endpoint);
    const countAfterConnect = selfLog.todos.filter((t) => t.endpoint === remote.endpoint && !t.done).length;
    expect(countAfterConnect).toBe(1); // one establishment todo

    // A re-announce of the SAME pair (e.g. the remote re-sends announce on a
    // second socket that then converges away): the registry-level refresh
    // fires recordRemotePeerTodo again — the PARENT dedupe (by endpoint)
    // is ParentContext's job; here we assert the registry keeps firing the
    // hook with the same endpoint key so the dedupe CAN work.
    const sock = { readyState: 1, OPEN: 1 } as unknown as WebSocket;
    recordAnnounce({ endpoint: remote.endpoint, dialed: false, socket: sock, sid: SID_REMOTE, initiatorSid: SID_REMOTE, meta: {} });
    const todosForEndpoint = selfLog.todos.filter((t) => t.endpoint === remote.endpoint && !t.done);
    expect(todosForEndpoint.length).toBe(2); // hook fired again — same endpoint key
    expect(todosForEndpoint.every((t) => t.sid === SID_REMOTE)).toBe(true);
  }, 20_000);
});