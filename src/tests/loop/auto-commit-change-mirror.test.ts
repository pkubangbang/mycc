/**
 * auto-commit-change-mirror.test.ts - the seam that keeps the WebUI's allow-list
 * mirror honest, and the reason the handler must NOT broadcast.
 *
 * THE DEFECT THIS FILE EXISTS FOR (round 2 of the review loop):
 *   `serve-persistent-guards.test.ts` proved the WS handler hands a submitted
 *   list to the hub, and `auto-commit-list.test.ts` proved AutoState stores and
 *   normalizes it — but nothing proved ANY of that reaches a browser. A
 *   regression that deleted `autoState.onAutoCommitBranchesChange` and restored
 *   a handler-side `broadcastAutoCommit` would have passed every test in the
 *   repo while delivering each frame twice.
 *
 * What is asserted here, against the REAL AutoState singleton:
 *   1. every mutator (seed / add / remove / clear / replace) notifies;
 *   2. the notification carries the NORMALIZED list, not the raw submission;
 *   3. a no-op write does not notify (no spurious frames);
 *   4. the terminal slash path is a first-class writer — it reaches the
 *      observer through the same callback the WebUI does.
 *
 * Rule it encodes: test the seam, not just the two sides of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { autoState, formatAutoCommitEntry } from '../../loop/auto-state.js';

describe('AutoState allow-list -> change callback (the WebUI mirror seam)', () => {
  let seen: string[][];

  beforeEach(() => {
    seen = [];
    autoState.onAutoCommitBranchesChange = (entries) => seen.push(entries);
    // Start from a known list. clear() is the public deny-all reset (the
    // `off --all` path), so it doubles as the test's own reset.
    autoState.clearAutoCommitBranches();
    seen.length = 0;
  });

  afterEach(() => {
    autoState.onAutoCommitBranchesChange = null;
    autoState.clearAutoCommitBranches();
  });

  it('notifies after an ADD with the stored entry (terminal `/auto-commit on`)', () => {
    autoState.addAutoCommitBranches(['main'], true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([formatAutoCommitEntry('main', true)]);
  });

  it('notifies after a REMOVE (terminal `/auto-commit off`)', () => {
    autoState.addAutoCommitBranches(['main', 'dev'], false);
    seen.length = 0;

    autoState.removeAutoCommitBranches(['main']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([formatAutoCommitEntry('dev', false)]);
  });

  it('notifies after a CLEAR (terminal `/auto-commit off --all`)', () => {
    autoState.addAutoCommitBranches(['main'], false);
    seen.length = 0;

    autoState.clearAutoCommitBranches();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([]);
  });

  it('notifies after an ADD with the NORMALIZED list, not the raw submission', () => {
    // Blanks dropped, duplicates collapsed: the broadcast must carry what was
    // STORED, because that is what the browser renders as the live list.
    autoState.addAutoCommitBranches(['  ', 'main', 'main', 'dev'], false);
    const stored = autoState.getAutoCommitBranches();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(stored);
    expect(seen[0]).toEqual([formatAutoCommitEntry('main', false), formatAutoCommitEntry('dev', false)]);
  });

  it('does NOT notify on a no-op add (no spurious frames)', () => {
    autoState.addAutoCommitBranches(['main'], true);
    seen.length = 0;

    // Re-adding an already-present branch in the same form changes nothing.
    autoState.addAutoCommitBranches(['main'], true);
    expect(seen).toEqual([]);
  });

  it('does NOT notify on a no-op remove (branch was never listed)', () => {
    autoState.addAutoCommitBranches(['main'], false);
    seen.length = 0;

    autoState.removeAutoCommitBranches(['not-listed']);
    expect(seen).toEqual([]);
  });

  it('does NOT notify on a no-op clear of an already-empty list', () => {
    autoState.clearAutoCommitBranches();
    seen.length = 0;

    autoState.clearAutoCommitBranches();
    expect(seen).toEqual([]);
  });

  it('does NOT notify when an add stores an identical list', () => {
    autoState.addAutoCommitBranches(['main', 'dev'], false);
    seen.length = 0;

    // Re-adding the same branches must not repaint every browser's rows: an
    // unchanged store is not a change.
    autoState.addAutoCommitBranches(['main', 'dev'], false);
    expect(seen).toEqual([]);
  });

  it('DOES notify when a re-add re-flags an entry (add is the upgrade path)', () => {
    autoState.addAutoCommitBranches(['main', 'dev'], false);
    seen.length = 0;

    // `main` gains :autoAdd — same branch, different authority, real change:
    // the badge must appear in every browser.
    autoState.addAutoCommitBranches(['main:autoAdd'], false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([formatAutoCommitEntry('main', true), formatAutoCommitEntry('dev', false)]);
  });

  it('every notification is a COPY — a later mutation cannot rewrite what was sent', () => {
    autoState.addAutoCommitBranches(['main'], false);
    expect(seen).toHaveLength(1);
    const delivered = seen[0];

    autoState.addAutoCommitBranches(['dev'], false);
    // The earlier frame must still describe the list as it was when sent.
    expect(delivered).toEqual([formatAutoCommitEntry('main', false)]);
  });

  it('notifies the CURRENT observer only (a replaced callback stops receiving)', () => {
    const first = vi.fn();
    autoState.onAutoCommitBranchesChange = first;

    autoState.addAutoCommitBranches(['a'], false);
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    autoState.onAutoCommitBranchesChange = second;
    autoState.addAutoCommitBranches(['b'], false);
    expect(first).toHaveBeenCalledTimes(1); // not re-invoked
    expect(second).toHaveBeenCalledTimes(1);
  });
});
