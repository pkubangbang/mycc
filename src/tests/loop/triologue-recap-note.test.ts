import { describe, it, expect } from 'vitest';
import {
  BRIEF_HASH_LENGTH,
  BRIEF_OK,
  briefHash,
  briefResultLine,
  stripHashPrefix,
  hashOf,
  hasPlanScopeSection,
  stampBriefResult,
  resolveBriefTarget,
  buildRecapNote,
  noteWithSummary,
  PLAN_SCOPE_HEADING,
} from '../../loop/triologue/recap-note.js';

/**
 * The brief result contract after the anchor-hash change:
 *
 *   [<hash>] OK                      pristine success
 *   [<hash>] OK Note, a recap …      consumed anchor (hash survives the rewrite)
 *
 * The hash is what `recap(target=…)` accepts, so the rendering and the parsing
 * live in the SAME module and must agree — that is what most of these cases
 * pin down.
 *
 * HISTORY — the reason the collision cases below exist: the first
 * implementation hashed with `callId.slice(0, 8)`, and real ids are minted as
 * `brief_<13-digit-ms>_<tail>`, so every brief in a ~1.15-day epoch rendered the
 * SAME `brief_17`. `resolveBriefTarget` then matched the OLDEST candidate and
 * recap collapsed a span the model never named. The old suite pinned the bug
 * instead of catching it (it asserted `briefHash(ID) === 'brief_17'`), so the
 * first group below now asserts the PROPERTY — distinct ids give distinct
 * hashes — rather than the current algorithm's output.
 */

/** Real-shaped ids: the shape that exposed the prefix collision. */
const ID = 'brief_1792715569650_ab12cd';
const SAME_EPOCH_ID = 'brief_1792715569999_zz99zz';
const NEXT_DAY_ID = 'brief_1792632446916_q1q1q1';
const PROVIDER_ID = 'call_t19y5eam';

/** All ids minted by the real producers, in one place. */
const REAL_SHAPED_IDS = [
  ID,
  SAME_EPOCH_ID,
  NEXT_DAY_ID,
  PROVIDER_ID,
  'compact_resume_1792715569650_ab12cd',
  'brief_recover_1792715569650_ab12cd',
];

describe('recap-note', () => {
  // The expected hash is DERIVED, never hard-coded: a test that spells out the
  // current digest only proves the implementation is stable w.r.t. itself.
  const HASH = briefHash(ID);
  const OTHER_HASH = briefHash(SAME_EPOCH_ID);

  // ---------------------------------------------------------------------------
  // hash uniqueness (the regression this suite exists to catch)
  // ---------------------------------------------------------------------------

  describe('hash uniqueness', () => {
    it('gives two briefs minted in the SAME epoch different hashes', () => {
      // BEFORE the fix both were 'brief_17' (their ids share an 8-char prefix).
      expect(ID.slice(0, BRIEF_HASH_LENGTH)).toBe(
        SAME_EPOCH_ID.slice(0, BRIEF_HASH_LENGTH),
      ); // documents WHY the naive cut was ambiguous
      expect(HASH).not.toBe(OTHER_HASH);
    });

    it('gives every real-shaped producer id a distinct hash', () => {
      const hashes = REAL_SHAPED_IDS.map((id) => briefHash(id));
      expect(new Set(hashes).size).toBe(REAL_SHAPED_IDS.length);
    });

    it('renders the current epoch\'s briefs as different visible tokens', () => {
      // The model reads these in history and quotes one back as `target`.
      const a = briefResultLine(ID);
      const b = briefResultLine(SAME_EPOCH_ID);
      expect(a).not.toBe(b);
      expect(a).toBe(`[${HASH}] ${BRIEF_OK}`);
      expect(b).toBe(`[${OTHER_HASH}] ${BRIEF_OK}`);
    });

    it('emits a fixed-length, readable, lower-case token', () => {
      for (const id of REAL_SHAPED_IDS) {
        const h = briefHash(id);
        expect(h).toHaveLength(BRIEF_HASH_LENGTH);
        expect(h).toMatch(/^[0-9a-z]+$/);
      }
    });

    it('is a pure function of the id', () => {
      expect(briefHash(ID)).toBe(briefHash(ID));
      expect(briefHash(SAME_EPOCH_ID)).toBe(OTHER_HASH);
    });

    it('renders a missing call id as an empty hash rather than a nameable one', () => {
      // '' must never read as a token that could resolve to some other brief.
      expect(briefHash(undefined)).toBe('');
      expect(briefHash('')).toBe('');
      expect(briefResultLine(undefined)).toBe('[] OK');
    });
  });

  // ---------------------------------------------------------------------------
  // render / stamp
  // ---------------------------------------------------------------------------

  it('renders the success line with the hash of the call id', () => {
    expect(BRIEF_OK).toBe('OK');
    expect(briefResultLine(ID)).toBe(`[${HASH}] OK`);
  });

  it('stamps a pristine brief result exactly once', () => {
    expect(stampBriefResult('OK.', ID)).toBe(`[${HASH}] OK.`);
    // Idempotent: an already-stamped result is not stamped twice.
    expect(stampBriefResult(`[${HASH}] OK.`, ID)).toBe(`[${HASH}] OK.`);
    // Never labels a non-success result as an anchor.
    expect(stampBriefResult('Error: confidence is required', ID)).toBe('Error: confidence is required');
  });

  it('stamps the id it is GIVEN, not the one implied by an existing prefix', () => {
    // Two briefs in one epoch no longer share a prefix, so a mismatch here is
    // visible: stamping with the other id must produce the other token.
    expect(stampBriefResult('OK', SAME_EPOCH_ID)).toBe(`[${OTHER_HASH}] OK`);
    expect(stampBriefResult('OK', undefined)).toBe('OK');
  });

  // ---------------------------------------------------------------------------
  // read back / strip
  // ---------------------------------------------------------------------------

  it('reads the hash back and strips it for display', () => {
    const result = `[${HASH}] OK Note, a recap has reset the conversation here with summary: body`;
    expect(hashOf(result)).toBe(HASH);
    expect(stripHashPrefix(result)).toBe('OK Note, a recap has reset the conversation here with summary: body');
    // No prefix → unchanged (the display must never lose what it cannot parse).
    expect(stripHashPrefix('OK')).toBe('OK');
    expect(hashOf('OK')).toBeNull();
  });

  it('hashOf rejects anything that is not a single-token prefix', () => {
    expect(hashOf('[] OK')).toBeNull();          // empty hash
    expect(hashOf('[a b] OK')).toBeNull();       // space is not a token char
    expect(hashOf('[a/b] OK')).toBeNull();       // nor a slash
    expect(hashOf(undefined)).toBeNull();
  });

  it('stripHashPrefix tolerates a missing separating space and a bare prefix', () => {
    expect(stripHashPrefix(`[${HASH}]OK`)).toBe('OK');
    expect(stripHashPrefix(`[${HASH}]`)).toBe('');
    expect(stripHashPrefix('[]')).toBe('[]');
  });

  it('round-trips: stamping then reading yields the original id\'s hash', () => {
    for (const id of REAL_SHAPED_IDS) {
      expect(hashOf(stampBriefResult('OK', id))).toBe(briefHash(id));
    }
  });

  // ---------------------------------------------------------------------------
  // target resolution
  // ---------------------------------------------------------------------------

  it('resolves target by hash or full id, and refuses an unknown one', () => {
    const candidates = [{ id: ID }, { id: SAME_EPOCH_ID }];
    expect(resolveBriefTarget(HASH, candidates)?.id).toBe(ID);
    // The OTHER same-epoch brief resolves to ITSELF, not to the oldest match.
    expect(resolveBriefTarget(OTHER_HASH, candidates)?.id).toBe(SAME_EPOCH_ID);
    expect(resolveBriefTarget(`[${HASH}]`, candidates)?.id).toBe(ID);
    expect(resolveBriefTarget(ID, candidates)?.id).toBe(ID);
    expect(resolveBriefTarget('nope', candidates)).toBeNull();
  });

  it('never resolves a same-epoch brief to the oldest candidate', () => {
    // The exact regression: oldest-first candidates + colliding hashes.
    const candidates = [
      { id: ID },
      { id: SAME_EPOCH_ID },
      { id: NEXT_DAY_ID },
    ];
    const picked = resolveBriefTarget(briefHash(NEXT_DAY_ID), candidates);
    expect(picked?.id).toBe(NEXT_DAY_ID);
    expect(picked?.id).not.toBe(ID);
  });

  it('matches an upper-case or bracketed spelling of the hash', () => {
    const candidates = [{ id: ID }];
    expect(resolveBriefTarget(HASH.toUpperCase(), candidates)?.id).toBe(ID);
    expect(resolveBriefTarget(` [${HASH.toUpperCase()}] `, candidates)?.id).toBe(ID);
  });

  it('refuses an empty or whitespace target instead of falling back to a default', () => {
    const candidates = [{ id: ID }];
    expect(resolveBriefTarget('', candidates)).toBeNull();
    expect(resolveBriefTarget('   ', candidates)).toBeNull();
    expect(resolveBriefTarget(`[${HASH}]`, [])).toBeNull();
  });

  it('prefers an exact id match over a hash match', () => {
    // A pathological id that HAPPENS to equal some other brief's hash.
    const collidingId = briefHash(ID);
    const candidates = [{ id: ID }, { id: collidingId }];
    expect(resolveBriefTarget(collidingId, candidates)?.id).toBe(collidingId);
  });

  // ---------------------------------------------------------------------------
  // recap note
  // ---------------------------------------------------------------------------

  it('a note keeps the hash line and is a pure overwrite', () => {
    const first = noteWithSummary(ID, 'first');
    const second = noteWithSummary(ID, 'second');
    expect(first.startsWith(`[${HASH}] OK Note, a recap has reset the conversation here with summary: first`)).toBe(true);
    expect(second).not.toContain('first');
    expect(second.endsWith('summary: second')).toBe(true);
  });

  it('a note keeps the ORIGINAL hash, so the anchor stays addressable', () => {
    // Before the fix both same-epoch briefs rendered 'brief_17', so this
    // assertion held for the wrong reason; now it distinguishes them.
    const noted = noteWithSummary(SAME_EPOCH_ID, 'body');
    expect(hashOf(noted)).toBe(OTHER_HASH);
    expect(hashOf(noted)).not.toBe(HASH);
  });

  it('an overwrite also replaces a plan-scope section', () => {
    const withScope = stampBriefResult(`OK. ${PLAN_SCOPE_HEADING}, decide the interface first.`, ID);
    expect(hasPlanScopeSection(withScope)).toBe(true);
    const noted = noteWithSummary(ID, 'the summary');
    expect(hasPlanScopeSection(noted)).toBe(false);
  });

  it('hasPlanScopeSection recognizes only the plan-scope section', () => {
    expect(hasPlanScopeSection(stampBriefResult(`OK. ${PLAN_SCOPE_HEADING}, x`, ID))).toBe(true);
    expect(hasPlanScopeSection('OK')).toBe(false);
    expect(hasPlanScopeSection('OK.')).toBe(false);
  });

  it('buildRecapNote heads with [RECAP] and quotes the anchor brief', () => {
    const note = buildRecapNote('explore the loop', 'the anchor text', 'BODY');
    expect(note.startsWith('[RECAP] explore the loop')).toBe(true);
    expect(note).toContain('Rewound past the brief: "the anchor text"');
    expect(note.endsWith('BODY')).toBe(true);
  });

  it('buildRecapNote omits the quote line for a brief with no message', () => {
    const note = buildRecapNote('explore the loop', '', 'BODY');
    expect(note).toBe('[RECAP] explore the loop\n\nBODY');
  });
});
