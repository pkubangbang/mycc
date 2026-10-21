/**
 * triologue-recap-note.test.ts — the two writers of a brief result must not drift.
 *
 * There is no "is this result pristine?" predicate any more: anchor eligibility
 * comes from the STRUCTURE (non-synthetic brief + something after its
 * round-trip), never from the result's text. This file therefore pins only what
 * actually exists — the success line, the note framing, and the plan-scope
 * section marker.
 */
import { describe, it, expect, vi } from 'vitest';

// agent-io writes to the terminal; keep the test output clean.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  PRISTINE_BRIEF_RESULT,
  PLAN_SCOPE_HEADING,
  hasPlanScopeSection,
  noteWithSummary,
} from '../../loop/triologue/recap-note.js';

const MARKER = 'OK Note, a recap has reset the conversation here with summary: ';

describe('recap-note', () => {
  it('the success line is "OK" and the tool renders it as "OK."', () => {
    // PRISTINE_BRIEF_RESULT is the shared prefix; the period belongs to the
    // rendered result so the plan-scope section reads as one sentence.
    expect(PRISTINE_BRIEF_RESULT).toBe('OK');
  });

  it('writes the summary after the marker, keeping the success prefix', () => {
    const content = noteWithSummary('{"summary":"xxxxx"}');
    expect(content).toBe(`${MARKER}{"summary":"xxxxx"}`);
  });

  it('emits the body verbatim (no re-encoding)', () => {
    const body = '[RECAP] collapse\nRewound past the brief: "foo bar"\n\n### Key Discoveries\n- x';
    expect(noteWithSummary(body).slice(MARKER.length)).toBe(body);
  });

  it('is a pure overwrite: a second note replaces the first', () => {
    const first = noteWithSummary('first');
    const second = noteWithSummary('second');
    expect(second).not.toContain('first');
    expect(second.slice(MARKER.length)).toBe('second');
    void first;
  });

  it('an overwrite also replaces a plan-scope section', () => {
    const withScope = `${PRISTINE_BRIEF_RESULT}. ${PLAN_SCOPE_HEADING}, decide the interface first.`;
    expect(hasPlanScopeSection(withScope)).toBe(true);
    // The note is the record of this stretch; the reflection rode in the slot
    // and is gone after the rewind.
    const noted = noteWithSummary('the summary');
    expect(hasPlanScopeSection(noted)).toBe(false);
    expect(noted).not.toContain(PLAN_SCOPE_HEADING);
  });

  it('hasPlanScopeSection recognizes only the plan-scope section', () => {
    expect(hasPlanScopeSection(`OK. ${PLAN_SCOPE_HEADING}, x`)).toBe(true);
    expect(hasPlanScopeSection('OK')).toBe(false);
    expect(hasPlanScopeSection('OK.')).toBe(false);
    expect(hasPlanScopeSection(undefined)).toBe(false);
  });
});
