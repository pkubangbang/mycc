/**
 * triologue-recap-note.test.ts — the note renderer and the INTERNAL brief hash.
 *
 * WHAT THIS SUITE PINS DOWN after auto-recap:
 *
 *   - `briefHash` is an INTERNAL key (the signal names a span with it, the audit
 *     record quotes it). Nothing the model reads contains it, so the old
 *     "addressable anchor line" contract is GONE with the `recap` tool.
 *   - `buildRecapNote(summary, todos)` is the whole note: `[RECAP]`, a blank
 *     line, the fork's summary, then the live checklist. No anchor quote — the
 *     fold is decided outside the conversation, so there is no anchor to echo.
 *   - `noteWithSummary(body)` is a PURE OVERWRITE: a second fold at the same
 *     brief replaces the note instead of stacking under a preserved line 1.
 *   - `hashOf` / `stripHashPrefix` still READ a legacy `[<hash>] …` prefix (the
 *     web projection uses them for message keys) but never mistake a note's
 *     `[RECAP]` marker for one.
 */
import { describe, it, expect } from 'vitest';

import {
  BRIEF_HASH_LENGTH,
  PLAN_SCOPE_HEADING,
  RECAP_MARKER,
  anchoredNoteLength,
  briefHash,
  buildRecapNote,
  hasPlanScopeSection,
  hashOf,
  noteWithSummary,
  resolveBriefTarget,
  stripHashPrefix,
} from '../../loop/triologue/recap-note.js';

const ID = 'brief_1793000000000_abc123';
const SAME_EPOCH_ID = 'brief_1793000000000_xyz789';
const OTHER_ID = 'brief_1793000000123_def456';

const HASH = briefHash(ID);

describe('recap-note', () => {
  // ==========================================================================
  // The internal hash
  // ==========================================================================

  describe('briefHash — internal identity', () => {
    it('gives two briefs minted in the SAME epoch different hashes', () => {
      expect(briefHash(ID)).not.toBe(briefHash(SAME_EPOCH_ID));
    });

    it('gives every real-shaped producer id a distinct hash', () => {
      const ids = [
        'brief_1793000000000_abc123',
        'brief_recover_1793000000000_q9',
        'crossroad_1793000000000_zz11',
      ];
      expect(new Set(ids.map(briefHash)).size).toBe(ids.length);
    });

    it('emits a fixed-length, readable, lower-case token', () => {
      expect(HASH).toHaveLength(BRIEF_HASH_LENGTH);
      expect(HASH).toMatch(/^[0-9a-f]+$/);
    });

    it('is a pure function of the id', () => {
      expect(briefHash(ID)).toBe(briefHash(ID));
    });

    it('renders a missing call id as an empty token rather than a nameable one', () => {
      expect(briefHash(undefined)).toBe('');
      expect(briefHash('')).toBe('');
    });
  });

  // ==========================================================================
  // hashOf / stripHashPrefix — legacy READERS only
  // ==========================================================================

  describe('hashOf / stripHashPrefix — reading a legacy prefix', () => {
    it('reads a hash-shaped prefix', () => {
      expect(hashOf(`[${HASH}] OK`)).toBe(HASH);
    });

    it('hashOf rejects anything that is not a single-token prefix', () => {
      expect(hashOf('OK')).toBeNull();
      expect(hashOf('[]')).toBeNull();
      expect(hashOf('[not a hash] x')).toBeNull();
      expect(hashOf(undefined)).toBeNull();
    });

    it('stripHashPrefix tolerates a missing separating space and a bare prefix', () => {
      expect(stripHashPrefix(`[${HASH}]OK`)).toBe('OK');
      expect(stripHashPrefix(`[${HASH}]`)).toBe('');
      expect(stripHashPrefix('[]')).toBe('[]');
      expect(stripHashPrefix('OK')).toBe('OK');
    });

    it("never reads a note's [RECAP] marker as a hash prefix", () => {
      const note = noteWithSummary(buildRecapNote('body'));
      expect(hashOf(note)).toBeNull();
      expect(stripHashPrefix(note)).toBe(note);
    });
  });

  // ==========================================================================
  // resolveBriefTarget — the loop's internal resolver
  // ==========================================================================

  describe('resolveBriefTarget — internal target resolution', () => {
    const candidates = [{ id: ID }, { id: OTHER_ID }];

    it('resolves target by hash or full id, and refuses an unknown one', () => {
      expect(resolveBriefTarget(briefHash(OTHER_ID), candidates)).toEqual({ id: OTHER_ID });
      expect(resolveBriefTarget(OTHER_ID, candidates)).toEqual({ id: OTHER_ID });
      expect(resolveBriefTarget('deadbeef', candidates)).toBeNull();
    });

    it('never resolves a same-epoch brief to the oldest candidate', () => {
      // The bug a prefix cut would cause: both ids share `brief_1793000000000_`.
      expect(resolveBriefTarget(briefHash(SAME_EPOCH_ID), [{ id: ID }])).toBeNull();
    });

    it('matches an upper-case or bracketed spelling of the hash', () => {
      expect(resolveBriefTarget(`[${briefHash(OTHER_ID).toUpperCase()}]`, candidates)).toEqual({ id: OTHER_ID });
    });

    it('refuses an empty or whitespace target instead of falling back to a default', () => {
      expect(resolveBriefTarget('', candidates)).toBeNull();
      expect(resolveBriefTarget('   ', candidates)).toBeNull();
      expect(resolveBriefTarget('[]', candidates)).toBeNull();
    });

    it('prefers an exact id match over a hash match', () => {
      const idLookingLikeAHash = 'abcdef12';
      expect(resolveBriefTarget(idLookingLikeAHash, [{ id: idLookingLikeAHash }])).toEqual({ id: idLookingLikeAHash });
    });
  });

  // ==========================================================================
  // The note
  // ==========================================================================

  describe('buildRecapNote — marker, summary, checklist', () => {
    it('heads with the bare [RECAP] marker, a blank line, then the summary', () => {
      const note = buildRecapNote('the span summary');
      expect(note).toBe(`${RECAP_MARKER}\n\nthe span summary`);
    });

    it('does not quote an anchor brief — there is no anchor to address', () => {
      const note = buildRecapNote('BODY');
      expect(note).not.toContain('Rewound past the brief');
    });

    it('appends the checklist as its own section after the summary', () => {
      const note = buildRecapNote('BODY', '### Open todos\n[ ] #1 wire it');
      expect(note.indexOf('BODY')).toBeLessThan(note.indexOf('### Open todos'));
    });

    it('is exactly the two-part note when there is no checklist', () => {
      expect(buildRecapNote('BODY', '')).toBe(buildRecapNote('BODY'));
      expect(buildRecapNote('BODY', '   ')).toBe(buildRecapNote('BODY'));
    });
  });

  describe('noteWithSummary — the whole result, pure overwrite', () => {
    it('is the note itself, not a line glued under a preserved header', () => {
      const body = buildRecapNote('the summary');
      expect(noteWithSummary(body)).toBe(body);
    });

    it('replaces a previous note at the same brief instead of stacking', () => {
      const first = noteWithSummary(buildRecapNote('first'));
      const second = noteWithSummary(buildRecapNote('second'));
      expect(second).not.toContain('first');
      expect(second).toContain('second');
      // Idempotent in the sense that matters: folding twice leaves ONE note.
      expect(first.split(RECAP_MARKER)).toHaveLength(2);
    });

    it('drops a plan-scope section: the note is this span\'s record', () => {
      const noted = noteWithSummary(buildRecapNote('SUMMARY'));
      expect(noted).not.toContain(PLAN_SCOPE_HEADING);
    });

    it('anchoredNoteLength measures exactly what the rewind stores', () => {
      const body = buildRecapNote('SUMMARY BODY');
      expect(anchoredNoteLength(body)).toBe(noteWithSummary(body).length);
    });
  });

  // ==========================================================================
  // plan-scope section detection (unchanged)
  // ==========================================================================

  describe('hasPlanScopeSection', () => {
    it('recognizes only the plan-scope section', () => {
      expect(hasPlanScopeSection(`OK. ${PLAN_SCOPE_HEADING}, decide the interface first.`)).toBe(true);
      expect(hasPlanScopeSection('OK')).toBe(false);
      expect(hasPlanScopeSection('OK.')).toBe(false);
      expect(hasPlanScopeSection(undefined)).toBe(false);
    });
  });
});
