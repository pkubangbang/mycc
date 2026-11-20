/**
 * reminders.ts - ONE registry for COLLECT's recurring nudges (fan-out).
 *
 * WHAT THIS REPLACES
 * ------------------
 * Four nudges, three arming conventions, two state tiers:
 *
 *   todo    TurnVars.nextTodoNudge = 3  (+ TurnVars.lastTodoState dedup)
 *   brief   TurnVars.nextBriefNudge = 5
 *   wt      MachineEnv.nextWtNudge = 0 sentinel
 *   team    (no counter — fired every COLLECT pass)
 *
 * Each `run*Nudge` helper re-implemented the same shape (check counter →
 * emit → re-arm) with its own convention, and two of them mutated `turn`
 * inside their own bodies. Now every nudge is a `Reminder` value, one runner
 * owns the cadence, and the counters live in one map.
 *
 * WHAT IS *NOT* HERE, AND WHY
 * ---------------------------
 * A reminder must be a PURE function of (env, turn). Two COLLECT notes look
 * like reminders but are not:
 *
 *  - MAIL. `collectMailsAndInput()` is a DRAIN, and its return value
 *    (`firstSteerNote`) is consumed by `skillSuggester.suggestSkill` as the
 *    freshest direction. A `build() → string | null` has nowhere to put that
 *    return value without a side channel, and the drain has file-system side
 *    effects by design.
 *  - The serve-state watch. It owns module-level state (`lastServeReported`)
 *    and an exported reset (`reconcileServeStateAfterClear`, called from
 *    agent-repl.ts and slashes/clear.ts), and it fires twice per session.
 *    Threading it through a registry would be a net loss.
 *
 * The hint round and the skill suggester are also excluded: both are async and
 * self-gated (confusion index, query change + cooldown), so they keep their own
 * throttles and only adopt the phantom marker.
 *
 * FAN-OUT: PARALLEL BUILD, SERIAL EMIT
 * ------------------------------------
 * Every `build()` runs concurrently (`Promise.all`) so the async reads (git,
 * IPC) overlap. The EMIT loop stays serial in REGISTRY ORDER, because
 * `transcript.ts` collation and the serve projection read piece order — if
 * emission followed `await` resolution order, conversation history would
 * become a function of which subprocess answered first.
 *
 * That fan-out is what makes `build()` side-effect freeness a CONTRACT rather
 * than a style preference: all builds complete before the first emit, so a
 * build that mutated shared state (the old `runTodoNudge` wrote
 * `turn.nextTodoNudge` / `turn.lastTodoState` inside its own body) would race
 * its siblings and corrupt the cadence.
 */

import type { MachineEnv, TurnVars } from './state-machine.js';
import type { NoteCategory } from '../types.js';
import { listWorktrees } from '../context/worktree-store.js';

/**
 * One recurring COLLECT nudge.
 *
 * The produced body becomes a `note(category, …)` whose `[CATEGORY] ` prefix
 * IS the label the model reads — there is no separate `[Y]`. `id` is the
 * phantom family (the eviction grouping key) and simultaneously the counter
 * key; it never reaches the model.
 */
export interface Reminder {
  /** Stable identity: phantom family + counter key. Never shown to the LLM. */
  id: string;
  /** The note() category — decides the `[CATEGORY]` prefix the model reads. */
  category: NoteCategory;
  /** Fire every N turns (a pass through COLLECT after a turn boundary). */
  every: number;
  /** Assistant turns the emitted note survives in the provider view. */
  ttl: number;
  /** Cheap short-circuit: does this reminder have anything to say at all? */
  isActive(env: MachineEnv, turn: TurnVars): boolean;
  /**
   * Produce the note body from live context, or null to stay silent this pass.
   * MUST be side-effect free (see the module header).
   */
  build(env: MachineEnv, turn: TurnVars): Promise<string | null>;
}

/**
 * Cadence + last-emitted-body bookkeeping, one entry per reminder id.
 *
 * `remaining` is the countdown to the next fire. `lastBody` powers the
 * identical-body suppression: a byte-identical re-emission carries no new
 * information (the brief nudge is a fixed string; the todo nudge repeats the
 * same list until state changes), so it re-arms without spending context.
 */
interface ReminderState {
  remaining: number;
  lastBody: string | null;
}

/** Process-wide reminder state, keyed by `Reminder.id`. */
const states = new Map<string, ReminderState>();

function stateFor(r: Reminder): ReminderState {
  let s = states.get(r.id);
  if (!s) {
    // A fresh reminder fires after a full period, matching the historical
    // `nextTodoNudge = 3` / `nextBriefNudge = 5` initial values.
    s = { remaining: r.every, lastBody: null };
    states.set(r.id, s);
  }
  return s;
}

/** Clear all reminder state (turn boundary / test isolation). */
export function resetReminders(): void {
  states.clear();
}

/**
 * Read a reminder's countdown (test/debug surface).
 *
 * Exposed so a cadence contract can be ASSERTED rather than inferred from
 * emission counts — the off-by-one here is exactly the kind of thing a
 * body-dedup layer can mask.
 */
export function reminderRemaining(id: string): number | undefined {
  return states.get(id)?.remaining;
}

/**
 * Re-arm one reminder so it fires after a full period again.
 *
 * Used by producers whose ACTION satisfies the reminder's ask early — the
 * `brief` tool resets `brief-nudge`, exactly as `turn.nextBriefNudge = 5` did
 * before the registry existed.
 *
 * CLEARS `lastBody` as well as the countdown. Without that the identical-body
 * rule would permanently suppress a reminder with a CONSTANT body: the brief
 * nudge always produces the same string, so a rearmed counter would reach zero
 * and then be swallowed by `body === s.lastBody` on every future period. Re-arm
 * means "fire again after a full period" — which requires forgetting what was
 * last said. (The suppression rule itself is unchanged: it still stops a
 * reminder from repeating itself on consecutive periods.)
 *
 * A no-op for an unknown id so a stale caller can never crash a turn.
 */
export function rearmReminder(id: string): void {
  const r = REMINDERS.find((x) => x.id === id);
  if (!r) return;
  const s = stateFor(r);
  s.remaining = r.every;
  s.lastBody = null;
}

/**
 * The registry. Order here IS emission order within a pass.
 *
 * `worktree` uses `every: 1` to preserve the old `0`-sentinel semantics: the
 * git query runs every pass and only emits when worktrees exist, so a worktree
 * created AND removed inside one window is never silently skipped. Suppression
 * comes from the identical-body rule and its long TTL, not from the counter.
 */
export const REMINDERS: Reminder[] = [
  {
    id: 'team-status',
    category: 'SYSTEM',
    every: 3,
    ttl: 2,
    isActive: () => true,
    build: async (env) => {
      const status = await env.ctx.team.printTeam();
      if (status === 'No teammates.') return null;
      // The snapshot is intentionally NOT deduped at the source (printTeam is
      // one-write-many-read: stop.ts, tm_print, /team, the child IPC and the
      // llm.ts hasTeam probe all call it), so the identical-body rule in the
      // runner is what keeps a steady-state team from re-emitting.
      return `[team status — snapshot, informational]\n${status}\n\ntm_print for a fresh read; elapsed ETAs are not actionable.`;
    }
  },
  {
    id: 'todo-nudge',
    category: 'REMINDER',
    every: 3,
    ttl: 4,
    isActive: (env) => env.ctx.todo.hasOpenTodo(),
    // `Update your todos. <list>` — the old `lastTodoState` dedup is subsumed
    // by the runner's identical-body rule: an unchanged list produces an
    // identical body and is suppressed; a changed list re-emits immediately.
    build: async (env) => (env.ctx.todo.hasOpenTodo() ? `Update your todos. ${env.ctx.todo.printTodoList()}` : null)
  },
  {
    id: 'brief-nudge',
    category: 'REMINDER',
    every: 5,
    ttl: 1,
    isActive: () => true,
    build: async () =>
      'Provide a brief status update using the brief tool: brief("<what you are doing now>", <confidence 0-10>).'
  },
  {
    id: 'worktree-nudge',
    category: 'REMINDER',
    every: 1,
    ttl: 8,
    isActive: () => true,
    build: async () => {
      const worktrees = await listWorktrees(process.cwd());
      if (worktrees.length === 0) return null;
      const lines = worktrees.map((w) => `- ${w.name} at ${w.path} (branch: ${w.branch})`);
      return (
        `Worktrees present. Remove one with bash (git worktree remove <path>) only if you are sure ` +
        `its branch is merged and no teammate is still working in it:\n${lines.join('\n')}`
      );
    }
  }
];

/**
 * Run every reminder for this COLLECT pass.
 *
 * Build phase fans out (side-effect free); emit phase is serial in registry
 * order. A reminder that is inactive, returns null, or repeats its previous
 * body re-arms without emitting — and re-arming is what keeps the cadence
 * honest for the silent case.
 */
export async function runReminders(env: MachineEnv, turn: TurnVars): Promise<void> {
  // ── 1. Build phase: parallel, no mutation ──
  const built = await Promise.all(
    REMINDERS.map(async (r) => {
      const s = stateFor(r);
      // Decrement FIRST, then test — reproduces the historical
      // `nextBriefNudge--; if (nextBriefNudge <= 0)` order, so a reminder with
      // `every: 5` fires on the 5th pass, not the 6th.
      s.remaining--;
      if (s.remaining > 0) return { r, s, body: null };
      try {
        if (!r.isActive(env, turn)) return { r, s, body: null };
        return { r, s, body: await r.build(env, turn) };
      } catch (err) {
        // A failing reminder must never abort COLLECT — the other reminders
        // still have something to say this pass.
        console.warn(`[reminder] ${r.id} build failed: ${err instanceof Error ? err.message : String(err)}`);
        return { r, s, body: null };
      }
    })
  );

  // ── 2. Emit phase: serial, registry order ──
  for (const { r, s, body } of built) {
    if (s.remaining > 0) continue;
    if (body === null) {
      // Silent pass: re-arm so a temporarily inactive reminder does not retry
      // on every subsequent pass.
      s.remaining = r.every;
      continue;
    }
    if (body === s.lastBody) {
      // Byte-identical to the last emission: carry no new information.
      s.remaining = r.every;
      continue;
    }
    s.lastBody = body;
    env.triologue.note(r.category, body, { phantom: { family: r.id, ttl: r.ttl } });
    s.remaining = r.every;
  }
}
