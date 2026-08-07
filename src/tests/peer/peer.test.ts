/**
 * peer.test.ts — tests for IdentityManager, ChannelManager, PeerManager.
 *
 * The peer modules read/write ~/.mycc-store/discovery/{identity.json,heartbeat/,channels/}.
 * To isolate the filesystem we mock ../config.js so the discovery helpers point
 * at a per-test temp dir. Mailbox paths (passed to the managers) also point
 * inside the temp dir so firstQuery delivery and sendMail append to test-owned
 * files.
 *
 * Freshness rule under test (D1): fresh ⟺ remoteLatest > localOldest.
 * Channel protocol under test: listChannels populates peerSessionId by sibling
 * scan; joinChannel sets joined + delivers firstQuery locally; sendMail is
 * gated by freshness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Mock config so discovery paths point at a temp directory ----------------
let tempDir = '';
const discoveryDir = () => path.join(tempDir, 'discovery');
const identityFile = () => path.join(discoveryDir(), 'identity.json');
const heartbeatDir = () => path.join(discoveryDir(), 'heartbeat');
const heartbeatFile = (sid: string) => path.join(heartbeatDir(), `${sid}.json`);
const channelsDir = () => path.join(discoveryDir(), 'channels');
const channelFile = (sid: string, cid: string) => path.join(channelsDir(), `${sid}-${cid}.json`);

vi.mock('../../config.js', () => ({
  getDiscoveryDir: () => discoveryDir(),
  getIdentityFile: () => identityFile(),
  getHeartbeatDir: () => heartbeatDir(),
  getHeartbeatFile: (sid: string) => heartbeatFile(sid),
  getChannelsDir: () => channelsDir(),
  getChannelFile: (sid: string, cid: string) => channelFile(sid, cid),
}));

// Import AFTER mocks are registered.
import { IdentityManager } from '../../peer/identity.js';
import { ChannelManager } from '../../peer/channel.js';
import { PeerManager } from '../../peer/peer.js';
import type { ChannelFile } from '../../types.js';

const SID_A = 'aaaa0000-0000-0000-0000-000000000000';
const SID_B = 'bbbb1111-1111-1111-1111-111111111111';

function writeHeartbeatRaw(sid: string, timestamps: number[]): void {
  const dir = heartbeatDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(heartbeatFile(sid), JSON.stringify({ timestamps }), 'utf-8');
}

function writeChannelRaw(sid: string, cid: string, ch: ChannelFile): void {
  const dir = channelsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(channelFile(sid, cid), JSON.stringify(ch, null, 2), 'utf-8');
}

function makeMailboxPath(sid: string): string {
  const mbDir = path.join(tempDir, 'mailbox', sid);
  if (!fs.existsSync(mbDir)) fs.mkdirSync(mbDir, { recursive: true });
  return path.join(mbDir, 'unread-lead.jsonl');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-peer-'));
  for (const d of [discoveryDir(), heartbeatDir(), channelsDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('IdentityManager', () => {
  it('register() upserts into identity.json and listIdentities() returns it', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const entries = id.listIdentities();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe(SID_A);
    expect(entries[0].workDir).toBe('/work/a');
    expect(entries[0].mailbox).toContain('unread-lead.jsonl');
  });

  it('unregister() removes the entry', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    expect(id.listIdentities()).toHaveLength(1);
    id.unregister();
    expect(id.listIdentities()).toHaveLength(0);
  });

  it('isFresh() returns false for an unregistered session', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    expect(id.isFresh(SID_B)).toBe(false);
  });

  it('isFresh() is true when remote heartbeat is newer than local oldest', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    // Register B too so identity.json has the entry.
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();

    // Local oldest = 1000 (A), remote latest = 5000 (B) → 5000 > 1000 → fresh.
    writeHeartbeatRaw(SID_A, [1000, 1100, 1200]);
    writeHeartbeatRaw(SID_B, [4800, 4900, 5000]);
    expect(id.isFresh(SID_B)).toBe(true);
  });

  it('isFresh() is false when remote heartbeat is older than local oldest', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();
    // Local oldest = 5000, remote latest = 1000 → 1000 > 5000 is false.
    writeHeartbeatRaw(SID_A, [5000, 5100, 5200]);
    writeHeartbeatRaw(SID_B, [800, 900, 1000]);
    expect(id.isFresh(SID_B)).toBe(false);
  });

  it('isFresh() treats everything as fresh when local has 0 beats (oldest = -Infinity)', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();
    // No local heartbeat file for A; remote has a recent beat.
    writeHeartbeatRaw(SID_B, [10, 20, 30]);
    expect(id.isFresh(SID_B)).toBe(true);
  });

  it('getRemoteMailbox() returns the registered mailbox path or null', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    expect(id.getRemoteMailbox(SID_A)).toContain('unread-lead.jsonl');
    expect(id.getRemoteMailbox('nonexistent-sid')).toBeNull();
  });

  it('startHeartbeat() writes a beat immediately and trims to 3', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.startHeartbeat();
    let beats = id.getOwnHeartbeat();
    expect(beats).toHaveLength(1);
    // Manually beat twice more to test the trim-to-3 invariant.
    id.stopHeartbeat();
    // Re-create and beat 5 times by calling start/stop won't trim predictably;
    // instead, write directly to test trim on read-back via a fresh instance.
    writeHeartbeatRaw(SID_A, [1, 2, 3, 4, 5]);
    // A new instance reading the same file trims on next beat.
    const id2 = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id2.startHeartbeat();
    beats = id2.getOwnHeartbeat();
    expect(beats).toHaveLength(3);
    // Last three of [1,2,3,4,5,now] → [4,5,now]
    expect(beats[0]).toBe(4);
    expect(beats[1]).toBe(5);
    id2.stopHeartbeat();
  });
});

describe('ChannelManager', () => {
  it('listChannels() returns own channel files and populates peerSessionId via sibling scan', () => {
    // Two-sided channel: A owns a file, B owns the sibling with same channelId.
    const cid = 'chan-001';
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: null,
      title: 'sync', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });
    writeChannelRaw(SID_B, cid, {
      channelId: cid, ownerSessionId: SID_B, peerSessionId: null,
      title: 'sync', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });

    const idA = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    const ch = new ChannelManager(SID_A, idA, makeMailboxPath(SID_A));
    const list = ch.listChannels();
    expect(list).toHaveLength(1);
    expect(list[0].channelId).toBe(cid);
    // Sibling scan should have discovered SID_B and persisted it.
    expect(list[0].peerSessionId).toBe(SID_B);
  });

  it('listChannels() returns [] when no own channel files exist', () => {
    const idA = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    const ch = new ChannelManager(SID_A, idA, makeMailboxPath(SID_A));
    expect(ch.listChannels()).toEqual([]);
  });

  it('joinChannel() throws if the channel file does not exist', () => {
    const idA = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    const ch = new ChannelManager(SID_A, idA, makeMailboxPath(SID_A));
    expect(() => ch.joinChannel('missing')).toThrow(/Channel file not found/);
  });

  it('joinChannel() sets joined=true and delivers firstQuery to the LOCAL mailbox', () => {
    const cid = 'chan-002';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 'theme-x', firstQuery: 'Hello there', joined: false, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    idA.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();
    // Make B fresh so later sendMail tests can use it.
    writeHeartbeatRaw(SID_A, [1000]);
    writeHeartbeatRaw(SID_B, [5000]);

    const ch = new ChannelManager(SID_A, idA, mailbox);
    const result = ch.joinChannel(cid);
    expect(result.joined).toBe(true);
    expect(result.firstQuery).toBe('Hello there');

    // firstQuery delivered to LOCAL mailbox as a JSONL line.
    const lines = fs.readFileSync(mailbox, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const mail = JSON.parse(lines[0]);
    expect(mail.title).toBe(`[${cid}] channel-init`);
    expect(mail.content).toContain('theme-x');
    expect(mail.content).toContain('Hello there');
    expect(mail.from).toBe('system');

    // firstQuerySent persisted so a re-join does not re-deliver.
    const rejoin = ch.joinChannel(cid);
    expect(rejoin.joined).toBe(true);
    expect(fs.readFileSync(mailbox, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('sendMail() returns false when the peer is stale', () => {
    const cid = 'chan-003';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: true, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    idA.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();
    // B is stale: local oldest 5000, remote latest 1000.
    writeHeartbeatRaw(SID_A, [5000, 5100, 5200]);
    writeHeartbeatRaw(SID_B, [800, 900, 1000]);

    const ch = new ChannelManager(SID_A, idA, mailbox);
    expect(ch.sendMail(cid, SID_B, 'topic', 'body')).toBe(false);
  });

  it('sendMail() appends to the remote mailbox when the peer is fresh', () => {
    const cid = 'chan-004';
    const mailboxA = makeMailboxPath(SID_A);
    const mailboxB = makeMailboxPath(SID_B);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: true, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailboxA);
    idA.register();
    const idB = new IdentityManager(SID_B, '/work/b', mailboxB);
    idB.register();
    writeHeartbeatRaw(SID_A, [1000, 1100, 1200]);
    writeHeartbeatRaw(SID_B, [4800, 4900, 5000]);

    const ch = new ChannelManager(SID_A, idA, mailboxA);
    expect(ch.sendMail(cid, SID_B, 'ping', 'hello-body')).toBe(true);

    const lines = fs.readFileSync(mailboxB, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const mail = JSON.parse(lines[0]);
    expect(mail.title).toBe(`[${cid}] ping`);
    expect(mail.content).toBe('hello-body');
    expect(mail.from).toBe(`${SID_A}/lead`);
  });
});

describe('PeerManager facade', () => {
  it('start() registers identity and writes a heartbeat immediately', () => {
    const peer = new PeerManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    peer.start();
    expect(peer.listIdentities()).toHaveLength(1);
    // start() writes one beat immediately. With a single beat, localOldest
    // == remoteLatest (same array) so isFresh(self) is false (strict >). This
    // is correct: a peer is "fresh" relative to a *remote* baseline, not to
    // itself. Verify the beat landed instead.
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    expect(id.getOwnHeartbeat()).toHaveLength(1);
    peer.stop();
    expect(peer.listIdentities()).toHaveLength(0);
  });

  it('hasActiveChannel() is false with no channels', () => {
    const peer = new PeerManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    peer.start();
    expect(peer.hasActiveChannel()).toBe(false);
    peer.stop();
  });

  it('hasActiveChannel() is true when a joined channel has a fresh peer', () => {
    const cid = 'chan-005';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: true, firstQuerySent: false, createdAt: 1,
    });
    const peer = new PeerManager(SID_A, '/work/a', mailbox);
    peer.start();
    // Register B and make it fresh.
    const peerB = new PeerManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    peerB.start();
    writeHeartbeatRaw(SID_A, [1000]);
    writeHeartbeatRaw(SID_B, [5000]);
    expect(peer.hasActiveChannel()).toBe(true);
    peer.stop();
    peerB.stop();
  });

  it('hasActiveChannel() is false when the peer is stale', () => {
    const cid = 'chan-006';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: true, firstQuerySent: false, createdAt: 1,
    });
    const peer = new PeerManager(SID_A, '/work/a', mailbox);
    peer.start();
    const peerB = new PeerManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    peerB.start();
    // Stale: local oldest 5000 > remote latest 1000.
    writeHeartbeatRaw(SID_A, [5000, 5100, 5200]);
    writeHeartbeatRaw(SID_B, [800, 900, 1000]);
    expect(peer.hasActiveChannel()).toBe(false);
    peer.stop();
    peerB.stop();
  });
});