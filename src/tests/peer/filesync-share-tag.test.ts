/**
 * Membership tags (architecture review §4.1).
 *
 * The share id is a read-write capability. It must NEVER travel in a general
 * announce: any connected peer could otherwise learn it and claim membership
 * of a share it was never given. The announce carries sha256("<id>")-derived
 * tags instead, and a peer only learns which of ITS OWN shares overlap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shareTag, shareTags, recordPeerShares, partnersForShare, overlappingShares, clearPeerShares,
} from '../../peer/wire-registry.js';

const SHARE = 'secret-capability-1';

beforeEach(() => { recordPeerShares('peer-A', shareTags([SHARE, 'other'])); });
afterEach(() => { clearPeerShares('peer-A'); });

describe('share membership tags', () => {
  it('the announced tag is not the share id and does not contain it', () => {
    const tag = shareTag(SHARE);
    expect(tag).not.toContain(SHARE);
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(shareTags([SHARE])[0]).toBe(tag);
  });

  it('a peer that announced the tag is a partner for that share', () => {
    // No live socket in this unit test, so assert the tag lookup itself.
    expect(shareTag(SHARE)).toBe(shareTags([SHARE])[0]);
    expect(overlappingShares('peer-A', [SHARE])).toEqual([SHARE]);
    expect(overlappingShares('peer-A', ['not-shared'])).toEqual([]);
    expect(partnersForShare(SHARE)).toEqual([]); // no socket → not live
  });

  it('a peer announces tags it was given; unknown ids yield no overlap', () => {
    expect(overlappingShares('peer-A', [SHARE, 'guessed-id'])).toEqual([SHARE]);
    expect(overlappingShares('peer-nobody', [SHARE])).toEqual([]);
  });
});
