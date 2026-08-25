/**
 * peers.test.ts - Tests for the peers tool (cross-instance discovery listing)
 *
 * Focus: the 1-hour cutoff. Peers whose latest heartbeat is older than 1h are
 * omitted entirely (even with all=true) so the listing doesn't grow unbounded
 * with dead instances' briefs. The count of omitted peers is noted in the
 * summary. The default (no all=true) still skips stale-but-recent peers via
 * isFresh; the cutoff is an additional hard filter on top of that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { peersTool } from '../../tools/peers.js';
import { createFullMockContext } from './test-utils.js';
import type { AgentContext, IdentityEntry } from '../../types.js';

// Anchored to the real Date.now() at module load: the tool calls Date.now()
// internally, so heartbeat timestamps must be relative to the real now for
// the 1h cutoff to behave deterministically.
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

const SID_OLD = 'old00000-0000-0000-0000-000000000000';
const SID_RECENT_STALE = 'rece00001-0000-0000-0000-000000000001';
const SID_FRESH = 'fres00002-0000-0000-0000-000000000002';
const SID_NO_HB = 'nohb00003-0000-0000-0000-000000000003';

function mkIdentity(sid: string): IdentityEntry {
  return {
    sessionId: sid,
    workDir: `/work/${sid.slice(0, 4)}`,
    mailbox: `/mb/${sid}/unread-lead.jsonl`,
    startedAt: NOW - 10 * HOUR,
  };
}

describe('peersTool — 1-hour cutoff', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    ctx = createFullMockContext();
    (ctx.peer.getSelfSessionId as ReturnType<typeof vi.fn>).mockReturnValue('self-0-0000-0000-0000-000000000000');
    vi.clearAllMocks();
  });

  it('omits a peer whose latest heartbeat is older than 1h (even with all=true) and reports the count', async () => {
    const identities = [mkIdentity(SID_OLD)];
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue(identities);
    // Latest heartbeat 2h ago -> older than the 1h cutoff.
    (ctx.peer.getLatestHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue(NOW - 2 * HOUR);
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await peersTool.handler(ctx, { all: true });

    // All peers omitted -> the empty-rows branch reports the omitted count
    // (not "no instances registered", which would be misleading).
    expect(result).toContain('older than 1h');
    expect(result).toContain('omitted');
    expect(result).not.toContain(SID_OLD);
    // The peer was filtered before isFresh/getBriefs mattered.
    expect(ctx.peer.getBriefs).not.toHaveBeenCalledWith(SID_OLD);
  });

  it('keeps a recent-but-stale peer when all=true (latest hb within 1h) and marks it offline', async () => {
    const identities = [mkIdentity(SID_RECENT_STALE)];
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue(identities);
    // 5 min ago -> within the 1h cutoff, but isFresh=false (stale by freshness).
    (ctx.peer.getLatestHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue(NOW - 5 * MIN);
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await peersTool.handler(ctx, { all: true });

    expect(result).toContain(SID_RECENT_STALE);
    expect(result).toContain('offline');
    expect(result).not.toContain('older than 1h omitted');
  });

  it('keeps a fresh peer (latest hb within 1h, isFresh=true) and marks it online', async () => {
    const identities = [mkIdentity(SID_FRESH)];
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue(identities);
    (ctx.peer.getLatestHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue(NOW - 10 * 1000);
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = await peersTool.handler(ctx, {});

    expect(result).toContain(SID_FRESH);
    expect(result).toContain('online');
  });

  it('surfaces the peer OS pid as a kill target (so another MYCC can terminate a daemon)', async () => {
    const identities = [{ ...mkIdentity(SID_FRESH), daemon: true, role: 'lfplater-skill-manager' }];
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue(identities);
    (ctx.peer.getLatestHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue(NOW - 1000);
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.peer.getPid as ReturnType<typeof vi.fn>).mockReturnValue(4242);
    (ctx.peer.getBriefs as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const result = await peersTool.handler(ctx, {});

    expect(result).toContain('pid: 4242');
    // The kill command must match the host platform.
    const killCmd = process.platform === 'win32' ? 'taskkill /PID 4242' : 'kill 4242';
    expect(result).toContain(killCmd);
  });

  it('omits the pid line when getPid returns null (legacy heartbeat without a pid field)', async () => {
    const identities = [mkIdentity(SID_FRESH)];
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue(identities);
    (ctx.peer.getLatestHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue(NOW - 1000);
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.peer.getPid as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (ctx.peer.getBriefs as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const result = await peersTool.handler(ctx, {});

    expect(result).toContain(SID_FRESH);
    expect(result).not.toMatch(/\bpid:/);
  });

  it('treats a peer with no heartbeat file (latest=null) as NOT cutoff-omitted; falls back to isFresh', async () => {
    const identities = [mkIdentity(SID_NO_HB)];
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue(identities);
    (ctx.peer.getLatestHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue(null);
    // No heartbeat -> isFresh returns false (unregistered beats) or true;
    // with all=true the peer is listed either way because the cutoff is skipped.
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await peersTool.handler(ctx, { all: true });

    expect(result).toContain(SID_NO_HB);
    expect(result).not.toContain('older than 1h omitted');
  });

  it('does not surface briefs for a cutoff-omitted peer', async () => {
    const identities = [mkIdentity(SID_OLD), mkIdentity(SID_FRESH)];
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue(identities);
    // First peer (OLD) -> 2h ago, omitted; second (FRESH) -> fresh, kept.
    (ctx.peer.getLatestHeartbeat as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(NOW - 2 * HOUR)
      .mockReturnValueOnce(NOW - 1000);
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);
    // The stale brief belongs to the OLD session only. getBriefs is NOT called
    // for the omitted OLD session (cutoff skips before getBriefs), so it is
    // never surfaced; the FRESH session returns no briefs.
    (ctx.peer.getBriefs as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const result = await peersTool.handler(ctx, { all: true });

    // The fresh peer IS listed; the stale peer's briefs are not surfaced.
    expect(result).toContain(SID_FRESH);
    expect(result).not.toContain(SID_OLD);
    expect(result).not.toContain('stale brief that should not appear');
    expect(result).toContain('older than 1h omitted');
    // getBriefs was called for FRESH (kept) but never for OLD (omitted).
    expect(ctx.peer.getBriefs).toHaveBeenCalledWith(SID_FRESH);
    expect(ctx.peer.getBriefs).not.toHaveBeenCalledWith(SID_OLD);
  });
});