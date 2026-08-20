/**
 * mail_to.test.ts — Tests for the mail_to tool, focusing on cross-instance
 * peer routing and fail-fast recipient validation.
 *
 * When `name` matches the identity pattern <session-id>/lead, the handler
 * routes through ctx.peer.sendPeerMail instead of local teammate IPC.
 * sendPeerMail returns true/false (freshness-gated); the handler returns an
 * "OK. Peer mail sent" / "Error: peer ..." string accordingly.
 *
 * Fail-fast validation (replaces the former soft bare-session-id warning):
 * a recipient must resolve to a KNOWN, live recipient, or the call is
 * rejected up front — no silent fall-through to ctx.team.mailTo. Valid forms:
 *   1. "lead"            — local IPC sentinel (always OK)
 *   2. "<uuid>/lead"     — cross-instance peer; must be fresh (ctx.peer.isFresh)
 *   3. "<teammate-name>" — a live teammate in ctx.team.listTeammates() (lead
 *                         context only; child context skips the roster check)
 *
 * The handler is async (returns Promise<string>), so every call is awaited.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mailToTool } from '../../tools/mail_to.js';
import { createFullMockContext } from './test-utils.js';
import type { AgentContext } from '../../types.js';

// Valid UUID (8-4-4-4-12 hex) — used by the UUID-validation routing tests.
const PEER_SID = '3b1b83d0-aaaa-bbbb-cccc-dddddddddddd';

describe('mailToTool — cross-instance peer routing', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    // Use the comprehensive mock (from mock-context.ts) so ctx.peer is present
    // and getName/sendPeerMail/isFresh are vi.fn mocks we can stub/observe.
    ctx = createFullMockContext();
    (ctx.core.getName as ReturnType<typeof vi.fn>).mockReturnValue('lead');
    // Default: peer IS fresh so the fail-fast isFresh pre-check passes; the
    // sendPeerMail return value still decides OK vs. delivery-failure.
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);
    vi.clearAllMocks();
  });

  it('routes a <session-id>/lead name to ctx.peer.sendPeerMail and returns OK', async () => {
    (ctx.peer.sendPeerMail as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = await mailToTool.handler(ctx, {
      name: `${PEER_SID}/lead`,
      title: 'sync-check',
      content: 'are you ready?',
    });

    expect(ctx.peer.isFresh).toHaveBeenCalledWith(PEER_SID);
    expect(ctx.peer.sendPeerMail).toHaveBeenCalledWith(PEER_SID, 'sync-check', 'are you ready?');
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toBe(`OK. Peer mail sent to ${PEER_SID}/lead.`);
  });

  it('fail-fast rejects a stale/offline peer BEFORE sendPeerMail (isFresh=false)', async () => {
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await mailToTool.handler(ctx, {
      name: `${PEER_SID}/lead`,
      title: 't',
      content: 'b',
    });

    // isFresh pre-check rejects; sendPeerMail is NOT attempted.
    expect(ctx.peer.isFresh).toHaveBeenCalledWith(PEER_SID);
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
    expect(result).toContain(PEER_SID);
  });

  it('does not treat a bare "lead" (no slash) as peer routing', async () => {
    // lead→lead: senderName is 'lead', name is 'lead' → not the teammate-to-lead
    // path. Falls to the generic tail: ctx.team.mailTo(name, title, content).
    const result = await mailToTool.handler(ctx, {
      name: 'lead',
      title: 'self-note',
      content: 'hi',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).toHaveBeenCalledWith('lead', 'self-note', 'hi');
    expect(result).toBe('OK');
  });

  it('a known teammate name (in roster) routes to ctx.team.mailTo and returns OK', async () => {
    (ctx.team.listTeammates as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: 'researcher', role: 'coder', status: 'working' },
    ]);

    const result = await mailToTool.handler(ctx, {
      name: 'researcher',
      title: 'task',
      content: 'go',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).toHaveBeenCalledWith('researcher', 'task', 'go');
    expect(result).toBe('OK');
  });

  it('fail-fast rejects an UNKNOWN teammate name (not in roster) — no mailTo', async () => {
    // Default roster is empty (mock-context), so 'researcher' is unknown.
    const result = await mailToTool.handler(ctx, {
      name: 'researcher',
      title: 'task',
      content: 'go',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
    expect(result).toContain('researcher');
  });

  it('fail-fast rejects a slash-name whose agent part is not "lead" (no mailTo)', async () => {
    // Only "lead" is a valid agent-name in the identity pattern; an unknown
    // agent-name is NOT a valid peer route and is rejected up front.
    const result = await mailToTool.handler(ctx, {
      name: `${PEER_SID}/worker`,
      title: 't',
      content: 'b',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
    expect(result).toContain(`${PEER_SID}/worker`);
  });

  it('fail-fast rejects a slash-name with no dash in the session part ("a/lead")', async () => {
    // "a/lead" has no dash in the session part — not a UUID, so not a valid
    // peer route. Rejected up front (no mailTo).
    const result = await mailToTool.handler(ctx, {
      name: 'a/lead',
      title: 't',
      content: 'b',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
  });
});

// ---------------------------------------------------------------------------
// Fix #4: UUID format validation (not just "contains dash")
// ---------------------------------------------------------------------------

describe('mailToTool — UUID session-id validation (Fix #4)', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    ctx = createFullMockContext();
    (ctx.core.getName as ReturnType<typeof vi.fn>).mockReturnValue('lead');
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);
    vi.clearAllMocks();
  });

  it('a valid <uuid>/lead IS routed to sendPeerMail', async () => {
    (ctx.peer.sendPeerMail as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await mailToTool.handler(ctx, {
      name: `${PEER_SID}/lead`,
      title: 'hello',
      content: 'world',
    });
    expect(ctx.peer.sendPeerMail).toHaveBeenCalledWith(PEER_SID, 'hello', 'world');
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toBe(`OK. Peer mail sent to ${PEER_SID}/lead.`);
  });

  it('a teammate name like "review-peer-1/lead" must NOT be misrouted to sendPeerMail (no valid UUID) — rejected fail-fast', async () => {
    // "review-peer-1" has dashes but is NOT a UUID (wrong segment lengths /
    // non-hex). It is not a valid peer route, so it is rejected up front
    // (no sendPeerMail, no mailTo).
    const result = await mailToTool.handler(ctx, {
      name: 'review-peer-1/lead',
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
  });

  it('a dashed but non-UUID session part like "ab-cd-ef/lead" is rejected (not routed to peer, not mailed)', async () => {
    const result = await mailToTool.handler(ctx, {
      name: 'ab-cd-ef/lead',
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
  });

  it('a UUID with wrong segment lengths is rejected (not routed to peer, not mailed)', async () => {
    // 7-4-4-4-12 — first segment too short (must be 8 hex chars).
    const bad = '1234567-1234-1234-1234-123456789012';
    const result = await mailToTool.handler(ctx, {
      name: `${bad}/lead`,
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
  });

  it('a UUID with non-hex characters is rejected (not routed to peer, not mailed)', async () => {
    // 8-4-4-4-12 but contains 'g' (non-hex).
    const bad = 'gggg0000-0000-0000-0000-000000000000';
    const result = await mailToTool.handler(ctx, {
      name: `${bad}/lead`,
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
  });
});

describe('mailToTool — validation', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    ctx = createFullMockContext();
    (ctx.core.getName as ReturnType<typeof vi.fn>).mockReturnValue('lead');
    vi.clearAllMocks();
  });

  it('returns an error for a missing name', async () => {
    const result = await mailToTool.handler(ctx, { title: 't', content: 'b' });
    expect(result).toBe('Error: name parameter is required and must be a string');
  });

  it('returns an error for a missing title', async () => {
    const result = await mailToTool.handler(ctx, { name: `${PEER_SID}/lead`, content: 'b' });
    expect(result).toBe('Error: title parameter is required and must be a string');
  });

  it('returns an error for missing content', async () => {
    const result = await mailToTool.handler(ctx, { name: `${PEER_SID}/lead`, title: 't' });
    expect(result).toBe('Error: content parameter is required and must be a string');
  });
});