/**
 * reminder-retention.test.ts - cadence + retention as loop-owned policy.
 *
 * Replaces fold-notes.test.ts / fold-notes-integration.test.ts: staleness is no
 * longer projected away at READ time (the fold is deleted); it is BLANKED in
 * place by the COLLECT-owned sweep, keyed on the note's retention TOPIC.
 * See docs/loop/reminder-retention.md §4 and §9.
 */

import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { Triologue } from '../../loop/triologue.js';
import { saveTranscript } from '../../loop/triologue/compact.js';
import { REMINDER_POLICY, nudgeEvery, sweepReminders, MAX_NUDGE_EVERY } from '../../loop/states/collect.js';
import type { MachineEnv } from '../../loop/state-machine.js';
import type { Message } from '../../types.js';
import { setSessionContext } from '../../config.js';
import * as fs from 'fs';
import * as path from 'path';

/** A minimal MachineEnv whose only used surface is `triologue`. */
function envFor(triologue: Triologue): MachineEnv {
  return { triologue } as unknown as MachineEnv;
}

function makeTriologue(): Triologue {
  return new Triologue({ onMessage: () => {}, tokenThreshold: 50000, resultThreshold: 100000 });
}

function contents(messages: readonly Message[]): string[] {
  return messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
}

/** A row is "blanked" when its prefix survives but its payload does not. */
function isBlanked(m: Message): boolean {
  return typeof m.content === 'string' && m.content.includes('retention policy');
}

describe('retention sweep', () => {
  let triologue: Triologue;
  beforeEach(() => {
    triologue = makeTriologue();
  });

  it('keep leaves every row intact, however many assistant rows follow', () => {
    triologue.note('MAIL', 'first mail', undefined, 'mail');
    triologue.agent('done');
    triologue.agent('done again');
    triologue.note('MAIL', 'second mail', undefined, 'mail');
    sweepReminders(envFor(triologue), new Set());
    const rows = triologue.getMessagesRaw();
    expect(rows.some(isBlanked)).toBe(false);
    expect(contents(rows)).toContain('[MAIL] first mail');
    expect(contents(rows)).toContain('[MAIL] second mail');
  });

  it('once keeps exactly the newest row and only when the topic was replaced', () => {
    triologue.note('NUDGE', 'Update your todos. - [ ] a', undefined, 'todo');
    const [oldRow] = triologue.getMessagesRaw();

    // Not replaced this round: nothing is swept.
    sweepReminders(envFor(triologue), new Set());
    expect(isBlanked(oldRow)).toBe(false);

    // Replaced: the older copy goes, the new one stays.
    triologue.note('NUDGE', 'Update your todos. - [x] a', undefined, 'todo');
    sweepReminders(envFor(triologue), new Set(['todo']));
    const rows = triologue.getMessagesRaw();
    expect(isBlanked(oldRow)).toBe(true);
    expect(isBlanked(rows[rows.length - 1])).toBe(false);
    expect(rows[rows.length - 1].content).toBe('[NUDGE] Update your todos. - [x] a');
  });

  /**
   * NOT TEST-COVERED ON PURPOSE — the "survives its own pass" half of `zero`.
   *
   * The contract is: a `zero` row emitted in pass N is the one the LLM reads
   * after pass N, and it is blanked in pass N+1. The sweep expresses that as
   * `keepNewest = replaced.has(topic) ? 1 : 0`, and `replaced` is filled ONLY
   * by the caller-local `replaceTopic` closure inside `handleCollect` — never
   * by `noteTopic`, which is the registry's public emitter.
   *
   * That closure is unreachable from a unit test: `envFor()` here is a bare
   * `{ triologue }` cast to `MachineEnv`, so driving the real COLLECT path
   * would drag in team/mail/wiki/steering. Adding a `countFreshByTopic`-style
   * API to the store just to make the pass testable was tried and rejected —
   * it re-couples the sweep to a second source of truth for "this round".
   *
   * The invariant is instead enforced by construction and audited by hand:
   * every `zero` producer must route through `replaceTopic` (see the `team`
   * bug: it used `noteTopic` and its snapshot was blanked in the pass that
   * wrote it, so the roster never reached the model). When adding a `zero`
   * topic, check its emit site calls `replaceTopic`, not `noteTopic`.
   */
  it('zero leaves no row at the next COLLECT, whether or not it was replaced', () => {
    triologue.note('NUDGE', 'brief now', undefined, 'brief');
    const [row] = triologue.getMessagesRaw();
    sweepReminders(envFor(triologue), new Set());
    expect(isBlanked(row)).toBe(true);
  });

  it('todo and peer do not evict each other (separate topics, same category)', () => {
    triologue.note('NUDGE', 'todo list', undefined, 'todo');
    triologue.note('NUDGE', 'peer routing', undefined, 'peer');
    const [todoRow, peerRow] = triologue.getMessagesRaw();
    triologue.note('NUDGE', 'todo list v2', undefined, 'todo');
    sweepReminders(envFor(triologue), new Set(['todo']));
    expect(isBlanked(todoRow)).toBe(true);
    expect(isBlanked(peerRow)).toBe(false);
  });

  it('never touches a note that carries no topic (compatibility rule)', () => {
    triologue.note('NUDGE', 'unregistered producer nudge');
    const [row] = triologue.getMessagesRaw();
    sweepReminders(envFor(triologue), new Set(Object.keys(REMINDER_POLICY)));
    expect(isBlanked(row)).toBe(false);
    expect(row.content).toBe('[NUDGE] unregistered producer nudge');
  });

  it('preserves length, object identity and role sequence; keeps the [CATEGORY] prefix', () => {
    triologue.note('NUDGE', 'old brief', undefined, 'brief');
    triologue.agent('working');
    triologue.note('NUDGE', 'new brief', undefined, 'brief');
    const before = triologue.getMessagesRaw().slice();
    const rolesBefore = before.map((m) => m.role);

    sweepReminders(envFor(triologue), new Set());

    const after = triologue.getMessagesRaw();
    expect(after.length).toBe(before.length);
    expect(after.map((m) => m.role)).toEqual(rolesBefore);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]); // same OBJECTS
    expect(before[0].content.startsWith('[NUDGE] ')).toBe(true);
    expect(isBlanked(before[0])).toBe(true);
  });

  it('recomputes tokenCount on a blanking round and leaves it alone otherwise', () => {
    triologue.note('NUDGE', 'x'.repeat(400), undefined, 'brief');
    triologue.note('NUDGE', 'y'.repeat(400), undefined, 'brief');

    const before = triologue.getTokenCount();
    sweepReminders(envFor(triologue), new Set());
    const after = triologue.getTokenCount();
    expect(after).toBeLessThan(before);

    // Second pass blanks nothing (the rows already hold the placeholder).
    sweepReminders(envFor(triologue), new Set());
    expect(triologue.getTokenCount()).toBe(after);
  });
});

describe('topic metadata is memory-only', () => {
  it('never reaches the provider view (allow-list drops it)', () => {
    const triologue = makeTriologue();
    triologue.note('NUDGE', 'todo list', undefined, 'todo');
    for (const m of triologue.getMessages()) expect(m.meta).toBeUndefined();
    // ...while the in-memory row still carries it for the sweep.
    expect(triologue.getMessagesRaw()[0].meta).toEqual({ topic: 'todo' });
  });

  it('never reaches the journal copy handed to onMessage', () => {
    let seen: Message | undefined;
    const triologue = new Triologue({
      onMessage: (msg: Message) => {
        if (msg.role === 'user') seen = msg;
      },
      tokenThreshold: 50000,
      resultThreshold: 100000
    });
    triologue.note('NUDGE', 'todo list', undefined, 'todo');
    expect(seen?.meta).toBeUndefined();
  });

  it('never reaches the compaction snapshot JSONL', async () => {
    const sid = 'reminder-retention-test';
    setSessionContext(sid);
    const triologue = makeTriologue();
    triologue.note('NUDGE', 'todo list', undefined, 'todo');
    const file = saveTranscript(triologue.getMessagesRaw());
    try {
      // saveTranscript opens the write stream ASYNCHRONOUSLY — poll until the
      // flushed file is readable, then assert on it and delete it.
      const readFlushed = async (): Promise<string> => {
        for (let i = 0; i < 100; i++) {
          try {
            const text = fs.readFileSync(file, 'utf-8');
            if (text.trimEnd().endsWith('}')) return text;
          } catch {
            /* not flushed yet */
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`transcript never flushed: ${file}`);
      };
      const text = await readFlushed();
      const lines = text.trim().split('\n');
      expect(lines.some((l) => l.includes('"meta"'))).toBe(false);
      expect(lines.some((l) => l.includes('[NUDGE] todo list'))).toBe(true);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('is carried through DEFERRAL so a mid-batch note keeps its topic', () => {
    const triologue = makeTriologue();
    triologue.agent('', [{ id: 'c1', function: { name: 'bash', arguments: {} } } as never]);
    triologue.note('NUDGE', 'deferred todo', undefined, 'todo'); // deferred: ledger open
    expect(triologue.getMessagesRaw().some((m) => m.content === '[NUDGE] deferred todo')).toBe(false);
    triologue.tool('bash', 'ok', 'c1'); // ledger closes → replay
    const replayed = triologue.getMessagesRaw().find((m) => m.content === '[NUDGE] deferred todo');
    expect(replayed?.meta).toEqual({ topic: 'todo' });
  });
});

describe('cadence registry', () => {
  it('clamps every cadence to MAX_NUDGE_EVERY', () => {
    for (const topic of Object.keys(REMINDER_POLICY)) {
      const every = nudgeEvery(topic);
      if (every !== undefined) expect(every).toBeLessThanOrEqual(MAX_NUDGE_EVERY);
    }
  });

  it('gives no cadence to event topics and no policy to unregistered topics', () => {
    expect(nudgeEvery('mail')).toBeUndefined();
    expect(nudgeEvery('hook')).toBeUndefined();
    expect(nudgeEvery('not-a-topic')).toBeUndefined();
  });

  it('keeps hook retention at keep (content-probed by hook/sequence.ts)', () => {
    expect(REMINDER_POLICY.hook.retention).toBe('keep');
  });
});
