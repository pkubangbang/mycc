/**
 * mail_to.test.ts — Tests for the mail_to tool, focusing on cross-instance
 * peer routing (pinned todo #15).
 *
 * When `name` matches the identity pattern <session-id>/lead, the handler
 * routes through ctx.peer.sendPeerMail instead of local teammate IPC.
 * sendPeerMail returns true/false (freshness-gated); the handler returns an
 * "OK. Peer mail sent" / "Error: peer ... stale" string accordingly.
 *
 * The handler is async (returns Promise<string>), so every call is awaited.
 * Local IPC paths (teammate name, "lead") are also covered to confirm the
 * peer branch does not shadow them.
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
    // and getName/sendPeerMail are vi.fn mocks we can stub/observe.
    ctx = createFullMockContext();
    (ctx.core.getName as ReturnType<typeof vi.fn>).mockReturnValue('lead');
    vi.clearAllMocks();
  });

  it('routes a <session-id>/lead name to ctx.peer.sendPeerMail and returns OK', async () => {
    (ctx.peer.sendPeerMail as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = await mailToTool.handler(ctx, {
      name: `${PEER_SID}/lead`,
      title: 'sync-check',
      content: 'are you ready?',
    });

    expect(ctx.peer.sendPeerMail).toHaveBeenCalledWith(PEER_SID, 'sync-check', 'are you ready?');
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toBe(`OK. Peer mail sent to ${PEER_SID}/lead.`);
  });

  it('returns an error and does NOT call team.mailTo when the peer is stale', async () => {
    (ctx.peer.sendPeerMail as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await mailToTool.handler(ctx, {
      name: `${PEER_SID}/lead`,
      title: 't',
      content: 'b',
    });

    expect(ctx.peer.sendPeerMail).toHaveBeenCalledOnce();
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

  it('does not treat a teammate name with no slash as peer routing', async () => {
    const result = await mailToTool.handler(ctx, {
      name: 'researcher',
      title: 'task',
      content: 'go',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).toHaveBeenCalledWith('researcher', 'task', 'go');
    expect(result).toBe('OK');
  });

  it('rejects a slash-name whose agent part is not "lead" (falls through to IPC)', async () => {
    // Only "lead" is a valid agent-name in the identity pattern; an unknown
    // agent-name must NOT be misrouted as peer mail. It falls through to the
    // generic ctx.team.mailTo path.
    const result = await mailToTool.handler(ctx, {
      name: `${PEER_SID}/worker`,
      title: 't',
      content: 'b',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).toHaveBeenCalledWith(`${PEER_SID}/worker`, 't', 'b');
    expect(result).toBe('OK');
  });

  it('requires a dash in the session-id part to avoid misrouting plain "a/lead" names', async () => {
    // "a/lead" has no dash in the session part — not a UUID, so not peer mail.
    const result = await mailToTool.handler(ctx, {
      name: 'a/lead',
      title: 't',
      content: 'b',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).toHaveBeenCalledWith('a/lead', 't', 'b');
    expect(result).toBe('OK');
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

  it('a teammate name like "review-peer-1/lead" must NOT be misrouted to sendPeerMail (no valid UUID)', async () => {
    // "review-peer-1" has dashes but is NOT a UUID (wrong segment lengths /
    // non-hex). AFTER FIX the handler validates UUID format (8-4-4-4-12 hex)
    // and falls through to local IPC.
    const result = await mailToTool.handler(ctx, {
      name: 'review-peer-1/lead',
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).toHaveBeenCalledWith('review-peer-1/lead', 't', 'b');
    expect(result).toBe('OK');
  });

  it('a dashed but non-UUID session part like "ab-cd-ef/lead" is NOT routed to peer', async () => {
    const result = await mailToTool.handler(ctx, {
      name: 'ab-cd-ef/lead',
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).toHaveBeenCalled();
  });

  it('a UUID with wrong segment lengths is NOT routed to peer', async () => {
    // 7-4-4-4-12 — first segment too short (must be 8 hex chars).
    const bad = '1234567-1234-1234-1234-123456789012';
    const result = await mailToTool.handler(ctx, {
      name: `${bad}/lead`,
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).toHaveBeenCalled();
  });

  it('a UUID with non-hex characters is NOT routed to peer', async () => {
    // 8-4-4-4-12 but contains 'g' (non-hex).
    const bad = 'gggg0000-0000-0000-0000-000000000000';
    const result = await mailToTool.handler(ctx, {
      name: `${bad}/lead`,
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).toHaveBeenCalled();
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