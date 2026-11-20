/**
 * fold-notes.test.ts — stale NUDGE folding (docs/loop/note-taxonomy.md)
 *
 * The projection must remove attention noise WITHOUT touching structure. Every
 * case below therefore asserts two things at once: what content changed, and
 * that nothing else did (length, role sequence, input immutability).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import type { Message } from '../types.js';
import {
  foldStaleNudges,
  STALE_ASSISTANT_ROWS,
  FOLDED_NUDGE_TEXT
} from '../loop/triologue/fold-notes.js';

const nudge = (text = 'Update your todos.') => ({ role: 'user', content: `[NUDGE] ${text}` }) as Message;
const note = (cat: string, text = 'body') => ({ role: 'user', content: `[${cat}] ${text}` }) as Message;
const assistant = (text = 'working') => ({ role: 'assistant', content: text }) as Message;
const tool = () => ({ role: 'tool', content: 'result', tool_name: 'bash' }) as Message;

/** Assert the projection changed nothing structural. */
function expectStructurePreserved(before: Message[], after: Message[]) {
  expect(after.length).toBe(before.length);
  expect(after.map((m) => m.role)).toEqual(before.map((m) => m.role));
}

describe('foldStaleNudges — staleness buckets', () => {
  it('pins STALE_ASSISTANT_ROWS to 1 (prompt-cache-friendly window)', () => {
    expect(STALE_ASSISTANT_ROWS).toBe(1);
  });

  it('keeps a nudge with 0 assistant rows after it', () => {
    const msgs = [assistant(), nudge()];
    const out = foldStaleNudges(msgs);
    expect(out[1].content).toBe('[NUDGE] Update your todos.');
    expectStructurePreserved(msgs, out);
  });

  it('folds a nudge with 1 assistant row after it', () => {
    const msgs = [nudge(), assistant()];
    const out = foldStaleNudges(msgs);
    expect(out[0].content).toBe(FOLDED_NUDGE_TEXT);
    expectStructurePreserved(msgs, out);
  });

  it('folds a nudge with 3 assistant rows after it', () => {
    const msgs = [nudge(), assistant('a'), assistant('b'), assistant('c'), nudge()];
    const out = foldStaleNudges(msgs);
    expect(out[0].content).toBe(FOLDED_NUDGE_TEXT);
    expect(out[4].content).toBe('[NUDGE] Update your todos.');
    expectStructurePreserved(msgs, out);
  });

  it('folds every nudge older than the window in a mixed history', () => {
    const msgs = [
      nudge('oldest'),
      assistant('r1'),
      tool(),
      nudge('older'),
      assistant('r2'),
      nudge('current'),
      note('HINT', 'Problem Analysis: x')
    ];
    const out = foldStaleNudges(msgs);
    expect(out[0].content).toBe(FOLDED_NUDGE_TEXT);
    expect(out[3].content).toBe(FOLDED_NUDGE_TEXT);
    expect(out[5].content).toBe('[NUDGE] current');
    expect(out[6].content).toBe('[HINT] Problem Analysis: x');
    expectStructurePreserved(msgs, out);
  });
});

describe('foldStaleNudges — only NUDGE is foldable', () => {
  it.each(['REMINDER', 'SYSTEM', 'MAIL', 'HINT', 'URGENT'])(
    'never folds a stale %s note',
    (cat) => {
      const m = note(cat, 'payload');
      const msgs = [m, assistant(), assistant()];
      const out = foldStaleNudges(msgs);
      expect(out[0].content).toBe(`[${cat}] payload`);
      expect(out[0]).toBe(m); // untouched: the same object, not a copy
    }
  );

  it('does not fold a [NUDGE]-looking string that is not a prefix', () => {
    const msgs = [{ role: 'user', content: 'see the [NUDGE] below' } as Message, assistant()];
    const out = foldStaleNudges(msgs);
    expect(out[0].content).toBe('see the [NUDGE] below');
  });

  it('does not fold a nudge whose role is not user', () => {
    const msgs = [{ role: 'system', content: '[NUDGE] x' } as Message, assistant()];
    const out = foldStaleNudges(msgs);
    expect(out[0].content).toBe('[NUDGE] x');
  });
});

describe('foldStaleNudges — structural guarantees', () => {
  it('never mutates the input array or its messages', () => {
    const msgs = [nudge('a'), assistant(), nudge('b')];
    const snapshot = JSON.parse(JSON.stringify(msgs));
    foldStaleNudges(msgs);
    expect(JSON.parse(JSON.stringify(msgs))).toEqual(snapshot);
  });

  it('returns the same array instance when nothing folds (no allocation)', () => {
    const msgs = [assistant(), nudge()];
    expect(foldStaleNudges(msgs)).toBe(msgs);
  });

  it('handles an empty array', () => {
    const msgs: Message[] = [];
    expect(foldStaleNudges(msgs)).toBe(msgs);
  });

  it('counts assistant rows only — tool/user rows do not age a nudge', () => {
    const msgs = [nudge(), tool(), tool(), note('MAIL', 'hi')];
    const out = foldStaleNudges(msgs);
    expect(out[0].content).toBe('[NUDGE] Update your todos.');
  });
});

describe('foldStaleNudges — guards that must not drift', () => {
  it('FOLDED_NUDGE_TEXT keeps the [NUDGE] prefix the hint-round filter matches', () => {
    // hint-round.ts filters with /^\[(?:NUDGE|REMINDER|WRAP_UP)\]/. If the
    // placeholder is reworded without the prefix, elided content silently
    // escapes the filter. Wording and filter must not drift apart.
    expect(FOLDED_NUDGE_TEXT.startsWith('[NUDGE]')).toBe(true);
    expect(/^\[(?:NUDGE|REMINDER|WRAP_UP)\]/.test(FOLDED_NUDGE_TEXT)).toBe(true);
  });

  it('carries no successor claim and no imperative', () => {
    // An earlier wording said "superseded by a later nudge", which is false
    // for throttled producers; "[NUDGE] (stale - omit)" was rejected as an
    // imperative (doc §5). Pin the descriptive contract.
    expect(FOLDED_NUDGE_TEXT.toLowerCase()).not.toContain('superseded');
    expect(FOLDED_NUDGE_TEXT.toLowerCase()).not.toContain('omit');
  });

  it('never elides a genuine user submission that merely starts with [NUDGE]', () => {
    const msgs = [
      { role: 'user', content: '[NUDGE] I typed this myself', user_origin: true } as Message,
      assistant(),
      assistant()
    ];
    const out = foldStaleNudges(msgs);
    expect(out[0].content).toBe('[NUDGE] I typed this myself');
  });

  it('does not match a bare [NUDGE] with no trailing space', () => {
    const msgs = [{ role: 'user', content: '[NUDGE]x' } as Message, assistant()];
    const out = foldStaleNudges(msgs);
    expect(out[0].content).toBe('[NUDGE]x');
  });

  it('counts a synthetic assistant row (tpFix bridge) as a boundary — pinned behaviour', () => {
    // KNOWN LIMITATION: bridges insert assistant rows mid-pass, so a nudge can
    // reach staleness 1 within the turn that emitted it. Accepted, not fixed.
    const msgs = [nudge('a'), { role: 'assistant', content: '', synthetic: true } as Message, nudge('b')];
    const out = foldStaleNudges(msgs);
    expect(out[0].content).toBe(FOLDED_NUDGE_TEXT);
    expect(out[2].content).toBe('[NUDGE] b');
  });

  it('tolerates null and sparse holes without throwing', () => {
    const msgs = [null as unknown as Message, nudge('a'), undefined as unknown as Message, assistant()];
    expect(() => foldStaleNudges(msgs)).not.toThrow();
  });

  it('is idempotent — folding an already-folded array changes nothing', () => {
    const msgs = [nudge('a'), assistant(), assistant()];
    const once = foldStaleNudges(msgs);
    const twice = foldStaleNudges(once);
    expect(twice.map((m) => m.content)).toEqual(once.map((m) => m.content));
  });
});

describe('taxonomy — non-recomputable producers must stay REMINDER', () => {
  // The dangerous drift is REMINDER -> NUDGE, not the reverse: it silently and
  // permanently elides a user instruction or a live file reference, nothing
  // throws, and both members type-check. Reviewer convergence flagged this as
  // the highest-value missing test in the change. Read the producer source and
  // assert the category literal, so an accidental "cleanup" fails loudly.
  const sites: Array<[string, string, string]> = [
    ['src/loop/states/collect.ts', 'Steering notes from the user', 'REMINDER'],
    ['src/loop/states/collect.ts', 'User uploaded file(s)', 'REMINDER'],
    ['src/loop/states/prompt.ts', 'Previously uploaded file(s)', 'REMINDER']
  ];

  it.each(sites)('%s — "%s" is emitted as %s', async (file, marker, expected) => {
    const src = await readFile(new URL(`../${file.slice(4)}`, import.meta.url), 'utf8');
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    // The category argument precedes the message in the same note() call.
    const callStart = src.lastIndexOf('triologue.note(', at);
    expect(callStart).toBeGreaterThan(-1);
    const call = src.slice(callStart, at);
    expect(call).toContain(`'${expected}'`);
  });

  it('collect.ts emits NUDGE exactly four times and no more', async () => {
    // Count-based, not text-matched: the todo nudge builds its body in a
    // variable, so anchoring on the message text is brittle. A fifth NUDGE in
    // collect.ts means a producer was migrated without this test being read;
    // a count below four means one silently reverted to REMINDER.
    const src = await readFile(new URL('../loop/states/collect.ts', import.meta.url), 'utf8');
    const nudgeCalls = src.match(/triologue\.note\(\s*'NUDGE'/g) ?? [];
    expect(nudgeCalls.length).toBe(4);
  });
});