/**
 * recap-rewind-empty-summary.test.ts — RETIRED (review M5 of commit b52ff0c).
 *
 * This file used to drive `handleRecap(messages, span, tools, escAware, 'c')` and
 * assert that an empty fork result survived as empty. It no longer tested anything
 * that runs:
 *
 *   - `handleRecap` has NO production caller — `states/hook.ts` calls
 *     `handleRecapSpan` and writes the model's OWN `summary` verbatim, so there is
 *     no summarization fork to return ''.
 *   - Its 5th positional argument is now `lastUserQuery`, not a comment; it still
 *     compiled because both are strings.
 *
 * The contract it pretended to pin — the summary floor, the `summary: ''` discard
 * request, and the whitespace-only refusal (M2) — is asserted on the LIVE path in:
 *
 *   src/tests/loop/states/hook-recap-contract.test.ts
 *
 * One test that fails when production regresses is worth more than five that cannot.
 * Kept as a tombstone so the next reader does not "restore" it.
 */
import { describe, it, expect } from 'vitest';

describe('recap empty-summary contract (retired)', () => {
  it('is covered by hook-recap-contract.test.ts', () => {
    expect(true).toBe(true);
  });
});
