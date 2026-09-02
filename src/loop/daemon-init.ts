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
import { autoState } from './auto-state.js';
import type { AgentContext, Skill } from '../types.js';
import type { Triologue } from './triologue.js';

/** Minimal structural type for the skill loader dependency (decoupled from the
 *  concrete Loader class — daemon-init only needs getSkill). */
interface SkillLookup {
  getSkill(name: string): Skill | undefined;
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
        if (ctx.peer.isFresh(entry.sessionId)) {
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
    // Inject a system note so the LLM loads the skill on its first turn.
    // The AWAIT state's 1s poll will pick up this note (it is appended to
    // the triologue) and route to COLLECT → LLM.
    triologue.note('SYSTEM', `Daemon started with skill '${daemonSkill}'. Load it via skill_load(name="${daemonSkill}") and follow its workflow.`);

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
  }

  return null;
}