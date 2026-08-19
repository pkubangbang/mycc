/**
 * mail_to.test.ts — Tests for the mail_to tool, focusing on intra-session
 * recipient validation and the cross-session rejection (scope-down).
 *
 * mail_to is scoped to communication WITHIN the current mycc instance:
 *   1. "lead"            — local IPC sentinel (always OK)
 *   2. "<teammate-name>" — a live teammate in ctx.team.listTeammates() (lead
 *                         context only; child context skips the roster check)
 *
 * Cross-instance / external mail is handled by the `mycc-mail` CLI, NOT
 * mail_to. Any slash-bearing recipient (e.g. "<uuid>/lead",
 * "<uuid>/worker", "review-peer-1/lead", "a/lead") is REJECTED up front with
 * an error string that points the caller to the `mycc-mail` CLI. The handler
 * never calls ctx.peer.sendPeerMail.
 *
 * Fail-fast validation: a recipient must resolve to a KNOWN, live recipient
 * (lead, a live teammate, or — for slash names — nothing, since they are all
 * rejected), or the call is rejected up front — no silent fall-through to
 * ctx.team.mailTo.
 *
 * The handler is async (returns Promise<string>), so every call is awaited.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mailToTool } from '../../tools/mail_to.js';
import { createFullMockContext } from './test-utils.js';
import type { AgentContext } from '../../types.js';

// Valid UUID (8-4-4-4-12 hex) — used by the slash-name rejection tests.
const PEER_SID = '3b1b83d0-aaaa-bbbb-cccc-dddddddddddd';

describe('mailToTool — intra-session routing', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    // Use the comprehensive mock (from mock-context.ts) so ctx.peer and
    // ctx.team are present and getName/listTeammates/mailTo are vi.fn mocks
    // we can stub/observe.
    ctx = createFullMockContext();
    (ctx.core.getName as ReturnType<typeof vi.fn>).mockReturnValue('lead');
    vi.clearAllMocks();
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
});

// ---------------------------------------------------------------------------
// Cross-session scope-down: ALL slash-bearing names are rejected with a
// pointer to the `mycc-mail` CLI. mail_to never routes to ctx.peer.
// ---------------------------------------------------------------------------

describe('mailToTool — cross-session names rejected (scope-down)', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    ctx = createFullMockContext();
    (ctx.core.getName as ReturnType<typeof vi.fn>).mockReturnValue('lead');
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);
    vi.clearAllMocks();
  });

  it('rejects a valid <uuid>/lead name and points to the mycc-mail CLI (no sendPeerMail)', async () => {
    const result = await mailToTool.handler(ctx, {
      name: `${PEER_SID}/lead`,
      title: 'sync-check',
      content: 'are you ready?',
    });

    // mail_to is intra-session only; cross-instance mail goes to the CLI.
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
    expect(result).toContain('mycc-mail');
    expect(result).toContain(`${PEER_SID}/lead`);
  });

  it('rejects a slash-name whose agent part is not "lead" (no mailTo)', async () => {
    const result = await mailToTool.handler(ctx, {
      name: `${PEER_SID}/worker`,
      title: 't',
      content: 'b',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
    expect(result).toContain('mycc-mail');
    expect(result).toContain(`${PEER_SID}/worker`);
  });

  it('rejects a slash-name with no dash in the session part ("a/lead")', async () => {
    const result = await mailToTool.handler(ctx, {
      name: 'a/lead',
      title: 't',
      content: 'b',
    });

    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
    expect(result).toContain('mycc-mail');
  });

  it('a teammate-like name "review-peer-1/lead" is rejected (not misrouted)', async () => {
    // "review-peer-1/lead" has a slash → rejected as cross-session, NOT
    // validated against the roster (which would treat it as an unknown
    // teammate). The error points to the CLI.
    const result = await mailToTool.handler(ctx, {
      name: 'review-peer-1/lead',
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
    expect(result).toContain('mycc-mail');
  });

  it('a dashed but non-UUID session part like "ab-cd-ef/lead" is rejected', async () => {
    const result = await mailToTool.handler(ctx, {
      name: 'ab-cd-ef/lead',
      title: 't',
      content: 'b',
    });
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(result).toContain('Error');
    expect(result).toContain('mycc-mail');
  });

  it('a UUID with wrong segment lengths is rejected', async () => {
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
    expect(result).toContain('mycc-mail');
  });

  it('a UUID with non-hex characters is rejected', async () => {
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
    expect(result).toContain('mycc-mail');
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