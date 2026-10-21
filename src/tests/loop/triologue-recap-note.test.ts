/**
 * triologue-recap-note.test.ts — the brief-result note that recap writes.
 *
 * recap does not append a summary turn: it REWRITES the anchor brief's tool
 * RESULT in place. These tests pin the note's wire shape and the marker rule
 * the anchor scan depends on:
 *
 *   pristine  → "OK"                       (still an eligible anchor)
 *   consumed  → "OK Note, a recap has reset the conversation here with summary: …"
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PRISTINE_BRIEF_RESULT,
  isPristineBriefResult,
  noteWithSummary,
  readNoteBody,
} from '../../loop/triologue/recap-note.js';

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const MARKER = 'OK Note, a recap has reset the conversation here with summary: ';

describe('recap-note', () => {
  it('pristine result is exactly "OK"', () => {
    expect(PRISTINE_BRIEF_RESULT).toBe('OK');
    expect(isPristineBriefResult('OK')).toBe(true);
    expect(isPristineBriefResult('OK.')).toBe(false);
    expect(isPristineBriefResult(undefined)).toBe(false);
  });

  it('writes the summary after the marker, keeping the success prefix', () => {
    const content = noteWithSummary('{"summary":"xxxxx"}');
    expect(content).toBe(`${MARKER}{"summary":"xxxxx"}`);
    expect(isPristineBriefResult(content)).toBe(false);
  });

  it('emits the body verbatim (no re-encoding)', () => {
    const body = '[RECAP] collapse\nRewound past the brief: "foo bar"\n\n### Key Discoveries\n- x';
    expect(noteWithSummary(body).slice(MARKER.length)).toBe(body);
  });

  it('is a pure overwrite: a second note replaces the first', () => {
    const first = noteWithSummary('first');
    const second = noteWithSummary('second');
    expect(second).not.toContain('first');
    expect(readNoteBody(second)).toBe('second');
    void first;
  });

  it('readNoteBody recovers the body, null when pristine', () => {
    expect(readNoteBody('OK')).toBeNull();
    expect(readNoteBody(undefined)).toBeNull();
    expect(readNoteBody(noteWithSummary('the summary'))).toBe('the summary');
  });
});
