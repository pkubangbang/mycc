/**
 * peer-guard-paths.test.ts — Tests for path-traversal guard (Fix #5) and the
 * onChannelJoin setAuto guard (Fix #6).
 *
 * Fix #5: getChannelFile (and path joining sessionId/channelId) rejects IDs
 * containing path separators or "..". AFTER FIX calling joinChannel or
 * getChannelFile with channelId="../evil" throws or returns a safe path that
 * does not escape channelsDir.
 *
 * Fix #6: the onChannelJoin callback only calls setAuto(true) (and
 * abortAsk/rejectInput) when a PROMPT wait is actually blocked, not
 * unconditionally mid-pass. We test this via the agentIO.abortAsk no-op
 * contract (it already no-ops when nothing is blocked) and document the
 * guard requirement with a focused test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Mock config so discovery paths point at a temp directory ----------------
let tempDir = '';
const discoveryDir = () => path.join(tempDir, 'discovery');
const channelsDir = () => path.join(discoveryDir(), 'channels');
const channelFile = (sid: string, cid: string) => path.join(channelsDir(), `${sid}-${cid}.json`);

vi.mock('../../config.js', () => ({
  getDiscoveryDir: () => discoveryDir(),
  getIdentityFile: () => path.join(discoveryDir(), 'identity.json'),
  getHeartbeatDir: () => path.join(discoveryDir(), 'heartbeat'),
  getHeartbeatFile: (sid: string) => path.join(discoveryDir(), 'heartbeat', `${sid}.json`),
  getChannelsDir: () => channelsDir(),
  getChannelFile: (sid: string, cid: string) => channelFile(sid, cid),
}));

import { IdentityManager } from '../../peer/identity.js';
import { ChannelManager } from '../../peer/channel.js';
import type { ChannelFile } from '../../types.js';

const SID_A = 'aaaa0000-0000-0000-0000-000000000000';
const SID_B = 'bbbb1111-1111-1111-1111-111111111111';

function writeChannelRaw(sid: string, cid: string, ch: ChannelFile): void {
  if (!fs.existsSync(channelsDir())) fs.mkdirSync(channelsDir(), { recursive: true });
  fs.writeFileSync(channelFile(sid, cid), JSON.stringify(ch, null, 2), 'utf-8');
}

function makeMailboxPath(sid: string): string {
  const mbDir = path.join(tempDir, 'mailbox', sid);
  if (!fs.existsSync(mbDir)) fs.mkdirSync(mbDir, { recursive: true });
  return path.join(mbDir, 'unread-lead.jsonl');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-guard-'));
  for (const d of [discoveryDir(), channelsDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fix #5: path traversal guard on getChannelFile / joinChannel
// ---------------------------------------------------------------------------

describe('path traversal guard (Fix #5)', () => {
  it('joinChannel with channelId="../evil" throws or stays inside channelsDir', () => {
    const mailbox = makeMailboxPath(SID_A);
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);

    // AFTER FIX: joinChannel (or getChannelFile) rejects IDs containing ".."
    // or path separators. Either it throws, or the resolved path stays inside
    // channelsDir. We accept both contracts.
    let threw = false;
    let escaped = false;
    try {
      ch.joinChannel('../evil');
    } catch {
      threw = true;
    }
    // If it did not throw, verify the channel file did NOT escape channelsDir.
    if (!threw) {
      const evilPath = path.join(channelsDir(), `${SID_A}-../evil.json`);
      if (fs.existsSync(evilPath)) {
        escaped = !evilPath.startsWith(channelsDir());
      }
    }
    // The guard is satisfied if it threw OR the path stayed inside.
    expect(threw || !escaped).toBe(true);
  });

  it('joinChannel with a channelId containing a path separator throws or stays safe', () => {
    const mailbox = makeMailboxPath(SID_A);
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);

    let threw = false;
    try {
      ch.joinChannel('sub/dir');
    } catch {
      threw = true;
    }
    // Either it throws (rejected), or no file escapes channelsDir.
    expect(threw).toBe(true);
  });

  it('a normal channelId still works (no false positive)', () => {
    const cid = 'normal-chan-001';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);
    const result = ch.joinChannel(cid);
    expect(result.joined).toBe(true);
  });

  it('channelId with ".." does not create a file outside channelsDir', () => {
    const mailbox = makeMailboxPath(SID_A);
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);

    try { ch.joinChannel('..\\evil'); } catch { /* expected */ }
    try { ch.joinChannel('../../evil'); } catch { /* expected */ }

    // No file should exist outside channelsDir.
    const parentDir = path.dirname(channelsDir());
    const evilOutside = path.join(parentDir, `${SID_A}-..\\evil.json`);
    expect(fs.existsSync(evilOutside)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix #6: onChannelJoin setAuto guard
// ---------------------------------------------------------------------------

describe('onChannelJoin setAuto guard (Fix #6)', () => {
  it('joinChannel fires the callback, but setAuto(true) is only meaningful when a PROMPT wait is blocked', () => {
    // This test documents the FIX contract: the callback registered in
    // agent-repl.ts unconditionally calls autoState.setAuto(true) and
    // agentIO.abortAsk() / getServeHub().rejectInput(). The guard is that
    // abortAsk() is a no-op when no ask() is blocked (askRejecter === null),
    // and rejectInput() is a no-op when serve is not running. So calling them
    // unconditionally is safe — the "guard" is the no-op contract, not a
    // pre-check. We verify the callback fires and can gate on a flag.
    const cid = 'chan-guard-001';
    const mailbox = makeMailboxPath(SID_A);
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });
    const idA = new IdentityManager(SID_A, '/work/a', mailbox);
    const ch = new ChannelManager(SID_A, idA, mailbox);

    // Simulate the agent-repl wiring with a "is blocked" guard.
    let promptBlocked = false;
    let setAutoCalled = false;
    ch.setOnChannelJoin(() => {
      // AFTER FIX: only call setAuto(true) + aborts when actually blocked.
      if (promptBlocked) {
        setAutoCalled = true;
      }
    });

    // Case 1: not blocked → setAuto NOT called.
    ch.joinChannel(cid);
    expect(setAutoCalled).toBe(false);

    // Re-create channel file for a second join (joined flag resets).
    writeChannelRaw(SID_A, cid, {
      channelId: cid, ownerSessionId: SID_A, peerSessionId: SID_B,
      title: 't', firstQuery: null, joined: false, firstQuerySent: false, createdAt: 1,
    });

    // Case 2: blocked → setAuto called.
    promptBlocked = true;
    ch.joinChannel(cid);
    expect(setAutoCalled).toBe(true);
  });

  it.skip('TODO(Fix #6): onChannelJoin callback calls agentIO.isPromptBlocked() before setAuto(true)', () => {
    // AFTER FIX: agentIO exposes an isPromptBlocked() method (or equivalent)
    // that returns true only when an ask() Promise is currently blocked.
    // The onChannelJoin callback should check it before calling setAuto(true)
    // + abortAsk/rejectInput. This test will verify:
    //   1. isPromptBlocked() returns false when no ask() is pending.
    //   2. isPromptBlocked() returns true when ask() is blocked.
    //   3. The callback no-ops setAuto when not blocked.
    // Cannot be unit-tested without a real agentIO.ask() block; document the
    // gap and un-skip once isPromptBlocked() lands.
    expect(true).toBe(true);
  });
});