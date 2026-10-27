/**
 * todo-nudge.test.ts — the "keep your todos current" reminder is a TEAMMATE-ONLY
 * instrument, and that asymmetry is deliberate.
 *
 * WHY THEY DIFFER — the structural reason, not a preference:
 *
 * A TEAMMATE has no COLLECT state, no `hintRound`, and no `recap`. So before this
 * reminder existed it had NO mid-task todo channel at all: the project-context
 * populator is frozen between compact()/clear() boundaries (to keep the
 * prompts-cache prefix hot), so mid-task it showed a stale list or none. A plain
 * every-N-calls reminder is therefore its ONLY current view of its own checklist.
 *
 * The LEAD has three channels already:
 *   1. the populator — guarantees the list appears, at boundaries;
 *   2. `hintRound` → `buildStateSections` (hint-round.ts:791) — renders the live,
 *      sanitized list mid-turn, gated on real trouble (confusion index);
 *   3. `recap` — folds finished work and re-surfaces the list WITH hashes.
 * A fourth, blind, every-N-calls reminder would fire unconditionally where
 * hint-round fires on a signal, and would compete for attention with the tool
 * results that already carry the current hash. It would also contradict the rule
 * collect.ts itself states: the list "must NOT be re-injected as a per-turn
 * REMINDER".
 *
 * So the lead's nudge was tried and REMOVED. These tests lock both halves of that
 * decision, so a future "consistency" refactor does not quietly add it back — and
 * so a future cleanup does not quietly delete the teammate's, which is load-
 * bearing.
 *
 * Source-level assertions on purpose: the teammate's reminder lives inside its
 * un-exported worker loop, which no unit test can import. Asserting presence and
 * shape is enough to catch the two failures that matter: the reminder silently
 * disappearing, or the two sides drifting back together.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

describe('TEAMMATE todo nudge (teammate-worker.ts step 3) — LOAD-BEARING', () => {
  const src = read('src/context/teammate-worker.ts');

  it('exists — the reminder was reinstated, not silently dropped again', () => {
    // It was removed once on the assumption the populator alone sufficed, which
    // it does not: the populator is boundary-frozen.
    expect(src).toContain('TODO_NUDGE_INTERVAL');
    expect(src).toContain('nextTodoNudge');
    expect(src).toContain('Update your todos');
  });

  it('is the FIRST nudge — todo before brief', () => {
    // The todo list is the teammate's only mid-task view of its own work; a stale
    // checklist is worse than a missing status line.
    const todoAt = src.indexOf('Update your todos');
    const briefAt = src.indexOf('Provide a brief status update using the brief tool');
    expect(todoAt).toBeGreaterThan(-1);
    expect(briefAt).toBeGreaterThan(-1);
    expect(todoAt).toBeLessThan(briefAt);
  });

  it('prints the OPEN list with sanitized fields and current hashes', () => {
    expect(src).toContain("getItems().filter((i) => !i.done || i.pinned)");
    expect(src).toContain('sanitizeTodoField(i.name)');
    expect(src).toContain('[hash: ${i.hash}]');
  });

  it('does NOT teach recap — recap is scope [main]', () => {
    // A teammate reading "use recap" is told to call a tool it does not have.
    const at = src.indexOf('Update your todos');
    expect(src.slice(at, at + 600)).not.toContain('recap');
  });

  it('has no hint-round of its own — which is WHY this nudge is needed', () => {
    // The premise of the whole decision. If a teammate ever gains hintRound, this
    // nudge becomes redundant and should be re-evaluated rather than kept.
    expect(src).not.toContain('hintRound');
    expect(src).not.toContain('buildStateSections');
  });
});

describe('LEAD has NO periodic todo nudge — the decision, locked', () => {
  const src = read('src/loop/states/collect.ts');

  it('does not print the todo list as a REMINDER', () => {
    expect(src).not.toContain('Update your todos');
    expect(src).not.toContain('nextTodoNudge');
  });

  it('states the rule it is obeying — no per-turn re-injection', () => {
    // The rationale lives in the docblock so the next reader does not "restore
    // symmetry" by copying the teammate's nudge over.
    expect(src).toContain('must NOT be re-injected');
  });
});

describe('the lead’s three channels are present (they are what make 5a unnecessary)', () => {
  it('1 — the populator', () => {
    expect(read('src/loop/agent-repl.ts')).toContain('registerProjectContextPopulator(() => buildTodoMessages');
  });

  it('2 — hintRound renders a live list mid-turn', () => {
    const hint = read('src/loop/hint-round.ts');
    expect(hint).toContain('buildStateSections');
    expect(hint).toContain('## Todo List');
  });

  it('3 — recap carries the open list (the list itself, not a rebuild)', () => {
    // NOTE the deliberate absence: recap does NOT call rebuildProjectContext().
    // That call is licensed ONLY at compact()/clear(), where the conversation
    // prefix already changes (triologue.ts:217-218). A rewind mutates the
    // transcript but not the prefix, so rebuilding there would pay a full
    // prompt-cache invalidation for a list that the recap note ALREADY carries —
    // the `### Open todos` section below. The list is delivered by the note.
    expect(read('src/loop/triologue/recap-note.ts')).toContain('formatOpenTodos');
    expect(read('src/loop/states/hook.ts')).not.toContain('rebuildProjectContext');
  });
});
