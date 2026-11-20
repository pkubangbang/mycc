/**
 * reminder-registry.test.ts — the fan-out reminder runner
 * (src/loop/reminders.ts).
 *
 * The behaviours protected here are the ones the old three-convention code got
 * wrong or duplicated: cadence, identical-body suppression (which subsumes the
 * old `lastTodoState` dedup), registry-ordered emission (history determinism),
 * and side-effect-freedom of `build()` (which the parallel build phase
 * requires).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { REMINDERS, resetReminders, rearmReminder, reminderRemaining, runReminders } from '../../loop/reminders.js';
import type { MachineEnv, TurnVars } from '../../loop/state-machine.js';

interface Emitted {
  category: string;
  message: string;
  opts?: { phantom?: { family: string; ttl?: number } };
}

/**
 * A minimal env: only the surface the four registry entries actually touch
 * (todo, team, worktree git query mocked at the module level below).
 */
function makeEnv(state: { todos: string; team: string }): { env: MachineEnv; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  // The suppression lifetime is measured in assistant turns, counted the same
  // way `ageOut()` counts them — so the mock must expose a messages array the
  // test can grow. `advanceTurns()` pushes one assistant message per turn.
  const messages: { role: string }[] = [];
  const env = {
    triologue: {
      note: (category: string, message: string, opts?: Emitted['opts']) => {
        emitted.push({ category, message, opts });
      },
      getMessagesRaw: () => messages
    },
    ctx: {
      todo: { hasOpenTodo: () => state.todos !== '', printTodoList: () => state.todos },
      team: { printTeam: async () => state.team },
      peer: { listChannels: () => [], listIdentities: () => [], isFresh: () => false }
    },
    __messages: messages
  } as unknown as MachineEnv;
  return { env, emitted };
}

/** Push N assistant messages — one per completed turn, as the TTL clock counts. */
function advanceTurns(env: MachineEnv, n = 1): void {
  const messages = (env as unknown as { __messages: { role: string }[] }).__messages;
  for (let i = 0; i < n; i++) messages.push({ role: 'assistant' });
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

describe('runReminders — identical-body suppression', () => {
  beforeEach(() => resetReminders());

  it('does not re-emit an unchanged todo list (subsumes lastTodoState)', async () => {
    const state = { todos: 'open #1', team: 'No teammates.' };
    const { env, emitted } = makeEnv(state);

    for (let pass = 1; pass <= 3; pass++) await runReminders(env, turn);
    const todoEmits = () => emitted.filter((e) => e.opts?.phantom?.family === 'todo-nudge');
    expect(todoEmits()).toHaveLength(1); // fired at pass 3

    for (let pass = 4; pass <= 9; pass++) await runReminders(env, turn);
    // Two more periods elapsed, but the list is byte-identical → suppressed.
    expect(todoEmits()).toHaveLength(1);
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
    // The B3 regression: identical-body suppression must LAPSE when the note it
    // suppressed is gone from the provider view, or a stable reminder is
    // delivered once and lost forever.
    const state = { todos: 'open #1', team: 'No teammates.' };
    const { env, emitted } = makeEnv(state);
    const todoEmits = () => emitted.filter((e) => e.opts?.phantom?.family === 'todo-nudge');

    for (let pass = 1; pass <= 3; pass++) {
      await runReminders(env, turn);
      advanceTurns(env);
    }
    expect(todoEmits()).toHaveLength(1);

    // 3 more passes inside the ttl: identical body → still suppressed.
    for (let pass = 1; pass <= 3; pass++) {
      await runReminders(env, turn);
      advanceTurns(env);
    }
    expect(todoEmits()).toHaveLength(1);

    // Past ttl: the note has aged out, so suppression must lapse and re-emit.
    for (let pass = 1; pass <= 6; pass++) {
      await runReminders(env, turn);
      advanceTurns(env);
    }
    expect(todoEmits().length).toBeGreaterThan(1);
  });

  it('exposes a stable registry shape', () => {
    const ids = REMINDERS.map((r) => r.id);
    expect(ids).toEqual(['team-status', 'todo-nudge', 'peer-nudge', 'brief-nudge', 'worktree-nudge']);
    for (const r of REMINDERS) {
      expect(r.every).toBeGreaterThan(0);
      expect(r.ttl).toBeGreaterThan(0);
    }
    // team-status is the one reminder whose subject (the roster) is useful
    // whenever a teammate exists, so its note must outlive the gap to its
    // replacement. peer-nudge deliberately violates the opposite way (ttl 2 <
    // every 3): a stale ROUTING address is worse than no address, so it is
    // meant to age out fast — do not "fix" that by raising its ttl.
    const team = REMINDERS.find((r) => r.id === 'team-status')!;
    expect(team.ttl).toBeGreaterThanOrEqual(team.every);
  });
});

