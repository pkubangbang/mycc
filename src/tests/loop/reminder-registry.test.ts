/**
 * reminder-registry.test.ts — the fan-out reminder runner
 * (src/loop/reminders.ts).
 *
 * The behaviours protected here are the ones the old three-convention code got
 * wrong or duplicated: cadence, registry-ordered emission (history
 * determinism), and side-effect-freedom of `build()` (which the parallel build
 * phase requires). Identical-body suppression was tried here and REMOVED — see
 * the ReminderState comment in src/loop/reminders.ts before reintroducing any
 * form of it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// `worktree-nudge.build()` shells out to `git worktree list`. The suite must not
// depend on the developer's actual `.worktrees/` contents — that made emitted
// counts environment-dependent — so the subprocess is stubbed here. Returning []
// exercises the "build produced nothing" path; the probe (`readdirSync`) is
// deliberately left real, since it is a filesystem stat the test cannot fake
// meaningfully and its answer only gates whether build() runs at all.
vi.mock('../../context/worktree-store.js', () => ({
  listWorktrees: vi.fn(async () => []),
  findWorktreeByName: vi.fn(async () => undefined),
  findWorktreeByPath: vi.fn(async () => undefined)
}));

import { MAX_PHANTOM_TTL, REMINDERS, resetReminders, rearmReminder, reminderRemaining, runReminders } from '../../loop/reminders.js';
import type { MachineEnv, TurnVars } from '../../loop/state-machine.js';

interface Emitted {
  category: string;
  message: string;
  opts?: { phantom?: { family: string; ttl?: number } };
}

/**
 * A minimal env: only the surface the five registry entries actually touch
 * (todo, team, peer, worktree). `listWorktrees` is mocked at the module level so
 * the `worktree-nudge` build never spawns a real `git worktree list`.
 */
function makeEnv(state: { todos: string; team: string }): { env: MachineEnv; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const env = {
    triologue: {
      note: (category: string, message: string, opts?: Emitted['opts']) => {
        emitted.push({ category, message, opts });
      }
    },
    ctx: {
      todo: { hasOpenTodo: () => state.todos !== '', printTodoList: () => state.todos },
      team: { printTeam: async () => state.team },
      peer: { listChannels: () => [], listIdentities: () => [], isFresh: () => false }
    }
  } as unknown as MachineEnv;
  return { env, emitted };
}

const turn = {} as TurnVars;

describe('runReminders — cadence', () => {
  beforeEach(() => resetReminders());

  it('fires a reminder only when its period elapses', () => {
    const state = { todos: 'open #1', team: 'No teammates.' };
    const { env, emitted } = makeEnv(state);

    // brief-nudge has every:5 → first fire on the 5th pass.
    return (async () => {
      for (let pass = 1; pass <= 4; pass++) await runReminders(env, turn);
      expect(emitted.filter((e) => e.opts?.phantom?.family === 'brief-nudge')).toHaveLength(0);

      await runReminders(env, turn); // pass 5
      expect(emitted.filter((e) => e.opts?.phantom?.family === 'brief-nudge')).toHaveLength(1);
    })();
  });

  it('re-arms an externally satisfied reminder via rearmReminder', async () => {
    const state = { todos: '', team: 'No teammates.' };
    const { env, emitted } = makeEnv(state);
    for (let pass = 1; pass <= 5; pass++) await runReminders(env, turn);
    const before = emitted.filter((e) => e.opts?.phantom?.family === 'brief-nudge').length;
    expect(before).toBe(1);

    rearmReminder('brief-nudge'); // the brief tool was used
    // every:5 — decrement-then-test means it fires on the 5th pass after rearm.
    for (let pass = 1; pass <= 4; pass++) await runReminders(env, turn);
    expect(emitted.filter((e) => e.opts?.phantom?.family === 'brief-nudge')).toHaveLength(before);

    expect(reminderRemaining('brief-nudge')).toBe(1);
    await runReminders(env, turn); // 5th pass after rearm → fires again
    expect(emitted.filter((e) => e.opts?.phantom?.family === 'brief-nudge')).toHaveLength(before + 1);
  });
});

describe('runReminders — cadence (no identical-body suppression)', () => {
  beforeEach(() => resetReminders());

  it('re-emits an unchanged todo list every period', async () => {
    // The registry deliberately does NOT suppress a repeated body (see the
    // ReminderState comment: the suppression clock could not survive
    // compaction). An unchanged list is therefore re-sent every `every` passes.
    const state = { todos: 'open #1', team: 'No teammates.' };
    const { env, emitted } = makeEnv(state);
    const todoEmits = () => emitted.filter((e) => e.opts?.phantom?.family === 'todo-nudge');

    for (let pass = 1; pass <= 3; pass++) await runReminders(env, turn);
    expect(todoEmits()).toHaveLength(1); // fired at pass 3

    for (let pass = 4; pass <= 9; pass++) await runReminders(env, turn);
    // Two more periods elapsed, body unchanged → emitted again each period.
    expect(todoEmits()).toHaveLength(3);
  });

  it('re-emits immediately when the todo body changes', async () => {
    const state = { todos: 'open #1', team: 'No teammates.' };
    const { env, emitted } = makeEnv(state);
    for (let pass = 1; pass <= 3; pass++) await runReminders(env, turn);

    state.todos = 'open #2 (a different list)';
    for (let pass = 4; pass <= 6; pass++) await runReminders(env, turn);

    const todoEmits = emitted.filter((e) => e.opts?.phantom?.family === 'todo-nudge');
    expect(todoEmits).toHaveLength(2);
    expect(todoEmits[1].message).toContain('open #2');
  });
});

describe('runReminders — activity gates', () => {
  beforeEach(() => resetReminders());

  it('stays silent for a reminder with nothing to say, and still re-arms', async () => {
    const state = { todos: '', team: 'No teammates.' };
    const { env, emitted } = makeEnv(state);
    for (let pass = 1; pass <= 6; pass++) await runReminders(env, turn);

    // team-status and todo-nudge are both inactive; only brief-nudge fires.
    expect(emitted.filter((e) => e.opts?.phantom?.family === 'team-status')).toHaveLength(0);
    expect(emitted.filter((e) => e.opts?.phantom?.family === 'todo-nudge')).toHaveLength(0);
    expect(emitted.filter((e) => e.opts?.phantom?.family === 'brief-nudge')).toHaveLength(1);
  });

  it('emits team status when teammates exist', async () => {
    const state = { todos: '', team: 'alpha (working), beta (idle)' };
    const { env, emitted } = makeEnv(state);
    for (let pass = 1; pass <= 3; pass++) await runReminders(env, turn);

    const teamEmits = emitted.filter((e) => e.opts?.phantom?.family === 'team-status');
    expect(teamEmits).toHaveLength(1);
    expect(teamEmits[0].message).toContain('team status');
    expect(teamEmits[0].category).toBe('SYSTEM');
  });
});

describe('runReminders — emission contract', () => {
  beforeEach(() => resetReminders());

  it('emits in REGISTRY order, not build-resolution order', async () => {
    // Make team.printTeam SLOW so an await-order implementation would emit it
    // last; the registry order must still win. (The delay has to be a real
    // timer — a resolved promise settles in microtask order, which cannot
    // distinguish registry order from await order.)
    const emitted: Emitted[] = [];
    const env = {
      triologue: {
        note: (category: string, message: string, opts?: Emitted['opts']) => {
          emitted.push({ category, message, opts });
        },
        getMessagesRaw: () => []
      },
      ctx: {
        todo: { hasOpenTodo: () => true, printTodoList: () => 'open #1' },
        team: {
          printTeam: async () => {
            await new Promise((r) => setTimeout(r, 5));
            return 'slow teammate';
          }
        },
        peer: { listChannels: () => [], listIdentities: () => [], isFresh: () => false }
      }
    } as unknown as MachineEnv;

    for (let pass = 1; pass <= 5; pass++) await runReminders(env, {} as TurnVars);

    const families = emitted.map((e) => e.opts?.phantom?.family);
    const teamIdx = families.indexOf('team-status');
    const briefIdx = families.lastIndexOf('brief-nudge');
    expect(teamIdx).toBeGreaterThanOrEqual(0);
    expect(briefIdx).toBeGreaterThan(teamIdx);
  });

  it('marks every reminder note with its family and ttl', async () => {
    const state = { todos: 'open #1', team: 'teammate' };
    const { env, emitted } = makeEnv(state);
    for (let pass = 1; pass <= 5; pass++) await runReminders(env, turn);

    for (const e of emitted) {
      expect(e.opts?.phantom?.family).toBeTruthy();
      expect(typeof e.opts?.phantom?.ttl).toBe('number');
    }
  });

  it('a throwing build does not abort the pass', async () => {
    const emitted: Emitted[] = [];
    const env = {
      triologue: {
        note: (category: string, message: string, opts?: Emitted['opts']) => {
          emitted.push({ category, message, opts });
        },
        getMessagesRaw: () => []
      },
      ctx: {
        todo: {
          hasOpenTodo: () => {
            throw new Error('boom');
          },
          printTodoList: () => ''
        },
        team: { printTeam: async () => 'No teammates.' },
        peer: { listChannels: () => [], listIdentities: () => [], isFresh: () => false }
      }
    } as unknown as MachineEnv;

    await expect(runReminders(env, {} as TurnVars)).resolves.toBeUndefined();
    // brief-nudge (pass 1..5) still fires on the 5th pass.
    for (let pass = 2; pass <= 5; pass++) await runReminders(env, {} as TurnVars);
    expect(emitted.some((e) => e.opts?.phantom?.family === 'brief-nudge')).toBe(true);
  });

  it('a steady todo list is re-emitted once its note has aged out', async () => {
    // Guarded here as the reviewer asked: with suppression gone this must hold
    // for the SIMPLE reason (it re-emits every period), so the assertion is now
    // an exact cadence check rather than an "eventually resurfaces" check.
    const state = { todos: 'open #1', team: 'No teammates.' };
    const { env, emitted } = makeEnv(state);
    const todoEmits = () => emitted.filter((e) => e.opts?.phantom?.family === 'todo-nudge');

    for (let pass = 1; pass <= 3; pass++) {
      await runReminders(env, turn);
    }
    expect(todoEmits()).toHaveLength(1);

    // Next period: one more emission, exactly on the cadence boundary.
    for (let pass = 1; pass <= 3; pass++) {
      await runReminders(env, turn);
    }
    expect(todoEmits()).toHaveLength(2);

    for (let pass = 1; pass <= 3; pass++) {
      await runReminders(env, turn);
    }
    expect(todoEmits()).toHaveLength(3);
  });

  it('exposes a stable registry shape', () => {
    const ids = REMINDERS.map((r) => r.id);
    expect(ids).toEqual(['team-status', 'todo-nudge', 'peer-nudge', 'brief-nudge', 'worktree-nudge']);
    for (const r of REMINDERS) {
      expect(r.every).toBeGreaterThan(0);
      expect(r.ttl).toBeGreaterThan(0);
      // A long ttl keeps the note's neighbourhood of the conversation mutable
      // for its whole lifetime, so the provider's prefix cache misses across
      // that window instead of just the emitting turn. See MAX_PHANTOM_TTL.
      expect(r.ttl, `${r.id}: ttl must not exceed MAX_PHANTOM_TTL`).toBeLessThanOrEqual(MAX_PHANTOM_TTL);
    }
    // `ttl >= every` is the rule for AUTO-EMITTING reminders: they carry
    // information with no other source, so the copy must survive until its
    // replacement arrives — at `ttl == every` that is a seamless handoff, zero
    // gap. `brief-nudge` (5/1) is outside the rule because it asks for something
    // OPTIONAL: an expired, unanswered nudge loses nothing, so it should show
    // once and not nag. Pinned per id so a new reminder must opt in explicitly
    // instead of inheriting an assumption.
    for (const id of ['team-status', 'todo-nudge', 'peer-nudge', 'worktree-nudge']) {
      const r = REMINDERS.find((x) => x.id === id)!;
      expect(r.ttl, `${id}: ttl must cover the gap to its replacement`).toBeGreaterThanOrEqual(r.every);
    }
    const brief = REMINDERS.find((r) => r.id === 'brief-nudge')!;
    expect(brief.ttl).toBeLessThan(brief.every); // a suggestion, not information
  });
});

