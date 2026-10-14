/**
 * daemon-init.ts - --daemon mode bootstrap for the Lead
 *
 * Extracted from agent-repl.ts. Daemon mode = auto mode + no terminal: the
 * Lead runs detached (spawned by the Coordinator with stdio:'ignore'),
 * auto-loads the named skill (if provided), starts a croner timer for skills
 * with `service_cron`, and stays alive in AWAIT mode between cron ticks /
 * external mail_to nudges. Only daemon mode activates the cron timer — a
 * non-daemon lead loading a skill with service_cron does NOT start cron.
 */

import chalk from 'chalk';
import { Cron } from 'croner';
import { shouldDaemon, getDaemonSkill } from '../config.js';
import { isOriginalHolderAlive } from '../utils/process-liveness.js';
import { autoState } from './auto-state.js';
import type { AgentContext, IdentityEntry, Skill } from '../types.js';
import type { Triologue } from './triologue.js';

/** Minimal structural type for the skill loader dependency (decoupled from the
 *  concrete Loader class — daemon-init only needs getSkill). */
interface SkillLookup {
  getSkill(name: string): Skill | undefined;
}

/**
 * True when the recorded OS pid for a peer identity is a LIVE holder — the
 * pid-reuse-aware half of the daemon-dedup liveness test.
 *
 * The pid is read from the heartbeat file via `ctx.peer.getPid` (the
 * authoritative, live-refreshed source), falling back to the `entry.pid`
 * published in identity.json at register() time. A missing pid is treated as
 * ALIVE so a legacy entry without a recorded pid is never wrongly bypassed
 * (we refuse to re-launch only when a live process is actually proven).
 *
 * PID-REUSE: a bare `process.kill(pid, 0)` cannot tell the ORIGINAL daemon from
 * an OS-recycled pid — the original may have exited leaving a fresh heartbeat,
 * and the OS reused its pid for an unrelated process (which would then wrongly
 * block a legitimate re-launch). `isOriginalHolderAlive` narrows that using the
 * entry's `startedAt` as a lower bound on when the recorded process began: a pid
 * that STARTED after the entry was registered cannot be the registrant. When
 * start-time evidence is unavailable it falls back CONSERVATIVELY to "alive".
 */
function isEntryPidAlive(ctx: AgentContext, entry: IdentityEntry): boolean {
  const pid = ctx.peer.getPid(entry.sessionId) ?? entry.pid;
  if (typeof pid !== 'number') return true; // no pid → preserve legacy behavior
  // The registered process necessarily started BEFORE the entry's startedAt;
  // a pid whose start time is AFTER that bound is a recycled pid, not the holder.
  const registeredAt = typeof entry.startedAt === 'number' ? entry.startedAt : 0;
  return isOriginalHolderAlive(pid, registeredAt);
}

/**
 * Initialize daemon mode if `--daemon` was passed. Forces auto mode on,
 * dedups against an already-running daemon with the same role + workDir,
 * auto-loads the named skill (injecting a system note so the LLM loads it
 * on its first turn), and starts the croner timer from the skill's
 * `service_cron`.
 *
 * On a fatal startup error (duplicate daemon, or named skill not found),
 * stops the peer subsystem and exits the process — the daemon cannot run.
 *
 * @returns The started cron job (so the caller's signal handlers can stop
 *   it on shutdown), or null when not in daemon mode or the skill declared
 *   no `service_cron` (passive daemon).
 */
export function initDaemonMode(
  ctx: AgentContext,
  loader: SkillLookup,
  triologue: Triologue,
): Cron | null {
  if (!shouldDaemon()) return null;

  // Force auto mode on (daemon is always headless auto).
  autoState.resetStreak();
  autoState.setAuto(true);
  console.log(chalk.cyan('daemon mode is on (--daemon). Running headless.'));

  const daemonSkill = getDaemonSkill();

  // Dedup check: ONLY when a skill name is provided (role is non-empty).
  // Bare --daemon (no skill) does NOT participate in dedup — multiple
  // passive daemons may coexist. The check happens AFTER peer.start() so
  // identity.json is populated, then we check for OTHER instances (not self).
  if (daemonSkill) {
    const identities = ctx.peer.listIdentities();
    const selfWorkDir = process.cwd();
    const selfSessionId = ctx.peer.getSelfSessionId();
    for (const entry of identities) {
      if (entry.sessionId === selfSessionId) continue; // skip self
      if (entry.role === daemonSkill && entry.workDir === selfWorkDir) {
        // A fresh heartbeat alone is NOT proof of a live daemon: after
        // `mycc-compose down`, a stopped peer's identity entry survives (its
        // own unregister() never runs under a SIGTERM/TerminateProcess), and
        // its heartbeat file may still look recent. Gating re-up on
        // `isFresh` (heartbeat freshness only) therefore made a dead-but-fresh
        // entry block a legitimate re-launch (Stage-7 bug). Require BOTH a
        // fresh heartbeat AND an alive recorded pid — the same pid-aware
        // discipline `assertNameNotLive` already applies (identity.ts). A
        // missing pid is treated as live (legacy behavior) so older entries
        // are never wrongly bypassed.
        if (ctx.peer.isFresh(entry.sessionId) && isEntryPidAlive(ctx, entry)) {
          console.error(chalk.red(`A daemon with role '${daemonSkill}' is already running for this workDir.`));
          console.error(chalk.gray(`Existing session: ${entry.sessionId.slice(0, 7)}`));
          // No cron job to stop yet — it is created below, so still null here.
          ctx.peer.stop();
          process.send?.({ type: 'exit' });
          process.exit(1);
        }
      }
    }
  }

  // Auto-load skill if provided.
  if (daemonSkill) {
    const skill = loader.getSkill(daemonSkill);
    if (!skill) {
      console.error(chalk.red(`Skill '${daemonSkill}' not found. Cannot start daemon.`));
      ctx.peer.stop();
      process.send?.({ type: 'exit' });
      process.exit(1);
    }
    // Decide the wake sources FIRST, then inject exactly ONE note with the
    // correct list. Injecting the skill note before the service_cron check
    // left TWO contradictory notes in the conversation: the first claimed
    // "you are woken by cron ticks" unconditionally, and a passive daemon
    // (no service_cron) then got a second note saying "no cron ticks"
    // (PR #28 review P2 F2). One note, computed from the actual config,
    // cannot contradict itself.
    //
    // The wake-source list is stated POSITIVELY (what wakes the daemon), NOT
    // as an exhaustive input channel: a daemon started with `--serve` also
    // accepts browser input, and the LLM cannot observe whether it is serving
    // (the process knows via ServeHub.isRunning(), the LLM does not). An
    // exclusive "...only..." phrasing would therefore be false, and a
    // conditional "...if serving..." asks the LLM to introspect a fact it
    // cannot see. Naming the triggers positively is true in every case.
    const hasCron = !!skill.service_cron;
    const wakeSources = hasCron
      ? 'cron ticks, incoming mail, or browser input if this daemon is serving a Web UI'
      : 'incoming mail, or browser input if this daemon is serving a Web UI';
    triologue.note(
      'SYSTEM',
      `Daemon started with skill '${daemonSkill}'${hasCron ? '' : ' (no service_cron — no cron ticks)'}. ` +
        `Load it via skill_load(name="${daemonSkill}") and follow its workflow. ` +
        `There is no terminal here — you are woken by ${wakeSources}.`,
    );

    // Start cron timer if the skill declares service_cron.
    if (skill.service_cron) {
      try {
        // { unref: true } so the timer doesn't keep the process alive on its
        // own — the agent loop / heartbeat already keep it alive. This
        // prevents a zombie timer if the loop exits but the process lingers.
        const job = new Cron(skill.service_cron, { unref: true }, () => {
          const title = 'Service nudge';
          const content = `[Service nudge] Cron tick for '${daemonSkill}'. Check for pending work and process it per the skill's workflow.`;
          ctx.mail.appendMail('lead', title, content);
          console.log(chalk.gray(`[cron] Nudge sent for '${daemonSkill}'`));
        });
        console.log(chalk.gray(`[cron] Started: ${skill.service_cron}`));
        return job;
      } catch (err) {
        console.error(chalk.red(`[cron] Failed to start: ${(err as Error).message}`));
      }
    } else {
      console.log(chalk.gray(`[daemon] Skill '${daemonSkill}' has no service_cron — passive daemon (waits for external mail).`));
    }
  } else {
    console.log(chalk.gray(`[daemon] No skill specified — passive daemon (waits for external mail).`));
    // Symmetric SYSTEM note (the console.log above is invisible in a
    // headless daemon) — no skill, no cron ticks, so no first-turn task to
    // give; only the wake sources.
    triologue.note(
      'SYSTEM',
      'Daemon started with no skill and no cron ticks. There is no terminal here — you are woken by incoming mail, or browser input if this daemon is serving a Web UI.',
    );
  }

  return null;
}