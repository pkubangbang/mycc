/**
 * edit-sanity.test.ts - Unit tests for the post-edit duplication detector
 *
 * The fixtures mirror the three shapes edit_file used to report as a clean
 * "OK": AADC / ADCC (a neighbour line re-included in new_text) and ABDC (the
 * anchor kept, i.e. a pure insertion).
 */

import { describe, it, expect } from 'vite-plus/test';
import { checkEditSanity, formatSanityWarning, type SanityFinding } from '../../utils/edit-sanity.js';

/**
 * Build the input for an edit `old_text` -> `new_text` applied to `before`.
 * The replacement is done by hand (not String.replace) so the helper mirrors
 * edit_file's own contract: exactly one literal occurrence.
 */
function editCase(before: string, oldText: string, newText: string) {
  const at = before.indexOf(oldText);
  if (at < 0) throw new Error(`fixture: old_text ${JSON.stringify(oldText)} absent from before`);
  const after = before.slice(0, at) + newText + before.slice(at + oldText.length);
  return { before, after, oldText, newText };
}

function kinds(findings: SanityFinding[]): string[] {
  return findings.map((f) => f.kind).sort();
}

describe('checkEditSanity', () => {
  describe('AADC / ADCC: a neighbour line is re-included', () => {
    it('reports prefix echo (A,B,C -> A,A,D,C)', () => {
      const findings = checkEditSanity(editCase('alpha\nanchor line\ngamma', 'anchor line', 'alpha\nchanged'));
      expect(kinds(findings)).toEqual(['adjacent-duplicate']);
      expect(findings[0].line).toBe('alpha');
    });

    it('reports suffix echo (A,B,C -> A,D,C,C)', () => {
      const findings = checkEditSanity(editCase('alpha\nanchor line\ngamma', 'anchor line', 'changed\ngamma'));
      expect(kinds(findings)).toEqual(['adjacent-duplicate']);
      expect(findings[0].line).toBe('gamma');
    });

    it('reports an echo that happens mid-file, not only at EOF/BOF', () => {
      const before = 'one\nkeep me\nanchor\nkeep me too\nlast';
      const findings = checkEditSanity(editCase(before, 'anchor', 'keep me\nchanged'));
      expect(kinds(findings)).toEqual(['adjacent-duplicate']);
    });

    it('matches through trailing-whitespace differences', () => {
      const findings = checkEditSanity(editCase('alpha\nanchor line\ngamma', 'anchor line', 'alpha \nnew'));
      expect(kinds(findings)).toEqual(['adjacent-duplicate']);
    });

    it('does not match a re-indented line (shape compares trimEnd only)', () => {
      // Contract lock: the pair key is trimEnd(line), so a line echoed with
      // EXTRA leading indentation (e.g. re-nested in a deeper block) is not
      // reported — deeper indentation usually means a child block, not a
      // copy-paste seam. Change shapeKey() to trim the head too if this
      // trade-off ever flips.
      const findings = checkEditSanity(
        editCase('    const alpha = 1;\n    const b = 2;\n', 'const b = 2;', '        const alpha = 1;\n    const c = 3;')
      );
      expect(findings).toEqual([]);
    });
  });

  describe('ABDC: the anchor is kept (pure insertion)', () => {
    it('reports anchor retained when new_text contains old_text', () => {
      const findings = checkEditSanity(editCase('alpha\nanchor line\ngamma', 'anchor line', 'anchor line\nnew line'));
      expect(kinds(findings)).toEqual(['anchor-retained']);
    });

    it('does not report short anchors (below the 8-char threshold)', () => {
      const findings = checkEditSanity(editCase('x\nanchor\ny', 'anchor', 'anchor\nnew line'));
      expect(findings).toEqual([]);
    });

    it('does not report when the file did not grow', () => {
      // new_text === old_text is the identity edit: nothing replaced, nothing added.
      const findings = checkEditSanity(editCase('alpha\nanchor line\ngamma', 'anchor line', 'anchor line'));
      expect(findings).toEqual([]);
    });
  });

  describe('clean edits stay silent', () => {
    it('a straight replacement reports nothing', () => {
      expect(checkEditSanity(editCase('A\nB\nC', 'B', 'D'))).toEqual([]);
    });

    it('a pure deletion reports nothing', () => {
      expect(checkEditSanity(editCase('A\nB\nC', 'B\n', ''))).toEqual([]);
    });

    it('inserting a line after the anchor reports nothing', () => {
      // Intentional insertion: the new line is different from both neighbours.
      expect(checkEditSanity(editCase('A\nB\nC', 'B', 'B\ninserted line'))).toEqual([]);
    });

    it('an addition inside a larger new_text reports nothing', () => {
      const before = 'function f() {\n  return 1;\n}\n';
      const after = 'function f() {\n  const x = 1;\n  return x;\n}\n';
      expect(checkEditSanity({ before, after, oldText: '  return 1;', newText: '  const x = 1;\n  return x;' })).toEqual(
        []
      );
    });
  });

  describe('trivial-line guard', () => {
    it('ignores a duplicated lone closing brace', () => {
      const before = 'if (a) {\n  b();\n}\n}\n';
      const after = 'if (a) {\n  b();\n}\n}\n}\n';
      expect(checkEditSanity({ before, after, oldText: '}\n}', newText: '}\n}\n}' })).toEqual([]);
    });

    it('ignores a duplicated bare bracket or separator line', () => {
      const before = 'section one\n---\nsection two\n';
      const after = 'section one\n---\n---\nsection two\n';
      expect(checkEditSanity({ before, after, oldText: '---\n', newText: '---\n---\n' })).toEqual([]);
    });

    it('ignores a duplicated code fence', () => {
      const before = 'text\n```\nbody\n```\n';
      const after = 'text\n```\n```\nbody\n```\n';
      expect(checkEditSanity({ before, after, oldText: '```\nbody', newText: '```\n```\nbody' })).toEqual([]);
    });
  });

  describe('safety valves', () => {
    it('skips very large files instead of scanning them', () => {
      const huge = 'x'.repeat(2_000_001);
      expect(checkEditSanity({ before: huge, after: `${huge}\nA\nA`, oldText: 'x', newText: 'A\nA' })).toEqual([]);
    });

    it('handles a 5000-line file with one replacement without pathological cost', () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
      const before = lines.join('\n');
      const findings = checkEditSanity({
        before,
        after: before.replace('line 2500', 'replacement'),
        oldText: 'line 2500',
        newText: 'replacement'
      });
      expect(findings).toEqual([]);
    });
  });
});

describe('formatSanityWarning', () => {
  it('renders nothing when there are no findings', () => {
    expect(formatSanityWarning([], 'src/a.ts')).toBe('');
  });

  it('leads with a warning header naming the file and that the edit was applied', () => {
    const block = formatSanityWarning(checkEditSanity(editCase('alpha\nanchor line\ngamma', 'anchor line', 'alpha\nchanged')), 'src/a.ts');
    expect(block).toContain('[Warning: possible unintended duplication in src/a.ts');
    expect(block).toContain('nothing was rolled back');
    expect(block).toMatch(/\n {2}- /);
    expect(block).toContain('read_file');
  });

  // The warning rides on a SUCCESSFUL result, so it must not trip the loop's
  // error detector (isErrorResult in src/loop/states/tool.ts) — that would
  // bump the confusion index for a correct edit.
  it('never contains a substring the loop treats as an error', () => {
    const findings = [
      ...checkEditSanity(editCase('alpha\nanchor line\ngamma', 'anchor line', 'alpha\nchanged')),
      ...checkEditSanity(editCase('alpha\nanchor line\ngamma', 'anchor line', 'anchor line\nnew line'))
    ];
    expect(findings.length).toBeGreaterThanOrEqual(2);
    const text = formatSanityWarning(findings, 'src/a.ts').toLowerCase();
    for (const needle of [
      'not found',
      'does not exist',
      'no such file',
      'permission denied',
      'enoent',
      'eacces',
      'eperm',
      'error:'
    ]) {
      expect(text).not.toContain(needle);
    }
  });
});
