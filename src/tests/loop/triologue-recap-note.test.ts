import { describe, it, expect } from 'vitest';
import {
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
 *   [<hash>] OK                      pristine success (hash = call-id prefix)
 *   [<hash>] OK Note, a recap …      consumed anchor (hash survives the rewrite)
 *
 * The hash is what `recap(target=…)` accepts, so the rendering and the parsing
 * live in the SAME module and must agree — that is what most of these cases
 * pin down.
 */
describe('recap-note', () => {
  const ID = 'brief_1792715569650_ab12cd';
  const HASH = 'brief_17'; // first BRIEF_HASH_LENGTH (8) chars of ID

  it('renders the success line with the call-id prefix as the hash', () => {
    expect(BRIEF_OK).toBe('OK');
    expect(briefHash(ID)).toBe(HASH);
    expect(briefResultLine(ID)).toBe(`[${HASH}] OK`);
  });

  it('stamps a pristine brief result exactly once', () => {
    expect(stampBriefResult('OK.', ID)).toBe(`[${HASH}] OK.`);
    // Idempotent: an already-stamped result is not stamped twice.
    expect(stampBriefResult(`[${HASH}] OK.`, ID)).toBe(`[${HASH}] OK.`);
    // Never labels a non-success result as an anchor.
    expect(stampBriefResult('Error: confidence is required', ID)).toBe('Error: confidence is required');
  });

  it('reads the hash back and strips it for display', () => {
    const result = `[${HASH}] OK Note, a recap has reset the conversation here with summary: body`;
    expect(hashOf(result)).toBe(HASH);
    expect(stripHashPrefix(result)).toBe('OK Note, a recap has reset the conversation here with summary: body');
    // No prefix → unchanged (the display must never lose what it cannot parse).
    expect(stripHashPrefix('OK')).toBe('OK');
    expect(hashOf('OK')).toBeNull();
  });

  it('resolves target by hash or full id, and refuses an unknown one', () => {
    const candidates = [{ id: ID }, { id: 'brief_1792715569999_zz99zz' }];
    expect(resolveBriefTarget(HASH, candidates)?.id).toBe(ID);
    expect(resolveBriefTarget(`[${HASH}]`, candidates)?.id).toBe(ID);
    expect(resolveBriefTarget(ID, candidates)?.id).toBe(ID);
    expect(resolveBriefTarget('nope', candidates)).toBeNull();
  });

  it('a note keeps the hash line and is a pure overwrite', () => {
    const first = noteWithSummary(ID, 'first');
    const second = noteWithSummary(ID, 'second');
    expect(first.startsWith(`[${HASH}] OK Note, a recap has reset the conversation here with summary: first`)).toBe(true);
    expect(second).not.toContain('first');
    expect(second.endsWith('summary: second')).toBe(true);
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
});
