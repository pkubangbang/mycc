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
import { estimateTextTokens } from '../../utils/token.js';
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

  it('register() prunes stale identity entries (heartbeat older than 1h)', () => {
    // Pre-seed identity.json with an orphan entry for SID_B whose heartbeat
    // is 2h old — well beyond the 1h prune cutoff.
    const now = Date.now();
    fs.writeFileSync(identityFile(), JSON.stringify({
      [SID_B]: { sessionId: SID_B, workDir: '/work/b', mailbox: makeMailboxPath(SID_B), startedAt: now - 2 * 60 * 60 * 1000 },
    }, null, 2), 'utf-8');
    writeHeartbeatRaw(SID_B, [now - 2 * 60 * 60 * 1000, now - 7000 * 1000, now - 7200 * 1000]);

    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();

    const entries = id.listIdentities();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe(SID_A); // stale SID_B was pruned
  });

  it('register() preserves fresh identity entries (heartbeat within 1h)', () => {
    // Pre-seed identity.json with a fresh entry for SID_B (beat 10s ago).
    const now = Date.now();
    fs.writeFileSync(identityFile(), JSON.stringify({
      [SID_B]: { sessionId: SID_B, workDir: '/work/b', mailbox: makeMailboxPath(SID_B), startedAt: now - 10_000 },
    }, null, 2), 'utf-8');
    writeHeartbeatRaw(SID_B, [now - 30_000, now - 20_000, now - 10_000]);

    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();

    const sids = id.listIdentities().map(e => e.sessionId).sort();
    expect(sids).toEqual([SID_A, SID_B]); // both present
  });

  it('register() preserves entries with no heartbeat file (mid-startup peer)', () => {
    // Pre-seed identity.json with SID_B but NO heartbeat file — it registered
    // but has not beaten yet. Pruning must not remove it (could be mid-startup).
    const now = Date.now();
    fs.writeFileSync(identityFile(), JSON.stringify({
      [SID_B]: { sessionId: SID_B, workDir: '/work/b', mailbox: makeMailboxPath(SID_B), startedAt: now - 5_000 },
    }, null, 2), 'utf-8');
    // Deliberately no writeHeartbeatRaw(SID_B, ...).

    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();

    const sids = id.listIdentities().map(e => e.sessionId).sort();
    expect(sids).toEqual([SID_A, SID_B]); // SID_B preserved despite no beats
  });

  it('register() never prunes its own entry even if its heartbeat is stale', () => {
    // Self-prune guard: write a stale heartbeat for SID_A itself, then
    // register SID_A. The self entry must survive.
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 2 * 60 * 60 * 1000]); // 2h old

    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();

    const sids = id.listIdentities().map(e => e.sessionId);
    expect(sids).toContain(SID_A); // self preserved
  });

  it('register() includes the role field when provided', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A), 'skill-manager');
    id.register();
    const entries = id.listIdentities();
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('skill-manager');
    // The role is persisted in the JSON on disk.
    const raw = JSON.parse(fs.readFileSync(identityFile(), 'utf-8'));
    expect(raw[SID_A].role).toBe('skill-manager');
  });

  it('register() omits the role field when not provided (clean JSON)', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const entries = id.listIdentities();
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBeUndefined();
    // The role key is absent from the JSON (not role: null / undefined).
    const raw = JSON.parse(fs.readFileSync(identityFile(), 'utf-8'));
    expect(raw[SID_A]).not.toHaveProperty('role');
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
    // Timestamps are Date.now()-relative so they fall within the 90s absolute
    // freshness window (fixed epoch values like 1000 are decades old → stale).
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 4000, now - 3000, now - 2000]);
    writeHeartbeatRaw(SID_B, [now - 200, now - 100, now]);
    expect(id.isFresh(SID_B)).toBe(true);
  });

  it('isFresh() is false when remote heartbeat is older than local oldest', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();
    // Both within the 90s window, but remote latest < local oldest.
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 10_000, now - 8_000, now - 5_000]);
    writeHeartbeatRaw(SID_B, [now - 80_000, now - 70_000, now - 60_000]);
    expect(id.isFresh(SID_B)).toBe(false);
  });

  it('isFresh() is true for a peer that started before local with a RECENT beat (startup race)', () => {
    // Regression: a peer (B) that started BEFORE the local instance (A) has
    // its only heartbeat older than A's oldest beat. The relative check
    // (remoteLatest > localOldest) alone would mark it stale for up to
    // HEARTBEAT_INTERVAL_MS (30s) until B's next beat — the "30s delay"
    // bug. The "recent clause" fixes this: a remote whose latest beat is
    // within one heartbeat interval of now is live regardless of the
    // relative ordering. Here B's latest beat is 5s ago (recent) but older
    // than A's oldest beat (now-1000), so WITHOUT the fix this is false.
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();
    const now = Date.now();
    // A started later: oldest beat at now-1000. B started earlier: single
    // beat at now-5000 (recent, within 30s, but older than A's oldest).
    writeHeartbeatRaw(SID_A, [now - 1000]);
    writeHeartbeatRaw(SID_B, [now - 5000]);
    expect(id.isFresh(SID_B)).toBe(true);
  });

  it('isFresh() is false for a peer whose recent beat is NOT recent enough AND older than local oldest', () => {
    // The "recent clause" only grants freshness within HEARTBEAT_INTERVAL_MS.
    // A remote whose latest beat is older than that window (but still within
    // FRESHNESS_WINDOW_MS) must still pass the relative check. Here B's
    // latest beat is 45s ago (past the 30s recent window) and older than A's
    // oldest (now-1000), so it is correctly stale — the relative check still
    // guards peers that died a while ago.
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 1000]);
    writeHeartbeatRaw(SID_B, [now - 45_000]);
    expect(id.isFresh(SID_B)).toBe(false);
  });

  it('isFresh() treats everything as fresh when local has 0 beats (oldest = -Infinity)', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.register();
    const idB = new IdentityManager(SID_B, '/work/b', makeMailboxPath(SID_B));
    idB.register();
    // No local heartbeat file for A; remote has a recent beat.
    // Timestamp is Date.now()-relative so it falls within the 90s absolute
    // freshness window (fixed epoch values are decades old → stale).
    const now = Date.now();
    writeHeartbeatRaw(SID_B, [now - 20, now - 10, now]);
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

  it('readHeartbeats() reads the legacy {timestamps} schema (backward-compat)', () => {
    writeHeartbeatRaw(SID_A, [100, 200, 300]);
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    expect(id.getOwnHeartbeat()).toEqual([100, 200, 300]);
  });

  it('recordBrief() writes a brief entry and getBriefs() reads it back', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.recordBrief('working on heartbeat', 8);
    const briefs = id.getBriefs(SID_A);
    expect(briefs).toHaveLength(1);
    expect(briefs[0].content).toBe('working on heartbeat');
    expect(briefs[0].confidence).toBe(8);
    expect(briefs[0].time).toBeTypeOf('number');
  });

  it('recordBrief() truncates content to at most 200 estimated tokens', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    // A short message fits and is stored verbatim.
    id.recordBrief('short message', 5);
    expect(id.getBriefs(SID_A)[0].content).toBe('short message');

    // A long message (well over 200 tokens) is truncated so the stored
    // content estimates to <= 200 tokens, and confidence is preserved.
    const longMsg = 'word '.repeat(500); // ~500 words -> well over 200 tokens
    expect(estimateTextTokens(longMsg)).toBeGreaterThan(200);
    id.recordBrief(longMsg, 6);
    const stored = id.getBriefs(SID_A)[1].content;
    expect(estimateTextTokens(stored)).toBeLessThanOrEqual(200);
    expect(id.getBriefs(SID_A)[1].confidence).toBe(6);
  });

  it('recordBrief() keeps only the last 3 briefs', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.recordBrief('b1', 1);
    id.recordBrief('b2', 2);
    id.recordBrief('b3', 3);
    id.recordBrief('b4', 4);
    id.recordBrief('b5', 5);
    const briefs = id.getBriefs(SID_A);
    expect(briefs).toHaveLength(3);
    expect(briefs[0].content).toBe('b3');
    expect(briefs[1].content).toBe('b4');
    expect(briefs[2].content).toBe('b5');
    // Confidence preserved alongside content.
    expect(briefs[2].confidence).toBe(5);
  });

  it('recordBrief() preserves existing heartbeats and getOwnHeartbeat still works', () => {
    // Start with a legacy {timestamps} heartbeat file.
    writeHeartbeatRaw(SID_A, [100, 200, 300]);
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.recordBrief('added a brief', 7);
    // Heartbeats must survive the brief write (not be wiped).
    expect(id.getOwnHeartbeat()).toEqual([100, 200, 300]);
    expect(id.getBriefs(SID_A)).toHaveLength(1);
  });

  it('beat() preserves existing briefs (does not wipe the briefs array)', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.recordBrief('survive-the-beat', 9);
    // A beat must keep the brief entry.
    id.startHeartbeat();
    id.stopHeartbeat();
    const briefs = id.getBriefs(SID_A);
    expect(briefs).toHaveLength(1);
    expect(briefs[0].content).toBe('survive-the-beat');
  });

  it('getBriefs() returns [] for a session with no heartbeat file', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    expect(id.getBriefs(SID_B)).toEqual([]);
  });

  it('beat() stamps process.pid into the heartbeat file (kill target for daemons)', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.startHeartbeat();
    id.stopHeartbeat();
    const raw = JSON.parse(fs.readFileSync(heartbeatFile(SID_A), 'utf-8'));
    expect(raw.pid).toBe(process.pid);
  });

  it('getPid() reads back the PID stamped by a beat', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    id.startHeartbeat();
    id.stopHeartbeat();
    expect(id.getPid(SID_A)).toBe(process.pid);
  });

  it('getPid() returns null for a heartbeat file without a pid field (legacy/backward-compat)', () => {
    // Legacy {timestamps} file has no pid — getPid must degrade to null.
    writeHeartbeatRaw(SID_A, [100, 200, 300]);
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    expect(id.getPid(SID_A)).toBeNull();
  });

  it('getPid() returns null for a session with no heartbeat file', () => {
    const id = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    expect(id.getPid(SID_B)).toBeNull();
  });

  it('PeerManager.getPid() forwards to IdentityManager', () => {
    const peer = new PeerManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    peer.start();
    expect(peer.getPid(SID_A)).toBe(process.pid);
    peer.stop();
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

  it('listChannels() warns and skips a malformed (unparseable) channel file instead of throwing', () => {
    // Regression for peer-discovery 弱点3: a corrupted/half-written channel
    // file (present but invalid JSON) used to be silently skipped with zero
    // observability. Now readChannelFile logs a console.warn. listChannels
    // must still not throw and must exclude the malformed entry.
    const cid = 'chan-malformed';
    const dir = channelsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Write a syntactically invalid JSON file (truncated/half-written shape).
    fs.writeFileSync(channelFile(SID_A, cid), '{ "channelId": "broken', 'utf-8');

    const idA = new IdentityManager(SID_A, '/work/a', makeMailboxPath(SID_A));
    const ch = new ChannelManager(SID_A, idA, makeMailboxPath(SID_A));

    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')); });
    const list = ch.listChannels();
    spy.mockRestore();

    expect(list).toEqual([]);              // malformed entry excluded
    expect(warns.some(w => w.includes('malformed channel file'))).toBe(true);
  });

  it('sweepChannels() warns (and does not throw) when joinChannel throws for an unjoined channel', () => {
    // Regression for peer-discovery 弱点3: sweepChannels used to swallow
    // joinChannel throws with a bare `catch {}` — zero observability. The catch
    // guards a genuine race window (file present+valid at listChannels() time,
    // then gone/malformed by the time joinChannel re-reads it). We exercise the
    // catch path deterministically by stubbing joinChannel to throw: the file
    // is written so listChannels() returns it as unjoined, then the stub makes
    // the sweep's joinChannel call throw, and the sweep must emit a console.warn
    // naming the channelId instead of silently eating the error.
    const cid = 'chan-sweep-throw';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);
    // Stub joinChannel so the sweep's auto-join throws — emulates the
    // race where the channel file disappears between list and join.
    vi.spyOn(ch as unknown as { joinChannel: () => never }, 'joinChannel')
      .mockImplementation(() => { throw new Error('Channel file not found: race'); });

    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')); });
    // startChannelPoll() calls sweepChannels() once immediately.
    ch.startChannelPoll();
    ch.stopChannelPoll();
    spy.mockRestore();

    expect(warns.some(w => w.includes('sweep auto-join failed'))).toBe(true);
    expect(warns.some(w => w.includes(cid))).toBe(true);
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
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 4000]);
    writeHeartbeatRaw(SID_B, [now]);

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
    // B is stale: remote latest older than local oldest (both within window).
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 5_000, now - 3_000, now - 1_000]);
    writeHeartbeatRaw(SID_B, [now - 80_000, now - 70_000, now - 60_000]);

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
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 4000, now - 3000, now - 2000]);
    writeHeartbeatRaw(SID_B, [now - 200, now - 100, now]);

    const ch = new ChannelManager(SID_A, idA, mailboxA);
    expect(ch.sendMail(cid, SID_B, 'ping', 'hello-body')).toBe(true);

    const lines = fs.readFileSync(mailboxB, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const mail = JSON.parse(lines[0]);
    expect(mail.title).toBe(`[${cid}] ping`);
    expect(mail.content).toBe('hello-body');
    expect(mail.from).toBe(`${SID_A}/lead`);
  });

  it('sendPeerMail() appends to the remote mailbox with no channel prefix and from=sessionId/lead', () => {
    const mailboxA = makeMailboxPath(SID_A);
    const mailboxB = makeMailboxPath(SID_B);
    const idA = new IdentityManager(SID_A, '/work/a', mailboxA);
    idA.register();
    const idB = new IdentityManager(SID_B, '/work/b', mailboxB);
    idB.register();
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 4000, now - 3000, now - 2000]);
    writeHeartbeatRaw(SID_B, [now - 200, now - 100, now]);

    const ch = new ChannelManager(SID_A, idA, mailboxA);
    expect(ch.sendPeerMail(SID_B, 'direct-topic', 'direct-body')).toBe(true);

    const lines = fs.readFileSync(mailboxB, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const mail = JSON.parse(lines[0]);
    // No channel prefix — title used verbatim (channel-independent path).
    expect(mail.title).toBe('direct-topic');
    expect(mail.content).toBe('direct-body');
    expect(mail.from).toBe(`${SID_A}/lead`);
  });

  it('sendPeerMail() returns false when the peer is stale', () => {
    const mailboxA = makeMailboxPath(SID_A);
    const mailboxB = makeMailboxPath(SID_B);
    const idA = new IdentityManager(SID_A, '/work/a', mailboxA);
    idA.register();
    const idB = new IdentityManager(SID_B, '/work/b', mailboxB);
    idB.register();
    // Stale: remote latest older than local oldest (both within window).
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 5_000, now - 3_000, now - 1_000]);
    writeHeartbeatRaw(SID_B, [now - 80_000, now - 70_000, now - 60_000]);

    const ch = new ChannelManager(SID_A, idA, mailboxA);
    expect(ch.sendPeerMail(SID_B, 't', 'b')).toBe(false);
    // Nothing appended to the remote mailbox.
    expect(fs.existsSync(mailboxB) ? fs.readFileSync(mailboxB, 'utf-8') : '').toBe('');
  });

  it('joinChannel() fires the onChannelJoin callback after joining (mid-PROMPT wake)', () => {
    const cid = 'chan-join-cb';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: 'hi', joined: false, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);

    const calls: string[] = [];
    ch.setOnChannelJoin(() => { calls.push('joined'); });

    ch.joinChannel(cid);
    expect(calls).toEqual(['joined']);
  });

  it('joinChannel() does not throw if no onChannelJoin callback is set', () => {
    const cid = 'chan-join-nocb';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);
    // No setOnChannelJoin call — joinChannel must still succeed.
    expect(() => ch.joinChannel(cid)).not.toThrow();
  });

  it('joinChannel() swallows a throwing onChannelJoin callback (channel state stays committed)', () => {
    const cid = 'chan-join-throw';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);
    ch.setOnChannelJoin(() => { throw new Error('callback exploded'); });

    // joinChannel must not propagate the callback error.
    const result = ch.joinChannel(cid);
    expect(result.joined).toBe(true);
    // joined flag persisted despite the callback throw.
    const persisted = JSON.parse(fs.readFileSync(channelFile(SID_A, cid), 'utf-8'));
    expect(persisted.joined).toBe(true);
  });

  it('setOnChannelJoin overwrites a previously registered callback (single listener)', () => {
    const cid = 'chan-join-overwrite';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);

    const first: string[] = [];
    const second: string[] = [];
    ch.setOnChannelJoin(() => { first.push('a'); });
    ch.setOnChannelJoin(() => { second.push('b'); });

    ch.joinChannel(cid);
    expect(first).toEqual([]);      // overwritten — not called
    expect(second).toEqual(['b']);  // only the latest listener fires
  });

  it('sendPeerMail() returns false for an unregistered session', () => {
    const mailboxA = makeMailboxPath(SID_A);
    const idA = new IdentityManager(SID_A, '/work/a', mailboxA);
    idA.register();
    const ch = new ChannelManager(SID_A, idA, mailboxA);
    expect(ch.sendPeerMail('not-registered-sid', 't', 'b')).toBe(false);
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
    const now = Date.now();
    writeHeartbeatRaw(SID_A, [now - 4000]);
    writeHeartbeatRaw(SID_B, [now]);
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
    // Stale: remote latest older than local oldest (both within window).
    const now2 = Date.now();
    writeHeartbeatRaw(SID_A, [now2 - 5_000, now2 - 3_000, now2 - 1_000]);
    writeHeartbeatRaw(SID_B, [now2 - 80_000, now2 - 70_000, now2 - 60_000]);
    expect(peer.hasActiveChannel()).toBe(false);
    peer.stop();
    peerB.stop();
  });

  it('setOnChannelJoin() delegates to ChannelManager and fires on joinChannel()', () => {
    const cid = 'chan-delegate';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });
    const peer = new PeerManager(SID_A, '/work/a', mailbox);
    peer.start();
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    idA.register();

    const calls: string[] = [];
    peer.setOnChannelJoin(() => { calls.push('fired'); });
    peer.joinChannel(cid);
    expect(calls).toEqual(['fired']);
    peer.stop();
  });
});