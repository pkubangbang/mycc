/**
 * auto-commit-fence.test.ts — the request-id fence on the `auto-commit` frame
 *
 * The frame plays two roles: the REPLY to an `auto-commit-get` (echoes that
 * read's id) and the BROADCAST after any write (id null). The store must tell
 * them apart, because an answer to a superseded read carries a list the user
 * has already edited past — applying it repaints the editor and resurrects a
 * branch that was just removed.
 *
 * These tests pin `shouldAdoptAutoCommitFrame`, the single decision point.
 */
import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { createPinia, setActivePinia } from 'pinia';
import { useChatStore } from '../../web/src/stores/chat-store.js';

describe('chat-store — auto-commit request-id fence', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('adopts a reply that answers the read still outstanding', () => {
    const store = useChatStore();
    store.autoCommitRequestId = '7';
    expect(store.shouldAdoptAutoCommitFrame('7')).toBe(true);
    // The read is satisfied — a second copy of the same reply is a duplicate.
    expect(store.autoCommitRequestId).toBeNull();
    expect(store.shouldAdoptAutoCommitFrame('7')).toBe(false);
  });

  it('DROPS a stale reply to a superseded read', () => {
    const store = useChatStore();
    store.autoCommitRequestId = '8'; // the read the editor is waiting on
    // An answer to read 7 arrives late (e.g. the seed request from an earlier
    // expand). Applying it would show a pre-click copy.
    expect(store.shouldAdoptAutoCommitFrame('7')).toBe(false);
    // ...and it must not consume the outstanding read.
    expect(store.autoCommitRequestId).toBe('8');
  });

  it('drops ANY reply when no read is outstanding', () => {
    const store = useChatStore();
    store.autoCommitRequestId = null;
    expect(store.shouldAdoptAutoCommitFrame('7')).toBe(false);
  });

  it('always adopts a broadcast (id null) — it reports a write that landed', () => {
    const store = useChatStore();
    store.autoCommitRequestId = '9';
    expect(store.shouldAdoptAutoCommitFrame(null)).toBe(true);
    // A broadcast is not an answer, so it must not clear the outstanding read.
    expect(store.autoCommitRequestId).toBe('9');
  });

  it('a reply id never matches a different outstanding read by prefix', () => {
    const store = useChatStore();
    store.autoCommitRequestId = '1';
    // '10' starts with '1'; correlation must be exact, not prefix-based.
    expect(store.shouldAdoptAutoCommitFrame('10')).toBe(false);
    expect(store.autoCommitRequestId).toBe('1');
  });
});
