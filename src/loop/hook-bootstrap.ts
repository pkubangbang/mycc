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
import type { AgentContext, Message, Skill } from '../types.js';
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
 * Build project-context Message[] for pending + legacy hookish skills.
 *
 * This is a pure function (no triologue dependency) so the lead can register
 * it as a project-context populator closure: each compact/clear rebuild calls
 * it fresh, re-querying the registry so newly-compiled hooks drop out and
 * newly-loaded legacy ones appear without a restart.
 *
 * - Pending: skills with a `when` but no compiled condition (re-synced from
 *   the loader each call so the list reflects current disk state).
 * - Legacy: skills whose compiled condition uses the outdated `seq.X` API
 *   (cached on the registry from the last load()).
 *
 * Returns an empty array when neither category has entries, so the populator
 * contributes nothing to projectContext in the common (no-hooks) case.
 */
export function buildHookInfoMessages(
  conditions: ConditionRegistry,
  loader: HookLoader,
): Message[] {
  const out: Message[] = [];

  // Legacy hooks: compiled conditions using the outdated `seq.X` API,
  // rejected at load and therefore inactive. Prompt the LLM to recompile.
  const legacy = conditions.getLegacyConditions();
  if (legacy.length > 0) {
    const lines: string[] = [
      '[Hooks Outdated] The following hookish skills have compiled conditions using the outdated `seq.X` API, which is no longer supported. These hooks were NOT loaded and are inactive. Recompile them to reactivate using the current `turn.X` / `session.X` / `isPlanMode()` syntax:',
      '',
    ];
    for (const entry of legacy) {
      lines.push(`- ${entry.name}:`);
      if (entry.when) {
        lines.push(`  When: ${entry.when}`);
      }
      lines.push(`  Old condition: ${entry.condition}`);
      lines.push(`  Recompile: skill_compile(name="${entry.name}")`);
      lines.push('');
    }
    lines.push('Recompiling re-runs the LLM translation and emits the new syntax, updating conditions.json in place. Once recompiled, the hook activates automatically on the next load.');
    lines.push('');
    out.push(
      { role: 'user', content: lines.join('\n') },
      { role: 'assistant', content: 'Understood. I see hooks with outdated `seq.X` conditions that failed to load. I will recompile them with skill_compile to reactivate them.' },
    );
  }

  // Pending hooks: skills with a `when` but no compiled condition. Re-sync
  // from the loader each call so the list reflects current disk state.
  const pendingSkillNames = conditions.getPending();
  if (pendingSkillNames.length > 0) {
    const pendingSkills = pendingSkillNames
      .map(name => loader.getSkill(name))
      .filter((s): s is Skill => !!s);
    if (pendingSkills.length > 0) {
      const lines: string[] = [
        '[Hooks Pending] The following skills have "when" conditions that can be compiled into proactive hooks. They are NOT active yet - use skill_compile to activate them:',
        '',
      ];
      for (const hook of pendingSkills) {
        lines.push(`- ${hook.name}: ${hook.description}`);
        if (hook.when) {
          lines.push(`  When: ${hook.when}`);
        }
        if (hook.keywords && hook.keywords.length > 0) {
          lines.push(`  Keywords: ${hook.keywords.join(', ')}`);
        }
        lines.push(`  Activate: skill_compile(name="${hook.name}")`);
        lines.push('');
      }
      lines.push('Not all hooks need to be compiled upfront. Only compile the ones relevant to your current task. A compiled hook stays in effect until the skill file changes.');
      lines.push('');
      out.push(
        { role: 'user', content: lines.join('\n') },
        { role: 'assistant', content: 'Understood. I know which hooks are available but not yet active. I can compile them when needed using the skill_compile tool.' },
      );
    }
  }

  return out;
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

  // NOTE: legacy + pending hook info is no longer injected here. The lead
  // registers buildHookInfoMessages as a project-context populator in
  // agent-repl.ts, so compact()/clear() rebuild it fresh from the registry
  // each time (newly-compiled hooks drop out, newly-loaded ones appear)
  // without needing initHookSystem to call setters on the triologue.

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

  // Pending-hook info is produced by buildHookInfoMessages (registered as a
  // populator in agent-repl.ts), not injected here.

  return conditions;
}