/**
 * plan-scope.test.ts - unit tests for the Web UI plan-scope parser
 *
 * The backend prints the PLAN-mode reflection as a TERMINAL block
 * (src/loop/plan-scope.ts formatPlanScopeForDisplay): an ASCII rule line plus
 * four padEnd()-aligned label columns. The Web UI cannot render that through
 * markdown, so the block is re-parsed (src/web/src/plan-scope.ts) and drawn
 * as PlanScopeCard. These tests pin the CONTRACT that makes that safe:
 *
 *   - the canonical four labelled lines parse into four ordered checks;
 *   - a run-on paragraph (all labels inline, no newlines) parses identically
 *     (the model frequently ignores the "one line each" instruction);
 *   - a lead-in before the first label is kept, not mistaken for an answer;
 *   - unlabelled prose is returned verbatim (never dropped);
 *   - a value is never dropped, even when a label is missing or repeated;
 *   - the sentinel classifier recognizes "none/no/two-way" answers only.
 */
import { describe, it, expect } from 'vitest';
import {
  parsePlanScope,
  isSentinelAnswer,
  PLAN_SCOPE_HINTS,
  PLAN_SCOPE_LABELS,
  PLAN_SCOPE_LOG_LABEL,
} from '../../web/src/plan-scope';

/** The exact shape src/loop/plan-scope.ts formatPlanScopeForDisplay() emits. */
const TERMINAL_BLOCK = [
  '── plan-scope ──────────────────────────────────',
  'SUBLATE     Serves the ask. One invariant: "no silent writes" — thesis vs antithesis.',
  'WRONG PRB   no — the user asked to optimize the display, and this does that.',
  'REVERSIBLE  two-way — delete PlanScopeCard.vue and the MessageItem branch.',
  'TUNNEL      none — no rule stands in the way here.',
].join('\n');

describe('parsePlanScope', () => {
  it('parses the terminal block into four ordered checks', () => {
    const p = parsePlanScope(TERMINAL_BLOCK);
    expect(p.prose).toBeNull();
    expect(p.checks.map((c) => c.label)).toEqual([
      'SUBLATE', 'WRONG PRB', 'REVERSIBLE', 'TUNNEL',
    ]);
    expect(p.checks[0].value).toContain('no silent writes');
    expect(p.checks[1].value.startsWith('no — the user asked')).toBe(true);
    expect(p.checks[2].value.startsWith('two-way — ')).toBe(true);
    expect(p.leadIn).toBe('');
  });

  it('parses a run-on paragraph with every label inline', () => {
    const runOn = 'TUNNEL: none — no rule blocks this. SUBLATE: none — no collision. '
      + 'WRONG PRB: no — the ask is display. REVERSIBLE: two-way — revert the commit.';
    const p = parsePlanScope(runOn);
    expect(p.checks.map((c) => c.label)).toEqual([
      'TUNNEL', 'SUBLATE', 'WRONG PRB', 'REVERSIBLE',
    ]);
    expect(p.checks[3].value).toBe('two-way — revert the commit.');
  });

  it('keeps a lead-in before the first label separate from the answers', () => {
    const p = parsePlanScope([
      '── plan-scope ──────────────────────────────────',
      'Serves the ask.',
      'TUNNEL      break the DTO — saves 3 files.',
    ].join('\n'));
    expect(p.leadIn).toBe('Serves the ask.');
    expect(p.checks).toHaveLength(1);
    expect(p.checks[0].value).toBe('break the DTO — saves 3 files.');
  });

  it('returns unlabelled prose verbatim instead of dropping it', () => {
    const prose = 'The model ignored the format entirely.\nSecond line stays.';
    const p = parsePlanScope(prose);
    expect(p.checks).toEqual([]);
    expect(p.prose).toBe(prose);
  });

  it('flattens a wrapped answer into one row value', () => {
    const p = parsePlanScope('TUNNEL      first half\n  second half\nSUBLATE  none — x');
    expect(p.checks[0].value).toBe('first half second half');
    expect(p.checks[1].label).toBe('SUBLATE');
  });

  it('never drops a value when a label is missing', () => {
    // No SUBLATE / REVERSIBLE — the present labels still carry their text.
    const p = parsePlanScope('TUNNEL  break the rule\nWRONG PRB  no — fine');
    expect(p.checks).toHaveLength(2);
    expect(p.checks[0].value).toBe('break the rule');
    expect(p.checks[1].value).toBe('no — fine');
  });

  it('keeps an empty answer as an empty check (rendered as "（无输出）")', () => {
    const p = parsePlanScope('TUNNEL:\nSUBLATE: merge them');
    expect(p.checks[0]).toEqual({ label: 'TUNNEL', value: '' });
    expect(p.checks[1].value).toBe('merge them');
  });

  it('tolerates empty / whitespace input', () => {
    expect(parsePlanScope('')).toEqual({ leadIn: '', checks: [], prose: null });
    expect(parsePlanScope('   \n  ')).toEqual({ leadIn: '', checks: [], prose: null });
  });
});

describe('isSentinelAnswer', () => {
  it('recognizes the three sentinels', () => {
    expect(isSentinelAnswer('none — no rule')).toBe(true);
    expect(isSentinelAnswer('no — the ask is display')).toBe(true);
    expect(isSentinelAnswer('two-way — revert the commit')).toBe(true);
  });

  it('does not treat a real finding as a sentinel', () => {
    expect(isSentinelAnswer('break the DTO — saves 3 files')).toBe(false);
    expect(isSentinelAnswer('nothing breaks')).toBe(false);
  });
});

describe('exported constants', () => {
  it('has a hint for every label, in prompt order', () => {
    expect(PLAN_SCOPE_LABELS).toEqual(['TUNNEL', 'SUBLATE', 'WRONG PRB', 'REVERSIBLE']);
    for (const label of PLAN_SCOPE_LABELS) {
      expect(PLAN_SCOPE_HINTS[label].length).toBeGreaterThan(0);
    }
  });

  it('matches the backend label contract used by MessageItem', () => {
    // src/loop/states/hook.ts: brief('info', 'plan-scope', …) — an exact
    // match here is what routes the log to PlanScopeCard.
    expect(PLAN_SCOPE_LOG_LABEL).toBe('plan-scope');
  });
});
