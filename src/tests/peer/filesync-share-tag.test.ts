/**
 * Share membership: nonces are claims, proofs are membership (PR #38 P1).
 *
 * The share id is a read-write capability. A static hash of it in a general
 * announce is OBSERVABLE and REPLAYABLE, so an announce can never grant
 * access: any wire peer could echo someone else's nonce and be treated as a
 * partner, then receive a manifest carrying the raw share id.
 *
 * The property asserted here is the security one, not an implementation
 * detail: membership comes only from a challenge/response answer that only a
 * holder of the share id can produce, for a challenge WE issued, exactly once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  shareTag,
  shareTags,
  shareProof,
  recordPeerShares,
  partnersForShare,
  overlappingShares,
  clearPeerShares,
  challengePeerShares,
  confirmShareChallenges,
  setWireHooks
} from '../../peer/wire-registry.js';

const SHARE = 'secret-capability-1';
const OTHER = 'not-shared';
const PEER = 'peer-A';
/** What the peer announced (a claim) vs what it must PROVE. */
const PROVEN_CHALLENGE = 'deadbeefdeadbeefdeadbeefdeadbeef';

beforeEach(() => {
  // The challenger holds the share: proofs are verified against OUR bound
  // ids, never against the peer's claim.
  setWireHooks({
    getSessionId: () => 'self-sid',
    getWorkDir: () => '/tmp',
    getDaemon: () => false,
    getRole: () => undefined,
    getShares: () => [SHARE, 'second'],
    getServingEndpoint: () => null,
    recordRemotePeerTodo: () => {},
    appendLocalMail: () => {},
    verbose: () => {}
  });
  recordPeerShares(PEER, shareTags([SHARE, OTHER]));
});
afterEach(() => {
  clearPeerShares(PEER);
});

describe('share membership: nonce vs proof', () => {
  it('the announced nonce is not the share id and does not contain it', () => {
    const tag = shareTag(SHARE);
    expect(tag).not.toContain(SHARE);
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(shareTags([SHARE])[0]).toBe(tag);
  });

  it('an announce ALONE grants nothing — a replayed nonce is not a partner', () => {
    // PEER announced the nonce in beforeEach. That IS the replay attack: the
    // nonce is public and copyable. Without a proof it must not appear as a
    // partner and must not be reported as an overlap.
    expect(partnersForShare(SHARE)).toEqual([]);
    expect(overlappingShares(PEER, [SHARE])).toEqual([]);
  });

  it('a proof computed over the wrong challenge is rejected', () => {
    // Even holding OTHER (or guessing), a proof must be bound to the exact
    // challenge we issued — so a recorded exchange cannot be replayed either.
    const forged = [{ tag: shareTag(SHARE), proof: shareProof(OTHER, PROVEN_CHALLENGE) }];
    expect(confirmShareChallenges(PEER, PROVEN_CHALLENGE, forged)).toEqual([]);
    expect(overlappingShares(PEER, [SHARE, 'guessed-id'])).toEqual([]);
  });

  it('a proof for a challenge we never issued grants nothing', () => {
    const crafted = [{ tag: shareTag(SHARE), proof: shareProof(SHARE, 'never-issued') }];
    expect(confirmShareChallenges(PEER, 'never-issued', crafted)).toEqual([]);
  });

  it('challengePeerShares does not challenge for nonces we do not hold', () => {
    expect(challengePeerShares(PEER, ['some-other-share'])).toBe(false);
  });
});
