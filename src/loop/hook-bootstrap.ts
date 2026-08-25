/**
 * hook-bootstrap.ts - Initialize the hook (condition) system for the Lead
 *
 * Extracted from agent-repl.ts. Loads the ConditionRegistry, reports
 * errors/warnings, wires the IPC reload callback, syncs pending skills,
 * wires the registry into the loader, and injects legacy/pending hook info
 * into the triologue project context.
 */

import chalk from 'chalk';
import { ConditionRegistry } from '../hook/conditions.js';
import { agentIO } from './agent-io.js';
import type { AgentContext, Skill } from '../types.js';
import type { Triologue } from './triologue.js';

/** Minimal structural type for the skill loader dependency (decoupled from the
 *  concrete Loader class — hook-bootstrap needs getSkill + listSkills +
 *  setConditionRegistry). */
interface HookLoader {
  getSkill(name: string): Skill | undefined;
  listSkills(): Array<{ name: string; when?: string }>;
  setConditionRegistry(reg: ConditionRegistry): void;
}

/**
 * Initialize the hook system for the agent lifetime.
 *
 * - Creates and loads the {@link ConditionRegistry}; reports errors/warnings.
 * - Injects legacy-condition info (outdated `seq.X` API) into the triologue so
 *   the LLM is prompted to recompile via skill_compile.
 * - Wires the IPC condition-reload callback (skill_compile triggers it).
 * - Syncs pending skills (skills with `when` but no compiled condition).
 * - Wires the runtime ConditionRegistry into the loader so skill_compile can
 *   update the in-memory conditions directly (lead process only).
 * - Injects pending-hook info into project context.
 *
 * @returns The loaded ConditionRegistry (the caller builds Sequence +
 *   HookExecutor from it).
 */
export async function initHookSystem(
  _ctx: AgentContext,
  loader: HookLoader,
  triologue: Triologue,
): Promise<ConditionRegistry> {
  // Initialize hook system (machine lifetime)
  const conditions = new ConditionRegistry();
  const loadResult = await conditions.load();
  // Report load errors/warnings
  for (const error of loadResult.errors) {
    console.error(chalk.red(`[conditions] Error: ${error}`));
  }
  for (const warning of loadResult.warnings) {
    console.log(chalk.yellow(`[conditions] Warning: ${warning}`));
  }

  // Inject info about hooks whose compiled condition uses the outdated
  // `seq.X` API (rejected at load) so the LLM is prompted to recompile them
  // via skill_compile into the current `turn.X` / `session.X` syntax.
  // This surfaces legacy conditions as a projectContext note the agent sees
  // every turn — non-blocking, but actionable (names the exact commands).
  triologue.setLegacyHooksInfo(loadResult.legacyConditions);

  // Wire up IPC-based condition reload: skill_compile sends IPC message
  // to refresh runtime conditions without restarting the agent
  agentIO.setConditionReloadCallback(async () => {
    const reloadResult = await conditions.load();
    // Report reload errors/warnings
    for (const error of reloadResult.errors) {
      console.error(chalk.red(`[conditions] Error: ${error}`));
    }
    for (const warning of reloadResult.warnings) {
      console.log(chalk.yellow(`[conditions] Warning: ${warning}`));
    }
  });

  // Sync pending skills (skills with 'when' but no compiled condition)
  // Will be notified during hint round
  conditions.syncPending(loader);

  // Wire the runtime ConditionRegistry into the Loader so that
  // skill_compile (via ctx.skill.compileCondition) can update the in-memory
  // conditions directly — no throwaway registry, no broken IPC, no restart.
  // Lead process only; child processes leave the loader's registry null and
  // fall back to disk write + 'condition_replace' IPC.
  loader.setConditionRegistry(conditions);

  // Inject pending hook info into project context so the LLM knows
  // which hooks are available but not yet compiled (closes the gap
  // on fresh installations where hooks are loaded but inactive).
  const pendingSkillNames = conditions.getPending();
  if (pendingSkillNames.length > 0) {
    const pendingSkills = pendingSkillNames
      .map(name => loader.getSkill(name))
      .filter((s): s is Skill => !!s);
    triologue.setPendingHooksInfo(pendingSkills);
  }

  return conditions;
}