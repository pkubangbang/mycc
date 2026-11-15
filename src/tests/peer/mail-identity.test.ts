/**
 * mail-identity.test.ts — Sender classification for external three-part
 * addresses ("<app>/<group>/<id>", e.g. "myview/REDBOX/56232").
 *
 * An external application pushes mail into our mailbox and stamps its address
 * into `Mail.from`. Such a sender has NO mailbox mycc can write to, so:
 *   - classifySender() reports kind 'external' with the app name,
 *   - replyHint() returns a NO-REPLY line instead of a mail_to recipe,
 *   - mail_to REFUSES the address as a recipient (non-routable).
 * Peer ("<uuid>/lead") and local ("lead", teammate) senders stay routable.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  classifySender,
  parseExternalAddress,
  isNonRoutableSender,
  describeSender,
  replyHint,
  explainNonRoutable
} from '../../peer/mail-identity.js';
import { mailToTool } from '../../tools/mail_to.js';
import type { AgentContext } from '../../types.js';
import { createFullMockContext, runTool, testSignal } from '../tools/test-utils.js';

const PEER_SID = '3b1b83d0-aaaa-bbbb-cccc-dddddddddddd';

describe('parseExternalAddress()', () => {
  it('parses a three-part app/group/id address', () => {
    expect(parseExternalAddress('myview/REDBOX/56232')).toEqual({
      app: 'myview',
      segments: ['myview', 'REDBOX', '56232']
    });
  });

  it('accepts deeper addresses (4+ parts) — still external', () => {
    expect(parseExternalAddress('myview/REDBOX/56232/sub')?.app).toBe('myview');
  });

  it('rejects one- and two-part names (lead sentinel, teammate, peer route)', () => {
    expect(parseExternalAddress('lead')).toBeNull();
    expect(parseExternalAddress('reviewer-1')).toBeNull();
    expect(parseExternalAddress(`${PEER_SID}/lead`)).toBeNull();
  });

  it('rejects malformed three-part names (empty segment, whitespace)', () => {
    expect(parseExternalAddress('myview//56232')).toBeNull();
    expect(parseExternalAddress('myview/REDBOX/')).toBeNull();
    expect(parseExternalAddress('my view/REDBOX/56232')).toBeNull();
    expect(parseExternalAddress('/REDBOX/56232')).toBeNull();
  });
});

describe('classifySender()', () => {
  it('classifies myview/REDBOX/56232 as external and non-routable', () => {
    const info = classifySender('myview/REDBOX/56232');
    expect(info.kind).toBe('external');
    expect(info.routable).toBe(false);
    expect(info.app).toBe('myview');
    expect(info.segments).toEqual(['myview', 'REDBOX', '56232']);
  });

  it('treats a three-part address ending in "lead" as external, not a peer', () => {
    // The slash COUNT decides: a peer route is exactly "<uuid>/lead".
    const info = classifySender('myview/REDBOX/lead');
    expect(info.kind).toBe('external');
    expect(info.routable).toBe(false);
  });

  it('keeps "lead", teammate names and "<uuid>/lead" routable', () => {
    expect(classifySender('lead')).toMatchObject({ kind: 'lead', routable: true });
    expect(classifySender('reviewer-1')).toMatchObject({ kind: 'teammate', routable: true });
    expect(classifySender(`${PEER_SID}/lead`)).toMatchObject({
      kind: 'peer',
      routable: true,
      sessionId: PEER_SID
    });
  });

  it('classifies unknown shapes (system, bad two-part names) as non-routable', () => {
    expect(classifySender('system')).toMatchObject({ kind: 'teammate' });
    for (const bad of ['a/lead', 'review-peer-1/lead', `${PEER_SID}/worker`, '']) {
      expect(classifySender(bad).routable).toBe(false);
    }
  });
});

describe('isNonRoutableSender()', () => {
  it('flags external and unknown senders', () => {
    expect(isNonRoutableSender('myview/REDBOX/56232')).toBe(true);
    expect(isNonRoutableSender('review-peer-1/lead')).toBe(true);
  });

  it('does not flag routable senders', () => {
    expect(isNonRoutableSender('lead')).toBe(false);
    expect(isNonRoutableSender(`${PEER_SID}/lead`)).toBe(false);
  });
});

describe('replyHint() / describeSender()', () => {
  it('gives an external sender an explicit NO-REPLY line (no mail_to recipe)', () => {
    const hint = replyHint('myview/REDBOX/56232', 'hello');
    expect(hint).toContain('NO REPLY');
    expect(hint).toContain('myview');
    expect(hint).not.toContain('Reply with mail_to');
    expect(describeSender('myview/REDBOX/56232')).toContain('external app myview');
  });

  it('still gives a peer the routable reply recipe', () => {
    const hint = replyHint(`${PEER_SID}/lead`, 'hello');
    expect(hint).toContain(`mail_to(name="${PEER_SID}/lead"`);
    expect(describeSender(`${PEER_SID}/lead`)).toBe(' (peer — cross-instance)');
  });

  it('leaves local mail untagged', () => {
    expect(describeSender('lead')).toBe('');
    expect(describeSender('reviewer-1')).toBe('');
  });

  it('explainNonRoutable() names the external reason, null for routable names', () => {
    expect(explainNonRoutable('myview/REDBOX/56232')).toContain('EXTERNAL');
    expect(explainNonRoutable('lead')).toBeNull();
    expect(explainNonRoutable(`${PEER_SID}/lead`)).toBeNull();
  });
});

describe('mail_to refuses an external sender as a recipient', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    ctx = createFullMockContext();
    (ctx.core.getName as ReturnType<typeof vi.fn>).mockReturnValue('lead');
    vi.clearAllMocks();
  });

  it('rejects "myview/REDBOX/56232" without attempting any delivery', async () => {
    const result = await runTool(
      mailToTool,
      ctx,
      { name: 'myview/REDBOX/56232', title: 're', content: 'thanks' },
      testSignal
    );

    expect(result).toContain('EXTERNAL sender address');
    expect(result).toContain('one-way');
    expect(ctx.team.mailTo).not.toHaveBeenCalled();
    expect(ctx.peer.sendPeerMail).not.toHaveBeenCalled();
  });

  it('still routes a valid peer recipient (no regression)', async () => {
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.peer.sendPeerMail as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.peer.hasChannelWith as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = await runTool(
      mailToTool,
      ctx,
      { name: `${PEER_SID}/lead`, title: 't', content: 'c' },
      testSignal
    );

    expect(result).toBe(`OK. Peer mail sent to ${PEER_SID}/lead.`);
  });
});
