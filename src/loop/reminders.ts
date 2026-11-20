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

import * as fs from 'fs';
import * as path from 'path';
import type { MachineEnv, TurnVars } from './state-machine.js';
import type { ChannelFile, NoteCategory } from '../types.js';
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
 * Cadence bookkeeping, one entry per reminder id.
 *
 * `remaining` is the countdown to the next fire — the ONLY cross-pass state a
 * reminder has.
 *
 * WHY THERE IS NO IDENTICAL-BODY SUPPRESSION
 * ------------------------------------------
 * This registry used to carry `lastBody` / `lastEmitAt` / `suppressed` so an
 * unchanged body could be swallowed between periods. That layer was removed on
 * purpose; do not reintroduce it without reading this.
 *
 * It could not be made correct. Suppression needs a lifetime ("is the previous
 * emission still in the provider view?"), and the only clock available was the
 * absolute assistant-message count of the CURRENT conversation array. That
 * clock is not monotonic: `installCompacted()` replaces the conversation with a
 * summary, or splices out an archived prefix while keeping the tail, so the
 * count moves BACKWARDS across normal lifecycle events. Two consequences, both
 * filed against this file in review:
 *
 *  1. Expiry had to be evaluated after the emit loop (so it could not influence
 *     the pass it ran on), which made a `ttl == every` reminder — team-status,
 *     3/3 — suppress on the very pass its note died, deferring the replacement
 *     by a full extra period.
 *  2. Suppression state and `ageOut()`'s eviction disagreed by construction
 *     after any compaction, because they measured different things.
 *
 * Rather than patch the clock, the dedup went away. The cost is bounded and
 * known: a reminder whose body is stable re-emits the same text each period.
 * Phantom TTL still bounds the conversation — the older copies age out — so
 * this spends context on a steady run, it does not grow it without limit.
 * Removing it also restores the pre-registry behavior where an unchanged todo
 * list was re-sent each period; `lastTodoState` stays deleted.
 */
interface ReminderState {
  remaining: number;
}

/** Process-wide reminder state, keyed by `Reminder.id`. */
const states = new Map<string, ReminderState>();

function stateFor(r: Reminder): ReminderState {
  let s = states.get(r.id);
  if (!s) {
    // A fresh reminder fires after a full period, matching the historical
    // `nextTodoNudge = 3` / `nextBriefNudge = 5` initial values.
    s = { remaining: r.every };
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
 * A no-op for an unknown id so a stale caller can never crash a turn.
 */
export function rearmReminder(id: string): void {
  const r = REMINDERS.find((x) => x.id === id);
  if (!r) return;
  stateFor(r).remaining = r.every;
}

/**
 * Channels currently worth telling the model about: joined, with a known peer,
 * whose heartbeat is still fresh.
 *
 * Same predicate the pre-registry `runTodoNudge` used, and the same one
 * `PeerManager.hasActiveChannel()` applies — kept as one local helper so
 * `isActive` and `build` cannot disagree about which channels are live (a
 * disagreement would arm the reminder and then build an empty body).
 */
function activeChannels(env: MachineEnv): ChannelFile[] {
  return env.ctx.peer
    .listChannels()
    .filter((ch) => ch.joined && ch.peerSessionId && env.ctx.peer.isFresh(ch.peerSessionId));
}

/**
 * Cheap "is a worktree even plausible" probe for `worktree-nudge.isActive`.
 *
 * A synchronous `readdirSync` of `<cwd>/.worktrees` instead of the
 * `git worktree list` SUBPROCESS that `build()` runs. The subprocess is the
 * expensive part (the pre-registry code deferred it behind a `0`-sentinel
 * precisely for that reason), so this keeps `every: 1` — never miss a worktree
 * created and removed between passes — without paying for a fork on every
 * COLLECT pass.
 *
 * FAILS OPEN: any stat error (missing dir, permissions, non-git cwd) returns
 * true so the real `listWorktrees()` decides. A probe must not be able to
 * silence the reminder it is gating.
 *
 * COST: one `statSync` on the directory itself — no readdir, no allocation of
 * the entry list, no dirent materialisation. This runs on EVERY COLLECT pass
 * (`every: 1`), which is why it is a stat and not a directory listing: an empty
 * string means the directory exists but is empty, so `null` is the honest
 * "plausible or unknown" answer and we let the subprocess say no.
 */
function hasOpenWorktreeHint(_env: MachineEnv): boolean {
  try {
    // A directory entry count is not exposed by stat, so an existing-but-empty
    // `.worktrees` reports "plausible" here and costs one git call in build().
    // That is the safe direction: a missed worktree is worse than a wasted fork.
    return fs.statSync(path.join(process.cwd(), '.worktrees')).isDirectory();
  } catch {
    return true;
  }
}

/**
 * The registry. Order here IS emission order within a pass.
 */
export const REMINDERS: Reminder[] = [
  {
    id: 'team-status',
    category: 'SYSTEM',
    every: 3,
    // ttl MUST be >= every. With ttl 2 the snapshot was evicted one pass before
    // its replacement existed, so a third of the passes had no roster at all —
    // masked until now by the duplicate collect.ts emission (see the note below).
    ttl: 3,
    isActive: () => true,
    build: async (env) => {
      const status = await env.ctx.team.printTeam();
      if (status === 'No teammates.') return null;
      // The snapshot is intentionally NOT deduped at the source (printTeam is
      // one-write-many-read: stop.ts, tm_print, /team, the child IPC and the
      // llm.ts hasTeam probe all call it). The registry no longer dedups bodies
      // either, so a steady-state team re-emits the same snapshot each period;
      // its single note ages out on `ttl`, so the snapshot never stacks up.
      return `[team status — snapshot, informational]\n${status}\n\ntm_print for a fresh read; elapsed ETAs are not actionable.`;
    }
  },
  {
    id: 'todo-nudge',
    category: 'REMINDER',
    every: 3,
    ttl: 4,
    isActive: (env) => env.ctx.todo.hasOpenTodo(),
    // `Update your todos. <list>` — the old `lastTodoState` dedup stays gone, but
    // for a different reason than the one it was originally replaced by: the
    // registry no longer suppresses identical bodies either (see ReminderState),
    // so an unchanged list is re-sent each period. That is accepted — see the
    // cost note there — not an oversight.
    build: async (env) => (env.ctx.todo.hasOpenTodo() ? `Update your todos. ${env.ctx.todo.printTodoList()}` : null)
  },
  {
    /**
     * Peer-channel nudge — SPLIT OUT of `todo-nudge` and deliberately NOT
     * re-fused into it.
     *
     * The pre-registry `runTodoNudge` emitted the todo list and the "Active
     * channels:" block from ONE body under ONE counter. That coupling meant a
     * channel appearing or disappearing did not change the todo list, so the
     * hand-rolled `compositeState` cursor had to fold both into one string just
     * to notice either. A separate reminder gives the channel snapshot its own
     * dedup key for free, which is the whole point of the split: a todo edit
     * and a peer going stale are independent events and must not suppress each
     * other.
     *
     * Three things the fused version supplied, each now carried here:
     *  1. channel-ONLY firing — `isActive` arms on channels, not on todos, so a
     *     session with peers but no todo list still gets the routing recipe;
     *  2. route METADATA — `build` reproduces the `peer/workdir/channel/topic`
     *     block, including the `mail_to(name="<sid>/lead", title="<topic>:…")`
     *     shape, which is the only place the model learns the reply address;
     *  3. FRESHNESS re-emit — the snapshot embeds each peer's `fresh=` flag, so
     *     a peer going stale changes the body. With body dedup gone the
     *     snapshot re-emits each period regardless; freshness only changes WHAT
     *     it says, not whether it is sent.
     *
     * `ttl: 2` (not todo's 4): a channel snapshot is far more perishable than a
     * todo list. A stale routing address sends mail to a dead session, so a
     * wrong hint is worse than no hint — let it age out fast.
     *
     * Reads `ctx.peer` directly (option (a)), following `worktree-nudge`'s
     * precedent of doing async I/O inside `build()`. `listChannels()` /
     * `listIdentities()` / `isFresh()` are synchronous in-memory reads over the
     * already-loaded registry, so this adds no disk I/O to the fan-out.
     */
    id: 'peer-nudge',
    category: 'REMINDER',
    every: 3,
    ttl: 2,
    isActive: (env) => activeChannels(env).length > 0,
    build: async (env) => {
      const channels = activeChannels(env);
      if (channels.length === 0) return null;
      // ChannelFile does not carry workDir; it lives on IdentityEntry. Falls
      // back to '?' if the peer unregistered between the two reads.
      const peerWorkDirs = new Map<string, string>();
      for (const id of env.ctx.peer.listIdentities()) {
        peerWorkDirs.set(id.sessionId, id.workDir ?? '?');
      }
      const lines = channels.map((ch) => {
        const peerSid = ch.peerSessionId ?? '(unknown)';
        const workDir = peerWorkDirs.get(peerSid) ?? '?';
        // `topic` is the channel's static `title` theme; mail_to routes a peer
        // reply by name="<peerSessionId>/lead". The `title=` convention is
        // "<topic>:<subject>" so the recipient sees which channel it is on.
        return (
          `- peer=${peerSid}\n` +
          `  workdir=${workDir}\n` +
          `  channel=${ch.channelId}, topic=${ch.title ?? '(none)'}\n` +
          `  use mail_to(name="${peerSid}/lead", title="${ch.title ?? ''}:<subject>") to communicate`
        );
      });
      return `Active channels:\n${lines.join('\n\n')}`;
    }
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
    // Always armed. The git subprocess moved into `build()`'s natural cadence
    // instead: `isActive` is now a cheap synchronous directory read of the
    // worktree ROOT (a new worktree creates `<cwd>/.worktrees/<name>` before it
    // is useful), so a worktree created and removed between passes is still
    // caught without spawning git every pass.
    isActive: (env) => hasOpenWorktreeHint(env),
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
    env.triologue.note(r.category, body, { phantom: { family: r.id, ttl: r.ttl } });
    s.remaining = r.every;
  }
}
