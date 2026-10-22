/**
 * peer-wire-dialer.test.ts — dialer flow: probe → dial → announce → mail → disconnect
 *
 * Drives the REAL dialer against the FakeRemote: identity recording,
 * duplicate/self/same-store refusals, both mail directions with dedupe,
 * oversize guard, and the two disconnect semantics.
 *
 * Split out of the former 1,007-line peer-wire.test.ts at behaviour seams;
 * the shared in-process fixture lives in peer-wire-harness.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  SID_SELF,
  SID_REMOTE,
  selfLog,
  FakeRemote,
  identityFile,
  harnessBeforeEach,
  harnessAfterEach,
  makeTempDir,
} from './peer-wire-harness.js';
import {
  findBySid,
  findByEndpoint,
  hasLiveWireForEndpoint,
  listRemotePeers,
  sendWireMail,
  generateWireMailId,
  WIRE_CLOSE_BYE,
  WIRE_MAX_PAYLOAD_BYTES,
} from '../../peer/wire-registry.js';
import { connectPeer, disconnectPeer, stopWireClient } from '../../peer/wire-client.js';

// config.js is mocked BEFORE the modules under test are imported: the
// dialer's same-store filter reads identity.json via getIdentityFile().
let tempDir = '';
vi.mock('../../config.js', () => ({
  getDiscoveryDir: () => path.join(tempDir, 'discovery'),
  getIdentityFile: () => identityFile(tempDir),
  // Mirror the real isWireDebugLocal(): accepts --debug-wire ('true') and
  // the legacy MYCC_WIRE_ALLOW_LOCAL=1 spelling.
  isWireDebugLocal: () => {
    const v = process.env.MYCC_WIRE_ALLOW_LOCAL;
    return v === '1' || v === 'true';
  },
}));

let remote: FakeRemote;

beforeEach(async () => {
  vi.useRealTimers();
  tempDir = makeTempDir();
  remote = await harnessBeforeEach(tempDir);
});

afterEach(async () => {
  await harnessAfterEach(remote);
  vi.useRealTimers();
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
    fs.writeFileSync(identityFile(tempDir), JSON.stringify({
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
    // dialer, the upgrade carries no X-MYCC-Wire-Token header; when the
    // acceptor also has no token configured, the upgrade is accepted openly
    // (security is the operator's responsibility at OSI L3, not an in-app
    // gate). The FakeRemote mirrors this: token=null → it accepts upgrades
    // with no token header. The wire must establish end-to-end without a
    // token.
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
